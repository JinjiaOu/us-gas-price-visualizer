# US Gas Price Visualizer

Full-stack, self-hosted dashboard for US gasoline prices: an interactive
choropleth map with **state -> metro -> county** drill-down, week/day deltas,
multi-state trend comparison, search, watchlist alerts, and dark/light themes.

Built with a simple deployment model: **the frontend is always online, while
the backend runs on demand on my own machine** and can be exposed through a
Cloudflare Tunnel when a live demo is needed. When the backend is offline, the
frontend degrades to a cached real-data snapshot.

## Screenshots

![US Gas Price Visualizer dashboard in dark mode](docs/screenshots/dark_mode.jpg)

![County-level state drill-down with tooltip](docs/screenshots/state-drilldown.jpg)

![Multi-state trend comparison](docs/screenshots/trend-comparison.jpg)

![Light mode dashboard](docs/screenshots/dashboard.jpg)

## Features

- **Interactive US choropleth** with a Magma-derived color scale,
  cursor-tracked 3D hover tilt, animated camera fly-in on state selection, and
  scroll-to-zoom.
- **Three-level drill-down**: national map -> state view -> county-level map,
  with AAA metro averages and day-over-day deltas.
- **Two data providers**: AAA daily state/metro/county
  data powers "now"; EIA weekly official API data powers historical trends.
  Regional fallback data is labeled instead of being passed off as state data.
- **State Insights Panel** for the selected state: rank, price percentile,
  difference versus national average, selected-range high/low, range movement,
  and data-source labeling.
- **Global search** for states, abbreviations, and counties. County search uses
  a static county index to jump to the right state first, then loads
  that state's live county data on demand.
- **Watchlist / price alerts** stored in `localStorage`: add thresholds for
  selected states and highlight alerts when the current price exceeds the
  configured value.
- **Provider status panel** showing backend status, AAA latest date, EIA latest
  week, last ingest time, and current data mode.
- Fuel-grade switching (regular / midgrade / premium / diesel), day-over-day
  deltas, biggest-mover card, top-5 rankings, 13w/26w/52w/3y trend ranges,
  ctrl/cmd-click multi-state comparison, offline snapshot mode, and an animated
  canvas contour-line background.

## Architecture

```text
Frontend: React + TypeScript + Vite
  - react-simple-maps + d3-scale choropleth
  - Recharts historical trends
  - localStorage watchlist and preferences
  - static county index for global county search
  - offline snapshot fallback

Backend: FastAPI + SQLite
  - EIA API ingest for weekly historical data
  - AAA scraper for daily state averages
  - on-demand AAA metro/county caching per state
  - APScheduler startup + daily refresh
  - health endpoint for provider status
```

- **SQLite** as the storage layer: the backend is single-user and local, so a
  zero-config single-file database is the right-sized choice.
- **On-demand scraping with a 24h cache**: metro/county data for a state is
  fetched only when someone views or searches into that state, keeping request
  volume low.
- **Fail-safe ingestion**: parsers refuse to write when page structure looks
  wrong, and scrape failures fall back to the last good data instead of breaking
  the API.

## Data Sources & Scraping Ethics

- [EIA Open Data](https://www.eia.gov/opendata/) - official weekly retail
  gasoline/diesel prices with a free API key.
- [AAA Gas Prices](https://gasprices.aaa.com/) - daily state / metro / county
  averages. Scraped with an identifying User-Agent, minimal request volume,
  24h per-state caching for metro/county pages, and structure-change fuses.
  County data is regular-grade only because that is all AAA publishes at that
  granularity.

## Running Locally

Backend (Windows PowerShell):

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy env.example .env          # put your EIA API key inside
python ingest_eia.py --full    # backfill ~3.5 years of weekly data
python ingest_aaa.py           # today's AAA state averages
```

Frontend:

```powershell
npm install
```

Then start both with one command from the project root:

```powershell
.\dev.ps1
```

Frontend: http://localhost:5173  
API docs: http://localhost:8000/docs

## Data Refresh

- `.\dev.ps1` starts the backend and frontend.
- `backend\start.ps1` runs an incremental EIA update before starting the API.
- The FastAPI app also runs background ingest on startup and daily at 09:30.
- AAA state averages refresh through the backend startup/daily ingest.
- Metro and county data are fetched per state on demand and cached.

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | liveness + ingest status for both providers |
| `GET /api/prices/latest?product=` | all 50 states, AAA-first with EIA fallback, with deltas |
| `GET /api/prices/history?weeks=&product=` | national weekly series from EIA |
| `GET /api/prices/state/{abbr}?weeks=&product=` | state series, with PADD fallback flagged |
| `GET /api/prices/metros/{abbr}?product=` | metro averages from AAA, on-demand cached |
| `GET /api/prices/counties/{abbr}` | county averages from AAA, regular only |
| `GET /api/prices/cities?product=` | EIA metro series for covered cities |

## Roadmap

- Persist AAA daily history for county/metro trend lines.
- Add pytest coverage for parser fuses, API contracts, and fallback behavior.
- Add GitHub Actions for frontend build/lint and backend tests.
- Add URL state sharing for selected state, product, range, and comparisons.
- Evaluate a station-level layer for one metro area.
