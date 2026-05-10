/**
 * MASEER frontend API client.
 *
 * Every helper first attempts the live FastAPI backend (`/api/...`).  When
 * the backend is unreachable the helper falls back to the exported JSON
 * snapshots under `frontend/public/data/` so the dashboard remains usable in
 * "Exported Data Fallback" mode.
 */

/** Vite dev: proxy ``/api`` → FastAPI. Override with full origin if needed. */
const API_BASE = String(import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

const FALLBACK_PATHS = {
  overview: "/data/overview.json",
  model_metrics: "/data/model_metrics.json",
  forecast_metrics: "/data/forecast_metrics.json",
  contextual_comparison: "/data/contextual_comparison.json",
  zone_pressure: "/data/zone_pressure.json",
  top_zones: "/data/top_zones.json",
  predictions_preview: "/data/predictions_preview.json",
  dataset_summary: "/data/dataset_summary.json",
  feature_dictionary: "/data/feature_dictionary.json",
  event_integration_summary: "/data/event_integration_summary.json",
  scenario_defaults: "/data/scenario_defaults.json",
  app_config: "/data/app_config.json",
  taxi_zones_geojson: "/data/taxi_zones.geojson",
};

function url(pathSuffix) {
  const suffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  const base = API_BASE.endsWith("/api")
    ? API_BASE
    : `${API_BASE}/api`;
  return `${base}${suffix}`;
}

const LOG = "[MASEER]";

/** Build the same absolute GET URL the client uses (for cache peek helpers). */
export function apiUrl(relPath) {
  const p = String(relPath).replace(/^\/+/, "");
  return url(p);
}

/** In-memory GET response cache (successful responses only). */
const apiCache = new Map();
const inflightCache = new Map();
/** Static JSON fallback file cache (keyed by relative path). */
const staticCache = new Map();
const staticInflight = new Map();
/** Last successful aggregate bundle for DataInfo so navigation feels instant. */
let lastDataInfoBundle = null;

export function makeCacheKey(fullUrl) {
  return String(fullUrl);
}

export function clearApiCache() {
  apiCache.clear();
  inflightCache.clear();
  staticCache.clear();
  staticInflight.clear();
  lastDataInfoBundle = null;
}

export function peekCachedApiUrl(fullUrl) {
  const hit = apiCache.get(makeCacheKey(fullUrl));
  if (!hit?.ok) return null;
  const r = hit.result;
  return { ok: r.ok, data: r.data, status: r.status };
}

/** Synchronous peek for the most recent successful DataInfo aggregate. */
export function peekCachedDataInfo() {
  return lastDataInfoBundle;
}

async function fetchApiGetCached(fullUrl, { forceRefresh = false } = {}) {
  const key = makeCacheKey(fullUrl);
  const inflightKey = forceRefresh ? `${key}\u0000force` : key;

  if (!forceRefresh) {
    const cached = apiCache.get(key);
    if (cached?.ok) {
      console.info(`${LOG} cache hit: ${fullUrl}`);
      return {
        ok: cached.result.ok,
        data: cached.result.data,
        status: cached.result.status,
      };
    }
    const waitInflight = inflightCache.get(inflightKey);
    if (waitInflight) return waitInflight;
  } else {
    const waitInflight = inflightCache.get(inflightKey);
    if (waitInflight) return waitInflight;
  }

  const p = (async () => {
    try {
      const res = await fetch(fullUrl, { method: "GET" });
      const data = await res.json().catch(() => null);
      const result = !res.ok ? { ok: false, data, status: res.status } : { ok: true, data, status: res.status };
      if (result.ok) {
        apiCache.set(key, { ok: true, result: { ...result }, fetchedAt: Date.now() });
      }
      return result;
    } catch {
      return { ok: false, data: null, status: 0 };
    } finally {
      inflightCache.delete(inflightKey);
    }
  })();

  inflightCache.set(inflightKey, p);
  return p;
}

function logEndpointFailure(path, status, detail = "") {
  const extra = detail ? ` ${detail}` : "";
  console.warn(`${LOG} endpoint failed: ${path} (status=${status})${extra}`);
}

function logStaticFallbackFor(endpoint, reason) {
  console.info(`${LOG} static JSON fallback for ${endpoint} — ${reason}`);
}

export function logFallbackMode(reason) {
  console.warn(`${LOG} exported data fallback mode — ${reason}`);
}

async function fetchJsonQuiet(input, opts) {
  try {
    const res = await fetch(input, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, data, status: res.status };
    return { ok: true, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

async function fetchStatic(path, fallback = null) {
  const key = String(path);
  if (staticCache.has(key)) {
    return staticCache.get(key);
  }
  const inflight = staticInflight.get(key);
  if (inflight) {
    const cached = await inflight;
    return cached !== undefined ? cached : fallback;
  }
  const p = (async () => {
    try {
      const { ok, data } = await fetchJsonQuiet(path);
      if (ok) {
        staticCache.set(key, data);
        return data;
      }
      return undefined;
    } finally {
      staticInflight.delete(key);
    }
  })();
  staticInflight.set(key, p);
  const result = await p;
  return result !== undefined ? result : fallback;
}

function computePressureRatio(row) {
  const pred =
    row.predicted_next_hour_pickups != null ? Number(row.predicted_next_hour_pickups) : null;
  const denom = Number(row.pickup_count_roll_mean_24);
  if (!Number.isFinite(pred) || !Number.isFinite(denom) || denom <= 0) {
    const r = row.pressure_ratio ?? row.observed_pressure_ratio;
    return Number.isFinite(Number(r)) ? Number(r) : null;
  }
  return pred / denom;
}

function pressureLabel(ratio) {
  const v = Number(ratio);
  if (!Number.isFinite(v)) return "Unavailable";
  if (v >= 1.35) return "High";
  if (v >= 1.15) return "Elevated";
  if (v >= 0.8) return "Typical";
  return "Low";
}

function uniqTimestamps(rows, limit) {
  const set = new Set(rows.map((r) => String(r.timestamp)).filter(Boolean));
  const sorted = [...set].sort();
  if (limit == null || limit <= 0 || limit >= sorted.length) return sorted;
  return sorted.slice(-limit);
}

function buildSnapshotFallback({ timestamp = null, borough = null } = {}) {
  return (async () => {
    const [zonePressure, overviewMeta] = await Promise.all([
      fetchStatic(FALLBACK_PATHS.zone_pressure, []),
      fetchStatic(FALLBACK_PATHS.overview, {}),
    ]);

    let rows = Array.isArray(zonePressure) ? [...zonePressure] : [];
    if (timestamp) {
      const match = rows.filter((r) => String(r.timestamp) === timestamp);
      if (match.length) rows = match;
    }
    if (!timestamp && rows.length) {
      const latest = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort().at(-1);
      if (latest) rows = rows.filter((r) => r.timestamp === latest);
    }
    if (borough && borough.toLowerCase() !== "all") {
      rows = rows.filter((r) => String(r.borough).toLowerCase() === borough.toLowerCase());
    }

    rows = rows.map((r) => {
      const pred = r.predicted_next_hour_pickups ?? r.observed_next_hour_pickups ?? null;
      const ratio = r.pressure_ratio ?? computePressureRatio({ ...r, predicted_next_hour_pickups: pred });
      return {
        ...r,
        predicted_next_hour_pickups: pred,
        pressure_ratio: ratio,
        pressure_label: r.pressure_label ?? pressureLabel(ratio),
        prediction_source: "exported_data_fallback",
      };
    });

    const highPressure = rows.filter(
      (r) => Number(r.pressure_ratio ?? r.observed_pressure_ratio) >= 1.35
    ).length;
    const incidentRows = rows.filter(
      (r) => Number(r.zone_incident_count) > 0 || Number(r.incident_flag) > 0
    );
    const totalPredicted =
      rows
        .map((r) => Number(r.predicted_next_hour_pickups))
        .filter(Number.isFinite)
        .reduce((a, b) => a + b, 0) || null;

    let peakBorough = null;
    const sums = {};
    for (const r of rows) {
      const b = r.borough || "—";
      const v = Number(r.predicted_next_hour_pickups ?? 0);
      sums[b] = (sums[b] || 0) + (Number.isFinite(v) ? v : 0);
    }
    let peakValue = -Infinity;
    for (const [b, v] of Object.entries(sums)) {
      if (v > peakValue) {
        peakValue = v;
        peakBorough = b;
      }
    }

    const first = rows[0] || {};
    const weatherStatus =
      first.weather_status ??
      first.weather_category ??
      (Number(first.precipitation) > 0 ? "Rain" : "Dry Conditions");

    return {
      prediction_source: "exported_data_fallback",
      timestamp: first.timestamp ?? null,
      model: overviewMeta.best_tabular_model ?? "XGBoost",
      summary: {
        timestamp: first.timestamp ?? null,
        rows_returned: rows.length,
        citywide_predicted_next_hour_pickups: totalPredicted,
        high_pressure_zone_count: highPressure,
        active_incident_rows: incidentRows.length,
        weather_status: weatherStatus,
        peak_borough: peakBorough,
      },
      rows,
    };
  })();
}

// ---------------------------------------------------------------------------
// Health & metadata
// ---------------------------------------------------------------------------

export async function getHealth() {
  const r = await fetchJsonQuiet(url("/health"));
  if (!r.ok) return { ok: false, data: r.data ?? null, status: r.status };
  return { ok: true, data: r.data ?? {}, status: 200 };
}

export async function getOverview({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/overview";
  const r = await fetchApiGetCached(url("/overview"), { forceRefresh });
  if (r.ok && r.data && typeof r.data === "object") {
    return { ok: true, source: "api", data: r.data };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return { ok: false, source: "api", data: null, error: `overview unavailable (status ${r.status})` };
  }
  logStaticFallbackFor(path, "/api/overview not OK while static fallback allowed");
  const ov = await fetchStatic(FALLBACK_PATHS.overview, {});
  const ds = await fetchStatic(FALLBACK_PATHS.dataset_summary, {});
  return {
    ok: true,
    source: "static",
    data: {
      ...ov,
      rows: ds.rows ?? ov.rows,
      columns: ds.columns ?? ov.columns,
      zones: ds.number_of_zones ?? ov.zones,
      time_range_start: ds.time_range_start,
      time_range_end: ds.time_range_end,
    },
  };
}

/**
 * Get all hourly timestamps known to the backend.
 * Accepts either ``getTimestamps()`` or the legacy
 * ``getTimestamps(zoneId, { maxTimestamps })`` shape used by older pages.
 */
export async function getTimestamps(zoneIdOrOpts = null, legacyOpts = {}) {
  const params = new URLSearchParams();
  let zoneId = null;
  let allowStaticFallback = true;
  let forceRefresh = false;
  if (typeof zoneIdOrOpts === "object" && zoneIdOrOpts !== null) {
    zoneId = zoneIdOrOpts.zoneId ?? null;
    if (typeof zoneIdOrOpts.allowStaticFallback === "boolean") {
      allowStaticFallback = zoneIdOrOpts.allowStaticFallback;
    }
    if (typeof zoneIdOrOpts.forceRefresh === "boolean") {
      forceRefresh = zoneIdOrOpts.forceRefresh;
    }
  } else if (zoneIdOrOpts != null) {
    zoneId = zoneIdOrOpts;
  }
  if (typeof legacyOpts.allowStaticFallback === "boolean") {
    allowStaticFallback = legacyOpts.allowStaticFallback;
  }
  if (typeof legacyOpts.forceRefresh === "boolean") {
    forceRefresh = legacyOpts.forceRefresh;
  }
  if (zoneId != null) params.set("zone_id", String(zoneId));
  const q = params.toString() ? `?${params}` : "";
  const path = `/api/timestamps${q}`;
  const r = await fetchApiGetCached(url(`/timestamps${q}`), { forceRefresh });
  if (r.ok && r.data && Array.isArray(r.data.timestamps)) {
    return {
      ok: true,
      source: "api",
      rows: r.data.timestamps,
      count: Number(r.data.count ?? r.data.timestamps.length),
      min: r.data.min ?? null,
      max: r.data.max ?? null,
    };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      count: 0,
      min: null,
      max: null,
      error: `timestamps unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "timestamps API not OK while static fallback allowed");
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  let arr = Array.isArray(zp) ? zp : [];
  if (zoneId != null) arr = arr.filter((x) => Number(x.zone_id) === Number(zoneId));
  const max = legacyOpts.maxTimestamps;
  const fromData = uniqTimestamps(arr, max && max > 0 ? max : 0).reverse();
  return {
    ok: true,
    source: "static",
    rows: fromData,
    count: fromData.length,
    min: fromData.at(-1) ?? null,
    max: fromData[0] ?? null,
  };
}

export async function getModels({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/models";
  const r = await fetchApiGetCached(url("/models"), { forceRefresh });
  if (r.ok && r.data && Array.isArray(r.data.models)) {
    return {
      ok: true,
      source: "api",
      models: r.data.models,
      default_model: r.data.default_model ?? r.data.models[0] ?? null,
    };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      models: [],
      default_model: null,
      error: `models unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "models API not OK while static fallback allowed");
  const mm = await fetchStatic(FALLBACK_PATHS.model_metrics, []);
  const ov = await fetchStatic(FALLBACK_PATHS.overview, {});
  const names = Array.isArray(mm) ? [...new Set(mm.map((m) => m.model_name).filter(Boolean))] : [];
  return {
    ok: true,
    source: "static",
    models: names,
    default_model: ov.best_tabular_model ?? names[0] ?? "XGBoost",
  };
}

export async function getZones({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/zones";
  const r = await fetchApiGetCached(url("/zones"), { forceRefresh });
  if (r.ok && r.data && Array.isArray(r.data.zones)) {
    return { ok: true, source: "api", rows: r.data.zones };
  }
  if (r.ok && r.data && Array.isArray(r.data.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `zones unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "zones API not OK while static fallback allowed");
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  const m = new Map();
  if (Array.isArray(zp)) {
    for (const row of zp) {
      const id = Number(row.zone_id);
      if (!Number.isFinite(id)) continue;
      if (!m.has(id))
        m.set(id, {
          zone_id: id,
          zone_name: row.zone_name,
          borough: row.borough,
          service_zone: row.service_zone,
        });
    }
  }
  return {
    ok: true,
    source: "static",
    rows: [...m.values()].sort(
      (a, b) =>
        (a.borough || "").localeCompare(b.borough || "") ||
        (a.zone_name || "").localeCompare(b.zone_name || "")
    ),
  };
}

// ---------------------------------------------------------------------------
// Dashboard data
// ---------------------------------------------------------------------------

export async function getDashboardSnapshot({
  timestamp = null,
  model = null,
  borough = null,
  limit = null,
  allowStaticFallback = true,
  forceRefresh = false,
} = {}) {
  const params = new URLSearchParams();
  if (timestamp) params.set("timestamp", timestamp);
  if (model) params.set("model", model);
  if (borough && borough !== "all") params.set("borough", borough);
  if (limit) params.set("limit", String(limit));
  const q = params.toString() ? `?${params}` : "";
  const path = `/api/dashboard/snapshot${q}`;
  const r = await fetchApiGetCached(url(`/dashboard/snapshot${q}`), { forceRefresh });
  if (r.ok && r.data && Array.isArray(r.data.rows)) {
    return { ok: true, source: "api", data: r.data };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      data: null,
      error: `dashboard snapshot unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "dashboard snapshot API not OK while static fallback allowed");
  return { ok: true, source: "static", data: await buildSnapshotFallback({ timestamp, borough }) };
}

function _normalizeTrendArgs(hoursOrOpts, restArg) {
  if (typeof hoursOrOpts === "object" && hoursOrOpts !== null) {
    const o = hoursOrOpts;
    return {
      hours: Number(o.hours ?? 168),
      model: o.model ?? null,
      start: o.start ?? null,
      end: o.end ?? null,
      allowStaticFallback: typeof o.allowStaticFallback === "boolean" ? o.allowStaticFallback : true,
      forceRefresh: typeof o.forceRefresh === "boolean" ? o.forceRefresh : false,
    };
  }
  const hours = hoursOrOpts != null ? Number(hoursOrOpts) : 168;
  if (restArg && typeof restArg === "object") {
    return {
      hours,
      model: restArg.model ?? null,
      start: restArg.start ?? null,
      end: restArg.end ?? null,
      allowStaticFallback:
        typeof restArg.allowStaticFallback === "boolean" ? restArg.allowStaticFallback : true,
      forceRefresh: typeof restArg.forceRefresh === "boolean" ? restArg.forceRefresh : false,
    };
  }
  return { hours, model: null, start: null, end: null, allowStaticFallback: true, forceRefresh: false };
}

export async function getCityTrend(hoursOrOpts = 168, restArg = null) {
  const { hours, model, start, end, allowStaticFallback, forceRefresh } = _normalizeTrendArgs(
    hoursOrOpts,
    restArg
  );
  const params = new URLSearchParams();
  params.set("hours", String(hours));
  if (model) params.set("model", model);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const path = `/api/city/trend?${params}`;
  const r = await fetchApiGetCached(url(`/city/trend?${params}`), { forceRefresh });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `city trend unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "city trend API not OK while static fallback allowed");
  // Fallback: use zone_pressure aggregation (single timestamp).
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { ok: true, source: "static", rows: [] };
  const byTs = {};
  for (const row of zp) {
    const t = row.timestamp;
    if (!t) continue;
    if (!byTs[t]) {
      byTs[t] = {
        timestamp: t,
        pickup_count_sum: 0,
        target_next_hour_sum: 0,
        predicted_next_hour_sum: 0,
        average_pressure_ratio: 0,
        high_pressure_zones: 0,
        incident_count_sum: 0,
        n: 0,
      };
    }
    const b = byTs[t];
    b.pickup_count_sum += Number(row.pickup_count) || 0;
    b.target_next_hour_sum += Number(row.target_pickup_count_next_hour) || 0;
    b.predicted_next_hour_sum +=
      Number(row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups) || 0;
    b.incident_count_sum += Number(row.zone_incident_count) || 0;
    const pr = computePressureRatio(row);
    if (Number.isFinite(pr)) {
      b.average_pressure_ratio += pr;
      b.n += 1;
      if (pr >= 1.35) b.high_pressure_zones += 1;
    }
  }
  let rows = Object.values(byTs).map((row) => ({
    timestamp: row.timestamp,
    pickup_count_sum: row.pickup_count_sum,
    target_next_hour_sum: row.target_next_hour_sum,
    predicted_next_hour_sum: row.predicted_next_hour_sum,
    average_pressure_ratio: row.n ? row.average_pressure_ratio / row.n : null,
    high_pressure_zones: row.high_pressure_zones,
    incident_count_sum: row.incident_count_sum,
  }));
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  rows = rows.slice(-hours);
  return { ok: true, source: "static", rows };
}

export async function getBoroughTrend(hoursOrOpts = 168, restArg = null) {
  const { hours, model, start, end, allowStaticFallback, forceRefresh } = _normalizeTrendArgs(
    hoursOrOpts,
    restArg
  );
  const params = new URLSearchParams();
  params.set("hours", String(hours));
  if (model) params.set("model", model);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const path = `/api/borough/trend?${params}`;
  const r = await fetchApiGetCached(url(`/borough/trend?${params}`), { forceRefresh });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `borough trend unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "borough trend API not OK while static fallback allowed");
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { ok: true, source: "static", rows: [] };
  const key = {};
  for (const row of zp) {
    const b = row.borough;
    const t = row.timestamp;
    if (!b || !t) continue;
    const k = `${t}__${b}`;
    if (!key[k])
      key[k] = {
        timestamp: t,
        borough: b,
        pickup_count_sum: 0,
        target_next_hour_sum: 0,
        predicted_next_hour_sum: 0,
        average_pressure_ratio: 0,
        high_pressure_zones: 0,
        incident_count_sum: 0,
        n: 0,
      };
    key[k].pickup_count_sum += Number(row.pickup_count) || 0;
    key[k].target_next_hour_sum += Number(row.target_pickup_count_next_hour) || 0;
    key[k].predicted_next_hour_sum +=
      Number(row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups) || 0;
    key[k].incident_count_sum += Number(row.zone_incident_count) || 0;
    const pr = computePressureRatio(row);
    if (Number.isFinite(pr)) {
      key[k].average_pressure_ratio += pr;
      key[k].n += 1;
      if (pr >= 1.35) key[k].high_pressure_zones += 1;
    }
  }
  let rows = Object.values(key).map((row) => ({
    timestamp: row.timestamp,
    borough: row.borough,
    pickup_count_sum: row.pickup_count_sum,
    target_next_hour_sum: row.target_next_hour_sum,
    predicted_next_hour_sum: row.predicted_next_hour_sum,
    average_pressure_ratio: row.n ? row.average_pressure_ratio / row.n : null,
    high_pressure_zones: row.high_pressure_zones,
    incident_count_sum: row.incident_count_sum,
  }));
  rows.sort((a, b) =>
    `${a.timestamp} ${a.borough}`.localeCompare(`${b.timestamp} ${b.borough}`)
  );
  rows = rows.slice(-Math.min(hours * 8, rows.length));
  return { ok: true, source: "static", rows };
}

/**
 * Accepts either ``getZoneHistory({ zoneId, hours, model })`` or the
 * legacy positional form ``getZoneHistory(zoneId, hours, model)``.
 */
export async function getZoneHistory(zoneIdOrOpts, hoursArg = 168, modelArg = null) {
  let zoneId, hours, model, allowStaticFallback = true, forceRefresh = false;
  if (typeof zoneIdOrOpts === "object" && zoneIdOrOpts !== null) {
    zoneId = zoneIdOrOpts.zoneId;
    hours = Number(zoneIdOrOpts.hours ?? 168);
    model = zoneIdOrOpts.model ?? null;
    if (typeof zoneIdOrOpts.allowStaticFallback === "boolean") {
      allowStaticFallback = zoneIdOrOpts.allowStaticFallback;
    }
    if (typeof zoneIdOrOpts.forceRefresh === "boolean") {
      forceRefresh = zoneIdOrOpts.forceRefresh;
    }
  } else {
    zoneId = zoneIdOrOpts;
    hours = Number(hoursArg ?? 168);
    model = modelArg;
  }
  const params = new URLSearchParams();
  params.set("hours", String(hours));
  if (model) params.set("model", model);
  const path = `/api/zone/${encodeURIComponent(zoneId)}/history?${params}`;
  const r = await fetchApiGetCached(url(`/zone/${encodeURIComponent(zoneId)}/history?${params}`), {
    forceRefresh,
  });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `zone history unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "zone history API not OK while static fallback allowed");
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { ok: true, source: "static", rows: [] };
  const rows = zp
    .filter((row) => Number(row.zone_id) === Number(zoneId))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .slice(-hours)
    .map((row) => ({
      timestamp: row.timestamp,
      zone_id: row.zone_id,
      zone_name: row.zone_name,
      borough: row.borough,
      pickup_count: row.pickup_count,
      target_pickup_count_next_hour: row.target_pickup_count_next_hour,
      predicted_next_hour_pickups:
        row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups ?? null,
      pickup_count_roll_mean_24: row.pickup_count_roll_mean_24,
      pressure_ratio: row.pressure_ratio ?? computePressureRatio(row),
      pressure_label: row.pressure_label ?? pressureLabel(row.pressure_ratio),
      event_intensity_score: row.event_intensity_score,
      disruption_score: row.disruption_score,
      zone_incident_count: row.zone_incident_count,
      citywide_incident_count: row.citywide_incident_count,
      temperature: row.temperature,
      precipitation: row.precipitation,
      weather_status: row.weather_status ?? row.weather_category ?? null,
    }));
  return { ok: true, source: "static", rows };
}

/**
 * Accepts either ``getZoneHourHeatmap({ hours, topN, model, metric })`` or
 * the legacy positional form ``getZoneHourHeatmap(hours, topN)``.
 */
export async function getZoneHourHeatmap(hoursOrOpts = 168, topNArg = 20, restArg = null) {
  let hours, topN, model, metric, allowStaticFallback = true, forceRefresh = false;
  if (typeof hoursOrOpts === "object" && hoursOrOpts !== null) {
    hours = Number(hoursOrOpts.hours ?? 168);
    topN = Number(hoursOrOpts.topN ?? hoursOrOpts.top_n ?? 20);
    model = hoursOrOpts.model ?? null;
    metric = hoursOrOpts.metric ?? "pressure_ratio";
    if (typeof hoursOrOpts.allowStaticFallback === "boolean") {
      allowStaticFallback = hoursOrOpts.allowStaticFallback;
    }
    if (typeof hoursOrOpts.forceRefresh === "boolean") {
      forceRefresh = hoursOrOpts.forceRefresh;
    }
  } else {
    hours = Number(hoursOrOpts ?? 168);
    topN = Number(topNArg ?? 20);
    model = restArg?.model ?? null;
    metric = restArg?.metric ?? "pressure_ratio";
    if (restArg && typeof restArg.allowStaticFallback === "boolean") {
      allowStaticFallback = restArg.allowStaticFallback;
    }
    if (restArg && typeof restArg.forceRefresh === "boolean") {
      forceRefresh = restArg.forceRefresh;
    }
  }
  const params = new URLSearchParams();
  params.set("hours", String(hours));
  params.set("top_n", String(topN));
  if (model) params.set("model", model);
  if (metric) params.set("metric", metric);
  const path = `/api/heatmap/zone-hour?${params}`;
  const r = await fetchApiGetCached(url(`/heatmap/zone-hour?${params}`), { forceRefresh });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `zone-hour heatmap unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "heatmap API not OK while static fallback allowed");
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { ok: true, source: "static", rows: [] };
  const rows = zp.map((row) => ({
    zone_id: row.zone_id,
    zone_name: row.zone_name,
    borough: row.borough,
    timestamp: row.timestamp,
    hour: row.timestamp ? new Date(row.timestamp).getHours() : 0,
    value:
      metric === "predicted_pickups"
        ? Number(row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups ?? 0)
        : metric === "pickup_count"
          ? Number(row.pickup_count ?? 0)
          : metric === "incident_context"
            ? Number(row.zone_incident_count ?? 0)
            : Number(row.pressure_ratio ?? computePressureRatio(row) ?? 0),
    metric,
  }));
  return {
    ok: true,
    source: "static",
    rows: rows.sort((a, b) => Number(b.value) - Number(a.value)).slice(0, topN * Math.max(hours, 1)),
  };
}

export async function getTaxiZonesGeoJson({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/map/taxi-zones";
  const r = await fetchApiGetCached(url("/map/taxi-zones"), { forceRefresh });
  if (r.ok && r.data && Array.isArray(r.data.features)) {
    return { ok: true, source: "api", data: r.data };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      data: null,
      error: `taxi zones GeoJSON unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "taxi zones API not OK while static fallback allowed");
  const data = await fetchStatic(FALLBACK_PATHS.taxi_zones_geojson, null);
  if (data && Array.isArray(data.features))
    return { ok: true, source: "static", data };
  return { ok: true, source: "none", data: null };
}

// ---------------------------------------------------------------------------
// Models / metrics / predictions
// ---------------------------------------------------------------------------

export async function getModelMetrics({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/models/metrics";
  const r = await fetchApiGetCached(url("/models/metrics"), { forceRefresh });
  if (r.ok && r.data && (Array.isArray(r.data.rows) || Array.isArray(r.data.model_metrics))) {
    const rows = Array.isArray(r.data.rows) ? r.data.rows : r.data.model_metrics;
    return {
      ok: true,
      source: "api",
      data: {
        model_metrics: rows,
        forecast_metrics: r.data.forecast_metrics ?? rows.filter((m) => m.scenario === "24h_forecast"),
        contextual_comparison: r.data.contextual_comparison ?? [],
        best_tabular_model: r.data.best_tabular_model,
        best_forecast_model: r.data.best_forecast_model,
      },
    };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      data: null,
      error: `model metrics unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "models/metrics API not OK while static fallback allowed");
  const [model_metrics, forecast_metrics, contextual_comparison, ov] = await Promise.all([
    fetchStatic(FALLBACK_PATHS.model_metrics, []),
    fetchStatic(FALLBACK_PATHS.forecast_metrics, []),
    fetchStatic(FALLBACK_PATHS.contextual_comparison, []),
    fetchStatic(FALLBACK_PATHS.overview, {}),
  ]);
  return {
    ok: true,
    source: "static",
    data: {
      model_metrics,
      forecast_metrics,
      contextual_comparison,
      best_tabular_model: ov.best_tabular_model ?? "XGBoost",
      best_forecast_model: ov.best_forecast_model ?? "GRU 24H Forecaster",
    },
  };
}

export async function getModelPredictions({
  model = null,
  zoneId = null,
  hours = 168,
  start = null,
  end = null,
  limit = 5000,
  allowStaticFallback = true,
  forceRefresh = false,
} = {}) {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (zoneId != null) params.set("zone_id", String(zoneId));
  if (hours) params.set("hours", String(hours));
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (limit) params.set("limit", String(limit));
  const path = `/api/models/predictions?${params}`;
  const r = await fetchApiGetCached(url(`/models/predictions?${params}`), { forceRefresh });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `model predictions unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "predictions API not OK while static fallback allowed");
  const pv = await fetchStatic(FALLBACK_PATHS.predictions_preview, []);
  let rows = Array.isArray(pv) ? pv : [];
  if (model) rows = rows.filter((row) => (row.model_name || "") === model);
  if (zoneId != null) rows = rows.filter((row) => Number(row.zone_id) === Number(zoneId));
  rows = rows.slice(0, limit);
  return { ok: true, source: "static", rows };
}

export async function runSimulation(payload) {
  const path = "/api/simulation/run";
  const r = await fetchJsonQuiet(url("/simulation/run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const detailRaw = r.data?.detail ?? r.data?.error;
  const detail =
    detailRaw == null
      ? null
      : typeof detailRaw === "string"
        ? detailRaw
        : Array.isArray(detailRaw)
          ? detailRaw
              .map((item) => (typeof item?.msg === "string" ? item.msg : JSON.stringify(item)))
              .join(" • ")
          : JSON.stringify(detailRaw);

  if (r.ok && r.data && typeof r.data === "object" && detailRaw == null)
    return { source: "api", ok: true, data: r.data };

  logEndpointFailure(path, r.status, detailRaw != null ? String(detailRaw).slice(0, 200) : "");
  return {
    source: "static",
    ok: false,
    message:
      detail || "Simulation API unavailable. Start the FastAPI backend to run POST /api/simulation/run.",
    payload,
  };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export async function getFigures({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const path = "/api/figures";
  const r = await fetchApiGetCached(url("/figures"), { forceRefresh });
  if (r.ok && Array.isArray(r.data?.figures)) {
    return { ok: true, source: "api", rows: r.data.figures };
  }
  if (r.ok && Array.isArray(r.data?.rows)) {
    return { ok: true, source: "api", rows: r.data.rows };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `figures unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "figures API not OK while static fallback allowed");
  return { ok: true, source: "static", rows: [] };
}

// ---------------------------------------------------------------------------
// Optional weather/events timeline (used by Dashboard sparkline).
// ---------------------------------------------------------------------------

export async function getWeatherEventsTimeline(hoursOrOpts = 168) {
  let hours = 168;
  let allowStaticFallback = true;
  let forceRefresh = false;
  if (typeof hoursOrOpts === "object" && hoursOrOpts !== null) {
    hours = Number(hoursOrOpts.hours ?? 168);
    if (typeof hoursOrOpts.allowStaticFallback === "boolean") {
      allowStaticFallback = hoursOrOpts.allowStaticFallback;
    }
    if (typeof hoursOrOpts.forceRefresh === "boolean") {
      forceRefresh = hoursOrOpts.forceRefresh;
    }
  } else {
    hours = Number(hoursOrOpts ?? 168);
  }
  const path = `/api/city/trend?hours=${encodeURIComponent(hours)}`;
  const r = await fetchApiGetCached(url(`/city/trend?hours=${encodeURIComponent(hours)}`), {
    forceRefresh,
  });
  if (r.ok && Array.isArray(r.data?.rows)) {
    return {
      ok: true,
      source: "api",
      rows: r.data.rows.map((row) => ({
        timestamp: row.timestamp,
        temperature: row.temperature,
        precipitation: row.precipitation,
        snowfall: row.snowfall,
        wind_speed: row.wind_speed,
        humidity: row.humidity,
        weather_status: row.weather_status,
        total_zone_incidents: row.incident_count_sum ?? row.citywide_incident_count ?? null,
        citywide_incident_count: row.citywide_incident_count,
      })),
    };
  }
  logEndpointFailure(path, r.status);
  if (!allowStaticFallback) {
    return {
      ok: false,
      source: "api",
      rows: [],
      error: `weather/events timeline unavailable (status ${r.status})`,
    };
  }
  logStaticFallbackFor(path, "city trend API not OK while static fallback allowed (weather strip)");
  return { ok: true, source: "static", rows: [] };
}

export async function getDataInfo({ allowStaticFallback = true, forceRefresh = false } = {}) {
  const [overview, mm, ds, fd, eis] = await Promise.all([
    getOverview({ allowStaticFallback, forceRefresh }),
    getModelMetrics({ allowStaticFallback, forceRefresh }),
    fetchStatic(FALLBACK_PATHS.dataset_summary, {}),
    fetchStatic(FALLBACK_PATHS.feature_dictionary, []),
    fetchStatic(FALLBACK_PATHS.event_integration_summary, []),
  ]);
  const apiSliceOk = overview.ok !== false && mm.ok !== false;
  const bundle = {
    ok: apiSliceOk,
    source: overview.source === "api" && mm.source === "api" ? "api" : overview.source,
    data: {
      dataset_summary: ds,
      feature_dictionary: Array.isArray(fd) ? fd : [],
      event_integration_summary: Array.isArray(eis) ? eis : [],
      target_explanation: {
        target_column: overview.data?.target ?? "target_pickup_count_next_hour",
        target_definition: overview.data?.target_definition,
        proxy_note: overview.data?.proxy_note,
      },
      data_sources: overview.data?.data_sources,
      best_tabular_model: mm.data?.best_tabular_model ?? overview.data?.best_tabular_model,
      best_forecast_model: mm.data?.best_forecast_model ?? overview.data?.best_forecast_model,
    },
    errors: {
      overview: overview.ok === false ? overview.error ?? "overview failed" : null,
      modelMetrics: mm.ok === false ? mm.error ?? "model metrics failed" : null,
    },
  };
  if (apiSliceOk && bundle.data) {
    lastDataInfoBundle = bundle;
  }
  return bundle;
}

/**
 * Warm common GET endpoints in the background after `/api/health` succeeds.
 * Failures are ignored; successful responses populate the GET cache.
 */
export async function prefetchCoreData() {
  const allowStaticFallback = false;
  try {
    const tsRes = await getTimestamps({ allowStaticFallback });
    const tsLatest =
      tsRes.ok !== false && Array.isArray(tsRes.rows) && tsRes.rows.length ? tsRes.rows[0] : null;
    await Promise.allSettled([
      getOverview({ allowStaticFallback }),
      getModels({ allowStaticFallback }),
      getModelMetrics({ allowStaticFallback }),
      getTaxiZonesGeoJson({ allowStaticFallback }),
      getCityTrend({ hours: 168, allowStaticFallback }),
      getBoroughTrend({ hours: 168, allowStaticFallback }),
      getZoneHourHeatmap({
        hours: 168,
        topN: 20,
        metric: "pressure_ratio",
        allowStaticFallback,
      }),
      tsLatest
        ? getDashboardSnapshot({ timestamp: tsLatest, allowStaticFallback })
        : getDashboardSnapshot({ allowStaticFallback }),
      getFigures({ allowStaticFallback: true }),
      getDataInfo({ allowStaticFallback: true }),
    ]);
  } catch {
    /* ignore */
  }
  console.info(`${LOG} prefetch complete`);
}
