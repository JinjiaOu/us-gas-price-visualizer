"""AAA 州页 metro 均价 + 县级均价:按需抓取 + 入库.

单个州页包含该州所有都市区的四油品价格(今日 + 昨日等参考值).
由 API 层在用户查看某州且缓存过期(>1 天)时调用,单次仅请求一页,
远低于 AAA robots.txt 的 Crawl-delay: 10 约束.
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
# 县级数据端点里每个县是 "name":"X"..."comment":"$3.859"
COUNTY_RE = re.compile(r'"name":"([^"]+)"[^{}]*?"comment":"\$([\d.]+)"')
MAP_DATA_URL = "https://gasprices.aaa.com/index.php?premiumhtml5map_js_data=true&map_id={map_id}"
ASOF_RE = re.compile(r"Price as of\s*(\d{1,2})/(\d{1,2})/(\d{2})")


def parse_state_page(html: str) -> tuple[str, list[dict]]:
    """返回 (数据日期, [{name, current[4], yesterday[4]|None}])."""
    soup = BeautifulSoup(html, "html.parser")

    m = ASOF_RE.search(soup.get_text(" "))
    if m:
        mm, dd, yy = (int(x) for x in m.groups())
        day = f"20{yy:02d}-{mm:02d}-{dd:02d}"
    else:
        day = ddate.today().isoformat()

    metros: list[dict] = []
    # 每个 metro 是一个 <h3>都市区名</h3> 后跟价格表格
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
    """拉取该州县级地图数据(仅 regular)并入库,返回县数."""
    resp = curl_requests.get(MAP_DATA_URL.format(map_id=map_id),
                             impersonate="chrome", timeout=30)
    resp.raise_for_status()
    pairs = COUNTY_RE.findall(resp.text)
    if len(pairs) < 5:  # 页面结构变化保险丝
        raise RuntimeError(f"{abbr} 县级数据只解析出 {len(pairs)} 条")
    db.upsert_counties([
        {"date": day, "abbr": abbr, "county": name, "value": float(v)}
        for name, v in pairs
    ])
    return len(pairs)


def fetch_and_store(abbr: str) -> str:
    """抓取指定州页并入库,返回数据日期.页面结构异常时抛错,不写脏数据."""
    resp = curl_requests.get(URL, params={"state": abbr},
                             impersonate="chrome", timeout=30)
    resp.raise_for_status()
    if "Just a moment" in resp.text[:2000]:
        raise RuntimeError("被 Cloudflare 质询页拦截,本次跳过")
    day, metros = parse_state_page(resp.text)
    if len(metros) < 2:
        raise RuntimeError(
            f"{abbr} 页面只解析出 {len(metros)} 个 metro,结构可能已变化"
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

    # 县级数据:从州页提取 map_id 再拉一次数据端点;失败不影响 metro
    m = MAP_ID_RE.search(resp.text)
    if m:
        try:
            n = fetch_counties(abbr, m.group(1), day)
            print(f"[counties][{abbr}] 入库 {n} 个县")
        except Exception as exc:  # noqa: BLE001
            print(f"[counties][{abbr}] 拉取失败(不影响 metro): {exc}")
    return day