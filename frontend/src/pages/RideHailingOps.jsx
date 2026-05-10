import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw, Car, Gauge, MapPin, BadgeAlert } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  AreaChart,
  Area,
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
  getZones,
  getTimestamps,
  getDashboardSnapshot,
  getZoneHistory,
  getCityTrend,
  getModelMetrics,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import {
  formatDecimal,
  formatNumber,
  isoToDisplay,
  pressureLabel,
  formatRatio,
} from "../lib/format";

const LOG = "[MASEER]";

export default function RideHailingOps({ overview, refreshHealth, apiOnline }) {
  const subtitle =
    "Operator-grade demand-pressure telemetry with zone drilling — still a pickup-count proxy without live idle-driver visibility.";

  const [zones, setZones] = useState([]);
  const [models, setModels] = useState([]);
  const [zoneId, setZoneId] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [timestamps, setTimestamps] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [city, setCity] = useState([]);
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
    const ctParams = new URLSearchParams();
    ctParams.set("hours", "72");
    if (model) ctParams.set("model", model);
    const ctPeek = peekCachedApiUrl(apiUrl(`city/trend?${ctParams}`));
    if (ctPeek?.ok && Array.isArray(ctPeek.data?.rows)) {
      setCity(ctPeek.data.rows);
    }
    if (zoneId) {
      const hp = new URLSearchParams();
      hp.set("hours", "72");
      if (model) hp.set("model", model);
      const histPeek = peekCachedApiUrl(apiUrl(`zone/${encodeURIComponent(zoneId)}/history?${hp}`));
      if (histPeek?.ok && Array.isArray(histPeek.data?.rows)) {
        setHistory(histPeek.data.rows);
      }
    }
  }, [apiOnline, timestamp, model, zoneId]);

  useEffect(() => {
    if (apiOnline === null) return;
    (async () => {
      const [z, mm] = await Promise.all([
        getZones({ allowStaticFallback }),
        getModelMetrics({ allowStaticFallback }),
      ]);
      if (z.ok !== false) {
        setZones(z.rows ?? []);
        setZoneId((prev) =>
          prev || (z.rows?.[0]?.zone_id != null ? String(z.rows[0].zone_id) : "")
        );
      } else console.warn(`${LOG} ops zones:`, z.error);
      if (mm.ok === false) {
        console.warn(`${LOG} ops model metrics:`, mm.error);
        return;
      }
      const names = [...new Set((mm.data?.model_metrics ?? []).map((m) => m.model_name).filter(Boolean))];
      const opts = [...new Set([mm.data?.best_tabular_model, overview?.best_tabular_model, ...names].filter(Boolean))];
      setModels(opts);
      setModel((p) => p || String(opts[0] || ""));
    })();
  }, [overview?.best_tabular_model, apiOnline, allowStaticFallback]);

  useEffect(() => {
    setTimestamp("");
  }, [zoneId]);

  useEffect(() => {
    if (apiOnline === null || !zoneId) return;
    (async () => {
      const ts = await getTimestamps(Number(zoneId), { allowStaticFallback });
      if (ts.ok === false) {
        console.warn(`${LOG} ops timestamps:`, ts.error);
        return;
      }
      const list = ts.rows ?? [];
      setTimestamps(list);
      const last = list[list.length - 1];
      if (last) setTimestamp(last);
      else setTimestamp("");
    })();
  }, [zoneId, apiOnline, allowStaticFallback]);

  const load = useCallback(async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    if (!snapshotRef.current && !forceRefresh) setLoading(true);
    try {
      const [snap, hist, ct] = await Promise.all([
        getDashboardSnapshot({
          timestamp: timestamp || undefined,
          model: model || undefined,
          allowStaticFallback,
          forceRefresh,
        }),
        zoneId
          ? getZoneHistory({
              zoneId: Number(zoneId),
              hours: 72,
              allowStaticFallback,
              forceRefresh,
            })
          : Promise.resolve({ ok: true, rows: [] }),
        getCityTrend({ hours: 72, model: model || undefined, allowStaticFallback, forceRefresh }),
      ]);
      setFetchErrors((prev) => {
        const n = { ...prev };
        const touch = (key, res) => {
          if (res && res.ok === false) {
            console.warn(`${LOG} ops panel [${key}]:`, res.error);
            n[key] = res.error || "Failed";
          } else delete n[key];
        };
        touch("snapshot", snap);
        touch("history", hist);
        touch("city", ct);
        return n;
      });
      if (snap.ok !== false) setSnapshot(snap.data);
      if (hist.ok !== false) setHistory(hist.rows ?? []);
      if (ct.ok !== false) setCity(ct.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [timestamp, model, zoneId, apiOnline, allowStaticFallback]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = snapshot?.rows ?? [];

  const zoneRow = useMemo(() => {
    const id = Number(zoneId);
    if (!Number.isFinite(id)) return null;
    return rows.find((r) => Number(r.zone_id) === id) ?? null;
  }, [rows, zoneId]);

  const kpisAttention = rows.filter((r) => Number(r.pressure_ratio) >= 1.35).length;

  const recoItems = useMemo(() => {
    const items = [];
    if (!zoneRow) {
      items.push({
        title: "Select an operating zone",
        body: "Choose a TLC zone above to hydrate KPIs tied to dispatched demand.",
      });
      return items;
    }
    items.push({
      title: `${zoneRow.zone_name} demand pulse`,
      body: `Pickup proxy ${formatNumber(zoneRow.predicted_next_hour_pickups, 0)} vs roll-mean denominator ${formatDecimal(zoneRow.pickup_count_roll_mean_24, 2)} → ${formatRatio(zoneRow.pressure_ratio)} (${pressureLabel(Number(zoneRow.pressure_ratio))}).`,
    });
    items.push({
      title: "Review Supply Coverage",
      body: "Reposition suggestions require live operator data — this UI only conveys relative pressure so teams can reconcile with proprietary dispatch analytics.",
    });
    items.push({
      title: "Recommended Monitoring",
      body: kpisAttention
        ? `${kpisAttention} zone rows currently exceed ratio 1.35 — align field teams with TLC communications.`
        : "Elevated-ratio footprint is subdued for this snapshot window.",
    });
    return items;
  }, [zoneRow, kpisAttention]);

  const histChart = useMemo(
    () =>
      (history ?? []).map((r) => ({
        t: isoToDisplay(r.timestamp, ""),
        pickups: Number(r.pickup_count ?? 0),
        target: Number(r.target_pickup_count_next_hour ?? 0),
        ratio: Number(r.pressure_ratio ?? 0),
      })),
    [history]
  );

  const pulse = useMemo(
    () =>
      (city ?? []).slice(-48).map((r) => ({
        t: isoToDisplay(r.timestamp, ""),
        cityD: Number(r.total_next_hour_target ?? r.total_pickups ?? 0),
      })),
    [city]
  );

  const bestMonitor = [...rows].sort((a, b) => Number(b.pressure_ratio) - Number(a.pressure_ratio)).slice(0, 8);

  const topPickups = [...rows]
    .filter((r) => Number(r.predicted_next_hour_pickups) >= 0)
    .sort((a, b) => Number(b.predicted_next_hour_pickups) - Number(a.predicted_next_hour_pickups))
    .slice(0, 8);

  const zoneOpts = zones.map((z) => ({
    value: String(z.zone_id),
    label: `${z.zone_name} (${z.borough})`,
  }));

  const pressureAlertLabel = zoneRow?.pressure_label ?? pressureLabel(Number(zoneRow?.pressure_ratio));

  const showBlocking = apiOnline === null || (loading && snapshot == null);
  const panelRefreshing = loading && snapshot != null;

  return (
    <div className="space-y-5">
      <PageHeader title="Ride-Hailing Ops" subtitle={subtitle}>
        <SelectField label="Zone" value={zoneId} onChange={setZoneId} options={zoneOpts} />
        <SelectField
          label="Snapshot time"
          value={timestamp}
          onChange={setTimestamp}
          options={timestamps.slice(-200).reverse().map((t) => ({ value: t, label: isoToDisplay(t, t) }))}
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
          Syncing operator snapshot…
        </div>
      ) : null}

      {panelRefreshing ? (
        <p className="text-xs font-semibold text-brand-muted">Updating…</p>
      ) : null}

      {!showBlocking && (fetchErrors.snapshot || fetchErrors.history || fetchErrors.city) ? (
        <div className="space-y-1 text-xs text-rose-600">
          {fetchErrors.snapshot ? <p>Snapshot: {fetchErrors.snapshot}</p> : null}
          {fetchErrors.history ? <p>Zone history: {fetchErrors.history}</p> : null}
          {fetchErrors.city ? <p>City trend: {fetchErrors.city}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-4">
        <KpiCard
          icon={Car}
          accent="teal"
          label="Expected Next-Hour Pickups"
          value={formatNumber(zoneRow?.predicted_next_hour_pickups, 0)}
          subtext={`TLC Zone ${zoneId || "—"} • waiting-pressure proxy`}
        />
        <KpiCard
          icon={Gauge}
          accent={Number(zoneRow?.pressure_ratio) >= 1.35 ? "danger" : "warn"}
          label="Demand Pressure Ratio"
          value={zoneRow ? `${formatDecimal(zoneRow.pressure_ratio, 2)}×` : "N/A"}
          subtext="Predicted pickups ÷ 24h rolling mean"
        />
        <KpiCard
          icon={MapPin}
          accent="danger"
          label="Zones Needing Attention"
          value={formatNumber(kpisAttention, 0)}
          subtext="Snapshot rows with ratio ≥ 1.35"
        />
        <KpiCard
          icon={BadgeAlert}
          accent={pressureAlertLabel === "High Pressure" ? "danger" : "neutral"}
          label="Pressure Alert"
          value={pressureAlertLabel}
          subtext="Proxy banding — not queue minutes"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_minmax(300px,1fr)]">
        <SectionCard title="Operational Demand Pressure Map" subtitle="Focus on largest ratio tiles for dispatch briefings">
          <HeatPanel rows={rows} />
        </SectionCard>

        <InsightCard title="Operational Recommendations" items={recoItems} footnote="No suggested driver counts — connect to internal dispatch systems for supply actions." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={`Selected Zone Detail — ${zoneRow?.zone_name ?? "—"}`} subtitle="Snapshot row fields">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ["Borough", zoneRow?.borough ?? "—"],
              ["Roll mean (24h)", formatDecimal(zoneRow?.pickup_count_roll_mean_24, 2)],
              ["Current pickups", formatNumber(zoneRow?.pickup_count, 0)],
              ["Event intensity", formatDecimal(zoneRow?.event_intensity_score, 2)],
              ["Disruption score", formatDecimal(zoneRow?.disruption_score, 2)],
              ["Incidents (zone)", formatNumber(zoneRow?.zone_incident_count, 0)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-brand-border bg-brand-bg/60 px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase text-brand-muted">{k}</dt>
                <dd className="mt-1 font-medium text-brand-text">{v}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        <SectionCard title="Short-Term City Pulse" subtitle="Citywide proxy sum — quick external context">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pulse}>
                <defs>
                  <linearGradient id="cp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00856f" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#00856f" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="5 8" stroke="#E3EEE9" />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Area type="monotone" dataKey="cityD" name="City demand signal" stroke="#00856f" fill="url(#cp)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Zone History — Pickups vs Next-Hour Target" subtitle="Last 72 hourly samples for selected zone">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={histChart}>
              <CartesianGrid strokeDasharray="5 8" stroke="#E3EEE9" />
              <XAxis dataKey="t" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="pickups" name="Pickups" stroke="#00856f" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="target" name="Next-hour target (proxy)" stroke="#66736d" dot={false} strokeDasharray="5 6" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Best Zones to Monitor" subtitle="Highest pressure ratios in current snapshot">
          <DataTable
            columns={[
              { key: "zone_name", label: "Zone", render: (_, r) => `${r.zone_name} (${r.borough})` },
              { key: "pressure_ratio", label: "Ratio", render: (v) => `${formatDecimal(v, 2)}×` },
              {
                key: "_m",
                label: "Operational note",
                render: () => "Recommended Monitoring • Review Supply Coverage",
              },
            ]}
            rows={bestMonitor}
            maxRows={12}
          />
        </SectionCard>

        <SectionCard title="Top Pickup Pressure Zones" subtitle="Sorted by predicted next-hour pickups">
          <DataTable
            columns={[
              { key: "zone_name", label: "Zone", render: (_, r) => `${r.zone_name} (${r.borough})` },
              {
                key: "predicted_next_hour_pickups",
                label: "Pred. pickups",
                render: (v) => formatNumber(v, 0),
              },
              { key: "pressure_ratio", label: "Ratio", render: (v) => `${formatDecimal(v, 2)}×` },
            ]}
            rows={topPickups}
            maxRows={12}
          />
        </SectionCard>
      </div>
    </div>
  );
}
