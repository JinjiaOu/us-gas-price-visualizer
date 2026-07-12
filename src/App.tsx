import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComposableMap, Geographies, Geography,
} from "react-simple-maps";
import { scaleLinear } from "d3-scale";
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  Tooltip as ReTooltip, CartesianGrid, Legend,
} from "recharts";
import { api, PRODUCTS } from "./api";
import type {
  CountyPrice, LatestResponse, MetroPrice, Product, SeriesPoint, StatePrice,
} from "./api";
import { snapshot } from "./data/snapshot";
import "./theme.css";

const geoUrl = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";
const countiesUrl = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

// State abbreviation -> FIPS prefix (first two digits of county topojson ids).
const STATE_FIPS: Record<string, string> = {
  AL:"01",AK:"02",AZ:"04",AR:"05",CA:"06",CO:"08",CT:"09",DE:"10",FL:"12",
  GA:"13",HI:"15",ID:"16",IL:"17",IN:"18",IA:"19",KS:"20",KY:"21",LA:"22",
  ME:"23",MD:"24",MA:"25",MI:"26",MN:"27",MS:"28",MO:"29",MT:"30",NE:"31",
  NV:"32",NH:"33",NJ:"34",NM:"35",NY:"36",NC:"37",ND:"38",OH:"39",OK:"40",
  OR:"41",PA:"42",RI:"44",SC:"45",SD:"46",TN:"47",TX:"48",UT:"49",VT:"50",
  VA:"51",WA:"53",WV:"54",WI:"55",WY:"56",
};

// Normalize county names for AAA/topojson matching by ignoring case,
// punctuation, and suffixes such as County and Parish.
// Keep "city" because states such as Virginia can have both Fairfax County
// and Fairfax City; independent-city matching is handled by countyPriceFor.
function normCounty(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/\b(county|parish|borough|census area|municipality|city and)\b/g, "")
    .replace(/[^a-z]/g, "");
}

// County codes >= 500 are usually independent cities (for example Alexandria
// and Virginia Beach in VA, Baltimore City in MD, St. Louis City in MO).
// Prefer "X city" for those and the bare name for normal counties, with both
// directions as fallbacks to avoid Fairfax County / Fairfax City collisions.
function countyPriceFor(
  m: Map<string, number>, geoId: string, cname: string
): number | undefined {
  const base = normCounty(cname);
  const cityKey = base + "city";
  const code = Number(String(geoId).slice(2));
  const keys = code >= 500 ? [cityKey, base] : [base, cityKey];
  for (const k of keys) {
    const v = m.get(k);
    if (v != null) return v;
  }
  return undefined;
}

type Theme = "dark" | "light";
type Mode = "loading" | "live" | "offline";
// Pixel-space camera in the 920x540 SVG viewBox coordinate system; naturally
// safe for the AK/HI inset boxes in the AlbersUSA projection.
type View = { cx: number; cy: number; zoom: number };
type HoveredState = {
  geo: any;
  name: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
};
type HoverTilt = {
  transform: string;
  shadowX: string;
  shadowY: string;
};

const MAP_W = 920;
const MAP_H = 540;
const US_VIEW: View = { cx: MAP_W / 2, cy: MAP_H / 2, zoom: 1 };
const RANGES = [
  { weeks: 13, label: "13w" },
  { weeks: 26, label: "26w" },
  { weeks: 52, label: "52w" },
  { weeks: 156, label: "3y" },
];
const MAX_COMPARE = 2;

function heatStops(): string[] {
  const s = getComputedStyle(document.documentElement);
  return [0, 1, 2, 3, 4].map((i) => s.getPropertyValue(`--heat-${i}`).trim());
}
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function mutedColor(color: string, theme: Theme): string {
  const hex = color.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return color;

  const raw = match[1].length === 3
    ? match[1].split("").map((c) => c + c).join("")
    : match[1];
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;

  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const saturation = theme === "dark"
    ? Math.max(7, s * 100 * 0.1)
    : Math.max(8, s * 100 * 0.1);
  const lightness = theme === "dark"
    ? Math.max(30, Math.min(44, l * 100 * 0.95))
    : Math.max(18, l * 100 * 0.78);

  return `hsl(${h.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}
function shortDate(period: string): string {
  const [y, m, d] = period.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[Number(m) - 1]} ${d} '${y.slice(2)}`;
}

function useCountUp(target: number, duration = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

/** Smooth camera: interpolate to target views with rAF. */
function useAnimatedView(target: View, duration = 650): View {
  const [v, setV] = useState(target);
  const currentRef = useRef(target);
  useEffect(() => {
    const from = currentRef.current;
    const to = target;
    let raf = 0;
    const t0 = performance.now();
    const ease = (k: number) =>
      k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = ease(k);
      const next: View = {
        cx: from.cx + (to.cx - from.cx) * e,
        cy: from.cy + (to.cy - from.cy) * e,
        zoom: from.zoom + (to.zoom - from.zoom) * e,
      };
      currentRef.current = next;
      setV(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

function viewForBBox(b: { x: number; y: number; width: number; height: number }): View {
  // Make the state fill about 72% of the viewport; clamp zoom to [1.6, 9].
  const zoom = Math.min(
    9,
    Math.max(1.6, 0.72 * Math.min(MAP_W / b.width, MAP_H / b.height))
  );
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, zoom };
}

function pointerToSvgPoint(el: SVGGraphicsElement, e: React.MouseEvent) {
  const svg = el.ownerSVGElement;
  if (!svg) return null;
  const ctm = el.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(ctm.inverse());
}

function Delta({ d }: { d: number | null | undefined }) {
  if (d == null) return null;
  if (Math.abs(d) < 0.0005) return <span className="delta">—</span>;
  const up = d > 0;
  return (
    <span className={`delta ${up ? "up" : "down"} mono`}>
      {up ? "▲" : "▼"} {Math.abs(d).toFixed(2)}
    </span>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    if (saved) return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [stops, setStops] = useState<string[]>([]);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const [mode, setMode] = useState<Mode>("loading");
  const [product, setProduct] = useState<Product>("EPMR");
  const [range, setRange] = useState(52);
  const [latest, setLatest] = useState<LatestResponse | null>(null);
  const [metros, setMetros] = useState<MetroPrice[]>([]);
  const [counties, setCounties] = useState<CountyPrice[]>([]);
  const [selected, setSelected] = useState<StatePrice | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [seriesMap, setSeriesMap] = useState<Record<string, SeriesPoint[]>>({});
  const [trendNote, setTrendNote] = useState("");
  const [targetView, setTargetView] = useState<View>(US_VIEW);
  const [hoveredState, setHoveredState] = useState<HoveredState | null>(null);
  const [hoverTilt, setHoverTilt] = useState<HoverTilt>({
    transform: "",
    shadowX: "0px",
    shadowY: "5px",
  });
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const tiltRafRef = useRef<number | null>(null);
  const tiltStateRef = useRef({ rx: 0, ry: 0, tx: 0, ty: 0 });
  const tiltTargetRef = useRef({ rx: 0, ry: 0, tx: 0, ty: 0 });
  const tiltPivotRef = useRef({ x: 0, y: 0 });

  const view = useAnimatedView(targetView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const selectedRef = useRef<StatePrice | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
    setStops(heatStops());
  }, [theme]);

  useEffect(() => {
    (async () => {
      try {
        await api.health();
        setMode("live");
      } catch {
        setLatest(snapshot);
        setMode("offline");
      }
    })();
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    (async () => {
      try {
        setLatest(await api.latest(product));
      } catch {
        setLatest(snapshot);
        setMode("offline");
      }
    })();
  }, [mode, product]);

  useEffect(() => {
    if (mode !== "live") return;
    (async () => {
      try {
        const baseKey = selected ? selected.abbr : "US";
        const jobs: Promise<[string, SeriesPoint[], string?]>[] = [
          selected
            ? api.stateHistory(selected.abbr, range, product)
                .then((h) => [baseKey, h.series, h.source] as [string, SeriesPoint[], string?])
            : api.nationalHistory(range, product)
                .then((h) => ["US", h.series, undefined] as [string, SeriesPoint[], string?]),
          ...compare.map((ab) =>
            api.stateHistory(ab, range, product)
              .then((h) => [ab, h.series, h.source] as [string, SeriesPoint[], string?])
          ),
        ];
        const results = await Promise.all(jobs);
        const m: Record<string, SeriesPoint[]> = {};
        let note = "";
        for (const [key, series, source] of results) {
          m[key] = series;
          if (key === baseKey && source === "padd") note = "regional (PADD) series";
        }
        setSeriesMap(m);
        setTrendNote(note);
      } catch {
        setSeriesMap({});
        setTrendNote("failed to load series");
      }
    })();
  }, [mode, product, range, selected, compare]);

  // When the selected state changes, load metro averages for that state.
  // Online only; first access can trigger a backend fetch.
  useEffect(() => {
    setMetros([]);
    if (mode !== "live" || !selected) return;
    let cancelled = false;
    api.metros(selected.abbr, product)
      .then((r) => { if (!cancelled) setMetros(r.metros); })
      .catch(() => { if (!cancelled) setMetros([]); });
    return () => { cancelled = true; };
  }, [mode, selected, product]);

  // When the selected state changes, load county data.
  // Online only and regular only because AAA county maps only publish regular.
  useEffect(() => {
    setCounties([]);
    if (mode !== "live" || !selected || product !== "EPMR") return;
    let cancelled = false;
    api.counties(selected.abbr)
      .then((r) => { if (!cancelled) setCounties(r.counties); })
      .catch(() => { if (!cancelled) setCounties([]); });
    return () => { cancelled = true; };
  }, [mode, selected, product]);

  // Wheel zoom: zoom toward the pointer; zooming out far enough from state view
  // returns to the national map.
  useEffect(() => {
    const el = mapWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      untiltState(); // Hide the hover clone while zooming to avoid stacked transforms.
      const svg = el.querySelector("svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * MAP_W;
      const sy = ((e.clientY - rect.top) / rect.height) * MAP_H;
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const z2 = Math.min(10, Math.max(1, v.zoom * factor));
      if (selectedRef.current && z2 < 1.45) {
        setSelected(null);
        setTargetView(US_VIEW);
        return;
      }
      // Keep the map point under the pointer fixed.
      const wx = v.cx + (sx - MAP_W / 2) / v.zoom;
      const wy = v.cy + (sy - MAP_H / 2) / v.zoom;
      let cx2 = wx - (sx - MAP_W / 2) / z2;
      let cy2 = wy - (sy - MAP_H / 2) / z2;
      // Keep the viewport within map bounds.
      const hw = MAP_W / (2 * z2), hh = MAP_H / (2 * z2);
      cx2 = Math.min(MAP_W - hw, Math.max(hw, cx2));
      cy2 = Math.min(MAP_H - hh, Math.max(hh, cy2));
      setTargetView({ cx: cx2, cy: cy2, zoom: z2 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape returns to the national map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") backToUS();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  function backToUS() {
    setSelected(null);
    setTargetView(US_VIEW);
  }

  function selectState(sp: StatePrice) {
    setSelected(sp);
    const path = mapWrapRef.current?.querySelector<SVGPathElement>(
      `path[data-name="${CSS.escape(sp.state)}"]`
    );
    if (path) setTargetView(viewForBBox(path.getBBox()));
  }

  /** 3D tilt: derive lift and angle from pointer position inside each state.
   * mousemove only updates the target; a separate rAF loop keeps easing the
   * current value toward it. This keeps motion smooth even after the pointer
   * stops and avoids mid-entry stalls.
   */
  function tiltState(e: React.MouseEvent, hovered: HoveredState) {
    const el = e.currentTarget as SVGPathElement;
    if (inStateView) {
      untiltState();
      return;
    }

    setHoveredState(hovered);
    const bb = el.getBBox();
    if (!bb.width || !bb.height) return;

    const pivot = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    const localPoint = pointerToSvgPoint(el, e);
    if (!localPoint) return;

    const nx = Math.max(-1, Math.min(1, (localPoint.x - pivot.x) / (bb.width / 2)));
    const ny = Math.max(-1, Math.min(1, (localPoint.y - pivot.y) / (bb.height / 2)));
    tiltPivotRef.current = pivot;
    tiltTargetRef.current = {
      rx: -ny * 15,
      ry: nx * 15,
      tx: 0,
      ty: -9,
    };
    if (tiltRafRef.current == null) tiltLoop();
  }

  function tiltLoop() {
    tiltRafRef.current = requestAnimationFrame(() => {
      const target = tiltTargetRef.current;
      const current = tiltStateRef.current;
      const next = {
        rx: current.rx + (target.rx - current.rx) * 0.28,
        ry: current.ry + (target.ry - current.ry) * 0.28,
        tx: current.tx + (target.tx - current.tx) * 0.28,
        ty: current.ty + (target.ty - current.ty) * 0.28,
      };
      tiltStateRef.current = next;
      const p = tiltPivotRef.current;
      setHoverTilt({
        // translate(pivot) -> tilt -> translate(-pivot):
        // Rotate, scale, and perspective around the state center without
        // relying on browser transform-box support.
        transform:
          `translate(${next.tx.toFixed(2)}px, ${next.ty.toFixed(2)}px) ` +
          `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) ` +
          `perspective(760px) ` +
          `rotateX(${next.rx.toFixed(2)}deg) rotateY(${next.ry.toFixed(2)}deg) scale(1.024) ` +
          `translate(${(-p.x).toFixed(1)}px, ${(-p.y).toFixed(1)}px)`,
        shadowX: `${(-next.ry / 5).toFixed(2)}px`,
        shadowY: `${(5 + next.rx / 7.5).toFixed(2)}px`,
      });
      tiltLoop();
    });
  }

  function untiltState() {
    if (tiltRafRef.current != null) {
      cancelAnimationFrame(tiltRafRef.current);
      tiltRafRef.current = null;
    }
    tiltStateRef.current = { rx: 0, ry: 0, tx: 0, ty: 0 };
    setHoveredState(null);
    setHoverTilt({ transform: "", shadowX: "0px", shadowY: "5px" });
  }

  function handleStateClick(sp: StatePrice, ev: React.MouseEvent) {
    if (ev.ctrlKey || ev.metaKey) {
      if (sp.abbr === (selected?.abbr ?? "US")) return;
      setCompare((c) =>
        c.includes(sp.abbr)
          ? c.filter((x) => x !== sp.abbr)
          : c.length < MAX_COMPARE
          ? [...c, sp.abbr]
          : c
      );
      return;
    }
    if (selected?.abbr === sp.abbr) backToUS();
    else {
      selectState(sp);
      setCompare((c) => c.filter((x) => x !== sp.abbr));
    }
  }

  const priceByName = useMemo(() => {
    const m = new Map<string, StatePrice>();
    latest?.states.forEach((s) => m.set(s.state, s));
    return m;
  }, [latest]);

  const values = useMemo(
    () => (latest ? latest.states.map((s) => s.price) : [0, 1]),
    [latest]
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const national = latest?.national ?? 0;
  const avgAnim = useCountUp(national);

  const sortedDesc = useMemo(
    () => (latest ? [...latest.states].sort((a, b) => b.price - a.price) : []),
    [latest]
  );
  const top5 = sortedDesc.slice(0, 5);
  const bottom5 = [...sortedDesc].reverse().slice(0, 5);
  const hiState = sortedDesc[0];
  const loState = sortedDesc[sortedDesc.length - 1];
  const rankOf = (abbr: string) =>
    sortedDesc.findIndex((s) => s.abbr === abbr) + 1;

  const biggestMover = useMemo(() => {
    if (!latest) return null;
    const withDelta = latest.states.filter((s) => s.delta != null);
    if (!withDelta.length) return null;
    return withDelta.reduce((m, s) =>
      Math.abs(s.delta!) > Math.abs(m.delta!) ? s : m
    );
  }, [latest]);

  const colorScale = useMemo(() => {
    if (!stops.length || hi === lo) return () => "#333";
    const span = hi - lo;
    return scaleLinear<string>()
      .domain([lo, lo + span * 0.3, lo + span * 0.55, lo + span * 0.8, hi])
      .range(stops)
      .clamp(true);
  }, [stops, lo, hi]);

  const rampCss = stops.length
    ? `linear-gradient(90deg, ${stops.join(", ")})`
    : "transparent";

  const trendColor = cssVar("--heat-3") || "#e04c67";
  const gridColor = cssVar("--border") || "#232030";
  const dimColor = cssVar("--text-faint") || "#666";
  const cmpColors = [cssVar("--cmp-1") || "#4aa3df", cssVar("--cmp-2") || "#b58ae0"];

  const baseKey = selected ? selected.abbr : "US";
  const chartData = useMemo(() => {
    const keys = [baseKey, ...compare];
    const periods = new Set<string>();
    keys.forEach((k) => seriesMap[k]?.forEach((p) => periods.add(p.period)));
    return [...periods].sort().map((period) => {
      const row: Record<string, string | number | null> = {
        week: shortDate(period),
      };
      keys.forEach((k) => {
        row[k] = seriesMap[k]?.find((p) => p.period === period)?.price ?? null;
      });
      return row;
    });
  }, [seriesMap, baseKey, compare]);

  const countyByNorm = useMemo(() => {
    const m = new Map<string, number>();
    counties.forEach((c) => {
      const cityOf = /^city of\s+(.+)$/i.exec(c.county.trim());
      const key = normCounty(cityOf ? `${cityOf[1]} city` : c.county);
      m.set(key, c.price);
    });
    return m;
  }, [counties]);

  const countyLoHi = useMemo(() => {
    if (!counties.length) return null;
    const vs = counties.map((c) => c.price);
    return [Math.min(...vs), Math.max(...vs)] as [number, number];
  }, [counties]);

  const countyScale = useMemo(() => {
    if (!stops.length || !countyLoHi || countyLoHi[0] === countyLoHi[1])
      return () => "var(--panel-2)";
    const [clo, chi] = countyLoHi;
    const span = chi - clo;
    return scaleLinear<string>()
      .domain([clo, clo + span * 0.3, clo + span * 0.55, clo + span * 0.8, chi])
      .range(stops)
      .clamp(true);
  }, [stops, countyLoHi]);

  const countyLayerOn = inStateViewCheck();
  function inStateViewCheck() {
    return selected != null && counties.length > 0;
  }

  const inStateView = selected != null;
  const productDisabled = mode !== "live";

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <div className="title">US Gas Price Visualizer</div>
          <div className="subtitle mono">
            $/gal · EIA ·{" "}
            {latest ? `as of ${shortDate(latest.period)}` : "loading"}
            {mode === "live" && <span className="live-dot" title="backend online" />}
            <span className="cursor" />
          </div>
        </div>
        <button
          className="toggle mono"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "◐ light" : "◑ dark"}
        </button>
      </div>

      {mode === "offline" && (
        <div className="banner mono">
          backend offline — showing cached snapshot ({snapshot.period}, regular
          only). trends, grades &amp; city data need the live backend.
        </div>
      )}

      <div className="controls-row">
        <div className="pills">
          {PRODUCTS.map((p) => (
            <button
              key={p.code}
              className={`pill mono${product === p.code ? " on" : ""}`}
              disabled={productDisabled}
              onClick={() => setProduct(p.code)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="cmp-hint mono">
          click a state · scroll to zoom · ctrl+click compare · esc reset
        </span>
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">National avg</div>
          <div className="value mono">
            ${avgAnim.toFixed(2)}
            <Delta d={latest?.national_delta} />
          </div>
        </div>
        <div className="card">
          <div className="label">Highest</div>
          <div className="value mono" style={{ color: "var(--hi-color)" }}>
            {hiState ? `${hiState.abbr} $${hiState.price.toFixed(2)}` : "—"}
          </div>
        </div>
        <div className="card">
          <div className="label">Lowest</div>
          <div className="value mono" style={{ color: "var(--lo-color)" }}>
            {loState ? `${loState.abbr} $${loState.price.toFixed(2)}` : "—"}
          </div>
        </div>
        <div className="card">
          <div className="label">Biggest mover</div>
          <div className="value mono">
            {biggestMover ? (
              <>
                {biggestMover.abbr}
                <Delta d={biggestMover.delta} />
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      <div className="main-grid">
        <div>
          <div ref={mapWrapRef} className={`map-wrap${inStateView ? " map-stateview" : ""}`}>
            {inStateView && (
              <button className="map-back mono" onClick={backToUS}>
                ← US map
              </button>
            )}
            <ComposableMap projection="geoAlbersUsa" width={920} height={540}
              style={{ width: "100%", height: "auto" }}>
              <g
                transform={`translate(${MAP_W / 2 - view.zoom * view.cx} ${
                  MAP_H / 2 - view.zoom * view.cy
                }) scale(${view.zoom})`}
              >
                <Geographies geography={geoUrl}>
                  {({ geographies }: { geographies: any[] }) =>
                    geographies.map((geo: any, i: number) => {
                      const name = geo.properties.name as string;
                      const sp = priceByName.get(name);
                      const fill = sp ? colorScale(sp.price) : "var(--panel-2)";
                      const isSel = selected?.state === name;
                      const isHoverBase = hoveredState?.name === name && !inStateView;
                      const stroke = isSel ? "var(--text)" : "var(--bg)";
                      const strokeWidth = (isSel ? 0.9 : 0.6) / view.zoom;
                      return (
                        <Geography
                          key={geo.rsmKey}
                          geography={geo}
                          data-name={name}
                          className={`state${isSel ? " selected" : ""}${isHoverBase ? " hover-base" : ""}`}
                          fill={isHoverBase ? mutedColor(fill, theme) : fill}
                          stroke={stroke}
                          strokeWidth={strokeWidth}
                          style={{
                            default: { outline: "none", animationDelay: `${i * 9}ms` },
                            hover: { outline: "none" },
                            pressed: { outline: "none" },
                          }}
                          onClick={(e: React.MouseEvent) => sp && handleStateClick(sp, e)}
                          onMouseMove={(e: React.MouseEvent) => {
                            setTip({
                              x: e.clientX, y: e.clientY,
                              text: sp
                                ? `${name} · $${sp.price.toFixed(2)}${
                                    sp.delta != null
                                      ? ` · ${sp.delta > 0 ? "▲" : sp.delta < 0 ? "▼" : ""}${Math.abs(sp.delta).toFixed(2)}`
                                      : ""
                                  }${sp.source === "padd" ? " · regional avg" : ""}`
                                : `${name} · n/a`,
                            });
                            tiltState(e, { geo, name, fill, stroke, strokeWidth });
                          }}
                          onMouseLeave={() => {
                            setTip(null);
                            untiltState();
                          }}
                        />
                      );
                    })
                  }
                </Geographies>

                {hoveredState && !inStateView && (
                  <Geography
                    geography={hoveredState.geo}
                    data-name={`${hoveredState.name}-hover`}
                    className="state state-hover-overlay"
                    fill={hoveredState.fill}
                    stroke={hoveredState.stroke}
                    strokeWidth={hoveredState.strokeWidth}
                    style={{
                      default: {
                        outline: "none",
                        pointerEvents: "none",
                        transform: hoverTilt.transform,
                        "--state-shadow-x": hoverTilt.shadowX,
                        "--state-shadow-y": hoverTilt.shadowY,
                      } as React.CSSProperties,
                      hover: { outline: "none", pointerEvents: "none" },
                      pressed: { outline: "none", pointerEvents: "none" },
                    }}
                  />
                )}

                {countyLayerOn && selected && (
                  <Geographies geography={countiesUrl}>
                    {({ geographies }: { geographies: any[] }) => {
                      const fips = STATE_FIPS[selected.abbr];
                      return geographies
                        .filter((geo: any) => String(geo.id).startsWith(fips))
                        .map((geo: any) => {
                          const cname = geo.properties.name as string;
                          const price = countyPriceFor(countyByNorm, geo.id, cname);
                          return (
                            <Geography
                              key={geo.rsmKey}
                              geography={geo}
                              className="county"
                              fill={price != null ? countyScale(price) : "var(--panel-2)"}
                              stroke="var(--bg)"
                              strokeWidth={0.35 / view.zoom}
                              style={{
                                default: { outline: "none" },
                                hover: { outline: "none" },
                                pressed: { outline: "none" },
                              }}
                              onMouseMove={(e: React.MouseEvent) =>
                                setTip({
                                  x: e.clientX, y: e.clientY,
                                  text: price != null
                                    ? `${cname} · $${price.toFixed(2)}`
                                    : `${cname} · n/a`,
                                })
                              }
                              onMouseLeave={() => setTip(null)}
                            />
                          );
                        });
                    }}
                  </Geographies>
                )}

              </g>
            </ComposableMap>
            <div className="legend mono">
              <span>
                ${countyLayerOn && countyLoHi
                  ? countyLoHi[0].toFixed(2)
                  : isFinite(lo) ? lo.toFixed(2) : "—"}
              </span>
              <div className="ramp" style={{ background: rampCss }} />
              <span>
                ${countyLayerOn && countyLoHi
                  ? countyLoHi[1].toFixed(2)
                  : isFinite(hi) ? hi.toFixed(2) : "—"}
              </span>
              {countyLayerOn && <span style={{ marginLeft: 6 }}>· county range</span>}
            </div>
          </div>
        </div>

        <div className="side">
          <div className="panel-box">
            <h3 className="mono">MOST EXPENSIVE</h3>
            {top5.map((s, i) => (
              <RankRow key={s.abbr} s={s} i={i}
                active={selected?.abbr === s.abbr}
                onClick={(e) => handleStateClick(s, e)} />
            ))}
          </div>
          <div className="panel-box">
            <h3 className="mono">CHEAPEST</h3>
            {bottom5.map((s, i) => (
              <RankRow key={s.abbr} s={s} i={i}
                active={selected?.abbr === s.abbr}
                onClick={(e) => handleStateClick(s, e)} />
            ))}
          </div>
          {selected && metros.length > 0 && (
            <div className="panel-box">
              <h3 className="mono">METRO AVERAGES</h3>
              <div className="metro-list">
                {metros.map((m) => (
                  <div key={m.name} className="rank-row" style={{ cursor: "default" }}>
                    <span className="st">{m.name}</span>
                    <span className="pr mono">${m.price.toFixed(2)}</span>
                    <span className={`dl mono ${
                      m.delta == null ? "na" : m.delta > 0 ? "up" : m.delta < 0 ? "down" : "na"
                    }`}>
                      {m.delta == null ? "" : m.delta === 0 ? "—"
                        : `${m.delta > 0 ? "▲" : "▼"}${Math.abs(m.delta).toFixed(2)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="panel-box info-card">
            <h3 className="mono">SELECTED</h3>
            {selected ? (
              <>
                <div style={{ fontSize: 13 }}>{selected.state}</div>
                <div className="big mono">
                  ${selected.price.toFixed(2)}
                  <Delta d={selected.delta} />
                </div>
                <div className="meta mono">
                  rank #{rankOf(selected.abbr)} of {sortedDesc.length}
                  <br />
                  {selected.source === "padd"
                    ? "regional (PADD) average"
                    : "state-level series"}
                </div>
              </>
            ) : (
              <div className="info-empty">
                click a state on the map or rankings
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="trend">
        <div className="trend-head">
          <div>
            <span className="trend-title">
              {selected ? selected.state : "National average"} · trend
            </span>
            <span className="trend-sub">
              {" "}
              {trendNote ? `— ${trendNote}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {compare.length > 0 && (
              <div className="chips">
                {compare.map((ab, i) => (
                  <span key={ab} className="chip mono">
                    <span className="dot" style={{ background: cmpColors[i] }} />
                    {ab}
                    <button onClick={() =>
                      setCompare((c) => c.filter((x) => x !== ab))
                    }>✕</button>
                  </span>
                ))}
              </div>
            )}
            <div className="pills">
              {RANGES.map((r) => (
                <button key={r.weeks}
                  className={`pill mono${range === r.weeks ? " on" : ""}`}
                  disabled={productDisabled}
                  onClick={() => setRange(r.weeks)}>
                  {r.label}
                </button>
              ))}
            </div>
            {selected && (
              <button className="trend-clear mono" onClick={backToUS}>
                ✕ national
              </button>
            )}
          </div>
        </div>

        {mode === "offline" ? (
          <div className="trend-empty mono">
            historical series unavailable in offline mode
          </div>
        ) : chartData.length === 0 ? (
          <div className="trend-empty mono">loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={chartData}
              margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={trendColor} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={trendColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={gridColor} strokeDasharray="3 6" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: dimColor }}
                tickLine={false} axisLine={false}
                interval={Math.max(0, Math.floor(chartData.length / 8) - 1)} />
              <YAxis tick={{ fontSize: 11, fill: dimColor }}
                tickLine={false} axisLine={false}
                domain={["dataMin - 0.1", "dataMax + 0.1"]}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
              <ReTooltip
                contentStyle={{
                  background: "var(--tip-bg)", border: "0.5px solid var(--border-strong)",
                  borderRadius: 8, fontSize: 13, fontFamily: "JetBrains Mono, monospace",
                }}
                labelStyle={{ color: "var(--text-dim)" }}
                formatter={(v: unknown, name: unknown) => [
                  v == null ? "—" : `$${Number(v).toFixed(2)}`,
                  String(name),
                ]}
              />
              {compare.length > 0 && (
                <Legend wrapperStyle={{ fontSize: 12, fontFamily: "JetBrains Mono, monospace" }} />
              )}
              <Area type="monotone" dataKey={baseKey}
                stroke={trendColor} strokeWidth={2}
                fill="url(#trendFill)" animationDuration={600}
                connectNulls />
              {compare.map((ab, i) => (
                <Line key={ab} type="monotone" dataKey={ab}
                  stroke={cmpColors[i]} strokeWidth={2} dot={false}
                  animationDuration={600} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {tip && (
        <div className="tooltip mono"
          style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function RankRow({
  s, i, active, onClick,
}: {
  s: StatePrice;
  i: number;
  active: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const d = s.delta;
  return (
    <div className={`rank-row${active ? " on" : ""}`} onClick={onClick}>
      <span className="rn mono">{i + 1}</span>
      <span className="st">{s.state}</span>
      <span className="pr mono">${s.price.toFixed(2)}</span>
      <span
        className={`dl mono ${
          d == null ? "na" : d > 0 ? "up" : d < 0 ? "down" : "na"
        }`}
      >
        {d == null ? "" : d === 0 ? "—" : `${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(2)}`}
      </span>
    </div>
  );
}
