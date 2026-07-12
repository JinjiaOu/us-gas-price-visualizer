"""SQLite 存储层:油价历史数据囤在本地单文件数据库."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "gas_prices.db"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS prices (
                period    TEXT NOT NULL,   -- '2026-07-07' 周
                duoarea   TEXT NOT NULL,   -- EIA 区域码: NUS / SCA / R20 ...
                area_name TEXT NOT NULL,
                product   TEXT NOT NULL,   -- EPMR = regular gasoline
                value     REAL NOT NULL,   -- $/gal
                PRIMARY KEY (period, duoarea, product)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_prices_area ON prices (duoarea, period DESC)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS aaa_prices (
                date    TEXT NOT NULL,   -- '2026-07-10' 日
                abbr    TEXT NOT NULL,   -- 州缩写, 'US' 为全国
                product TEXT NOT NULL,
                value   REAL NOT NULL,
                PRIMARY KEY (date, abbr, product)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS aaa_metros (
                date    TEXT NOT NULL,
                abbr    TEXT NOT NULL,   -- 所属州缩写
                metro   TEXT NOT NULL,   -- 都市区名, 如 'Houston'
                product TEXT NOT NULL,
                value   REAL NOT NULL,
                PRIMARY KEY (date, abbr, metro, product)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS aaa_counties (
                date   TEXT NOT NULL,
                abbr   TEXT NOT NULL,
                county TEXT NOT NULL,
                value  REAL NOT NULL,   -- 仅 regular
                PRIMARY KEY (date, abbr, county)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )


def upsert_rows(rows: list[dict]) -> int:
    """插入或更新价格行,返回受影响行数."""
    with connect() as conn:
        conn.executemany(
            """
            INSERT INTO prices (period, duoarea, area_name, product, value)
            VALUES (:period, :duoarea, :area_name, :product, :value)
            ON CONFLICT (period, duoarea, product) DO UPDATE SET
                value = excluded.value, area_name = excluded.area_name
            """,
            rows,
        )
        return conn.total_changes


def upsert_aaa(rows: list[dict]) -> int:
    with connect() as conn:
        conn.executemany(
            """
            INSERT INTO aaa_prices (date, abbr, product, value)
            VALUES (:date, :abbr, :product, :value)
            ON CONFLICT (date, abbr, product) DO UPDATE SET value = excluded.value
            """,
            rows,
        )
        return conn.total_changes


def upsert_metros(rows: list[dict]) -> int:
    with connect() as conn:
        conn.executemany(
            """
            INSERT INTO aaa_metros (date, abbr, metro, product, value)
            VALUES (:date, :abbr, :metro, :product, :value)
            ON CONFLICT (date, abbr, metro, product) DO UPDATE SET
                value = excluded.value
            """,
            rows,
        )
        return conn.total_changes


def upsert_counties(rows: list[dict]) -> int:
    with connect() as conn:
        conn.executemany(
            """
            INSERT INTO aaa_counties (date, abbr, county, value)
            VALUES (:date, :abbr, :county, :value)
            ON CONFLICT (date, abbr, county) DO UPDATE SET
                value = excluded.value
            """,
            rows,
        )
        return conn.total_changes


def set_meta(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_meta(key: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None