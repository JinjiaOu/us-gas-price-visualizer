"""AAA 州均价爬虫:每日 50 州 + 全国, 四种油品 -> SQLite.

数据源: https://gasprices.aaa.com/state-gas-price-averages/ (服务端渲染表格)
用法:
    python ingest_aaa.py

礼貌抓取: 每次运行只请求一个页面, 带明确 UA 标识.
页面结构变化时解析会失败并报错退出, 不会写入脏数据.
"""
import re
import sys
from datetime import date as ddate, datetime, timezone

from curl_cffi import requests as curl_requests
from bs4 import BeautifulSoup

import db

URL = "https://gasprices.aaa.com/state-gas-price-averages/"
UA = "Mozilla/5.0 (compatible; gas-price-visualizer/0.1; personal educational project)"

# 表格列顺序 -> 内部油品码(与 EIA 对齐)
PRODUCT_COLS = ["EPMR", "EPMM", "EPMP", "EPD2D"]

STATE_RE = re.compile(r"state=([A-Z]{2})")
PRICE_RE = re.compile(r"\$([\d.]+)")
ASOF_RE = re.compile(r"Price as of\s*(\d{1,2})/(\d{1,2})/(\d{2})")
NATIONAL_RE = re.compile(r"National Average\s*\$([\d.]+)")


def parse(html: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ")

    # 页面标注的数据日期;取不到则用今天
    m = ASOF_RE.search(text)
    if m:
        mm, dd, yy = (int(x) for x in m.groups())
        day = f"20{yy:02d}-{mm:02d}-{dd:02d}"
    else:
        day = ddate.today().isoformat()

    rows: list[dict] = []

    # 全国均价(仅 regular,页面头部)
    m = NATIONAL_RE.search(text)
    if m:
        rows.append({"date": day, "abbr": "US", "product": "EPMR",
                     "value": float(m.group(1))})

    # 州表格:每行 = 州链接 + 4 个价格单元格
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
    if state_count < 45:  # 页面结构变化的保险丝
        raise RuntimeError(
            f"解析异常:只识别出 {state_count} 个州,页面结构可能已变化,本次不入库"
        )
    return day, rows


def run() -> None:
    db.init_db()
    print(f"抓取 AAA 州均价 {URL} ...")
    resp = curl_requests.get(URL, impersonate="chrome", timeout=30)
    resp.raise_for_status()
    if "Just a moment" in resp.text[:2000]:
        raise RuntimeError("被 Cloudflare 质询页拦截,本次跳过")
    day, rows = parse(resp.text)
    db.upsert_aaa(rows)
    db.set_meta("last_aaa_ingest", datetime.now(timezone.utc).isoformat())
    print(f"完成:{day} 共 {len(rows)} 行(50 州 x 4 油品 + 全国)")


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"AAA 抓取失败: {exc}")