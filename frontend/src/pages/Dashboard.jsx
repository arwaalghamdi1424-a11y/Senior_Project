import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCcw,
  CloudSun,
  Gauge,
  Flame,
  TriangleAlert,
  MapPin,
  Cpu,
  Info,
  RotateCcw,
  Loader2,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Line,
  BarChart,
  Bar,
  Legend,
  Label,
} from "recharts";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import ZoneDemandCanvas from "../components/ZoneDemandCanvas";
import TlcZoneMap from "../components/TlcZoneMap";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import brandLogo from "../assets/maseer-logo.jpg";
import {
  getDashboardSnapshot,
  getCityTrend,
  getBoroughTrend,
  getZoneHourHeatmap,
  getWeatherEventsTimeline,
  getTimestamps,
  getModels,
  getTaxiZonesGeoJson,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import { formatDecimal, formatNumber, isoToDisplay, pressureTierLabel, formatRatio } from "../lib/format";
import { buildDashboardInsightRail } from "../lib/insights";

const LOG = "[MASEER]";

const PROJECT_BLURB =
  "MASEER forecasts next-hour taxi demand pressure across NYC TLC taxi zones using taxi trip records, weather, and event/incident context. It supports monitoring, model comparison, and scenario analysis using demand-pressure proxies.";

const TEAM = [
  "Rahaf Saleh Aldhahri",
  "Anhar Mohammed Alansari",
  "Ghala Adel Alharbi",
  "Remas Fawaz Almaliki",
  "Arwa Ahmed Alghamdi",
];

const BOROUGH_PRESETS = [
  { value: "all", label: "All NYC" },
  { value: "Manhattan", label: "Manhattan" },
  { value: "Brooklyn", label: "Brooklyn" },
  { value: "Queens", label: "Queens" },
  { value: "Bronx", label: "Bronx" },
  { value: "Staten Island", label: "Staten Island" },
  { value: "EWR", label: "EWR" },
];

const MAP_METRICS = [
  { value: "ratio", label: "Pressure Ratio" },
  { value: "pickups", label: "Predicted Pickups" },
  { value: "incident", label: "Incident Context" },
];

const ZONE_HOURS = Array.from({ length: 24 }, (_, i) => i);
const HEATMAP_HOUR_TICKS = new Set([0, 4, 8, 12, 16, 20, 23]);

function isExcludedBoroughAggregate(name) {
  if (name == null) return true;
  const s = String(name).trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (lower === "unknown") return true;
  if (lower === "—" || lower === "-" || lower === "n/a") return true;
  return false;
}

function zoneHourHue(pr) {
  if (!Number.isFinite(pr)) return "rgb(229 231 235)";
  if (pr >= 1.35) return "rgb(180 35 24)";
  if (pr >= 1.15) return "rgb(247 183 49)";
  if (pr >= 0.85) return "rgb(110 231 183)";
  return "rgb(223 247 239)";
}

function ChartBodySkeleton() {
  return <div className="h-[280px] w-full min-w-0 animate-pulse rounded-lg bg-slate-100/90" aria-hidden />;
}

function DashboardChartSection({ title, subtitle, note, footnote, children, className = "", error }) {
  return (
    <section
      className={`flex min-h-[460px] flex-col rounded-xl border border-brand-border bg-white shadow-card ${className}`}
    >
      <div className="flex min-h-[76px] shrink-0 flex-col justify-center border-b border-brand-border px-4 py-3">
        <h3 className="font-semibold text-brand-text">{title}</h3>
        {subtitle ? <p className="mt-1 text-xs leading-relaxed text-brand-muted">{subtitle}</p> : null}
        {note ? <p className="mt-2 text-[11px] leading-snug text-brand-muted">{note}</p> : null}
        {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4 pt-3">{children}</div>
      {footnote ? (
        <div className="shrink-0 border-t border-brand-border/80 px-4 py-2 text-[11px] text-brand-muted">{footnote}</div>
      ) : null}
    </section>
  );
}

function ZoneHourHeatPanel({ rows = [], error }) {
  const zoneKeys = useMemo(() => {
    const ordered = [...rows].sort((a, b) => Number(b.value) - Number(a.value));
    return [...new Set(ordered.map((r) => String(r.zone_name ?? `Zone ${r.zone_id ?? ""}`)))].slice(0, 20);
  }, [rows]);

  const cellMap = useMemo(() => {
    const m = {};
    for (const r of rows) {
      const z = String(r.zone_name ?? `Zone ${r.zone_id ?? ""}`);
      const h = Number(r.hour);
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      const v = Number(r.value);
      if (!m[z]) m[z] = {};
      const prev = m[z][h];
      if (prev == null || (Number.isFinite(v) && v > prev)) m[z][h] = v;
    }
    return m;
  }, [rows]);

  if (error) {
    return (
      <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-lg border border-dashed border-brand-border bg-brand-bg/40 px-4 text-center text-sm text-brand-muted">
        Heatmap data is unavailable for the selected filters.
      </div>
    );
  }

  if (!zoneKeys.length) {
    return (
      <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-lg border border-dashed border-brand-border bg-brand-bg/40 px-4 text-center text-sm text-brand-muted">
        Heatmap data is unavailable for the selected filters.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-[420px] max-h-[520px] min-w-0 flex-1 overflow-auto rounded-lg border border-brand-border bg-white p-3">
        <div className="w-full min-w-[640px]">
          <div className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-brand-muted">Hour of day</div>
          <div className="grid w-full gap-1" style={{ gridTemplateColumns: `minmax(112px, 1.1fr) repeat(24, minmax(18px, 1fr))` }}>
            <div className="flex flex-col justify-end px-1 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-muted">Zone</span>
            </div>
            {ZONE_HOURS.map((h) => (
              <div key={`h-${h}`} className="pb-1 text-center text-[9px] font-semibold text-brand-muted">
                {HEATMAP_HOUR_TICKS.has(h) ? h : ""}
              </div>
            ))}
            {zoneKeys.map((z) => (
              <div key={z} className="contents">
                <div className="truncate px-1 py-1 text-[11px] font-medium text-brand-text" title={z}>
                  {z}
                </div>
                {ZONE_HOURS.map((h) => {
                  const pr = cellMap[z]?.[h];
                  return (
                    <div
                      key={`${z}-${h}`}
                      className="aspect-square min-h-[18px] min-w-[14px] rounded-[2px] border border-white/50"
                      style={{ backgroundColor: zoneHourHue(pr) }}
                      title={`${z} @ ${h}:00 — pressure ${Number.isFinite(pr) ? formatRatio(pr) : "N/A"}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-brand-muted">
        <span className="flex items-center gap-1 normal-case">
          <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: zoneHourHue(0.5) }} />
          Low
        </span>
        <span className="flex items-center gap-1 normal-case">
          <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: zoneHourHue(0.9) }} />
          Typical
        </span>
        <span className="flex items-center gap-1 normal-case">
          <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: zoneHourHue(1.2) }} />
          Elevated
        </span>
        <span className="flex items-center gap-1 normal-case">
          <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: zoneHourHue(1.4) }} />
          High
        </span>
      </div>
      <p className="mt-3 text-[11px] leading-snug text-brand-muted">
        This heatmap helps identify which zones repeatedly show higher demand pressure at specific hours.
      </p>
    </div>
  );
}

function rowIncidentContext(row) {
  if (!row) return false;
  if (Number(row.incident_flag) > 0) return true;
  if (Number(row.event_flag) > 0 || Number(row.event_active) > 0) return true;
  if (Number(row.road_closure_flag) > 0) return true;
  if (Number(row.zone_incident_count) > 0) return true;
  if (Number(row.citywide_incident_count) > 0) return true;
  const d = Number(row.disruption_score);
  if (Number.isFinite(d) && d > 0) return true;
  return false;
}

export default function Dashboard({ overview, refreshHealth, apiOnline }) {
  const [timestamps, setTimestamps] = useState([]);
  const [models, setModels] = useState([]);
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [borough, setBorough] = useState("all");
  const [pressureView, setPressureView] = useState("ratio");
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [snapshot, setSnapshot] = useState(null);
  const [city, setCity] = useState([]);
  const [boroughTrend, setBoroughTrend] = useState([]);
  const [heat, setHeat] = useState([]);
  const [fetchErrors, setFetchErrors] = useState({});
  const [geoJson, setGeoJson] = useState(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState(null);

  const snapshotRef = useRef(null);
  const cityRef = useRef([]);
  const boroughTrendRef = useRef([]);
  const heatRef = useRef([]);

  const allowStaticFallback = apiOnline !== true;

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    cityRef.current = city;
  }, [city]);
  useEffect(() => {
    boroughTrendRef.current = boroughTrend;
  }, [boroughTrend]);
  useEffect(() => {
    heatRef.current = heat;
  }, [heat]);

  useLayoutEffect(() => {
    if (apiOnline === null) return;

    const tsPeek = peekCachedApiUrl(apiUrl("timestamps"));
    if (tsPeek?.ok && Array.isArray(tsPeek.data?.timestamps)) {
      const raw = tsPeek.data.timestamps;
      const seen = new Set();
      const unique = [];
      for (const t of raw) {
        const s = String(t);
        if (seen.has(s)) continue;
        seen.add(s);
        unique.push(s);
      }
      setTimestamps(unique);
    }

    const mPeek = peekCachedApiUrl(apiUrl("models"));
    if (mPeek?.ok && Array.isArray(mPeek.data?.models)) {
      const opts = (mPeek.data.models ?? []).map(String);
      setModels(opts);
      setModel((prev) => {
        if (prev && opts.includes(prev)) return prev;
        if (opts.includes("XGBoost")) return "XGBoost";
        const def = mPeek.data.default_model ? String(mPeek.data.default_model) : "";
        if (def && opts.includes(def)) return def;
        return opts[0] ? String(opts[0]) : prev;
      });
    }

    const snapParams = new URLSearchParams();
    if (timestamp) snapParams.set("timestamp", timestamp);
    if (model) snapParams.set("model", model);
    const sq = snapParams.toString() ? `?${snapParams}` : "";
    const snapPeek = peekCachedApiUrl(apiUrl(`dashboard/snapshot${sq}`));
    if (snapPeek?.ok && snapPeek.data && Array.isArray(snapPeek.data.rows)) {
      setSnapshot(snapPeek.data);
    }

    const modelArg = model || undefined;
    const trendParams = new URLSearchParams();
    trendParams.set("hours", "168");
    if (modelArg) trendParams.set("model", modelArg);
    const ctPeek = peekCachedApiUrl(apiUrl(`city/trend?${trendParams}`));
    if (ctPeek?.ok && Array.isArray(ctPeek.data?.rows)) {
      setCity(ctPeek.data.rows);
    }
    const borPeek = peekCachedApiUrl(apiUrl(`borough/trend?${trendParams}`));
    if (borPeek?.ok && Array.isArray(borPeek.data?.rows)) {
      setBoroughTrend(borPeek.data.rows);
    }
    const hmParams = new URLSearchParams();
    hmParams.set("hours", "168");
    hmParams.set("top_n", "20");
    if (modelArg) hmParams.set("model", modelArg);
    hmParams.set("metric", "pressure_ratio");
    const hmPeek = peekCachedApiUrl(apiUrl(`heatmap/zone-hour?${hmParams}`));
    if (hmPeek?.ok && Array.isArray(hmPeek.data?.rows)) {
      setHeat(hmPeek.data.rows);
    }

    const geoPeek = peekCachedApiUrl(apiUrl("map/taxi-zones"));
    if (geoPeek?.ok && geoPeek.data?.features?.length) {
      setGeoJson(geoPeek.data);
      setGeoError(null);
      setGeoLoading(false);
    }
  }, [apiOnline, timestamp, model]);

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const tsRes = await getTimestamps({ allowStaticFallback });
      if (cancel) return;
      if (tsRes.ok === false) {
        console.warn(`${LOG} timestamps list failed:`, tsRes.error ?? "");
        if (apiOnline === true) setTimestamps([]);
        return;
      }
      const raw = tsRes.rows ?? [];
      const seen = new Set();
      const unique = [];
      for (const t of raw) {
        const s = String(t);
        if (seen.has(s)) continue;
        seen.add(s);
        unique.push(s);
      }
      console.info("[MASEER] timestamps loaded", unique.length, unique[0], unique[unique.length - 1]);
      setTimestamps(unique);
    })();
    return () => {
      cancel = true;
    };
  }, [apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const gm = await getModels({ allowStaticFallback });
      if (cancel) return;
      if (gm.ok === false) {
        console.warn(`${LOG} /api/models failed:`, gm.error ?? "");
        const fb = overview?.best_tabular_model;
        if (fb) {
          setModels([String(fb)]);
          setModel((prev) => prev || String(fb));
        }
        return;
      }
      const opts = (gm.models ?? []).map(String);
      setModels(opts);
      setModel((prev) => {
        if (prev && opts.includes(prev)) return prev;
        if (opts.includes("XGBoost")) return "XGBoost";
        const def = gm.default_model ? String(gm.default_model) : "";
        if (def && opts.includes(def)) return def;
        return opts[0] ? String(opts[0]) : "";
      });
    })();
    return () => {
      cancel = true;
    };
  }, [apiOnline, allowStaticFallback, overview?.best_tabular_model]);

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const geoHit = peekCachedApiUrl(apiUrl("map/taxi-zones"));
      if (geoHit?.ok && geoHit.data?.features?.length) {
        if (cancel) return;
        setGeoJson(geoHit.data);
        setGeoError(null);
        setGeoLoading(false);
        return;
      }
      setGeoLoading(true);
      const r = await getTaxiZonesGeoJson({ allowStaticFallback });
      if (cancel) return;
      if (r.ok && r.data?.features?.length) {
        setGeoJson(r.data);
        setGeoError(null);
      } else {
        setGeoJson(null);
        setGeoError(r.error || "GeoJSON unavailable");
      }
      setGeoLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [apiOnline, allowStaticFallback]);

  const loadSnapshotPanel = useCallback(async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    const hasSnapshot = snapshotRef.current != null;
    if (!hasSnapshot && !forceRefresh) setSnapshotLoading(true);
    try {
      const modelArg = model || undefined;
      const snapRes = await getDashboardSnapshot({
        timestamp: timestamp || undefined,
        model: modelArg,
        allowStaticFallback,
        forceRefresh,
      });

      setFetchErrors((prev) => {
        const n = { ...prev };
        if (snapRes.ok === false) {
          console.warn(`${LOG} dashboard panel failed [snapshot]:`, snapRes.error ?? "");
          n.snapshot = snapRes.error || "Request failed";
        } else delete n.snapshot;
        return n;
      });

      if (snapRes.ok !== false) setSnapshot(snapRes.data);
    } finally {
      setSnapshotLoading(false);
    }
  }, [timestamp, model, apiOnline, allowStaticFallback]);

  const loadAnalyticsPanels = useCallback(async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    const hasAny =
      (cityRef.current?.length ?? 0) > 0 ||
      (boroughTrendRef.current?.length ?? 0) > 0 ||
      (heatRef.current?.length ?? 0) > 0;
    if (!hasAny && !forceRefresh) setAnalyticsLoading(true);
    try {
      const modelArg = model || undefined;
      const [ct, bor, hm, wx] = await Promise.all([
        getCityTrend({ hours: 168, model: modelArg, allowStaticFallback, forceRefresh }),
        getBoroughTrend({ hours: 168, model: modelArg, allowStaticFallback, forceRefresh }),
        getZoneHourHeatmap({
          hours: 168,
          topN: 20,
          model: modelArg,
          metric: "pressure_ratio",
          allowStaticFallback,
          forceRefresh,
        }),
        getWeatherEventsTimeline({ hours: 168, allowStaticFallback, forceRefresh }),
      ]);

      setFetchErrors((prev) => {
        const n = { ...prev };
        const touch = (key, res) => {
          if (res.ok === false) {
            console.warn(`${LOG} dashboard panel failed [${key}]:`, res.error ?? "");
            n[key] = res.error || "Request failed";
          } else delete n[key];
        };
        touch("city", ct);
        touch("borough", bor);
        touch("heatmap", hm);
        touch("weather", wx);
        return n;
      });

      if (ct.ok !== false) setCity(ct.rows ?? []);
      if (bor.ok !== false) setBoroughTrend(bor.rows ?? []);
      if (hm.ok !== false) setHeat(hm.rows ?? []);
    } finally {
      setAnalyticsLoading(false);
    }
  }, [model, apiOnline, allowStaticFallback]);

  useEffect(() => {
    loadSnapshotPanel();
  }, [loadSnapshotPanel]);

  useEffect(() => {
    loadAnalyticsPanels();
  }, [loadAnalyticsPanels]);

  const loadBoard = useCallback(async ({ forceRefresh = false } = {}) => {
    await Promise.all([
      loadSnapshotPanel({ forceRefresh }),
      loadAnalyticsPanels({ forceRefresh }),
    ]);
  }, [loadSnapshotPanel, loadAnalyticsPanels]);

  /** API returns timestamps newest-first; default = latest. */
  const defaultTs = timestamps.length ? timestamps[0] : "";
  useEffect(() => {
    if (!timestamp && defaultTs) setTimestamp(defaultTs);
  }, [defaultTs, timestamp]);

  useEffect(() => {
    if (!timestamp || !timestamps.length) return;
    if (!timestamps.includes(timestamp)) setTimestamp(defaultTs || timestamps[0] || "");
  }, [timestamps, timestamp, defaultTs]);

  const rawRows = snapshot?.rows ?? [];

  const boroughOptions = useMemo(() => {
    const found = [...new Set(rawRows.map((r) => r.borough).filter(Boolean))];
    const opts = [{ value: "all", label: "All NYC" }];
    const presetVals = BOROUGH_PRESETS.slice(1).map((b) => b.value);
    for (const b of presetVals) {
      const hit = found.some((f) => String(f).toLowerCase() === b.toLowerCase());
      opts.push({
        value: b,
        label: hit ? b : `${b} (no rows in slice)`,
      });
    }
    for (const f of found.sort()) {
      if (!presetVals.some((p) => p.toLowerCase() === String(f).toLowerCase()))
        opts.push({ value: f, label: String(f) });
    }
    return opts;
  }, [rawRows]);

  const filteredRows = useMemo(() => {
    if (borough === "all") return rawRows;
    return rawRows.filter((r) => String(r.borough).toLowerCase() === borough.toLowerCase());
  }, [rawRows, borough]);

  const peakBoroughMeta = useMemo(() => {
    const by = {};
    for (const r of filteredRows) {
      if (isExcludedBoroughAggregate(r.borough)) continue;
      const name = String(r.borough).trim();
      if (!by[name]) by[name] = { ratios: [], preds: [] };
      const pr = Number(r.pressure_ratio ?? r.observed_pressure_ratio);
      if (Number.isFinite(pr)) by[name].ratios.push(pr);
      const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
      if (Number.isFinite(p)) by[name].preds.push(p);
    }
    const candidates = Object.entries(by).map(([name, v]) => {
      const avgR = v.ratios.length ? v.ratios.reduce((a, x) => a + x, 0) / v.ratios.length : null;
      const sumP = v.preds.reduce((a, x) => a + x, 0);
      return { name, avgR, sumP };
    }).filter((c) => (c.avgR != null && Number.isFinite(c.avgR)) || (Number.isFinite(c.sumP) && c.sumP > 0));

    if (!candidates.length) {
      return {
        kpiValue: "Not available",
        kpiSub: "Borough signal unavailable for selected snapshot.",
        insightName: null,
      };
    }

    candidates.sort((a, b) => {
      const hasA = a.avgR != null;
      const hasB = b.avgR != null;
      if (hasA && hasB && b.avgR !== a.avgR) return b.avgR - a.avgR;
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      if (hasA && hasB && b.avgR === a.avgR) return b.sumP - a.sumP;
      return b.sumP - a.sumP;
    });

    const winner = candidates[0];
    return {
      kpiValue: winner.name,
      kpiSub: "Borough with the strongest average demand-pressure ratio in the selected snapshot.",
      insightName: winner.name,
    };
  }, [filteredRows]);

  const insightCards = useMemo(
    () => buildDashboardInsightRail(snapshot, filteredRows, peakBoroughMeta.insightName),
    [snapshot, filteredRows, peakBoroughMeta.insightName]
  );

  const totalPredicted = useMemo(() => {
    const s =
      snapshot?.summary?.citywide_predicted_next_hour_pickups ??
      snapshot?.summary?.total_predicted_next_hour_pickups;
    if (borough === "all" && Number.isFinite(Number(s))) return Number(s);
    let sum = 0;
    let n = 0;
    for (const r of filteredRows) {
      const v = Number(
        r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour ?? r.observed_next_hour_pickups
      );
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n ? sum : null;
  }, [snapshot, filteredRows, borough]);

  const highPressureCount = useMemo(
    () =>
      filteredRows.filter((r) => Number(r.pressure_ratio ?? r.observed_pressure_ratio) >= 1.35).length,
    [filteredRows]
  );

  const incidentContextCount = useMemo(
    () => filteredRows.filter((r) => rowIncidentContext(r)).length,
    [filteredRows]
  );

  const weatherHeadline = useMemo(() => {
    const cats = filteredRows.map((r) => r.weather_category).filter(Boolean);
    if (!cats.length)
      return snapshot?.summary?.weather_status ?? overview?.subtitle?.slice(0, 48) ?? "N/A";
    const counts = {};
    for (const c of cats) counts[c] = (counts[c] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? String(cats[0]);
  }, [filteredRows, snapshot, overview]);

  const cityChartFull = useMemo(() => {
    return (city ?? []).map((r) => ({
      t: isoToDisplay(r.timestamp, ""),
      pickups: Number(r.pickup_count_sum),
      predicted: Number(r.predicted_next_hour_sum),
      highPz: Number(r.high_pressure_zones ?? 0),
    }));
  }, [city]);

  const boroughBars = useMemo(() => {
    const selectedSnapTs = snapshot?.summary?.timestamp;
    const validTrend = (boroughTrend ?? []).filter((r) => !isExcludedBoroughAggregate(r.borough));
    const orderedTs = [...new Set(validTrend.map((r) => String(r.timestamp)))].sort();
    const latestTrendTs = orderedTs.length ? orderedTs[orderedTs.length - 1] : null;
    let targetTs = latestTrendTs;
    if (
      selectedSnapTs &&
      validTrend.some((r) => String(r.timestamp) === String(selectedSnapTs))
    ) {
      targetTs = String(selectedSnapTs);
    }
    let slice = targetTs ? validTrend.filter((r) => String(r.timestamp) === targetTs) : [];

    if (!slice.length && filteredRows.length) {
      const m = {};
      for (const row of filteredRows) {
        if (isExcludedBoroughAggregate(row.borough)) continue;
        const b = String(row.borough).trim();
        if (!m[b]) m[b] = { sumR: 0, n: 0, pred: 0 };
        const pr = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
        if (Number.isFinite(pr)) {
          m[b].sumR += pr;
          m[b].n++;
        }
        const p = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
        if (Number.isFinite(p)) m[b].pred += p;
      }
      return Object.entries(m)
        .filter(([, v]) => v.n > 0 || v.pred > 0)
        .map(([name, v]) => ({
          name,
          ratio: v.n ? v.sumR / v.n : 0,
          pred: v.pred,
        }));
    }
    const agg = {};
    for (const r of slice) {
      if (isExcludedBoroughAggregate(r.borough)) continue;
      const b = String(r.borough).trim();
      if (!agg[b]) agg[b] = { sum: 0, n: 0, pred: 0 };
      const pr = Number(r.average_pressure_ratio ?? r.avg_pressure_ratio ?? r.pressure_ratio);
      if (Number.isFinite(pr)) {
        agg[b].sum += pr;
        agg[b].n++;
      }
      agg[b].pred += Number(r.predicted_next_hour_sum ?? r.pickup_count_sum ?? 0);
    }
    return Object.entries(agg)
      .filter(([, v]) => v.n > 0 || v.pred > 0)
      .map(([name, v]) => ({
        name,
        ratio: v.n ? v.sum / v.n : 0,
        pred: v.pred,
      }));
  }, [boroughTrend, snapshot, filteredRows]);

  const heatFiltered = useMemo(() => {
    if (borough === "all") return heat;
    const allowed = new Set(filteredRows.map((r) => String(r.zone_id)));
    return heat.filter((h) => allowed.has(String(h.zone_id)));
  }, [heat, borough, filteredRows]);

  const tablePressure = useMemo(() => {
    return [...filteredRows]
      .filter((r) => r.zone_name || r.zone_id != null)
      .sort((a, b) => Number(b.pressure_ratio ?? 0) - Number(a.pressure_ratio ?? 0))
      .slice(0, 25);
  }, [filteredRows]);

  const tablePickup = useMemo(() => {
    return [...filteredRows]
      .filter((r) => r.zone_name || r.zone_id != null)
      .sort(
        (a, b) =>
          Number(b.predicted_next_hour_pickups ?? b.target_pickup_count_next_hour ?? 0) -
          Number(a.predicted_next_hour_pickups ?? a.target_pickup_count_next_hour ?? 0)
      )
      .slice(0, 25);
  }, [filteredRows]);

  const resetFilters = () => {
    setBorough("all");
    setPressureView("ratio");
    if (defaultTs) setTimestamp(defaultTs);
    if (models.includes("XGBoost")) setModel("XGBoost");
    else if (models[0]) setModel(String(models[0]));
  };

  const cityChartReady = cityChartFull.length >= 2;

  const awaitingSnapshot = snapshotLoading && snapshot == null && !fetchErrors.snapshot;
  const mapSnapshotLoading = Boolean(geoJson?.features?.length) && awaitingSnapshot;
  const refreshing = snapshotLoading && snapshot != null;
  const showCitySkeleton = analyticsLoading && city.length === 0 && !fetchErrors.city;
  const showBoroughSkeleton = analyticsLoading && boroughTrend.length === 0 && !fetchErrors.borough;
  const showHeatSkeleton = analyticsLoading && heat.length === 0 && !fetchErrors.heatmap;

  const boroughLabelForMap = BOROUGH_PRESETS.find((b) => b.value === borough)?.label ?? borough;
  const mapMetricLabel = MAP_METRICS.find((p) => p.value === pressureView)?.label ?? "Metric";
  const modelLabelForMap = model || snapshot?.model_name || "—";
  const snapshotLabelForMap = isoToDisplay(snapshot?.summary?.timestamp ?? timestamp, "—");

  return (
    <div className="space-y-5 pb-6">
      <section className="overflow-hidden rounded-2xl border border-brand-border bg-white shadow-card">
        <div className="grid gap-6 p-6 lg:grid-cols-[1fr_300px] lg:items-start">
          <div>
            <div className="flex flex-wrap items-start gap-4">
              <img
                src={brandLogo}
                alt="MASEER"
                className="h-[72px] w-[72px] shrink-0 rounded-2xl object-cover shadow-md ring-2 ring-brand-mint/90"
              />
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-primary">Main Dashboard</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-brand-text sm:text-[1.85rem]">
                  NYC Taxi Demand Pressure Forecasting
                </h1>
                <p className="mt-3 max-w-[48rem] text-sm leading-relaxed text-brand-muted">{PROJECT_BLURB}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-brand-border bg-gradient-to-br from-brand-mint/60 to-white p-4 shadow-inner">
            <div className="text-xs font-bold uppercase tracking-wide text-brand-deep">Team MASEER — Data Science Students</div>
            <ul className="mt-3 space-y-1.5 text-[13px] leading-snug text-brand-text">
              {TEAM.map((name) => (
                <li key={name} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-primary/80" />
                  <span className="break-words">{name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-brand-border bg-white px-4 py-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xs font-bold uppercase tracking-wide text-brand-muted">Controls</h2>
            <p className="mt-1 max-w-[52rem] text-[11px] leading-relaxed text-brand-muted">
              Selected snapshot:{" "}
              <span className="font-medium text-brand-text">
                {isoToDisplay(snapshot?.summary?.timestamp ?? timestamp, "—")}
              </span>
              {" · "}
              Forecast target variable:{" "}
              <code className="rounded bg-brand-bg px-1 py-0.5 font-mono text-[10px] text-brand-text">
                target_pickup_count_next_hour
              </code>
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {refreshing ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-mint/50 px-2 py-0.5 text-[11px] font-semibold text-brand-deep">
                <Loader2 className="h-3 w-3 animate-spin" />
                Updating…
              </span>
            ) : null}
            <GlassButton onClick={resetFilters}>
              <RotateCcw size={16} strokeWidth={1.75} />
              Reset filters
            </GlassButton>
            <button
              type="button"
              onClick={() => {
                refreshHealth?.({ forceRefresh: true });
                loadBoard({ forceRefresh: true });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border bg-white px-2 py-1 text-[11px] font-medium text-brand-muted shadow-sm transition-colors hover:border-brand-primary/35 hover:text-brand-text"
            >
              <RefreshCcw size={13} strokeWidth={1.75} />
              Update view
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Snapshot timestamp"
            value={timestamp}
            onChange={setTimestamp}
            options={(timestamps ?? []).map((t) => ({ value: t, label: isoToDisplay(t, t) }))}
            placeholder={timestamps.length ? "Select time" : "Loading timestamps…"}
          />
          <SelectField
            label="Selected forecasting model"
            value={model}
            onChange={setModel}
            options={models.map((m) => ({ value: m, label: m }))}
            placeholder="Select model"
          />
          <SelectField label="Borough filter" value={borough} onChange={setBorough} options={boroughOptions} />
        </div>
        {apiOnline === true && timestamps.length <= 1 ? (
          <p className="mt-3 text-xs text-amber-800">
            Only one timestamp was loaded. Check{" "}
            <code className="rounded bg-brand-bg px-1 py-0.5 font-mono text-[10px]">/api/timestamps</code>.
          </p>
        ) : null}
      </section>

      <div className="flex gap-3 rounded-xl border border-brand-border bg-gradient-to-r from-brand-mint/35 via-white to-brand-bg px-4 py-3 shadow-sm">
        <Info className="mt-0.5 shrink-0 text-brand-primary" size={18} />
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-wide text-brand-primary">What does demand pressure mean?</div>
          <p className="mt-1 text-[13px] leading-relaxed text-brand-muted">
            <span className="font-mono text-[11px] text-brand-text">target_pickup_count_next_hour</span> is the next-hour TLC pickup
            count. Demand-pressure ratio is predicted next-hour pickups divided by the rolling 24-hour pickup mean for the zone — a
            waiting-pressure / demand-pressure proxy, not observed passenger waiting time.
          </p>
        </div>
      </div>

      <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {awaitingSnapshot ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`kpi-sk-${i}`}
                  className="h-[92px] animate-pulse rounded-xl border border-brand-border bg-slate-100/85"
                  aria-hidden
                />
              ))
            ) : (
              <>
                <KpiCard
                  icon={Gauge}
                  accent="teal"
                  label="Predicted Next-Hour Pickups"
                  value={totalPredicted != null ? formatNumber(totalPredicted, 0) : "N/A"}
                  subtext="Citywide predicted pickup demand for the selected snapshot."
                />
                <KpiCard
                  icon={Flame}
                  accent={highPressureCount > 0 ? "danger" : "teal"}
                  label="High-Pressure Zones"
                  value={formatNumber(highPressureCount, 0)}
                  subtext="Zones with pressure ratio ≥ 1.35."
                />
                <KpiCard
                  icon={TriangleAlert}
                  accent="warn"
                  label="Active Incident Context"
                  value={formatNumber(incidentContextCount, 0)}
                  subtext="Rows with event, incident, closure, or disruption signals."
                />
                <KpiCard
                  icon={CloudSun}
                  accent="mint"
                  label="Weather Snapshot"
                  value={typeof weatherHeadline === "string" ? weatherHeadline : "N/A"}
                  subtext="Average weather signal in the selected snapshot."
                />
                <KpiCard
                  icon={MapPin}
                  accent="neutral"
                  label="Peak Borough"
                  value={peakBoroughMeta.kpiValue}
                  subtext={peakBoroughMeta.kpiSub}
                />
                <KpiCard
                  icon={Cpu}
                  accent="teal"
                  label="Selected Model"
                  value={model || snapshot?.model_name || "—"}
                  subtext="Forecasting model used for the current dashboard view."
                />
              </>
            )}
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] lg:items-start">
            <section className="overflow-hidden rounded-2xl border border-brand-border bg-white shadow-card ring-1 ring-brand-primary/15">
              <div className="flex flex-col gap-3 border-b border-brand-border px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-brand-text">NYC TLC Zone Demand Pressure Map</h3>
                  <p className="mt-1.5 text-xs leading-snug text-brand-text">
                    Map view: {mapMetricLabel} • {boroughLabelForMap} • {modelLabelForMap} • {snapshotLabelForMap}
                  </p>
                  <p className="mt-1 text-[11px] text-brand-muted">
                    Changing <span className="font-medium text-brand-text">Map metric</span> updates zone colors; borough and
                    snapshot filters narrow which rows feed the map.
                  </p>
                </div>
                <div className="shrink-0 sm:w-[min(100%,220px)]">
                  <SelectField label="Map metric" value={pressureView} onChange={setPressureView} options={MAP_METRICS} />
                </div>
              </div>
              <div className="p-4">
                {fetchErrors.snapshot ? (
                  <p className="mb-3 text-xs text-rose-600">Could not load snapshot for this selection.</p>
                ) : null}
                {geoJson?.features?.length ? (
                  <TlcZoneMap
                    geojson={geoJson}
                    rows={filteredRows}
                    mapMetric={pressureView}
                    loading={mapSnapshotLoading}
                  />
                ) : geoLoading ? (
                  <div className="flex h-[480px] items-center justify-center rounded-xl border border-dashed border-brand-border bg-brand-mint/20 text-sm font-medium text-brand-muted">
                    Loading TLC zone map…
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-brand-text">
                      TLC zone geometry unavailable. Showing schematic demand panel.
                    </p>
                    {geoError && apiOnline === true ? (
                      <p className="text-xs text-brand-muted">Detail: {geoError}</p>
                    ) : null}
                    <ZoneDemandCanvas rows={filteredRows} pressureView={pressureView} boroughFilter={borough} />
                  </div>
                )}
              </div>
            </section>

            <div className="flex min-w-0 flex-col gap-3">
              <div className="rounded-xl border border-brand-border bg-gradient-to-br from-brand-mint/50 to-white px-4 py-3 shadow-card">
                <h3 className="text-sm font-semibold text-brand-text">AI Insights &amp; Recommendations</h3>
                <p className="mt-1 text-[11px] leading-snug text-brand-muted">
                  Demand-pressure proxies from TLC pickups — not direct passenger waiting times.
                </p>
              </div>
              <div className="grid max-h-[520px] gap-3 overflow-y-auto pr-1">
                {insightCards.map((card, idx) => (
                  <div
                    key={`${card.title}-${idx}`}
                    className="rounded-xl border border-brand-border bg-white p-4 shadow-card transition-shadow hover:shadow-soft"
                  >
                    <div className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">{card.title}</div>
                    <p className="mt-2 text-[13px] leading-relaxed text-brand-muted">{card.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6">
            <DashboardChartSection
              title="City Demand Trend"
              subtitle="Hourly citywide pickup demand signal across the selected 168-hour window."
              note="Pickup count sum = observed TLC pickups in that hour. Predicted next-hour sum = model prediction for next-hour demand. High-pressure zones = number of zones with pressure ratio ≥ 1.35."
              className="w-full min-w-0"
              error={fetchErrors.city ? "City trend data unavailable." : undefined}
              footnote={
                fetchErrors.weather ? (
                  <span className="text-amber-800">Incident-style timeline unavailable for this window.</span>
                ) : null
              }
            >
              {showCitySkeleton ? (
                <ChartBodySkeleton />
              ) : cityChartReady ? (
                <>
                  <div className="h-[400px] w-full min-w-0 shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={cityChartFull}>
                        <defs>
                          <linearGradient id="dashPickupsCity" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#94a3b8" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="dashPredCity" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#008B78" stopOpacity={0.4} />
                            <stop offset="100%" stopColor="#008B78" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                        <XAxis dataKey="t" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                        <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Area
                          yAxisId="left"
                          type="monotone"
                          dataKey="pickups"
                          name="Observed pickups"
                          stroke="#64748b"
                          fill="url(#dashPickupsCity)"
                        />
                        <Area
                          yAxisId="left"
                          type="monotone"
                          dataKey="predicted"
                          name="Predicted next-hour pickups"
                          stroke="#008B78"
                          fill="url(#dashPredCity)"
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="highPz"
                          name="High-pressure zones"
                          stroke="#F7B731"
                          dot={false}
                          strokeWidth={2}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <div className="flex min-h-[360px] flex-col justify-center space-y-3">
                  <p className="text-sm text-brand-muted">Not enough city trend points to chart — showing recent rows instead.</p>
                  <DataTable
                    columns={[
                      { key: "t", label: "Time" },
                      { key: "pickups", label: "Pickup sum", render: (v) => formatNumber(v, 0) },
                      { key: "predicted", label: "Predicted sum", render: (v) => formatNumber(v, 0) },
                    ]}
                    rows={cityChartFull.slice(-12)}
                    maxRows={16}
                  />
                </div>
              )}
            </DashboardChartSection>

            <DashboardChartSection
              title="Borough Pressure Comparison"
              subtitle="Average demand-pressure ratio by borough for the snapshot hour when it appears in the 168-hour trend; otherwise the latest hour available in that trend."
              note="Used to identify which borough has the strongest relative demand compared with its recent baseline."
              className="w-full min-w-0"
              error={fetchErrors.borough ? "Borough comparison is unavailable for the selected filters." : undefined}
            >
              {showBoroughSkeleton ? (
                <ChartBodySkeleton />
              ) : boroughBars.length ? (
                <div className="h-[350px] min-h-[320px] w-full min-w-0 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={boroughBars} layout="vertical" margin={{ left: 4, bottom: 28 }}>
                      <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                      <XAxis type="number" tickFormatter={(v) => `${formatDecimal(v, 2)}×`}>
                        <Label value="Pressure ratio ×" offset={-4} position="insideBottom" style={{ fontSize: 11, fill: "#64748b" }} />
                      </XAxis>
                      <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10 }} />
                      <Tooltip
                        content={({ payload }) => {
                          const p = payload?.[0]?.payload;
                          if (!p) return null;
                          return (
                            <div className="rounded-lg border border-brand-border bg-white px-3 py-2 text-xs shadow-card">
                              <div className="font-semibold text-brand-text">{p.name}</div>
                              <div className="mt-1 text-brand-muted">
                                Average demand-pressure ratio:{" "}
                                <span className="font-medium text-brand-text">{formatDecimal(p.ratio, 2)}×</span>
                              </div>
                              <div className="text-brand-muted">
                                Predicted next-hour sum:{" "}
                                <span className="font-medium text-brand-text">{formatNumber(p.pred, 0)}</span>
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="ratio" fill="#008B78" radius={[0, 6, 6, 0]} name="Avg demand-pressure ratio" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex min-h-[280px] flex-1 items-center justify-center px-4 text-center text-sm text-brand-muted">
                  Borough comparison is unavailable for the selected filters.
                </div>
              )}
            </DashboardChartSection>

            <DashboardChartSection
              title="Zone-Hour Demand Pressure Heatmap"
              subtitle="Rows represent high-priority TLC zones. Columns represent hour-of-day buckets. Cell color shows the pressure level during the selected 168-hour window."
              footnote="Demand-pressure levels follow the same ratio bands as elsewhere on the dashboard (Low / Typical / Elevated / High)."
              className="w-full min-w-0"
            >
              {showHeatSkeleton ? (
                <ChartBodySkeleton />
              ) : (
                <ZoneHourHeatPanel rows={heatFiltered.length ? heatFiltered : heat} error={fetchErrors.heatmap} />
              )}
            </DashboardChartSection>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Top Pressure Zones" subtitle="Highest demand-pressure ratio in current filters">
              <div className="max-h-[320px] overflow-auto rounded-lg border border-brand-border">
                <DataTable
                  columns={[
                    { key: "__rank", label: "Rank" },
                    { key: "zone_name", label: "Zone" },
                    { key: "borough", label: "Borough" },
                    {
                      key: "predicted_next_hour_pickups",
                      label: "Predicted Pickups",
                      render: (v, row) =>
                        formatNumber(v ?? row.target_pickup_count_next_hour ?? row.observed_next_hour_pickups, 0),
                    },
                    {
                      key: "pickup_count_roll_mean_24",
                      label: "Rolling 24h Mean",
                      render: (v) => formatDecimal(v, 2),
                    },
                    {
                      key: "pressure_ratio",
                      label: "Pressure Ratio",
                      render: (v, row) => formatRatio(v ?? row.observed_pressure_ratio),
                    },
                    {
                      key: "pressure_label",
                      label: "Label",
                      render: (_, row) =>
                        pressureTierLabel(Number(row.pressure_ratio ?? row.observed_pressure_ratio)),
                    },
                  ]}
                  rows={tablePressure.map((row, i) => ({ ...row, __rank: i + 1 }))}
                  maxRows={50}
                />
              </div>
            </SectionCard>

            <SectionCard title="Top Predicted Pickup Zones" subtitle="Highest predicted next-hour pickups in current filters">
              <div className="max-h-[320px] overflow-auto rounded-lg border border-brand-border">
                <DataTable
                  columns={[
                    { key: "__rank", label: "Rank" },
                    { key: "zone_name", label: "Zone" },
                    { key: "borough", label: "Borough" },
                    {
                      key: "predicted_next_hour_pickups",
                      label: "Predicted Pickups",
                      render: (v, row) =>
                        formatNumber(v ?? row.target_pickup_count_next_hour ?? row.observed_next_hour_pickups, 0),
                    },
                    {
                      key: "_inc",
                      label: "Incident Context",
                      render: (_, row) =>
                        rowIncidentContext(row)
                          ? `Active (${formatNumber(row.zone_incident_count, 0)} zone incidents)`
                          : "Quiet",
                    },
                    {
                      key: "weather_category",
                      label: "Weather",
                      render: (v, row) => v ?? row.weather_status ?? "—",
                    },
                  ]}
                  rows={tablePickup.map((row, i) => ({ ...row, __rank: i + 1 }))}
                  maxRows={50}
                />
              </div>
            </SectionCard>
          </div>
      </>
    </div>
  );
}
