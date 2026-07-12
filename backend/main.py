"""FastAPI backend: runs locally on demand and can be exposed via cloudflared.

Start:
    uvicorn main:app --reload --port 8000

While the service is running, data refreshes incrementally: once at startup and
again every day at 09:30.
"""
from contextlib import asynccontextmanager
from datetime import date as ddate
from statistics import mean

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import db
from areas import ABBR_STATE, STATE_ABBR, STATE_PADD, state_duoarea


def _auto_ingest() -> None:
    """Fetch EIA weekly data and AAA daily data in the background.

    Individual failures are logged only; they do not stop the service or the
    other ingest job.
    """
    try:
        from ingest_eia import run as run_eia
        run_eia(full=False)
    except Exception as exc:  # noqa: BLE001
        print(f"[auto-ingest][eia] failed: {exc}")
    try:
        from ingest_aaa import run as run_aaa
        run_aaa()
    except Exception as exc:  # noqa: BLE001
        print(f"[auto-ingest][aaa] failed: {exc}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    scheduler = BackgroundScheduler()
    # EIA publishes weekly on Mondays. Daily checks are safe because incremental
    # ingest is idempotent.
    scheduler.add_job(_auto_ingest, "cron", hour=9, minute=30, id="daily-ingest")
    scheduler.add_job(_auto_ingest, id="startup-ingest")  # Run once after startup in a non-blocking background thread.
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="US Gas Price API", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["GET"],
    allow_headers=["*"],
)

VALID_PRODUCTS = {"EPMR", "EPMM", "EPMP", "EPD2D"}


def check_product(product: str) -> str:
    p = product.upper()
    if p not in VALID_PRODUCTS:
        raise HTTPException(400, f"product must be one of {sorted(VALID_PRODUCTS)}")
    return p


@app.get("/api/health")
def health():
    db.init_db()
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM prices").fetchone()["n"]
        row = conn.execute("SELECT MAX(period) AS p FROM prices").fetchone()
    with db.connect() as conn:
        aaa_n = conn.execute("SELECT COUNT(*) AS n FROM aaa_prices").fetchone()["n"]
        aaa_row = conn.execute("SELECT MAX(date) AS d FROM aaa_prices").fetchone()
    return {
        "status": "ok",
        "rows": n,
        "latest_period": row["p"] if row else None,
        "last_ingest": db.get_meta("last_ingest"),
        "aaa_rows": aaa_n,
        "aaa_latest_date": aaa_row["d"] if aaa_row else None,
        "last_aaa_ingest": db.get_meta("last_aaa_ingest"),
    }


AAA_FRESH_DAYS = 3


def _aaa_latest(product: str) -> dict | None:
    """Return fresh AAA daily data when available within the last 3 days.

    AAA covers all 50 states at state level.
    """
    with db.connect() as conn:
        dates = [
            r["date"]
            for r in conn.execute(
                "SELECT DISTINCT date FROM aaa_prices WHERE product = ? "
                "ORDER BY date DESC LIMIT 2",
                (product,),
            ).fetchall()
        ]
        if not dates:
            return None
        latest_d = dates[0]
        if (ddate.today() - ddate.fromisoformat(latest_d)).days > AAA_FRESH_DAYS:
            return None
        prev_d = dates[1] if len(dates) > 1 else None

        def by_abbr(d: str) -> dict[str, float]:
            rows = conn.execute(
                "SELECT abbr, value FROM aaa_prices WHERE date = ? AND product = ?",
                (d, product),
            ).fetchall()
            return {r["abbr"]: r["value"] for r in rows}

        cur = by_abbr(latest_d)
        prev = by_abbr(prev_d) if prev_d else {}

    states = []
    for full_name, abbr in STATE_ABBR.items():
        if abbr not in cur:
            continue
        price = cur[abbr]
        p_prev = prev.get(abbr)
        states.append({
            "state": full_name, "abbr": abbr,
            "price": round(price, 3),
            "delta": round(price - p_prev, 3) if p_prev is not None else None,
            "source": "state",
        })
    if not states:
        return None

    # National: regular uses the official page value; other products approximate
    # national price with the state average.
    national = cur.get("US")
    if national is None:
        national = round(mean(s["price"] for s in states), 3)
    nat_prev = prev.get("US")
    national_delta = (
        round(national - nat_prev, 3) if nat_prev is not None else None
    )
    return {
        "period": latest_d,
        "provider": "aaa",
        "national": national,
        "national_delta": national_delta,
        "states": states,
    }


@app.get("/api/prices/latest")
def prices_latest(product: str = Query("EPMR")):
    """Latest prices and deltas for all 50 states.

    Prefer AAA daily data, which is state-level for all 50 states. Fall back to
    EIA weekly data when fresh AAA data is unavailable. source='state' means
    state-level data; source='padd' means regional fallback.
    """
    product = check_product(product)
    aaa = _aaa_latest(product)
    if aaa:
        return aaa
    with db.connect() as conn:
        periods = [
            r["period"]
            for r in conn.execute(
                "SELECT DISTINCT period FROM prices WHERE product = ? "
                "ORDER BY period DESC LIMIT 2",
                (product,),
            ).fetchall()
        ]
        if not periods:
            raise HTTPException(503, "No data for this product; run ingest_eia.py first")
        period = periods[0]
        prev_period = periods[1] if len(periods) > 1 else None

        def area_map(p: str) -> dict[str, float]:
            rows = conn.execute(
                "SELECT duoarea, value FROM prices WHERE period = ? AND product = ?",
                (p, product),
            ).fetchall()
            return {r["duoarea"]: r["value"] for r in rows}

        cur = area_map(period)
        prev = area_map(prev_period) if prev_period else {}

    def price_of(area_code: str, m: dict) -> float | None:
        return m.get(area_code)

    states = []
    for full_name, abbr in STATE_ABBR.items():
        s_code, padd = state_duoarea(abbr), STATE_PADD[abbr]
        if s_code in cur:
            price, source, area = cur[s_code], "state", s_code
        elif padd in cur:
            price, source, area = cur[padd], "padd", padd
        else:
            continue
        p_prev = price_of(area, prev)
        delta = round(price - p_prev, 3) if p_prev is not None else None
        states.append({
            "state": full_name, "abbr": abbr,
            "price": round(price, 3), "delta": delta, "source": source,
        })

    national = cur.get("NUS")
    nat_prev = prev.get("NUS")
    national_delta = (
        round(national - nat_prev, 3)
        if national is not None and nat_prev is not None
        else None
    )
    return {
        "period": period,
        "provider": "eia",
        "national": national,
        "national_delta": national_delta,
        "states": states,
    }


@app.get("/api/prices/cities")
def city_prices(product: str = Query("EPMR")):
    """Latest weekly metro prices and deltas for all EIA-covered metros."""
    product = check_product(product)
    with db.connect() as conn:
        periods = [
            r["period"]
            for r in conn.execute(
                "SELECT DISTINCT period FROM prices "
                "WHERE product = ? AND duoarea LIKE 'Y%' "
                "ORDER BY period DESC LIMIT 2",
                (product,),
            ).fetchall()
        ]
        if not periods:
            return {"period": None, "cities": []}
        period = periods[0]
        prev_period = periods[1] if len(periods) > 1 else None

        def rows_of(p: str):
            return conn.execute(
                "SELECT duoarea, area_name, value FROM prices "
                "WHERE period = ? AND product = ? AND duoarea LIKE 'Y%'",
                (p, product),
            ).fetchall()

        cur = rows_of(period)
        prev = {r["duoarea"]: r["value"] for r in rows_of(prev_period)} if prev_period else {}

    cities = []
    for r in cur:
        p_prev = prev.get(r["duoarea"])
        cities.append({
            "duoarea": r["duoarea"],
            "name": r["area_name"],
            "price": round(r["value"], 3),
            "delta": round(r["value"] - p_prev, 3) if p_prev is not None else None,
        })
    return {"period": period, "cities": cities}


@app.get("/api/prices/metros/{abbr}")
def metro_prices(abbr: str, product: str = Query("EPMR")):
    """Metro averages for one state.

    Fetches the state page on demand when the cache is older than one day.
    """
    product = check_product(product)
    abbr = abbr.upper()
    if abbr not in ABBR_STATE:
        raise HTTPException(404, f"Unknown state abbreviation: {abbr}")

    def latest_date() -> str | None:
        with db.connect() as conn:
            row = conn.execute(
                "SELECT MAX(date) AS d FROM aaa_metros WHERE abbr = ?",
                (abbr,),
            ).fetchone()
            return row["d"] if row else None

    d = latest_date()
    stale = d is None or (ddate.today() - ddate.fromisoformat(d)).days >= 1
    if stale:
        try:
            from aaa_metros import fetch_and_store
            fetch_and_store(abbr)
            d = latest_date()
        except Exception as exc:  # noqa: BLE001
            print(f"[metros][{abbr}] fetch failed, using existing cache: {exc}")
    if d is None:
        return {"period": None, "state": ABBR_STATE[abbr], "metros": []}

    with db.connect() as conn:
        dates = [
            r["date"]
            for r in conn.execute(
                "SELECT DISTINCT date FROM aaa_metros "
                "WHERE abbr = ? AND product = ? ORDER BY date DESC LIMIT 2",
                (abbr, product),
            ).fetchall()
        ]
        def by_metro(day: str) -> dict[str, float]:
            rows = conn.execute(
                "SELECT metro, value FROM aaa_metros "
                "WHERE date = ? AND abbr = ? AND product = ?",
                (day, abbr, product),
            ).fetchall()
            return {r["metro"]: r["value"] for r in rows}

        cur = by_metro(dates[0]) if dates else {}
        prev = by_metro(dates[1]) if len(dates) > 1 else {}

    metros = []
    for name in sorted(cur):
        p_prev = prev.get(name)
        metros.append({
            "name": name,
            "price": round(cur[name], 3),
            "delta": round(cur[name] - p_prev, 3) if p_prev is not None else None,
        })
    return {"period": dates[0] if dates else None,
            "state": ABBR_STATE[abbr], "metros": metros}


@app.get("/api/prices/counties/{abbr}")
def county_prices(abbr: str):
    """County-level regular averages for one state.

    County data is cached together with the metro fetch.
    """
    abbr = abbr.upper()
    if abbr not in ABBR_STATE:
        raise HTTPException(404, f"Unknown state abbreviation: {abbr}")

    def latest_date() -> str | None:
        with db.connect() as conn:
            row = conn.execute(
                "SELECT MAX(date) AS d FROM aaa_counties WHERE abbr = ?",
                (abbr,),
            ).fetchone()
            return row["d"] if row else None

    d = latest_date()
    stale = d is None or (ddate.today() - ddate.fromisoformat(d)).days >= 1
    if stale:
        try:
            from aaa_metros import fetch_and_store
            fetch_and_store(abbr)  # Updates both metro and county data.
            d = latest_date()
        except Exception as exc:  # noqa: BLE001
            print(f"[counties][{abbr}] fetch failed, using existing cache: {exc}")
    if d is None:
        return {"period": None, "state": ABBR_STATE[abbr], "counties": []}

    with db.connect() as conn:
        rows = conn.execute(
            "SELECT county, value FROM aaa_counties "
            "WHERE date = ? AND abbr = ? ORDER BY county",
            (d, abbr),
        ).fetchall()
    return {
        "period": d,
        "state": ABBR_STATE[abbr],
        "counties": [
            {"county": r["county"], "price": round(r["value"], 3)} for r in rows
        ],
    }


@app.get("/api/prices/history")
def national_history(weeks: int = 52, product: str = Query("EPMR")):
    product = check_product(product)
    weeks = max(1, min(weeks, 520))
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT period, value FROM prices WHERE duoarea = 'NUS' AND product = ? "
            "ORDER BY period DESC LIMIT ?",
            (product, weeks),
        ).fetchall()
    return {
        "area": "US",
        "series": [{"period": r["period"], "price": r["value"]} for r in reversed(rows)],
    }


@app.get("/api/prices/state/{abbr}")
def state_history(abbr: str, weeks: int = 52, product: str = Query("EPMR")):
    product = check_product(product)
    abbr = abbr.upper()
    if abbr not in ABBR_STATE:
        raise HTTPException(404, f"Unknown state abbreviation: {abbr}")
    weeks = max(1, min(weeks, 520))

    with db.connect() as conn:
        def query(area: str):
            return conn.execute(
                "SELECT period, value FROM prices WHERE duoarea = ? AND product = ? "
                "ORDER BY period DESC LIMIT ?",
                (area, product, weeks),
            ).fetchall()

        rows = query(state_duoarea(abbr))
        source = "state"
        if not rows:
            rows, source = query(STATE_PADD[abbr]), "padd"

    if not rows:
        raise HTTPException(404, "No data")
    return {
        "area": ABBR_STATE[abbr], "abbr": abbr, "source": source,
        "series": [{"period": r["period"], "price": r["value"]} for r in reversed(rows)],
    }
