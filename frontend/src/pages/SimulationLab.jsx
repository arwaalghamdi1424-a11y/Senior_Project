import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FlaskConical, RefreshCcw, Play } from "lucide-react";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import {
  getZones,
  getTimestamps,
  getModelMetrics,
  runSimulation,
  getDashboardSnapshot,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import { formatDecimal, formatNumber } from "../lib/format";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

const LOG = "[MASEER]";

function num(val) {
  if (val === "" || val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export default function SimulationLab({ overview, refreshHealth, apiOnline }) {
  const subtitle =
    "Counterfactual weather, disruption, and rolling-demand inputs re-score the next-hour pickup proxy for a single zone — no passenger waiting-time targets.";

  const allowStaticFallback = apiOnline !== true;

  const [zones, setZones] = useState([]);
  const [models, setModels] = useState([]);
  const [zoneId, setZoneId] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [timestamps, setTimestamps] = useState([]);

  const [temperature, setTemperature] = useState("");
  const [precipitation, setPrecipitation] = useState("");
  const [eventIntensity, setEventIntensity] = useState("");
  const [disruption, setDisruption] = useState("");
  const [rollMean, setRollMean] = useState("");
  const [actualNext, setActualNext] = useState("");

  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const zPeek = peekCachedApiUrl(apiUrl("zones"));
    if (zPeek?.ok && zPeek.data && (Array.isArray(zPeek.data.zones) || Array.isArray(zPeek.data.rows))) {
      const rows = Array.isArray(zPeek.data.zones) ? zPeek.data.zones : zPeek.data.rows;
      setZones(rows);
      setZoneId((prev) =>
        prev || (rows?.[0]?.zone_id != null ? String(rows[0].zone_id) : "")
      );
    }
    const mmPeek = peekCachedApiUrl(apiUrl("models/metrics"));
    if (
      mmPeek?.ok &&
      mmPeek.data &&
      (Array.isArray(mmPeek.data.rows) || Array.isArray(mmPeek.data.model_metrics))
    ) {
      const mrows = Array.isArray(mmPeek.data.rows) ? mmPeek.data.rows : mmPeek.data.model_metrics;
      const names = [...new Set((mrows ?? []).map((m) => m.model_name).filter(Boolean))];
      const opts = [
        ...new Set([mmPeek.data.best_tabular_model, overview?.best_tabular_model, ...names].filter(Boolean)),
      ];
      setModels(opts);
      setModel((p) => p || String(opts[0] || ""));
    }
  }, [apiOnline, overview?.best_tabular_model]);

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
      } else console.warn(`${LOG} simulation zones:`, z.error);
      if (mm.ok === false) {
        console.warn(`${LOG} simulation model metrics:`, mm.error);
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
        console.warn(`${LOG} simulation timestamps:`, ts.error);
        return;
      }
      const list = ts.rows ?? [];
      setTimestamps(list);
      const last = list[list.length - 1];
      if (last) setTimestamp(last);
      else setTimestamp("");
    })();
  }, [zoneId, apiOnline, allowStaticFallback]);

  async function hydrateFromSnapshot({ forceRefresh = false } = {}) {
    if (!zoneId || apiOnline === null) return;
    const snap = await getDashboardSnapshot({
      timestamp: timestamp || undefined,
      model: model || undefined,
      allowStaticFallback,
      forceRefresh,
    });
    if (snap.ok === false) {
      console.warn(`${LOG} hydrate snapshot:`, snap.error);
      return;
    }
    const row = (snap.data?.rows ?? []).find((r) => Number(r.zone_id) === Number(zoneId));
    if (!row) return;
    setTemperature(row.temperature != null ? String(row.temperature) : "");
    setPrecipitation(row.precipitation != null ? String(row.precipitation) : "");
    setEventIntensity(row.event_intensity_score != null ? String(row.event_intensity_score) : "");
    setDisruption(row.disruption_score != null ? String(row.disruption_score) : "");
    setRollMean(row.pickup_count_roll_mean_24 != null ? String(row.pickup_count_roll_mean_24) : "");
    setActualNext(row.target_pickup_count_next_hour != null ? String(row.target_pickup_count_next_hour) : "");
  }

  const baselineChart = useMemo(() => {
    if (!result?.data) return [];
    const b = result.data.baseline_prediction;
    const s = result.data.predicted_next_hour_pickups;
    return [
      { label: "Baseline", value: typeof b === "number" ? b : null },
      { label: "Scenario", value: typeof s === "number" ? s : null },
    ];
  }, [result]);

  const handleRun = async () => {
    setRunning(true);
    setError("");
    const payload = {
      zone_id: Number(zoneId),
      timestamp: timestamp || null,
      model_name: model || null,
      temperature: num(temperature),
      precipitation: num(precipitation),
      event_intensity_score: num(eventIntensity),
      disruption_score: num(disruption),
      pickup_count_roll_mean_24: num(rollMean),
      actual_next_hour_pickups: num(actualNext),
    };
    try {
      const res = await runSimulation(payload);
      if (res.ok) {
        setResult(res);
      } else {
        setResult(null);
        setError(res.message ?? "Simulation failed.");
      }
    } catch {
      setResult(null);
      setError("Unable to POST scenario — backend offline?");
    } finally {
      setRunning(false);
      refreshHealth?.();
    }
  };

  const d = result?.data;
  const scenarioRows = [
    ["Zone ID", formatNumber(d?.zone_id, 0)],
    ["Timestamp", (d?.timestamp ?? "").slice(0, 19) || "N/A"],
    ["Model", d?.model_name ?? "—"],
    ["Prediction source", d?.prediction_source ?? "—"],
    ["Baseline pickups (proxy)", formatDecimal(d?.baseline_prediction, 3)],
    ["Scenario pickups (proxy)", formatDecimal(d?.predicted_next_hour_pickups, 3)],
    ["Rolling mean denominator", formatDecimal(d?.pickup_count_roll_mean_24, 3)],
    ["Pressure ratio", d?.pressure_ratio != null ? `${formatDecimal(d?.pressure_ratio, 2)}×` : "N/A"],
    ["Pressure label", d?.pressure_label ?? "—"],
    ["Held-out actual (optional)", formatDecimal(d?.actual_next_hour_pickups, 3)],
    ["Absolute error", d?.absolute_error != null ? formatDecimal(d.absolute_error, 3) : "N/A"],
  ];

  const zoneOpts = zones.map((z) => ({
    value: String(z.zone_id),
    label: `${z.zone_name} (${z.borough})`,
  }));

  return (
    <div className="space-y-5">
      <PageHeader title="Simulation Lab" subtitle={subtitle}>
        <SelectField label="Zone" value={zoneId} onChange={setZoneId} options={zoneOpts} />
        <SelectField
          label="Baseline timestamp"
          value={timestamp}
          onChange={setTimestamp}
          options={timestamps.slice(-280).reverse().map((t) => ({ value: t, label: t.slice(0, 16) }))}
        />
        {models.length ? (
          <SelectField label="Model" value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />
        ) : null}
        <GlassButton variant="primary" onClick={handleRun} disabled={running || !zoneId}>
          <Play size={14} strokeWidth={2} />
          {running ? "Running…" : "Run Simulation"}
        </GlassButton>
        <GlassButton onClick={() => refreshHealth?.({ forceRefresh: true })}>
          <RefreshCcw size={14} strokeWidth={1.75} />
          API pulse
        </GlassButton>
      </PageHeader>

      <SectionCard title="Scenario Inputs" subtitle="Edit contextual drivers then run — deltas stay in pickup space">
        <div className="mb-4 flex flex-wrap gap-2">
          <GlassButton onClick={() => hydrateFromSnapshot()}>Hydrate inputs from snapshot</GlassButton>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Temperature (°C)" value={temperature} onChange={setTemperature} />
          <Field label="Precipitation (mm)" value={precipitation} onChange={setPrecipitation} />
          <Field label="Event intensity score" value={eventIntensity} onChange={setEventIntensity} />
          <Field label="Disruption score" value={disruption} onChange={setDisruption} />
          <Field label="Pickup rolling mean (24h)" value={rollMean} onChange={setRollMean} helper="Pressure ratio denominator guardrail" />
          <Field label="Actual next-hour pickups (eval)" value={actualNext} onChange={setActualNext} helper="Optional: compute absolute error" />
        </div>
        <p className="mt-4 rounded-lg bg-brand-bg px-4 py-2 text-[11px] text-brand-muted">
          POST <code className="text-brand-text">/api/simulation/run</code> with JSON payload — responses include baseline vs scenario pickup proxy and pressure banding.
        </p>
      </SectionCard>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">{error}</div>
      ) : null}

      {result?.ok ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <KpiCard
              icon={FlaskConical}
              accent="teal"
              label="Baseline Prediction"
              value={formatDecimal(d?.baseline_prediction, 2)}
              subtext={d?.prediction_source ?? "source"}
            />
            <KpiCard
              icon={FlaskConical}
              accent="mint"
              label="Scenario Prediction"
              value={formatDecimal(d?.predicted_next_hour_pickups, 2)}
              subtext={`Δ ${deltaLabel(d?.baseline_prediction, d?.predicted_next_hour_pickups)}`}
            />
            <KpiCard
              icon={FlaskConical}
              accent={Number(d?.pressure_ratio) >= 1.35 ? "danger" : "neutral"}
              label="Pressure Ratio"
              value={d?.pressure_ratio != null ? `${formatDecimal(d.pressure_ratio, 2)}×` : "N/A"}
              subtext={`Label: ${d?.pressure_label ?? "—"}`}
            />
            <KpiCard
              icon={FlaskConical}
              accent="warn"
              label="Absolute Error"
              value={d?.absolute_error != null ? formatDecimal(d.absolute_error, 3) : "N/A"}
              subtext={`Optional comparison vs observed proxy`}
            />
          </div>

          <SectionCard title="Recommendation" subtitle={d?.proxy_note}>
            <p className="text-sm font-medium leading-relaxed text-brand-text">{d?.recommendation ?? "—"}</p>
          </SectionCard>

          <SectionCard title="Baseline vs Scenario" subtitle="Pickup-count deltas (waiting-pressure proxy axis)">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={baselineChart}>
                  <CartesianGrid strokeDasharray="5 10" stroke="#E3EEE9" />
                  <XAxis dataKey="label" />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => formatDecimal(value, 4)} />
                  <Legend />
                  <Line type="monotone" dataKey="value" stroke="#00856f" strokeWidth={3} dot={{ r: 5 }} name="Pickup proxy" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>

          <SectionCard title="Scenario Summary" subtitle="Captured IO for audit logs">
            <DataTable columns={[{ key: "k", label: "Field", render: (_, row) => row.k }, { key: "v", label: "Value" }]} rows={scenarioRows.map(([k, v]) => ({ k, v }))} />
          </SectionCard>
        </>
      ) : null}

      <p className="text-[11px] leading-relaxed text-brand-muted">
        FastAPI rejects unknown zones/time pairs with actionable errors — rerun after selecting a hydrated timestamp pulled from TLC features.
      </p>
    </div>
  );
}

function Field({ label, value, onChange, helper }) {
  return (
    <label className="text-xs font-semibold uppercase tracking-wide text-brand-muted">
      <span>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-normal tracking-normal text-brand-text shadow-inner focus:border-brand-primary focus:outline-none"
      />
      {helper ? <span className="mt-1 block normal-case tracking-normal text-[10px] text-brand-muted/90">{helper}</span> : null}
    </label>
  );
}

function deltaLabel(b, s) {
  const nb = Number(b);
  const ns = Number(s);
  if (!Number.isFinite(nb) || !Number.isFinite(ns)) return "N/A";
  const pct = ((ns - nb) / (Math.abs(nb) < 1e-9 ? 1 : nb)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs baseline`;
}
