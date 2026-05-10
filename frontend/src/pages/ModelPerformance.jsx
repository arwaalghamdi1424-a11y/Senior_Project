import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCcw,
  Trophy,
  BarChart2,
  Layers,
  LineChart as LineChartIcon,
  Activity,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  ZAxis,
  Cell,
} from "recharts";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import GlassButton from "../components/GlassButton";
import { getModelMetrics, getModelPredictions, getModels, apiUrl, peekCachedApiUrl } from "../lib/api";
import { formatDecimal } from "../lib/format";

const LOG = "[MASEER]";
const OVERVIEW_TAB = "overview";

const GROUP_TABULAR = "Tabular Next-Hour";
const GROUP_SEQUENCE = "Sequence / Forecasting";

function aggregatePredictionsByTime(rows) {
  const m = {};
  for (const r of rows ?? []) {
    const t = r.timestamp;
    if (!t) continue;
    const a = Number(r.actual ?? r.y_true ?? 0);
    const p = Number(r.predicted ?? r.y_pred ?? 0);
    if (!m[t]) m[t] = { a: [], p: [] };
    m[t].a.push(a);
    m[t].p.push(p);
  }
  const out = Object.entries(m).map(([t, bundle]) => {
    const avg = (arr) =>
      arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
    return {
      timestamp: t,
      actualAvg: avg(bundle.a),
      predAvg: avg(bundle.p),
    };
  });
  out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return out;
}

function sortByTestRmse(rows) {
  return [...(rows ?? [])].sort(
    (a, b) => (Number(a.test_rmse) || Infinity) - (Number(b.test_rmse) || Infinity)
  );
}

/** Canonical bucket for display dedupe: GRU / GRU Sequence → gru; Temporal CNN * → temporal_cnn; etc. */
function canonicalDisplayKey(rawName) {
  const s = String(rawName ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return "";
  if (s.includes("xgboost")) return "xgboost";
  if (s.includes("random forest")) return "random_forest";
  if (s.includes("gradient boosting")) return "gradient_boosting";
  if (s.includes("ridge")) return "ridge_regression";
  if (s.includes("temporal") && s.includes("cnn")) return "temporal_cnn";
  if (s.includes("seasonal naive")) return "seasonal_naive";
  if (s.includes("previous 24")) return "previous_24h_naive";
  if (/\bgru\b/.test(s)) return "gru";
  if (/\blstm\b/.test(s)) return "lstm";
  return s;
}

/** One row per canonical display model — prefer lowest valid test_rmse; prefer finite RMSE over missing. */
function dedupeModelMetricsByCanonical(rows) {
  const byCanon = new Map();
  for (const row of rows ?? []) {
    const raw = String(row.model_name ?? "").trim();
    if (!raw) continue;
    const key = canonicalDisplayKey(raw);
    if (!key) continue;
    const rmse = Number(row.test_rmse);
    const prev = byCanon.get(key);
    if (!prev) {
      byCanon.set(key, row);
      continue;
    }
    const prevRmse = Number(prev.test_rmse);
    const finiteNew = Number.isFinite(rmse);
    const finitePrev = Number.isFinite(prevRmse);
    const pickNew =
      (finiteNew && !finitePrev) ||
      (finiteNew && finitePrev && rmse < prevRmse) ||
      (!finiteNew && !finitePrev && raw.length < String(prev.model_name ?? "").length);
    if (pickNew) byCanon.set(key, row);
  }
  return sortByTestRmse([...byCanon.values()]);
}

function normalizeModelName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/** Sequence / forecasting bucket (checked before tabular). Seasonal Naive lives here per project copy. */
function isSequenceForecastingGroup(name, row) {
  const n = normalizeModelName(name);
  if (!n) return false;
  if (n.includes("seasonal naive")) return true;
  if (n.includes("previous 24 hours")) return true;
  if (n.includes("lstm")) return true;
  if (n.includes("gru")) return true;
  if (n.includes("temporal cnn")) return true;
  if (n.includes("seq2seq") || n.includes("sequence")) return true;
  if (n.includes("recurrent")) return true;
  if (n.includes("24h forecaster") || n.includes("24-hour")) return true;
  if (/\bforecast(er)?\b/.test(n)) return true;
  const fam = String(row?.model_family ?? "").toLowerCase();
  if (fam === "deep_sequence") return true;
  return false;
}

function isTabularNextHourGroup(name, row) {
  if (isSequenceForecastingGroup(name, row)) return false;
  const n = normalizeModelName(name);
  const fam = String(row?.model_family ?? "").toLowerCase();
  if (
    n.includes("xgboost") ||
    n.includes("random forest") ||
    n.includes("gradient boosting") ||
    n.includes("ridge") ||
    n.includes("elastic net") ||
    n.includes("lasso") ||
    n.includes("linear regression") ||
    n.includes("logistic") ||
    n.includes("tabular")
  )
    return true;
  if (fam === "tabular") return true;
  return false;
}

function modelGroupLabel(row) {
  const name = row?.model_name ?? "";
  if (isSequenceForecastingGroup(name, row)) return GROUP_SEQUENCE;
  if (isTabularNextHourGroup(name, row)) return GROUP_TABULAR;
  return "Other";
}

/** Stable display label per canonical model (avoids duplicate GRU / GRU Sequence rows). */
function displayModelLabel(apiName) {
  const raw = String(apiName ?? "").trim();
  if (!raw) return "—";
  const k = canonicalDisplayKey(raw);
  const map = {
    xgboost: "XGBoost",
    random_forest: "Random Forest",
    gradient_boosting: "Gradient Boosting",
    ridge_regression: "Ridge Regression",
    temporal_cnn: "Temporal CNN",
    seasonal_naive: "Seasonal Naive",
    previous_24h_naive: "Previous 24 Hours Naive",
    gru: "GRU Sequence",
    lstm: "LSTM Sequence",
  };
  return map[k] ?? raw;
}

function pickBestTabularRow(dedupedRows) {
  const tabular = (dedupedRows ?? []).filter((m) =>
    isTabularNextHourGroup(m.model_name, m)
  );
  return tabular.length ? sortByTestRmse(tabular)[0] : null;
}

function rankByRmse(modelName, sortedDeduped) {
  const k = canonicalDisplayKey(modelName);
  const idx = sortedDeduped.findIndex((m) => canonicalDisplayKey(m.model_name) === k);
  return idx >= 0 ? idx + 1 : null;
}

function rankInGroup(modelName, sortedDeduped, predicate) {
  const k = canonicalDisplayKey(modelName);
  const subset = sortedDeduped.filter((m) => predicate(m));
  const idx = subset.findIndex((m) => canonicalDisplayKey(m.model_name) === k);
  return idx >= 0 ? idx + 1 : null;
}

function pickBestSequenceRow(sequenceRows) {
  const rows = [...(sequenceRows ?? [])].filter((m) =>
    Number.isFinite(Number(m.test_rmse))
  );
  if (!rows.length) return null;
  return sortByTestRmse(rows)[0];
}

function modelsMatchCanonical(a, b) {
  return canonicalDisplayKey(a) === canonicalDisplayKey(b);
}

function dedupeContextualByCanonical(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    const raw = String(r.model_name ?? "").trim();
    if (!raw) continue;
    const key = canonicalDisplayKey(raw);
    if (!key) continue;
    const ctx = Number(r.context_test_rmse);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r, model_name: raw });
      continue;
    }
    const prevCtx = Number(prev.context_test_rmse);
    const finiteNew = Number.isFinite(ctx);
    const finitePrev = Number.isFinite(prevCtx);
    const pickNew =
      (finiteNew && !finitePrev) ||
      (finiteNew && finitePrev && ctx < prevCtx) ||
      (!finiteNew && !finitePrev);
    if (pickNew) map.set(key, { ...r, model_name: raw });
  }
  return [...map.values()];
}

function findContextualRowForModel(contextualRows, apiName) {
  const k = canonicalDisplayKey(apiName);
  const hit = (contextualRows ?? []).find(
    (c) => canonicalDisplayKey(c.model_name) === k
  );
  return hit ?? null;
}

function contextualDifferenceLabel(baseRmse, contextRmse) {
  const b = Number(baseRmse);
  const c = Number(contextRmse);
  if (!Number.isFinite(b) || !Number.isFinite(c)) return "—";
  const eps = 1e-6;
  if (c < b - eps) return "Context lower";
  if (c > b + eps) return "Base lower";
  return "Similar";
}

function interpretSelectedContextual(baseRmse, contextRmse) {
  const b = Number(baseRmse);
  const c = Number(contextRmse);
  if (!Number.isFinite(b) || !Number.isFinite(c))
    return "Base and contextual features performed similarly for this model.";
  const eps = 1e-6;
  if (c < b - eps) return "Contextual features reduced RMSE for this model.";
  if (c > b + eps) return "Base features had lower RMSE for this model in this export.";
  return "Base and contextual features performed similarly for this model.";
}

function interpretSelectedContextualGeneric(baseVal, contextVal) {
  const b = Number(baseVal);
  const c = Number(contextVal);
  if (!Number.isFinite(b) || !Number.isFinite(c))
    return "Base and contextual features performed similarly for this model.";
  const eps = 1e-6;
  if (c < b - eps) return "Contextual features reduced this holdout error metric for this model.";
  if (c > b + eps) return "Base features had lower error for this model in this export.";
  return "Base and contextual features performed similarly for this model.";
}

function friendlyModelType(row) {
  const name = String(row?.model_name ?? "").toLowerCase();
  const family = String(row?.model_family ?? "").toLowerCase();

  if (
    name.includes("xgboost") ||
    name.includes("gradient boosting") ||
    name.includes("random forest")
  ) {
    return "Tree Ensemble";
  }
  if (name.includes("ridge")) return "Linear Baseline";
  if (name.includes("seasonal naive") || name.includes("previous 24 hours naive")) {
    return "Naive Baseline";
  }
  if (name.includes("lstm") || name.includes("gru") || name.includes("temporal cnn")) {
    return "Sequence Forecasting Model";
  }
  if (family === "tabular") return "Tabular ML";
  if (family === "deep_sequence") return "Sequence Forecasting Model";
  return "Forecasting model";
}

function tableNotesForRow(row, opts) {
  const { isBestTabular, rankOverall, isBestSequenceModel } = opts;
  const name = String(row?.model_name ?? "");
  const nl = name.toLowerCase();
  const group = modelGroupLabel(row);

  if (group === GROUP_TABULAR) {
    if (isBestTabular)
      return "Best tabular candidate for engineered zone-hour features.";
    if (nl.includes("xgboost"))
      return "Tabular next-hour prediction with strong nonlinear feature interactions.";
    if (nl.includes("random forest"))
      return "Tabular ensemble baseline for zone-hour pickup signals.";
    if (nl.includes("gradient boosting"))
      return "Tabular boosting baseline alongside peer tree models.";
    if (nl.includes("ridge"))
      return "Linear tabular baseline for comparing nonlinear lift.";
    return `Tabular next-hour model · rank ${rankOverall} by RMSE among exported models.`;
  }

  if (group === GROUP_SEQUENCE) {
    if (nl.includes("temporal cnn"))
      return isBestSequenceModel
        ? "Best sequence/forecasting candidate in this export by lowest valid sequence RMSE."
        : "Sequence-style forecasting with temporal convolution over recent windows.";
    if (nl.includes("lstm"))
      return "Recurrent sequence model for temporal demand dynamics.";
    if (nl.includes("gru"))
      return "Recurrent sequence model for temporal demand dynamics.";
    if (nl.includes("seasonal naive") || nl.includes("naive"))
      return "Naive benchmark for comparing advanced forecasting models.";
    return "Sequence / forecasting lane — interpret separately from tabular next-hour.";
  }

  return "Holdout metrics from export — compare alongside peers.";
}

function strengthsBlock(modelName) {
  let n = String(modelName ?? "").trim();
  if (n === "GRU Sequence") n = "GRU";
  if (n === "LSTM Sequence") n = "LSTM";
  const blocks = {
    XGBoost: {
      strengths:
        "Handles nonlinear interactions among lagged pickup demand, weather fields, incident indicators, and zone-hour patterns.",
      useCase:
        "Primary candidate for next-hour pickup-count prediction when tabular features dominate.",
      explanation:
        "XGBoost is a tree boosting model that works well with engineered tabular features such as lagged pickup demand, weather variables, incident indicators, and zone-level patterns.",
    },
    "Gradient Boosting": {
      strengths: "Captures curved relationships in structured features with strong gradient-step fitting.",
      useCase: "Robust tabular ML baseline alongside other tree ensembles.",
      explanation:
        "Gradient Boosting captures nonlinear relationships in structured features and provides a strong tabular machine-learning baseline.",
    },
    "Random Forest": {
      strengths: "Ensemble averaging reduces variance versus single decision trees.",
      useCase: "Stable ensemble baseline for pickup-demand signals.",
      explanation:
        "Random Forest is a robust ensemble baseline that reduces overfitting by averaging many decision trees.",
    },
    "Ridge Regression": {
      strengths: "Fast, interpretable linear structure with L2 shrinkage.",
      useCase: "Linear baseline to contextualize lift from nonlinear models.",
      explanation:
        "Ridge Regression provides a linear baseline used to compare whether nonlinear models add predictive value.",
    },
    "Seasonal Naive": {
      strengths: "Transparent seasonal repetition benchmark.",
      useCase: "Judges whether advanced models improve on simple seasonality.",
      explanation:
        "Seasonal Naive is a simple benchmark that repeats historical seasonal behavior, useful for judging whether advanced models add value.",
    },
    LSTM: {
      strengths: "Retains longer memory in recurrent states for temporal sequences.",
      useCase: "Multi-hour demand projection and temporal pattern tracking.",
      explanation:
        "LSTM is a sequence model designed to capture longer temporal dependencies across demand history.",
    },
    GRU: {
      strengths: "Efficient recurrent gating for sequential pickup dynamics.",
      useCase: "Multi-hour rolling forecasts with lighter recurrence than LSTM.",
      explanation:
        "GRU is a sequence model that captures temporal patterns with a simpler recurrent structure than LSTM.",
    },
    "Temporal CNN": {
      strengths:
        "Temporal convolution filters can capture local demand spikes and short-term temporal motifs.",
      useCase:
        "Useful for sequence-style forecasting where recent time windows contain predictive patterns.",
      explanation:
        "Temporal CNN applies convolution across time to highlight local demand dynamics and short-horizon structure in sequential inputs.",
    },
  };
  if (blocks[n])
    return blocks[n];
  return {
    strengths: "Evaluated with the same holdout metrics as peer models.",
    useCase: "Compare pickup-demand behavior against tabular and sequence peers.",
    explanation:
      "This model is evaluated using the same holdout metrics to compare its pickup-demand forecasting behavior.",
  };
}

function forecastBenchmarkLabel(row) {
  const b = row?.benchmark_name;
  if (b && String(b).trim()) return String(b);
  const name = String(row?.model_name ?? "").toLowerCase();
  if (name.includes("naive")) return "Naive Baseline";
  return "24-hour forecasting";
}

function isFiniteMetric(v) {
  return Number.isFinite(Number(v));
}

function forecastRowsPartition(forecastMetrics) {
  const rows = [...(forecastMetrics ?? [])];
  const chartRows = rows.filter((r) => isFiniteMetric(r.rmse));
  const hasAnyNumeric = chartRows.length > 0;
  const allMissing =
    rows.length > 0 &&
    rows.every(
      (r) =>
        !isFiniteMetric(r.rmse) &&
        !isFiniteMetric(r.mae) &&
        !isFiniteMetric(r.r2)
    );
  return { rows, chartRows, hasAnyNumeric, allMissing };
}

function KpiSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-brand-border bg-white p-4 shadow-card">
      <div className="h-3 w-24 rounded bg-brand-border" />
      <div className="mt-3 h-8 w-32 rounded bg-brand-border/80" />
      <div className="mt-2 h-3 w-full max-w-[14rem] rounded bg-brand-bg" />
    </div>
  );
}

/** Matches KpiCard layout but allows multi-line model names (no truncate). ModelPerformance-only. */
function SequenceCandidateKpiCard({ label, value, subtext, icon: Icon }) {
  const ring = "bg-maseer-mint/70 text-brand-primary";
  return (
    <div className="flex gap-3 rounded-xl border border-brand-border bg-white p-4 shadow-card">
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${ring}`}
      >
        <Icon size={22} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
          {label}
        </div>
        <div className="mt-1 min-h-[2.75rem] whitespace-normal break-words text-2xl font-semibold leading-snug text-brand-text">
          {value}
        </div>
        {subtext ? (
          <div className="mt-1 text-xs leading-snug text-brand-muted">{subtext}</div>
        ) : null}
      </div>
    </div>
  );
}

function ChartSkeleton({ className = "" }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-gradient-to-b from-brand-bg to-white ${className}`}
      style={{ minHeight: 280 }}
    />
  );
}

function FullModelMetricsTable({
  sortedDeduped,
  bestTabularApiName,
  selectedApiModelName,
  bestSequenceApiName,
}) {
  if (!sortedDeduped?.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-brand-border">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-brand-bg">
          <tr>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">Model</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">Group</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">RMSE</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">MAE</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">R²</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">Type</th>
            <th className="px-3 py-2 text-xs uppercase text-brand-muted">Notes</th>
          </tr>
        </thead>
        <tbody>
          {sortedDeduped.map((row, idx) => {
            const apiName = row.model_name ?? "—";
            const label = displayModelLabel(apiName);
            const group = modelGroupLabel(row);
            const rankOverall = idx + 1;
            const isBestTabular =
              Boolean(bestTabularApiName) &&
              modelsMatchCanonical(apiName, bestTabularApiName);
            const isBestSequenceModel =
              Boolean(bestSequenceApiName) &&
              modelsMatchCanonical(apiName, bestSequenceApiName);
            const isSelected =
              Boolean(selectedApiModelName) &&
              modelsMatchCanonical(apiName, selectedApiModelName);
            return (
              <tr
                key={canonicalDisplayKey(apiName)}
                className={`border-t border-brand-border ${
                  isBestTabular ? "bg-maseer-mint/50" : ""
                } ${isSelected ? "outline outline-2 outline-brand-primary -outline-offset-2" : ""}`}
              >
                <td className="max-w-[14rem] whitespace-normal px-3 py-2 font-medium text-brand-text">
                  {label}
                </td>
                <td className="whitespace-normal px-3 py-2 text-brand-muted">{group}</td>
                <td className="px-3 py-2 tabular-nums">{formatDecimal(row.test_rmse, 3)}</td>
                <td className="px-3 py-2 tabular-nums">{formatDecimal(row.test_mae, 3)}</td>
                <td className="px-3 py-2 tabular-nums">{formatDecimal(row.test_r2, 3)}</td>
                <td className="whitespace-normal px-3 py-2 text-brand-muted">
                  {friendlyModelType(row)}
                </td>
                <td className="max-w-[20rem] whitespace-normal px-3 py-2 text-brand-muted">
                  {tableNotesForRow(row, {
                    isBestTabular,
                    rankOverall,
                    isBestSequenceModel,
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal grouped bars: categories on Y axis. */
function HorizontalGroupedMaeRmse({ data }) {
  if (!data?.length) return <EmptyMetricsNote />;
  const chartH = Math.max(260, data.length * 44);
  return (
    <div style={{ height: chartH }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ left: 16, right: 16, top: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => formatDecimal(v, 2)} />
          <YAxis
            type="category"
            dataKey="label"
            width={132}
            tick={{ fontSize: 11 }}
            interval={0}
          />
          <Tooltip formatter={(v) => formatDecimal(v, 3)} />
          <Legend />
          <Bar dataKey="rmse" name="RMSE" fill="#00856f" radius={[0, 6, 6, 0]} />
          <Bar dataKey="mae" name="MAE" fill="#66736d" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function HorizontalR2Chart({ data }) {
  if (!data?.length) return <EmptyMetricsNote />;
  const chartH = Math.max(260, data.length * 40);
  return (
    <div style={{ height: chartH }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ left: 16, right: 16, top: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
          <XAxis type="number" domain={["auto", "auto"]} tickFormatter={(v) => formatDecimal(v, 2)} />
          <YAxis type="category" dataKey="label" width={132} tick={{ fontSize: 11 }} interval={0} />
          <Tooltip formatter={(v) => formatDecimal(v, 3)} />
          <Bar dataKey="r2" name="R²" fill="#003D34" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Contextual vs base — horizontal grouped bars (model on Y). */
function HorizontalContextualBaseContextChart({ data }) {
  if (!data?.length) return null;
  const chartH = Math.max(240, data.length * 42);
  return (
    <div style={{ height: chartH }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ left: 12, right: 12, top: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => formatDecimal(v, 2)} />
          <YAxis type="category" dataKey="label" width={140} tick={{ fontSize: 11 }} interval={0} />
          <Tooltip formatter={(v) => formatDecimal(v, 3)} />
          <Legend />
          <Bar dataKey="base_rmse" name="Base RMSE" fill="#BFEFE3" radius={[0, 6, 6, 0]} />
          <Bar dataKey="context_rmse" name="Context RMSE" fill="#00856f" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function sortForecastTableRows(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    const fa = isFiniteMetric(a.rmse);
    const fb = isFiniteMetric(b.rmse);
    if (fa && !fb) return -1;
    if (!fa && fb) return 1;
    if (fa && fb) return Number(a.rmse) - Number(b.rmse);
    return String(a.model_name ?? "").localeCompare(String(b.model_name ?? ""));
  });
}

export default function ModelPerformance({ overview: _overview, apiOnline }) {
  const allowStaticFallback = apiOnline !== true;

  const [metricsPack, setMetricsPack] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsRefreshing, setMetricsRefreshing] = useState(false);
  const [metricsError, setMetricsError] = useState(null);
  const metricsPackRef = useRef(null);

  const [modelsMetaOk, setModelsMetaOk] = useState(true);

  const [activeTab, setActiveTab] = useState(OVERVIEW_TAB);

  const [predictions, setPredictions] = useState([]);
  const [predLoading, setPredLoading] = useState(false);
  const [predError, setPredError] = useState(null);
  const [predRefreshing, setPredRefreshing] = useState(false);
  const predictionsRef = useRef([]);

  useEffect(() => {
    metricsPackRef.current = metricsPack;
  }, [metricsPack]);
  useEffect(() => {
    predictionsRef.current = predictions;
  }, [predictions]);

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const raw = peekCachedApiUrl(apiUrl("models/metrics"));
    if (raw?.ok && raw.data && (Array.isArray(raw.data.rows) || Array.isArray(raw.data.model_metrics))) {
      const rows = Array.isArray(raw.data.rows) ? raw.data.rows : raw.data.model_metrics;
      const pack = {
        model_metrics: rows,
        forecast_metrics: raw.data.forecast_metrics ?? rows.filter((m) => m.scenario === "24h_forecast"),
        contextual_comparison: raw.data.contextual_comparison ?? [],
        best_tabular_model: raw.data.best_tabular_model,
        best_forecast_model: raw.data.best_forecast_model,
      };
      metricsPackRef.current = pack;
      setMetricsPack(pack);
    }
  }, [apiOnline]);

  const loadMetrics = useCallback(async ({ forceRefresh = false } = {}) => {
    setMetricsError(null);
    try {
      if (apiOnline === null) return;
      const hasData = metricsPackRef.current != null;
      if (!hasData && !forceRefresh) setMetricsLoading(true);
      if (hasData && forceRefresh) setMetricsRefreshing(true);
      const [mm, gm] = await Promise.all([
        getModelMetrics({ allowStaticFallback, forceRefresh }),
        getModels({ allowStaticFallback, forceRefresh }),
      ]);
      if (gm.ok === false) {
        setModelsMetaOk(false);
        console.warn(`${LOG} models list:`, gm.error);
      } else {
        setModelsMetaOk(true);
      }
      if (mm.ok === false) {
        console.warn(`${LOG} model metrics:`, mm.error);
        setMetricsError(mm.error || "Failed to load metrics");
        if (!hasData) setMetricsPack(null);
      } else {
        setMetricsPack(mm.data ?? null);
      }
    } finally {
      setMetricsLoading(false);
      setMetricsRefreshing(false);
    }
  }, [allowStaticFallback, apiOnline]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const loadPredictionsForModel = useCallback(
    async (modelName, { forceRefresh = false } = {}) => {
      if (!modelName || modelName === OVERVIEW_TAB) return;
      const hasPreds = (predictionsRef.current?.length ?? 0) > 0;
      if (!hasPreds && !forceRefresh) setPredLoading(true);
      if (hasPreds && forceRefresh) setPredRefreshing(true);
      setPredError(null);
      try {
        if (apiOnline === null) return;
        const pr = await getModelPredictions({
          model: modelName,
          limit: 2400,
          allowStaticFallback,
          forceRefresh,
        });
        if (pr.ok === false) {
          console.warn(`${LOG} model predictions:`, pr.error);
          setPredError(pr.error || "Failed");
          if (!hasPreds) setPredictions([]);
        } else {
          setPredictions(pr.rows ?? []);
        }
      } finally {
        setPredLoading(false);
        setPredRefreshing(false);
      }
    },
    [allowStaticFallback, apiOnline]
  );

  useEffect(() => {
    if (activeTab === OVERVIEW_TAB) {
      setPredictions([]);
      setPredError(null);
      setPredLoading(false);
      return;
    }
    loadPredictionsForModel(activeTab);
  }, [activeTab, loadPredictionsForModel]);

  const modelMetricsRaw = metricsPack?.model_metrics ?? [];
  const forecastMetrics = metricsPack?.forecast_metrics ?? [];
  const contextual = metricsPack?.contextual_comparison ?? [];

  const dedupedSorted = useMemo(
    () => dedupeModelMetricsByCanonical(modelMetricsRaw),
    [modelMetricsRaw]
  );

  const tabularRows = useMemo(
    () => dedupedSorted.filter((m) => isTabularNextHourGroup(m.model_name, m)),
    [dedupedSorted]
  );

  const sequenceRows = useMemo(
    () => dedupedSorted.filter((m) => isSequenceForecastingGroup(m.model_name, m)),
    [dedupedSorted]
  );

  const bestTabularRow = useMemo(() => pickBestTabularRow(dedupedSorted), [dedupedSorted]);
  const bestTabularApiName = bestTabularRow?.model_name ?? null;

  const bestSequenceRow = useMemo(() => pickBestSequenceRow(sequenceRows), [sequenceRows]);
  const bestSequenceApiName = bestSequenceRow?.model_name ?? null;
  const bestSequenceLabel = bestSequenceApiName
    ? displayModelLabel(bestSequenceApiName)
    : null;
  const hasValidSequenceRmse = Boolean(bestSequenceRow);

  const tabModelApiNames = useMemo(
    () => dedupedSorted.map((m) => m.model_name).filter(Boolean),
    [dedupedSorted]
  );

  const forecastPart = useMemo(
    () => forecastRowsPartition(forecastMetrics),
    [forecastMetrics]
  );

  const forecastTableSorted = useMemo(
    () => sortForecastTableRows(forecastPart.rows),
    [forecastPart.rows]
  );

  const tabularLeaderboardBars = useMemo(() => {
    return [...tabularRows].reverse().map((m) => ({
      model_name: displayModelLabel(m.model_name),
      test_rmse: Number(m.test_rmse ?? NaN),
    }));
  }, [tabularRows]);

  const sequenceLeaderboardBars = useMemo(() => {
    return [...sequenceRows].reverse().map((m) => ({
      model_name: displayModelLabel(m.model_name),
      test_rmse: Number(m.test_rmse ?? NaN),
    }));
  }, [sequenceRows]);

  const tabularMaeRmseH = useMemo(() => {
    return tabularRows.map((m) => ({
      label: displayModelLabel(m.model_name),
      mae: Number(m.test_mae ?? NaN),
      rmse: Number(m.test_rmse ?? NaN),
    }));
  }, [tabularRows]);

  const sequenceMaeRmseH = useMemo(() => {
    return sequenceRows.map((m) => ({
      label: displayModelLabel(m.model_name),
      mae: Number(m.test_mae ?? NaN),
      rmse: Number(m.test_rmse ?? NaN),
    }));
  }, [sequenceRows]);

  const tabularR2H = useMemo(() => {
    return tabularRows.map((m) => ({
      label: displayModelLabel(m.model_name),
      r2: Number(m.test_r2 ?? NaN),
    }));
  }, [tabularRows]);

  const sequenceR2H = useMemo(() => {
    return sequenceRows.map((m) => ({
      label: displayModelLabel(m.model_name),
      r2: Number(m.test_r2 ?? NaN),
    }));
  }, [sequenceRows]);

  const contextualTabularDeduped = useMemo(() => {
    const filtered = contextual.filter((c) => isTabularNextHourGroup(c.model_name, {}));
    return dedupeContextualByCanonical(filtered);
  }, [contextual]);

  const contextualHorizontalData = useMemo(() => {
    return [...contextualTabularDeduped]
      .sort(
        (a, b) =>
          (Number(a.context_test_rmse) || Infinity) -
          (Number(b.context_test_rmse) || Infinity)
      )
      .map((c) => ({
        label: displayModelLabel(c.model_name),
        base_rmse: Number(c.base_test_rmse ?? NaN),
        context_rmse: Number(c.context_test_rmse ?? NaN),
      }));
  }, [contextualTabularDeduped]);

  const contextualOverviewTableRows = useMemo(() => {
    return [...contextualTabularDeduped]
      .sort(
        (a, b) =>
          (Number(a.context_test_rmse) || Infinity) -
          (Number(b.context_test_rmse) || Infinity)
      )
      .map((c) => {
        const baseRmse = Number(c.base_test_rmse);
        const contextRmse = Number(c.context_test_rmse);
        return {
          model: displayModelLabel(c.model_name),
          baseRmse,
          contextRmse,
          difference: contextualDifferenceLabel(baseRmse, contextRmse),
        };
      });
  }, [contextualTabularDeduped]);

  const forecastChartBars = useMemo(() => {
    return [...forecastPart.chartRows]
      .sort((a, b) => Number(a.rmse) - Number(b.rmse))
      .reverse()
      .map((f) => ({
        model_name: f.model_name ?? "Model",
        rmse: Number(f.rmse ?? NaN),
      }));
  }, [forecastPart.chartRows]);

  const selectedMetricRow =
    activeTab !== OVERVIEW_TAB
      ? dedupedSorted.find((m) => modelsMatchCanonical(m.model_name, activeTab))
      : null;

  const contextLines = aggregatePredictionsByTime(predictions.slice(0, 2000));
  const predsHaveSeries = contextLines.length >= 4;
  const scatterDots = predictions
    .slice(0, 400)
    .map((r, i) => ({
      i,
      actual: Number(r.actual ?? r.y_true ?? NaN),
      pred: Number(r.predicted ?? r.y_pred ?? NaN),
    }))
    .filter((d) => Number.isFinite(d.actual) && Number.isFinite(d.pred));

  const xgboostIsBestTabular =
    bestTabularApiName && String(bestTabularApiName).toLowerCase() === "xgboost";

  const blockingUnknown = apiOnline === null;

  const forecast24hShowChart =
    forecastPart.rows.length > 0 && forecastPart.hasAnyNumeric;

  const sequenceModelsExplanationBody = (
    <div className="space-y-2">
      <p>
        Sequence and temporal models capture demand patterns across time windows. In this export,
        the best sequence/forecasting candidate is selected by the lowest valid RMSE.
      </p>
      <p>
        {hasValidSequenceRmse && bestSequenceLabel ? (
          <>Current best sequence/forecasting candidate: {bestSequenceLabel}.</>
        ) : (
          <>Current best sequence/forecasting candidate is unavailable in this export.</>
        )}
      </p>
      <p>
        GRU and LSTM remain useful recurrent baselines, while Temporal CNN can capture local
        temporal patterns efficiently.
      </p>
    </div>
  );

  const groupingExplainer =
    "Tabular models are used for next-hour pickup-demand prediction using engineered zone-hour features. Sequence models are used for broader temporal or multi-hour demand projection.";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Performance & Comparison"
        subtitle="Evaluate forecasting models for next-hour TLC pickup demand and 24-hour demand projection."
      >
        <GlassButton
          variant="primary"
          onClick={async () => {
            await loadMetrics({ forceRefresh: true });
            if (activeTab !== OVERVIEW_TAB)
              await loadPredictionsForModel(activeTab, { forceRefresh: true });
          }}
          disabled={metricsLoading && metricsPack == null}
        >
          <RefreshCcw size={16} strokeWidth={1.75} />
          Refresh metrics
        </GlassButton>
      </PageHeader>

      {metricsRefreshing ? (
        <p className="-mt-2 text-xs font-semibold text-brand-muted">Updating…</p>
      ) : null}

      <p className="-mt-2 text-xs leading-relaxed text-brand-muted">
        Metrics evaluate pickup-count prediction, not direct passenger waiting-time labels.
        Target:{" "}
        <span className="font-medium text-brand-text">target_pickup_count_next_hour</span>{" "}
        (next-hour TLC pickup demand; demand-pressure analysis, not observed waiting time).
      </p>

      <p className="text-xs leading-relaxed text-brand-muted">{groupingExplainer}</p>

      {!modelsMetaOk ? (
        <p className="text-xs text-amber-700">
          Model list from <code className="rounded bg-brand-bg px-1">/api/models</code> was
          unavailable; tabs use deduplicated names from{" "}
          <code className="rounded bg-brand-bg px-1">/api/models/metrics</code>.
        </p>
      ) : null}

      {blockingUnknown ? (
        <div className="rounded-xl border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">
          Checking API status…
        </div>
      ) : null}

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metricsLoading && metricsPack == null ? (
          <>
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
          </>
        ) : metricsError ? (
          <div className="sm:col-span-2 xl:col-span-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            Model metrics are unavailable. Please verify{" "}
            <code className="rounded bg-white px-1">/api/models/metrics</code>.{" "}
            <span className="text-rose-700">{metricsError}</span>
          </div>
        ) : (
          <>
            <KpiCard
              icon={Trophy}
              accent="teal"
              label="Best Tabular Next-Hour Model"
              value={
                bestTabularApiName ? displayModelLabel(bestTabularApiName) : "—"
              }
              subtext="Best tabular model for next-hour pickup-demand prediction based on holdout RMSE."
            />
            <KpiCard
              icon={BarChart2}
              accent="mint"
              label="Best Test RMSE"
              value={
                bestTabularRow?.test_rmse != null
                  ? formatDecimal(bestTabularRow.test_rmse, 3)
                  : "N/A"
              }
              subtext="Lower error indicates closer pickup-count predictions."
            />
            <KpiCard
              icon={Activity}
              accent="neutral"
              label="Best Test MAE"
              value={
                bestTabularRow?.test_mae != null
                  ? formatDecimal(bestTabularRow.test_mae, 3)
                  : "N/A"
              }
              subtext="Average absolute pickup-count error."
            />
            <KpiCard
              icon={LineChartIcon}
              accent="mint"
              label="Best Test R²"
              value={
                bestTabularRow?.test_r2 != null
                  ? formatDecimal(bestTabularRow.test_r2, 3)
                  : "N/A"
              }
              subtext="Higher values indicate stronger fit to pickup-count variation."
            />
            <SequenceCandidateKpiCard
              icon={Layers}
              label="Best Sequence Candidate"
              value={bestSequenceLabel ?? "N/A"}
              subtext={
                hasValidSequenceRmse
                  ? "Lowest valid RMSE among sequence/forecasting candidates."
                  : "Valid sequence holdout metrics unavailable in this export."
              }
            />
          </>
        )}
      </div>

      {!metricsLoading && !metricsError && metricsPack != null ? (
        <p className="text-xs leading-relaxed text-brand-muted">
          Sequence models are evaluated separately because they target temporal forecasting behavior
          rather than the same tabular next-hour comparison.
        </p>
      ) : null}

      {/* Explore Models tabs */}
      <section className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
        <h2 className="text-base font-semibold text-brand-text">Explore Models</h2>
        <p className="mt-1 text-xs text-brand-muted">
          Compare models by group and open a dedicated profile for each exported model (one tab per
          unique model).
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setActiveTab(OVERVIEW_TAB)}
            className={`rounded-lg border px-3 py-2 text-left text-sm font-medium leading-snug transition-colors ${
              activeTab === OVERVIEW_TAB
                ? "border-[#006b5c] bg-[#006b5c] text-white shadow-sm"
                : "border-brand-border bg-brand-bg text-brand-text hover:border-brand-primary/50"
            }`}
          >
            Overview
          </button>
          {tabModelApiNames.map((apiName) => (
            <button
              key={apiName}
              type="button"
              onClick={() => setActiveTab(apiName)}
              className={`max-w-full rounded-lg border px-3 py-2 text-left text-sm font-medium leading-snug transition-colors whitespace-normal ${
                activeTab === apiName
                  ? "border-[#006b5c] bg-[#006b5c] text-white shadow-sm"
                  : "border-brand-border bg-white text-brand-text hover:border-brand-primary/50"
              }`}
            >
              {displayModelLabel(apiName)}
            </button>
          ))}
        </div>
      </section>

      {/* Tab body */}
      {!metricsError && !(metricsLoading && metricsPack == null) ? (
        activeTab === OVERVIEW_TAB ? (
          <div className="space-y-8">
            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-brand-text">
                  Tabular Next-Hour Model Comparison
                </h3>
                <p className="mt-1 text-sm text-brand-muted">
                  These models predict next-hour TLC pickup demand using engineered zone-hour
                  features.
                </p>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <SectionCard
                  title="Tabular RMSE Leaderboard"
                  subtitle="Lower RMSE means better pickup-count prediction within the tabular group."
                >
                  {tabularRows.length ? (
                    <div className="h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          layout="vertical"
                          data={tabularLeaderboardBars}
                          margin={{ left: 8, right: 8 }}
                        >
                          <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                          <XAxis type="number" tickFormatter={(v) => formatDecimal(v, 2)} />
                          <YAxis
                            type="category"
                            dataKey="model_name"
                            width={140}
                            tick={{ fontSize: 11 }}
                          />
                          <Tooltip formatter={(v) => formatDecimal(v, 3)} />
                          <Bar dataKey="test_rmse" name="Test RMSE" radius={[0, 6, 6, 0]}>
                            {tabularLeaderboardBars.map((_, i, arr) => (
                              <Cell
                                key={i}
                                fill={i === arr.length - 1 ? "#00856f" : "#BFEFE3"}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-brand-muted">
                      No tabular next-hour models found in this export.
                    </p>
                  )}
                </SectionCard>

                <SectionCard
                  title="MAE vs RMSE (tabular)"
                  subtitle="Grouped comparison without crowding vertical category labels."
                >
                  <HorizontalGroupedMaeRmse data={tabularMaeRmseH} />
                </SectionCard>
              </div>

              <SectionCard
                title="Explained Variance — Tabular (R²)"
                subtitle="Higher R² indicates stronger fit to pickup-count variation."
              >
                <HorizontalR2Chart data={tabularR2H} />
              </SectionCard>
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-brand-text">
                  Sequence and Forecasting Model Comparison
                </h3>
                <p className="mt-1 text-sm text-brand-muted">
                  These models capture temporal demand patterns and should be interpreted separately
                  from the tabular next-hour comparison.
                </p>
                {bestSequenceLabel ? (
                  <p className="mt-2 text-sm font-medium text-brand-text">
                    Best sequence/forecasting candidate: {bestSequenceLabel}
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-brand-muted">
                    Sequence forecast metrics are unavailable in the current export.
                  </p>
                )}
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <SectionCard
                  title="Sequence RMSE Leaderboard"
                  subtitle="Holdout RMSE for sequence / naive forecasting candidates in this export."
                >
                  {sequenceRows.length ? (
                    <div className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          layout="vertical"
                          data={sequenceLeaderboardBars}
                          margin={{ left: 8, right: 8 }}
                        >
                          <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                          <XAxis type="number" tickFormatter={(v) => formatDecimal(v, 2)} />
                          <YAxis
                            type="category"
                            dataKey="model_name"
                            width={148}
                            tick={{ fontSize: 11 }}
                          />
                          <Tooltip formatter={(v) => formatDecimal(v, 3)} />
                          <Bar dataKey="test_rmse" name="Test RMSE" radius={[0, 6, 6, 0]} fill="#003D34" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-brand-muted">
                      No sequence or forecasting models found in this export.
                    </p>
                  )}
                </SectionCard>

                <SectionCard
                  title="MAE vs RMSE (sequence)"
                  subtitle="Grouped bars — interpret alongside tabular charts only with the grouping note above."
                >
                  <HorizontalGroupedMaeRmse data={sequenceMaeRmseH} />
                </SectionCard>
              </div>

              <SectionCard
                title="Explained Variance — Sequence (R²)"
                subtitle="Explained variance for temporal / naive candidates."
              >
                <HorizontalR2Chart data={sequenceR2H} />
              </SectionCard>
            </section>

            <SectionCard
              title="Contextual Features vs Base Model"
              subtitle="Compares baseline features with weather and incident context using RMSE."
            >
              <p className="mb-4 text-sm leading-relaxed text-brand-muted">
                Weather and incident features add real-world context to the prediction task. This
                comparison shows how each model responds to contextual transportation signals.
              </p>
              {contextualHorizontalData.length ? (
                <>
                  <HorizontalContextualBaseContextChart data={contextualHorizontalData} />
                  <div className="mt-4 overflow-x-auto rounded-lg border border-brand-border">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-brand-bg">
                        <tr>
                          <th className="px-3 py-2 text-xs uppercase text-brand-muted">Model</th>
                          <th className="px-3 py-2 text-xs uppercase text-brand-muted">Base RMSE</th>
                          <th className="px-3 py-2 text-xs uppercase text-brand-muted">
                            Context RMSE
                          </th>
                          <th className="px-3 py-2 text-xs uppercase text-brand-muted">
                            Difference
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {contextualOverviewTableRows.map((r) => (
                          <tr
                            key={canonicalDisplayKey(r.model)}
                            className="border-t border-brand-border"
                          >
                            <td className="px-3 py-2 font-medium text-brand-text">{r.model}</td>
                            <td className="px-3 py-2 tabular-nums">{formatDecimal(r.baseRmse, 3)}</td>
                            <td className="px-3 py-2 tabular-nums">
                              {formatDecimal(r.contextRmse, 3)}
                            </td>
                            <td className="px-3 py-2 text-brand-muted">{r.difference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="rounded-lg border border-brand-border bg-brand-bg px-3 py-3 text-sm text-brand-muted">
                  Contextual comparison is unavailable in the current export.
                </p>
              )}
            </SectionCard>
          </div>
        ) : (
          <ModelDetailPanel
            modelRow={selectedMetricRow}
            dedupedSorted={dedupedSorted}
            contextualRows={contextual}
            predLoading={predLoading && predictions.length === 0}
            predRefreshing={predRefreshing}
            predError={predError}
            predsHaveSeries={predsHaveSeries}
            contextLines={contextLines}
            scatterDots={scatterDots}
            predictions={predictions}
          />
        )
      ) : metricsLoading && metricsPack == null ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartSkeleton className="h-[300px]" />
          <ChartSkeleton className="h-[300px]" />
        </div>
      ) : null}

      {/* Full metrics table */}
      {!(metricsLoading && metricsPack == null) && !metricsError && dedupedSorted.length ? (
        <SectionCard
          title="Full Model Metrics Table"
          subtitle="Deduplicated holdout metrics — one row per model; groups separate tabular next-hour from sequence / forecasting."
        >
          <FullModelMetricsTable
            sortedDeduped={dedupedSorted}
            bestTabularApiName={bestTabularApiName}
            selectedApiModelName={activeTab !== OVERVIEW_TAB ? activeTab : null}
            bestSequenceApiName={bestSequenceApiName}
          />
        </SectionCard>
      ) : null}

      {/* Why cards stacked → 24H section */}
      {!(metricsLoading && metricsPack == null) && !metricsError ? (
        <div className="space-y-4">
          <ExplanationCard
            title="Why XGBoost for Next-Hour Prediction?"
            badge="tabular"
            body={
              xgboostIsBestTabular
                ? 'XGBoost is highlighted as the main tabular model for next-hour pickup-demand prediction because it works well with engineered zone-hour features such as lagged pickup demand, weather variables, incident indicators, and zone-level patterns. In the tabular comparison, it achieved the strongest holdout RMSE.'
                : "XGBoost is highlighted as the main tabular model for next-hour pickup-demand prediction because it works well with engineered zone-hour features such as lagged pickup demand, weather variables, incident indicators, and zone-level patterns."
            }
          />
          <ExplanationCard
            title="Why Sequence Models for Multi-Hour Forecasting?"
            badge="forecast"
            body={sequenceModelsExplanationBody}
          />
          {!forecast24hShowChart ? (
            <div className="rounded-xl border border-brand-border bg-gradient-to-br from-white to-brand-bg p-4 shadow-card">
              <h4 className="text-sm font-semibold text-brand-text">24-Hour Forecast Metrics</h4>
              <p className="mt-2 text-sm leading-snug text-brand-muted">
                Dedicated 24-hour forecast metrics are not available in the current export. Sequence
                candidates are still compared above using available holdout metrics.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {forecast24hShowChart ? (
        <SectionCard
          title="24-Hour Forecasting Models"
          subtitle="Multi-hour demand projection — interpret separately from next-hour tabular models."
        >
          <p className="mb-4 text-sm leading-relaxed text-brand-muted">
            These models evaluate multi-hour demand projection and should be interpreted separately
            from next-hour tabular pickup-demand models. Sequence models such as GRU and LSTM capture
            temporal dependencies across several hours, while naive baselines provide a simple
            comparison point.
          </p>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={forecastChartBars}
                margin={{ left: 8, right: 8 }}
              >
                <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => formatDecimal(v, 2)} />
                <YAxis type="category" dataKey="model_name" width={160} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => formatDecimal(v, 3)} />
                <Bar dataKey="rmse" name="Forecast RMSE" radius={[0, 6, 6, 0]} fill="#003D34" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {forecastPart.chartRows.length < forecastPart.rows.length ? (
            <p className="mt-3 text-xs text-brand-muted">
              Rows without numeric RMSE are excluded from the chart.
            </p>
          ) : null}
          <div className="mt-6 overflow-x-auto rounded-lg border border-brand-border">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-brand-bg">
                <tr>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">Model</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">
                    Benchmark / Type
                  </th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">MAE</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">RMSE</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">R²</th>
                </tr>
              </thead>
              <tbody>
                {forecastTableSorted.map((row, idx) => (
                  <tr key={`${row.model_name}-${idx}`} className="border-t border-brand-border">
                    <td className="px-3 py-2 font-medium">{row.model_name ?? "—"}</td>
                    <td className="px-3 py-2 text-brand-muted">
                      {forecastBenchmarkLabel(row)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {isFiniteMetric(row.mae) ? formatDecimal(row.mae, 3) : "N/A"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {isFiniteMetric(row.rmse) ? formatDecimal(row.rmse, 3) : "N/A"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {isFiniteMetric(row.r2) ? formatDecimal(row.r2, 3) : "N/A"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function SelectedModelContextualSection({ contextualRow }) {
  if (!contextualRow) {
    return (
      <div className="rounded-xl border border-brand-border bg-brand-bg px-3 py-3 text-sm text-brand-muted shadow-card">
        Base vs contextual comparison is unavailable for this selected model.
      </div>
    );
  }

  const baseRmse = Number(contextualRow.base_test_rmse);
  const ctxRmse = Number(contextualRow.context_test_rmse);
  const baseMae = Number(contextualRow.base_test_mae);
  const ctxMae = Number(contextualRow.context_test_mae);
  const baseR2 = Number(contextualRow.base_test_r2);
  const ctxR2 = Number(contextualRow.context_test_r2);

  const hasRmsePair = Number.isFinite(baseRmse) && Number.isFinite(ctxRmse);
  const hasMaePair = Number.isFinite(baseMae) && Number.isFinite(ctxMae);

  if (!hasRmsePair && !hasMaePair) {
    return (
      <div className="rounded-xl border border-brand-border bg-brand-bg px-3 py-3 text-sm text-brand-muted shadow-card">
        Base vs contextual comparison is unavailable for this selected model.
      </div>
    );
  }

  const chartData = [];
  if (hasRmsePair) chartData.push({ metric: "RMSE", Base: baseRmse, Context: ctxRmse });
  if (hasMaePair) chartData.push({ metric: "MAE", Base: baseMae, Context: ctxMae });

  const interpretation = hasRmsePair
    ? interpretSelectedContextual(baseRmse, ctxRmse)
    : hasMaePair
      ? interpretSelectedContextualGeneric(baseMae, ctxMae)
      : "Base and contextual features performed similarly for this model.";

  return (
    <SectionCard
      title="Base vs Contextual Features — Selected Model"
      subtitle="Shows how weather and incident context changed the selected model’s holdout metrics."
    >
      <div className="flex flex-wrap gap-2">
        {hasRmsePair ? (
          <>
            <span className="inline-flex items-center rounded-full border border-brand-border bg-brand-bg px-3 py-1 text-xs text-brand-text">
              Base RMSE <span className="ml-1 tabular-nums font-semibold">{formatDecimal(baseRmse, 3)}</span>
            </span>
            <span className="inline-flex items-center rounded-full border border-brand-border bg-brand-mint/80 px-3 py-1 text-xs text-brand-deep">
              Context RMSE{" "}
              <span className="ml-1 tabular-nums font-semibold">{formatDecimal(ctxRmse, 3)}</span>
            </span>
            <span className="inline-flex items-center rounded-full border border-brand-border bg-white px-3 py-1 text-xs text-brand-muted">
              Difference{" "}
              <span className="ml-1 font-medium text-brand-text">
                {contextualDifferenceLabel(baseRmse, ctxRmse)}
              </span>
            </span>
          </>
        ) : null}
        {Number.isFinite(baseR2) && Number.isFinite(ctxR2) ? (
          <>
            <span className="inline-flex items-center rounded-full border border-brand-border bg-brand-bg px-3 py-1 text-xs text-brand-text">
              Base R² <span className="ml-1 tabular-nums font-semibold">{formatDecimal(baseR2, 3)}</span>
            </span>
            <span className="inline-flex items-center rounded-full border border-brand-border bg-brand-mint/80 px-3 py-1 text-xs text-brand-deep">
              Context R² <span className="ml-1 tabular-nums font-semibold">{formatDecimal(ctxR2, 3)}</span>
            </span>
          </>
        ) : null}
      </div>

      {chartData.length ? (
        <div className="mt-4 h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
              <XAxis dataKey="metric" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatDecimal(v, 3)} />
              <Legend />
              <Bar dataKey="Base" name="Base" fill="#BFEFE3" radius={[6, 6, 0, 0]} />
              <Bar dataKey="Context" name="Context" fill="#00856f" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      <p className="mt-3 text-sm leading-relaxed text-brand-muted">{interpretation}</p>
      <p className="mt-2 text-[11px] text-brand-muted">
        Effect differs by model — use the Overview contextual chart to compare responses across the
        full leaderboard.
      </p>
    </SectionCard>
  );
}

function ModelDetailPanel({
  modelRow,
  dedupedSorted,
  contextualRows,
  predLoading,
  predRefreshing,
  predError,
  predsHaveSeries,
  contextLines,
  scatterDots,
  predictions,
}) {
  if (!modelRow) {
    return (
      <div className="rounded-xl border border-brand-border bg-white p-6 text-sm text-brand-muted shadow-card">
        Model metrics for this tab were not found in the loaded export.
      </div>
    );
  }

  const apiName = modelRow.model_name ?? "Model";
  const label = displayModelLabel(apiName);
  const group = modelGroupLabel(modelRow);
  const rankOverall = rankByRmse(apiName, dedupedSorted);
  const rankTab = rankInGroup(apiName, dedupedSorted, (m) =>
    isTabularNextHourGroup(m.model_name, m)
  );
  const rankSeq = rankInGroup(apiName, dedupedSorted, (m) =>
    isSequenceForecastingGroup(m.model_name, m)
  );
  const block = strengthsBlock(label);

  const rmse = modelRow.test_rmse;
  const mae = modelRow.test_mae;
  const r2 = modelRow.test_r2;

  const contextualMatch = findContextualRowForModel(contextualRows ?? [], apiName);

  const previewRows = (predictions ?? []).slice(0, 12).map((r) => {
    const actual = Number(r.actual ?? r.y_true ?? NaN);
    const pred = Number(r.predicted ?? r.y_pred ?? NaN);
    const err = Number.isFinite(actual) && Number.isFinite(pred) ? pred - actual : NaN;
    return {
      timestamp: r.timestamp,
      zone_id: r.zone_id ?? r.zone ?? "—",
      actual,
      pred,
      err,
    };
  });

  const groupRankLine =
    group === GROUP_TABULAR
      ? "Tabular Next-Hour"
      : group === GROUP_SEQUENCE
        ? "Sequence / Forecasting"
        : group;

  const groupRankDetail =
    group === GROUP_TABULAR && rankTab
      ? `Rank ${rankTab} by RMSE within tabular models`
      : group === GROUP_SEQUENCE && rankSeq
        ? `Rank ${rankSeq} by RMSE within sequence models`
        : null;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-brand-border bg-white p-5 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
            Model profile
          </div>
          <h3 className="mt-1 text-xl font-semibold text-brand-text">{label}</h3>
          <p className="mt-2 text-sm text-brand-muted">
            <span className="font-medium text-brand-text">{groupRankLine}</span>
            {groupRankDetail ? (
              <>
                {" "}
                · <span className="text-brand-muted">{groupRankDetail}</span>
              </>
            ) : null}
            {rankOverall ? (
              <>
                {" "}
                · Overall rank <span className="tabular-nums">{rankOverall}</span> of{" "}
                <span className="tabular-nums">{dedupedSorted.length}</span>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-brand-muted">
            Type: <span className="font-medium text-brand-text">{friendlyModelType(modelRow)}</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-brand-muted">{block.explanation}</p>
        </div>

        <div className="rounded-xl border border-brand-border bg-white p-5 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
            Selected model metrics
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-brand-muted">RMSE</dt>
              <dd className="mt-1 font-semibold tabular-nums text-brand-text">
                {formatDecimal(rmse, 3)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-brand-muted">MAE</dt>
              <dd className="mt-1 font-semibold tabular-nums text-brand-text">
                {formatDecimal(mae, 3)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-brand-muted">R²</dt>
              <dd className="mt-1 font-semibold tabular-nums text-brand-text">
                {formatDecimal(r2, 3)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-brand-muted">
            RMSE emphasizes larger pickup-count errors; MAE summarizes typical absolute error. R²
            describes how much pickup-count variation the model explains on the holdout split.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
          <div className="mb-2 text-sm font-semibold text-brand-text">Strengths</div>
          <p className="text-sm text-brand-muted">{block.strengths}</p>
        </div>
        <div className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
          <div className="mb-2 text-sm font-semibold text-brand-text">Use case</div>
          <p className="text-sm text-brand-muted">{block.useCase}</p>
        </div>
      </div>

      <SectionCard
        title="Actual vs Predicted"
        subtitle="Holdout preview trace for the selected forecasting model."
      >
        {predRefreshing ? (
          <p className="mb-2 text-xs font-semibold text-brand-muted">Updating…</p>
        ) : null}
        {predLoading ? (
          <ChartSkeleton className="h-72" />
        ) : predError ? (
          <p className="text-sm text-brand-muted">
            Prediction trace is unavailable for this model.
            <span className="mt-1 block text-xs text-rose-700">{predError}</span>
          </p>
        ) : !predictions?.length ? (
          <p className="text-sm text-brand-muted">
            Prediction trace is unavailable for this model.
          </p>
        ) : predsHaveSeries ? (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={contextLines.slice(-160)}>
                <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                <XAxis dataKey="timestamp" tick={{ fontSize: 9 }} hide />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(l) => l}
                  formatter={(value) => formatDecimal(value, 3)}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="actualAvg"
                  stroke="#00856f"
                  name="Actual pickups"
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="predAvg"
                  stroke="#F7B731"
                  name="Predicted pickups"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : scatterDots.length > 40 ? (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ bottom: 8 }}>
                <CartesianGrid strokeDasharray="5 10" stroke="#E3EEE9" />
                <XAxis type="number" dataKey="actual" name="Actual pickups" />
                <YAxis type="number" dataKey="pred" name="Predicted pickups" />
                <ZAxis range={[18, 18]} />
                <Tooltip formatter={(value) => formatDecimal(value, 3)} />
                <Scatter data={scatterDots} fill="#00856f77" />
              </ScatterChart>
            </ResponsiveContainer>
            <p className="mt-2 text-[11px] text-brand-muted">
              Timestamp coverage is sparse in this preview; showing an Actual pickups vs Predicted
              pickups scatter for visibility.
            </p>
          </div>
        ) : (
          <p className="text-sm text-brand-muted">
            Prediction trace is unavailable for this model.
          </p>
        )}
      </SectionCard>

      <SelectedModelContextualSection contextualRow={contextualMatch} />

      {previewRows.length ? (
        <SectionCard
          title="Prediction preview"
          subtitle="Recent holdout rows for the selected model."
        >
          <div className="overflow-x-auto rounded-lg border border-brand-border">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-brand-bg">
                <tr>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">Time</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">Zone</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">Actual Pickups</th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">
                    Predicted Pickups
                  </th>
                  <th className="px-3 py-2 text-xs uppercase text-brand-muted">Error</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i} className="border-t border-brand-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.timestamp ? String(r.timestamp).slice(0, 19) : "—"}
                    </td>
                    <td className="px-3 py-2">{r.zone_id}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDecimal(r.actual, 3)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDecimal(r.pred, 3)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDecimal(r.err, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function ExplanationCard({ title, body, badge }) {
  return (
    <div className="rounded-xl border border-brand-border bg-gradient-to-br from-white to-brand-bg p-5 shadow-card">
      <div className="mb-3 inline-flex items-center rounded-full bg-brand-mint px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-primary">
        {badge}
      </div>
      <h4 className="text-lg font-semibold text-brand-text">{title}</h4>
      <div className="mt-2 text-sm leading-relaxed text-brand-muted">{body}</div>
    </div>
  );
}

function EmptyMetricsNote() {
  return (
    <p className="rounded-lg border border-dashed border-brand-border bg-brand-bg p-8 text-center text-sm text-brand-muted">
      Model metrics are unavailable. Please verify{" "}
      <code className="rounded bg-white px-1">/api/models/metrics</code>.
    </p>
  );
}
