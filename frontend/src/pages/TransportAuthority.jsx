import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCcw,
  Shield,
  MapPinned,
  TriangleAlert,
  Clock3,
  Activity,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import HeatPanel from "../components/HeatPanel";
import InsightCard from "../components/InsightCard";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import {
  getDashboardSnapshot,
  getBoroughTrend,
  getCityTrend,
  getWeatherEventsTimeline,
  getTimestamps,
  getModelMetrics,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import { formatDecimal, formatNumber, formatRatio, isoToDisplay, pressureLabel } from "../lib/format";

const LOG = "[MASEER]";

function peakWindow(rows, window = 3) {
  if (!rows?.length) return "N/A";
  const slice = rows.slice(-Math.min(rows.length, 168));
  let bestAvg = -1;
  let bestIdx = 0;
  for (let i = 0; i <= slice.length - window; i++) {
    let acc = 0;
    let n = 0;
    for (let j = 0; j < window; j++) {
      const v = Number(slice[i + j].total_next_hour_target ?? slice[i + j].total_pickups ?? 0);
      if (Number.isFinite(v)) {
        acc += v;
        n++;
      }
    }
    const avg = n ? acc / n : 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIdx = i;
    }
  }
  const mid = slice[bestIdx + Math.floor(window / 2)];
  if (!mid?.timestamp) return "N/A";
  const center = new Date(mid.timestamp).getHours();
  const fmt = (h) =>
    new Date(2020, 0, 1, (h + 24) % 24).toLocaleString(undefined, { hour: "numeric", hour12: true });
  return `${fmt(center - 1)} – ${fmt(center + 1)}`;
}

function latestBoroughSlice(rows) {
  const stamps = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort();
  const last = stamps.at(-1);
  if (!last) return [];
  return rows.filter((r) => r.timestamp === last);
}

export default function TransportAuthority({ overview, refreshHealth, apiOnline }) {
  const subtitle =
    "Government-style monitoring of citywide demand-pressure context, incidents, and borough-level stress — no fleet availability data.";

  const [timestamps, setTimestamps] = useState([]);
  const [models, setModels] = useState([]);
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [borough, setBorough] = useState([]);
  const [city, setCity] = useState([]);
  const [wx, setWx] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchErrors, setFetchErrors] = useState({});
  const snapshotRef = useRef(null);

  const allowStaticFallback = apiOnline !== true;

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const snapParams = new URLSearchParams();
    if (timestamp) snapParams.set("timestamp", timestamp);
    if (model) snapParams.set("model", model);
    const sq = snapParams.toString() ? `?${snapParams}` : "";
    const snPeek = peekCachedApiUrl(apiUrl(`dashboard/snapshot${sq}`));
    if (snPeek?.ok && snPeek.data && Array.isArray(snPeek.data.rows)) {
      setSnapshot(snPeek.data);
    }
    const trendParams = new URLSearchParams();
    trendParams.set("hours", "168");
    if (model) trendParams.set("model", model);
    const borPeek = peekCachedApiUrl(apiUrl(`borough/trend?${trendParams}`));
    if (borPeek?.ok && Array.isArray(borPeek.data?.rows)) {
      setBorough(borPeek.data.rows);
    }
    const ctPeek = peekCachedApiUrl(apiUrl(`city/trend?${trendParams}`));
    if (ctPeek?.ok && Array.isArray(ctPeek.data?.rows)) {
      setCity(ctPeek.data.rows);
    }
    const wxPeek = peekCachedApiUrl(apiUrl(`city/trend?${trendParams}`));
    if (wxPeek?.ok && Array.isArray(wxPeek.data?.rows)) {
      setWx(
        wxPeek.data.rows.map((row) => ({
          timestamp: row.timestamp,
          temperature: row.temperature,
          precipitation: row.precipitation,
          snowfall: row.snowfall,
          wind_speed: row.wind_speed,
          humidity: row.humidity,
          weather_status: row.weather_status,
          total_zone_incidents: row.incident_count_sum ?? row.citywide_incident_count ?? null,
          citywide_incident_count: row.citywide_incident_count,
          avg_event_intensity_score: row.avg_event_intensity_score,
          avg_disruption_score: row.avg_disruption_score,
        }))
      );
    }
  }, [apiOnline, timestamp, model]);

  useEffect(() => {
    if (apiOnline === null) return;
    (async () => {
      const [tsRes, mm] = await Promise.all([
        getTimestamps({ allowStaticFallback }),
        getModelMetrics({ allowStaticFallback }),
      ]);
      if (tsRes.ok !== false) setTimestamps(tsRes.rows ?? []);
      else console.warn(`${LOG} transport timestamps:`, tsRes.error);
      if (mm.ok === false) {
        console.warn(`${LOG} transport model metrics:`, mm.error);
        return;
      }
      const names = [...new Set((mm.data?.model_metrics ?? []).map((m) => m.model_name).filter(Boolean))];
      const opts = [...new Set([mm.data?.best_tabular_model, overview?.best_tabular_model, ...names].filter(Boolean))];
      setModels(opts);
      setModel((p) => p || String(opts[0] || ""));
    })();
  }, [overview?.best_tabular_model, apiOnline, allowStaticFallback]);

  const load = useCallback(async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    if (!snapshotRef.current && !forceRefresh) setLoading(true);
    try {
      const [sn, bor, ct, wl] = await Promise.all([
        getDashboardSnapshot({
          timestamp: timestamp || undefined,
          model: model || undefined,
          allowStaticFallback,
          forceRefresh,
        }),
        getBoroughTrend({ hours: 168, allowStaticFallback, forceRefresh }),
        getCityTrend({ hours: 168, allowStaticFallback, forceRefresh }),
        getWeatherEventsTimeline({ hours: 168, allowStaticFallback, forceRefresh }),
      ]);
      setFetchErrors((prev) => {
        const n = { ...prev };
        const touch = (key, res) => {
          if (res.ok === false) {
            console.warn(`${LOG} transport panel [${key}]:`, res.error);
            n[key] = res.error || "Failed";
          } else delete n[key];
        };
        touch("snapshot", sn);
        touch("borough", bor);
        touch("city", ct);
        touch("weather", wl);
        return n;
      });
      if (sn.ok !== false) setSnapshot(sn.data);
      if (bor.ok !== false) setBorough(bor.rows ?? []);
      if (ct.ok !== false) setCity(ct.rows ?? []);
      if (wl.ok !== false) setWx(wl.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [timestamp, model, apiOnline, allowStaticFallback]);

  useEffect(() => {
    load();
  }, [load]);

  const defaultTs = timestamps.length ? timestamps[timestamps.length - 1] : "";
  useEffect(() => {
    if (!timestamp && defaultTs) setTimestamp(defaultTs);
  }, [defaultTs, timestamp]);

  const rows = snapshot?.rows ?? [];

  const maxRatio = snapshot?.summary?.max_pressure_zone?.pressure_ratio;
  const cityPressureLabel =
    snapshot?.summary?.max_pressure_zone?.pressure_label ??
    pressureLabel(Number(maxRatio)) ??
    "Unavailable";

  const boroughBars = useMemo(() => {
    const slice = latestBoroughSlice(borough);
    return slice.map((r) => ({
      name: r.borough ?? "—",
      ratio: Number(r.avg_pressure_ratio ?? 0),
      pickups: Number(r.pickup_count ?? 0),
    }));
  }, [borough]);

  const incidentLine = useMemo(
    () =>
      (wx ?? []).slice(-96).map((r) => ({
        t: isoToDisplay(r.timestamp, ""),
        inc: Number(r.total_zone_incidents ?? 0),
        intensity: Number(r.avg_event_intensity_score ?? r.avg_disruption_score ?? 0),
      })),
    [wx]
  );

  const actions = useMemo(() => {
    const items = [];
    const crit = snapshot?.summary?.high_pressure_zone_count ?? 0;
    items.push({
      title: "Critical zone monitoring",
      body: `${crit} zone(s) exceed the high-pressure ratio threshold. Escalate Recommended Monitoring and verify event overlays.`,
    });
    const inc = snapshot?.summary?.active_incident_rows ?? 0;
    items.push({
      title: "Incident-aware review",
      body:
        inc > 0
          ? `${inc} snapshot row(s) carry incident features. Cross-check against NYPD / DOT feeds when available.`
          : "Incident footprint is light in this hour — maintain baseline monitoring.",
    });
    const mz = snapshot?.summary?.max_pressure_zone;
    if (mz?.zone_name) {
      items.push({
        title: "Hot zone spotlight",
        body: `${mz.zone_name} (${mz.borough}) peaks at ${formatRatio(mz.pressure_ratio)} — ${pressureLabel(Number(mz.pressure_ratio))}.`,
      });
    }
    items.push({
      title: "Supply coverage reminder",
      body: "Use demand pressure as a waiting-pressure proxy only. No observed passenger queue times or live driver counts are implied.",
    });
    return items;
  }, [snapshot]);

  const peak = useMemo(() => peakWindow(city), [city]);

  const showBlocking = apiOnline === null || (loading && snapshot == null);
  const panelRefreshing = loading && snapshot != null;

  return (
    <div className="space-y-5">
      <PageHeader title="Transport Authority View" subtitle={subtitle}>
        <SelectField
          label="Snapshot time"
          value={timestamp}
          onChange={setTimestamp}
          options={timestamps.slice(-240).reverse().map((t) => ({
            value: t,
            label: isoToDisplay(t, t),
          }))}
        />
        {models.length ? (
          <SelectField label="Model" value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />
        ) : null}
        <GlassButton
          variant="primary"
          onClick={() => {
            refreshHealth?.({ forceRefresh: true });
            load({ forceRefresh: true });
          }}
        >
          <RefreshCcw size={16} strokeWidth={1.75} />
          Refresh
        </GlassButton>
      </PageHeader>

      {showBlocking ? (
        <div className="rounded-xl border border-brand-border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">
          Loading regulator snapshot…
        </div>
      ) : null}

      {panelRefreshing ? (
        <p className="text-xs font-semibold text-brand-muted">Updating…</p>
      ) : null}

      {!showBlocking && fetchErrors.snapshot ? (
        <p className="text-xs text-rose-600">Snapshot: {fetchErrors.snapshot}</p>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-4">
        <KpiCard
          icon={Shield}
          accent={Number(maxRatio) >= 1.35 ? "danger" : "warn"}
          label="City Demand Pressure Level"
          value={cityPressureLabel}
          subtext={
            maxRatio != null
              ? `Peak ratio ${formatDecimal(maxRatio, 2)}× at ${snapshot?.summary?.max_pressure_zone?.zone_name ?? "—"}`
              : "Awaiting ratio signal"
          }
        />
        <KpiCard
          icon={MapPinned}
          accent="danger"
          label="Critical Zones"
          value={formatNumber(snapshot?.summary?.high_pressure_zone_count, 0)}
          subtext="Monitoring priority — ratio ≥ 1.35"
        />
        <KpiCard
          icon={TriangleAlert}
          accent="warn"
          label="Active Incident Context"
          value={formatNumber(snapshot?.summary?.active_incident_rows, 0)}
          subtext="Rows with nonzero incident-derived inputs"
        />
        <KpiCard
          icon={Clock3}
          accent="neutral"
          label="Peak Demand Window"
          value={peak}
          subtext={`Derived from last ${Math.min((city ?? []).length, 168)} city buckets`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.65fr_minmax(300px,1fr)]">
        <SectionCard
          title="Citywide Demand Pressure Panel"
          subtitle="High-readability zone lattice — TLC geometry not required"
        >
          <HeatPanel rows={rows} />
        </SectionCard>

        <InsightCard title="Recommended Monitoring Actions" items={actions} footnote="Operational copy stays within proxy semantics — no fabricated resource allocations." />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <SectionCard title="Incident & Disruption Trend" subtitle="Consolidated zone incidents (timeline)" className="lg:col-span-2">
          {fetchErrors.weather || fetchErrors.city ? (
            <p className="mb-2 text-xs text-rose-600">
              {fetchErrors.weather || fetchErrors.city}
            </p>
          ) : null}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={incidentLine}>
                <CartesianGrid strokeDasharray="5 10" stroke="#E3EEE9" />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="inc" name="Σ zone incidents" stroke="#B42318" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        <SectionCard title="Borough Stress Comparison" subtitle="Latest aligned hour • avg pressure ratio" className="lg:col-span-3">
          {fetchErrors.borough ? <p className="mb-2 text-xs text-rose-600">{fetchErrors.borough}</p> : null}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={boroughBars} layout="vertical" margin={{ left: 8 }}>
                <CartesianGrid strokeDasharray="5 10" stroke="#E3EEE9" />
                <XAxis type="number" domain={[0, "auto"]} tickFormatter={(v) => `${v.toFixed(2)}×`} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatDecimal(value, 2)} />
                <Bar dataKey="ratio" name="Avg pressure ratio" radius={[0, 6, 6, 0]}>
                  {boroughBars.map((_, i) => (
                    <Cell key={i} fill={boroughBars[i]?.ratio >= 1.35 ? "#B42318" : boroughBars[i]?.ratio >= 1 ? "#F7B731" : "#00856f"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Monitoring Priority Zones" subtitle="Ranked surveillance list — Review Supply Coverage where elevated">
        <DataTable
          columns={[
            {
              key: "zone_name",
              label: "Zone",
              render: (_, row) =>
                `${row.zone_name ?? "—"}${row.borough ? ` (${row.borough})` : ""}`,
            },
            {
              key: "pressure_ratio",
              label: "Pressure ratio",
              render: (v) => `${formatDecimal(v, 2)}×`,
            },
            {
              key: "pressure_label",
              label: "Status",
              render: (_, row) => row.pressure_label ?? pressureLabel(Number(row.pressure_ratio)),
            },
            {
              key: "_act",
              label: "Suggested follow-up",
              render: (_, row) =>
                Number(row.pressure_ratio) >= 1.35 ? "Elevated Monitoring" : "Routine Monitor",
            },
          ]}
          rows={[...(rows ?? [])].sort((a, b) => Number(b.pressure_ratio) - Number(a.pressure_ratio))}
          maxRows={22}
        />
      </SectionCard>

      <div className="flex flex-wrap gap-4 rounded-xl border border-brand-border bg-brand-mint/20 px-4 py-3 text-xs text-brand-text">
        <Activity className="text-brand-primary" size={16} strokeWidth={1.75} />
        <p>
          <strong>Monitoring framing:</strong> This view highlights where demand-pressure signals cluster. Agencies should align
          staffing and communications using their authoritative operations data — NYC TLC extracts do not provide queue minutes or
          real-time driver availability.
        </p>
      </div>
    </div>
  );
}
