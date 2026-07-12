"""AAA state-average scraper: daily 50-state + national prices -> SQLite.

Data source: https://gasprices.aaa.com/state-gas-price-averages/
(server-rendered table)

Usage:
    python ingest_aaa.py

Polite scraping: each run requests one page and sends an identifying UA.
If the page structure changes, parsing fails and exits without writing bad data.
"""
import re
import sys
from datetime import date as ddate, datetime, timezone

from curl_cffi import requests as curl_requests
from bs4 import BeautifulSoup

import db

URL = "https://gasprices.aaa.com/state-gas-price-averages/"
UA = "Mozilla/5.0 (compatible; gas-price-visualizer/0.1; personal educational project)"

# Table column order -> internal product codes aligned with EIA.
PRODUCT_COLS = ["EPMR", "EPMM", "EPMP", "EPD2D"]

STATE_RE = re.compile(r"state=([A-Z]{2})")
PRICE_RE = re.compile(r"\$([\d.]+)")
ASOF_RE = re.compile(r"Price as of\s*(\d{1,2})/(\d{1,2})/(\d{2})")
NATIONAL_RE = re.compile(r"National Average\s*\$([\d.]+)")


def parse(html: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ")

    # Use the page's "as of" date; fall back to today if unavailable.
    m = ASOF_RE.search(text)
    if m:
        mm, dd, yy = (int(x) for x in m.groups())
        day = f"20{yy:02d}-{mm:02d}-{dd:02d}"
    else:
        day = ddate.today().isoformat()

    rows: list[dict] = []

    # National average from the page header, regular only.
    m = NATIONAL_RE.search(text)
    if m:
        rows.append({"date": day, "abbr": "US", "product": "EPMR",
                     "value": float(m.group(1))})

    # State table: each row is a state link plus four price cells.
    for tr in soup.find_all("tr"):
        a = tr.find("a", href=STATE_RE)
        if not a:
            continue
        abbr = STATE_RE.search(a["href"]).group(1)
        prices = []
        for td in tr.find_all("td"):
            pm = PRICE_RE.search(td.get_text())
            if pm:
                prices.append(float(pm.group(1)))
        if len(prices) < 4:
            continue
        for product, value in zip(PRODUCT_COLS, prices[:4]):
            rows.append({"date": day, "abbr": abbr, "product": product,
                         "value": value})

    state_count = len({r["abbr"] for r in rows if r["abbr"] != "US"})
    if state_count < 45:  # Fuse for page structure changes.
        raise RuntimeError(
            f"Parse anomaly: only found {state_count} states; page structure may have changed, skipping write"
        )
    return day, rows


def run() -> None:
    db.init_db()
    print(f"Fetching AAA state averages from {URL} ...")
    resp = curl_requests.get(URL, impersonate="chrome", timeout=30)
    resp.raise_for_status()
    if "Just a moment" in resp.text[:2000]:
        raise RuntimeError("Blocked by a Cloudflare challenge page; skipping this run")
    day, rows = parse(resp.text)
    db.upsert_aaa(rows)
    db.set_meta("last_aaa_ingest", datetime.now(timezone.utc).isoformat())
    print(f"Done: {day}, {len(rows)} rows (50 states x 4 products + national)")


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"AAA fetch failed: {exc}")
