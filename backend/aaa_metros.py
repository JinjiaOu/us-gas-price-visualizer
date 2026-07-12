"""AAA state-page metro and county averages: on-demand fetch + storage.

A single state page contains all metro-area prices for four products
(current, yesterday, and other reference values).
The API calls this when a user views a state and the cache is stale (>1 day).
Each call requests only one page, far below AAA robots.txt's Crawl-delay: 10.
"""
import re
from datetime import date as ddate, datetime, timedelta, timezone

from curl_cffi import requests as curl_requests
from bs4 import BeautifulSoup

import db

URL = "https://gasprices.aaa.com/"
UA = "Mozilla/5.0 (compatible; gas-price-visualizer/0.1; personal educational project)"
PRODUCT_COLS = ["EPMR", "EPMM", "EPMP", "EPD2D"]

PRICE_RE = re.compile(r"\$([\d.]+)")
MAP_ID_RE = re.compile(r"map_id=(\d+)")
# The county data endpoint stores each county as "name":"X"..."comment":"$3.859".
COUNTY_RE = re.compile(r'"name":"([^"]+)"[^{}]*?"comment":"\$([\d.]+)"')
MAP_DATA_URL = "https://gasprices.aaa.com/index.php?premiumhtml5map_js_data=true&map_id={map_id}"
ASOF_RE = re.compile(r"Price as of\s*(\d{1,2})/(\d{1,2})/(\d{2})")


def parse_state_page(html: str) -> tuple[str, list[dict]]:
    """Return (data date, [{name, current[4], yesterday[4]|None}])."""
    soup = BeautifulSoup(html, "html.parser")

    m = ASOF_RE.search(soup.get_text(" "))
    if m:
        mm, dd, yy = (int(x) for x in m.groups())
        day = f"20{yy:02d}-{mm:02d}-{dd:02d}"
    else:
        day = ddate.today().isoformat()

    metros: list[dict] = []
    # Each metro is an <h3> metro name followed by a price table.
    for h3 in soup.find_all("h3"):
        name = h3.get_text(" ", strip=True)
        if not name or "highest" in name.lower():
            continue
        table = h3.find_next("table")
        if not table:
            continue
        cur = yest = None
        for tr in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if not cells:
                continue
            label = cells[0].lower()
            prices = []
            for c in cells[1:]:
                pm = PRICE_RE.search(c)
                if pm:
                    prices.append(float(pm.group(1)))
            if label.startswith("current") and len(prices) >= 4:
                cur = prices[:4]
            elif label.startswith("yesterday") and len(prices) >= 4:
                yest = prices[:4]
        if cur:
            metros.append({"name": name, "current": cur, "yesterday": yest})
    return day, metros


def fetch_counties(abbr: str, map_id: str, day: str) -> int:
    """Fetch county map data for this state, regular only, store it, and return the county count."""
    resp = curl_requests.get(MAP_DATA_URL.format(map_id=map_id),
                             impersonate="chrome", timeout=30)
    resp.raise_for_status()
    pairs = COUNTY_RE.findall(resp.text)
    if len(pairs) < 5:  # Fuse for page structure changes.
        raise RuntimeError(f"{abbr} county data only parsed {len(pairs)} rows")
    db.upsert_counties([
        {"date": day, "abbr": abbr, "county": name, "value": float(v)}
        for name, v in pairs
    ])
    return len(pairs)


def fetch_and_store(abbr: str) -> str:
    """Fetch and store one state page, returning its data date.

    Raise on page-structure anomalies so bad data is not written.
    """
    resp = curl_requests.get(URL, params={"state": abbr},
                             impersonate="chrome", timeout=30)
    resp.raise_for_status()
    if "Just a moment" in resp.text[:2000]:
        raise RuntimeError("Blocked by a Cloudflare challenge page; skipping this run")
    day, metros = parse_state_page(resp.text)
    if len(metros) < 2:
        raise RuntimeError(
            f"{abbr} page only parsed {len(metros)} metros; structure may have changed"
        )
    rows: list[dict] = []
    yday = (ddate.fromisoformat(day) - timedelta(days=1)).isoformat()
    for m in metros:
        for product, value in zip(PRODUCT_COLS, m["current"]):
            rows.append({"date": day, "abbr": abbr, "metro": m["name"],
                         "product": product, "value": value})
        if m["yesterday"]:
            for product, value in zip(PRODUCT_COLS, m["yesterday"]):
                rows.append({"date": yday, "abbr": abbr, "metro": m["name"],
                             "product": product, "value": value})
    db.upsert_metros(rows)
    db.set_meta(f"last_metro_ingest_{abbr}",
                datetime.now(timezone.utc).isoformat())

    # County data: extract map_id from the state page, then fetch one data
    # endpoint. Failures do not affect metro data.
    m = MAP_ID_RE.search(resp.text)
    if m:
        try:
            n = fetch_counties(abbr, m.group(1), day)
            print(f"[counties][{abbr}] stored {n} counties")
        except Exception as exc:  # noqa: BLE001
            print(f"[counties][{abbr}] fetch failed (metro unaffected): {exc}")
    return day
