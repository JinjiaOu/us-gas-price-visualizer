"""EIA data ingest: weekly retail gasoline/diesel prices -> SQLite.

Usage:
    python ingest_eia.py            # Incremental: fetch only new data
    python ingest_eia.py --full     # Full: fetch the most recent ~3 years

Requires EIA_API_KEY in .env.
"""
import argparse
import os
import sys
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv

import db

load_dotenv()

API_KEY = os.getenv("EIA_API_KEY", "")
BASE_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/"
# Regular / midgrade / premium gasoline + diesel
PRODUCTS = ["EPMR", "EPMM", "EPMP", "EPD2D"]
PAGE_SIZE = 5000


def fetch_page(offset: int, start: str | None) -> dict:
    params: dict = {
        "api_key": API_KEY,
        "frequency": "weekly",
        "data[0]": "value",
        "facets[product][]": PRODUCTS,
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        "offset": offset,
        "length": PAGE_SIZE,
    }
    if start:
        params["start"] = start
    resp = httpx.get(BASE_URL, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()["response"]


def keep_row(row: dict) -> bool:
    """Keep national (NUS), state (S**), PADD region (R**), and metro (Y**) rows."""
    area = row.get("duoarea", "")
    return (
        area == "NUS"
        or area.startswith("S")
        or area.startswith("R")
        or area.startswith("Y")
    )


def run(full: bool) -> None:
    if not API_KEY:
        raise RuntimeError("Missing EIA_API_KEY: copy .env.example to .env and add your key")

    db.init_db()

    # Incremental mode starts from the latest stored week. The one-week overlap
    # is deduplicated by upsert.
    start = None
    if not full:
        with db.connect() as conn:
            row = conn.execute("SELECT MAX(period) AS p FROM prices").fetchone()
            start = row["p"] if row and row["p"] else None
    if full or start is None:
        start = "2023-01-01"

    print(f"Fetching EIA data, start={start} ...")
    offset, total_kept = 0, 0
    while True:
        page = fetch_page(offset, start)
        data = page.get("data", [])
        if not data:
            break
        rows = [
            {
                "period": r["period"],
                "duoarea": r["duoarea"],
                "area_name": r.get("area-name", r["duoarea"]),
                "product": r["product"],
                "value": float(r["value"]),
            }
            for r in data
            if keep_row(r) and r.get("value") is not None
        ]
        db.upsert_rows(rows)
        total_kept += len(rows)
        offset += PAGE_SIZE
        total = int(page.get("total", 0))
        print(f"  offset={offset}, stored {total_kept} rows so far (API total={total})")
        if offset >= total:
            break

    db.set_meta("last_ingest", datetime.now(timezone.utc).isoformat())
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM prices").fetchone()["n"]
        latest = conn.execute("SELECT MAX(period) AS p FROM prices").fetchone()["p"]
    print(f"Done: database has {n} rows, latest week {latest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Full fetch, about 3 years")
    run(parser.parse_args().full)
