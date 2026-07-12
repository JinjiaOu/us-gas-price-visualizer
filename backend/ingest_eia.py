"""EIA 数据拉取:周度普通汽油零售价 -> SQLite.

用法:
    python ingest_eia.py            # 增量:只拉库里没有的最新数据
    python ingest_eia.py --full     # 全量:拉最近 ~3 年

需要 .env 里配置 EIA_API_KEY.
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
# 普通 / 中级 / 高级汽油 + 柴油
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
    """保留 全国(NUS) / 州(S**) / PADD 区(R**) / 都市区(Y**)."""
    area = row.get("duoarea", "")
    return (
        area == "NUS"
        or area.startswith("S")
        or area.startswith("R")
        or area.startswith("Y")
    )


def run(full: bool) -> None:
    if not API_KEY:
        raise RuntimeError("缺少 EIA_API_KEY:复制 .env.example 为 .env 并填入你的 key")

    db.init_db()

    # 增量模式:从库里最新周开始拉(重叠一周,靠 upsert 去重)
    start = None
    if not full:
        with db.connect() as conn:
            row = conn.execute("SELECT MAX(period) AS p FROM prices").fetchone()
            start = row["p"] if row and row["p"] else None
    if full or start is None:
        start = "2023-01-01"

    print(f"拉取 EIA 数据,start={start} ...")
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
        print(f"  offset={offset}, 累计入库 {total_kept} 行 (API total={total})")
        if offset >= total:
            break

    db.set_meta("last_ingest", datetime.now(timezone.utc).isoformat())
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM prices").fetchone()["n"]
        latest = conn.execute("SELECT MAX(period) AS p FROM prices").fetchone()["p"]
    print(f"完成:库内共 {n} 行,最新周 {latest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="全量拉取(约3年)")
    run(parser.parse_args().full)