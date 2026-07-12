// Backend API layer. Override the backend URL with VITE_API_URL, such as a
// tunnel URL during deployment.
export type Product = "EPMR" | "EPMM" | "EPMP" | "EPD2D";
export const PRODUCTS: { code: Product; label: string }[] = [
  { code: "EPMR", label: "regular" },
  { code: "EPMM", label: "midgrade" },
  { code: "EPMP", label: "premium" },
  { code: "EPD2D", label: "diesel" },
];

export interface StatePrice {
  state: string;
  abbr: string;
  price: number;
  delta?: number | null; // Week-over-week delta; offline snapshots omit it.
  source: "state" | "padd";
}
export interface LatestResponse {
  period: string;
  national: number | null;
  national_delta?: number | null;
  states: StatePrice[];
}
export interface SeriesPoint {
  period: string;
  price: number;
}
export interface CityPrice {
  duoarea: string;
  name: string;
  price: number;
  delta?: number | null;
}
export interface CitiesResponse {
  period: string | null;
  cities: CityPrice[];
}
export interface MetroPrice {
  name: string;
  price: number;
  delta?: number | null;
}
export interface MetrosResponse {
  period: string | null;
  state: string;
  metros: MetroPrice[];
}
export interface CountyPrice {
  county: string;
  price: number;
}
export interface CountiesResponse {
  period: string | null;
  state: string;
  counties: CountyPrice[];
}
export interface HistoryResponse {
  area: string;
  abbr?: string;
  source?: string;
  series: SeriesPoint[];
}

const API_BASE: string =
  ((import.meta as any).env?.VITE_API_URL as string | undefined) ??
  "http://localhost:8000";

async function get<T>(path: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () =>
    get<{ status: string; latest_period: string | null }>("/api/health", 3000),
  latest: (product: Product = "EPMR") =>
    get<LatestResponse>(`/api/prices/latest?product=${product}`),
  cities: (product: Product = "EPMR") =>
    get<CitiesResponse>(`/api/prices/cities?product=${product}`),
  counties: (abbr: string) =>
    get<CountiesResponse>(`/api/prices/counties/${abbr}`, 15000),
  metros: (abbr: string, product: Product = "EPMR") =>
    get<MetrosResponse>(
      `/api/prices/metros/${abbr}?product=${product}`, 15000
    ), // First access to a state can trigger a backend fetch, so allow more time.
  nationalHistory: (weeks = 52, product: Product = "EPMR") =>
    get<HistoryResponse>(`/api/prices/history?weeks=${weeks}&product=${product}`),
  stateHistory: (abbr: string, weeks = 52, product: Product = "EPMR") =>
    get<HistoryResponse>(
      `/api/prices/state/${abbr}?weeks=${weeks}&product=${product}`
    ),
};
