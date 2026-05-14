import { formatDecimal, formatNumber, formatRatio, isValidNumber, pressureLabel } from "./format";

export function getTopPressureRow(rows = []) {
  let best = null;
  let bestR = -Infinity;
  for (const row of rows) {
    const r = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
    if (Number.isFinite(r) && r >= bestR) {
      bestR = r;
      best = row;
    }
  }
  return best;
}

export function buildInsights(snapshot) {
  const rows = snapshot?.rows ?? snapshot?.zonePressure ?? [];
  const summary = snapshot?.summary ?? {};
  const items = [];

  const top = getTopPressureRow(rows);
  if (top) {
    items.push({
      title: "Highest demand-pressure zone",
      body: `${top.zone_name} (${top.borough}) • pressure ratio ${formatRatio(top.pressure_ratio ?? top.observed_pressure_ratio)} — ${pressureLabel(Number(top.pressure_ratio ?? top.observed_pressure_ratio))}`,
    });
  }

  const incidentZones = rows.filter(
    (row) =>
      Number(row.zone_incident_count) > 0 ||
      Number(row.citywide_incident_count) > 0 ||
      Number(row.incident_flag) > 0
  ).length;

  items.push({
    title: "Incident & disruption context",
    body:
      incidentZones > 0
        ? `Signals appear in ${incidentZones} zone snapshot row(s). Recommended Monitoring relative to disruptions and street closures.`
        : "Light incident/disruption footprint in this hour bucket based on consolidated features.",
  });

  const weather =
    summary.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temp = rows[0]?.temperature;
  items.push({
    title: "Weather signal",
    body: weather
      ? `${typeof weather === "string" ? weather : "Composite status"}${isValidNumber(temp) ? ` • ~${formatDecimal(temp, 1)}°C` : ""}`
      : "Weather fields not present in this export slice.",
  });

  const total = summary.total_predicted_next_hour_pickups;
  items.push({
    title: "Operational priority",
    body: isValidNumber(total)
      ? `Citywide predicted next-hour pickups about ${formatNumber(total, 0)} (pickup-demand indicator). Review Supply Coverage where ratios stay elevated.`
      : "Citywide pickup total unavailable for this slice — check the API connection or choose another snapshot.",
  });

  if (!items.length) {
    items.push({
      title: "Awaiting data",
      body: "Load a snapshot with zone rows to populate AI-style insights.",
    });
  }

  return items;
}

/** Right-rail insight cards for the Main Dashboard (evaluator-friendly, honest wording). */
export function buildDashboardInsightRail(snapshot, filteredRows = [], peakBoroughName = null) {
  const rows = filteredRows.length ? filteredRows : snapshot?.rows ?? [];
  const summary = snapshot?.summary ?? {};

  const top = getTopPressureRow(rows);
  const card1 =
    top != null
      ? {
          title: "Highest demand-pressure zone",
          body: `${top.zone_name} (${top.borough}) has the highest pressure ratio at ${formatRatio(top.pressure_ratio ?? top.observed_pressure_ratio)} (${pressureLabel(Number(top.pressure_ratio ?? top.observed_pressure_ratio))}). Prioritize visibility into sustained elevated ratios in this zone.`,
        }
      : {
          title: "Highest demand-pressure zone",
          body: "No pressure ratios available for this filtered view — widen borough scope or pick another snapshot timestamp.",
        };

  const peakName = peakBoroughName || null;
  const card2 = {
    title: "Peak borough",
    body: peakName
      ? `${peakName} has the strongest average demand-pressure ratio in this snapshot view. Monitor elevated zones here versus recent baseline.`
      : "Borough signal unavailable for the selected snapshot — try another timestamp or widen borough filters.",
  };

  const incidentRows = rows.filter(
    (row) =>
      Number(row.zone_incident_count) > 0 ||
      Number(row.citywide_incident_count) > 0 ||
      Number(row.incident_flag) > 0 ||
      Number(row.event_flag) > 0 ||
      Number(row.event_active) > 0 ||
      Number(row.road_closure_flag) > 0 ||
      Number(row.disruption_score) > 0
  ).length;

  const card3 = {
    title: "Incident / disruption context",
    body:
      incidentRows > 0
        ? `${incidentRows} zone row(s) show incident or disruption-related signals in engineered features. Track incident context alongside external DOT/NYPD feeds for authoritative status.`
        : "No elevated incident or disruption indicators in this filtered slice — engineered features appear comparatively calm.",
  };

  const weather =
    summary.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temps = rows.map((r) => Number(r.temperature)).filter(Number.isFinite);
  const avgTemp =
    temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

  const card4 = {
    title: "Weather signal",
    body:
      weather || isValidNumber(avgTemp)
        ? `${weather ? String(weather) : "Composite weather fields"}${isValidNumber(avgTemp) ? ` • mean temperature ~${formatDecimal(avgTemp, 1)}°C across zones in view` : ""}`
        : "Weather categories are not populated for this hour in the active snapshot slice.",
  };

  const card5 = {
    title: "Recommended monitoring",
    body:
      "Monitor high-pressure zones, review operational coverage against TLC pickup-demand indicators, prioritize visibility where ratios stay elevated, and track incident context using external authoritative sources. This dashboard does not measure passenger waiting time directly and does not reflect live on-street supply conditions.",
  };

  return [card1, card2, card3, card4, card5];
}

export function incidentContextActive(row) {
  if (!row) return false;
  return (
    Number(row.zone_incident_count) > 0 ||
    Number(row.citywide_incident_count) > 0 ||
    Number(row.incident_flag) > 0 ||
    Number(row.event_flag) > 0 ||
    Number(row.event_active) > 0 ||
    Number(row.road_closure_flag) > 0 ||
    Number(row.disruption_score) > 0
  );
}

export function summarizeIncidentContext(row) {
  if (!incidentContextActive(row)) return "No strong signal";
  const parts = [];
  if (Number(row.zone_incident_count) > 0) parts.push("Zone incidents");
  if (Number(row.road_closure_flag) > 0) parts.push("Closure signal");
  if (Number(row.event_flag) > 0 || Number(row.event_active) > 0) parts.push("Event context");
  if (Number(row.incident_flag) > 0) parts.push("Incident flag");
  if (Number(row.disruption_score) > 0) parts.push("Disruption score");
  return parts.length ? parts.join(" · ") : "Context present";
}

/** Highest row by pressure ratio, predicted pickups, or incident-style score (for authority map-metric insight). */
export function getTopAuthorityMetricRow(rows = [], mapMetric = "ratio") {
  if (!rows.length) return null;
  if (mapMetric === "pickups") {
    let best = null;
    let bestV = -Infinity;
    for (const row of rows) {
      const v = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
      if (Number.isFinite(v) && v >= bestV) {
        bestV = v;
        best = row;
      }
    }
    return best;
  }
  if (mapMetric === "incident") {
    let best = null;
    let bestS = -Infinity;
    for (const row of rows) {
      const s =
        Number(row.zone_incident_count || 0) +
        (Number(row.incident_flag) > 0 ? 2 : 0) +
        (Number(row.road_closure_flag) > 0 ? 1.5 : 0) +
        Number(row.disruption_score || 0) +
        (Number(row.event_active) > 0 || Number(row.event_flag) > 0 ? 1 : 0);
      if (s >= bestS) {
        bestS = s;
        best = row;
      }
    }
    return best;
  }
  return getTopPressureRow(rows);
}

/**
 * Right-rail cards for Transport Authority (regulatory wording only).
 * @param {"ratio"|"pickups"|"incident"} mapMetric
 */
export function buildAuthorityRegulatoryRail(rows, summary, mapMetric, peakBoroughStress) {
  const top = getTopAuthorityMetricRow(rows, mapMetric);
  const card1 =
    top != null
      ? mapMetric === "pickups"
        ? {
            title: "Highest monitoring zone",
            body: `${top.zone_name ?? "—"} (${top.borough ?? "—"}) shows the strongest predicted pickup-demand signal in view at ${formatNumber(Number(top.predicted_next_hour_pickups ?? top.target_pickup_count_next_hour), 0)} predicted next-hour pickups.`,
          }
        : mapMetric === "incident"
          ? {
              title: "Highest monitoring zone",
              body: `${top.zone_name ?? "—"} (${top.borough ?? "—"}) shows the strongest incident/disruption context among zones in this snapshot (${summarizeIncidentContext(top)}).`,
            }
          : {
              title: "Highest monitoring zone",
              body: `${top.zone_name ?? "—"} (${top.borough ?? "—"}) has the highest demand-pressure ratio at ${formatRatio(top.pressure_ratio ?? top.observed_pressure_ratio)} (${pressureLabel(Number(top.pressure_ratio ?? top.observed_pressure_ratio))}).`,
            }
      : {
          title: "Highest monitoring zone",
          body: "No comparable zone signal in this filtered view — adjust borough or snapshot.",
        };

  const pb = peakBoroughStress?.name;
  const pr = peakBoroughStress?.ratio;
  const card2 = {
    title: "Borough stress summary",
    body:
      pb && isValidNumber(pr)
        ? `${pb} shows the strongest average demand-pressure ratio in the latest borough trend slice (~${formatDecimal(pr, 2)}×). Compare with other boroughs in the chart below for planning review.`
        : "Borough-level average pressure is not available for this selection — check borough trend data.",
  };

  const incidentRows = rows.filter((row) => incidentContextActive(row)).length;
  const card3 = {
    title: "Incident and disruption context",
    body:
      incidentRows > 0
        ? `${incidentRows} zone row(s) include event, incident, closure, or disruption indicators in this snapshot. Use external DOT/NYPD sources for authoritative closure status.`
        : "Few or no engineered incident or disruption indicators in this snapshot slice.",
  };

  const weather =
    summary?.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temps = rows.map((r) => Number(r.temperature)).filter(isValidNumber);
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const precips = rows.map((r) => Number(r.precipitation)).filter(isValidNumber);
  const avgPrecip = precips.length ? precips.reduce((a, b) => a + b, 0) / precips.length : null;

  const card4 = {
    title: "Weather signal",
    body:
      weather || isValidNumber(avgTemp)
        ? `${weather ? String(weather) : "Composite weather fields"}${isValidNumber(avgTemp) ? ` • mean temperature ~${formatDecimal(avgTemp, 1)}°C` : ""}${isValidNumber(avgPrecip) && avgPrecip > 0 ? ` • mean precipitation ~${formatDecimal(avgPrecip, 2)} mm` : ""}`
        : "Weather fields are sparse for this snapshot hour.",
  };

  const card5 = {
    title: "Planning note",
    body:
      "Use these signals to monitor high-pressure zones, review recurring borough-level stress, and support coordination with mobility operators when operational visibility is needed.",
  };

  return [card1, card2, card3, card4, card5];
}

/** Right-rail cards for Ride-Hailing Companies View (company-facing wording). */
export function buildCompanyOperationalInsightRail(rows, summary, boroughConcentration) {
  let topPred = null;
  let bestPred = -Infinity;
  for (const row of rows) {
    const v = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
    if (Number.isFinite(v) && v >= bestPred) {
      bestPred = v;
      topPred = row;
    }
  }

  const topPressure = getTopPressureRow(rows);

  const card1 =
    topPred != null
      ? {
          title: "Highest predicted-demand zone",
          body: `${topPred.zone_name ?? "—"} (${topPred.borough ?? "—"}) shows the strongest predicted next-hour pickup-demand indicator in this view (${formatNumber(Number(topPred.predicted_next_hour_pickups ?? topPred.target_pickup_count_next_hour), 0)} pickups).`,
        }
      : {
          title: "Highest predicted-demand zone",
          body: "No predicted pickup values in this filtered view — adjust borough or snapshot.",
        };

  const card2 =
    topPressure != null
      ? {
          title: "Highest demand-pressure zone",
          body: `${topPressure.zone_name ?? "—"} (${topPressure.borough ?? "—"}) has the highest Pressure Ratio at ${formatRatio(topPressure.pressure_ratio ?? topPressure.observed_pressure_ratio)} (${pressureLabel(Number(topPressure.pressure_ratio ?? topPressure.observed_pressure_ratio))}).`,
        }
      : {
          title: "Highest demand-pressure zone",
          body: "Pressure Ratio is not available for ranking in this view.",
        };

  const bc = boroughConcentration;
  const card3 = {
    title: "Borough demand concentration",
    body:
      bc?.name && Number.isFinite(bc?.share)
        ? `${bc.name} accounts for about ${formatDecimal(bc.share * 100, 1)}% of predicted pickup-demand in the selected borough scope — useful for borough-level coverage review.`
        : "Borough concentration is not available — widen scope or check snapshot rows.",
  };

  const incidentRows = rows.filter((row) => incidentContextActive(row)).length;
  const weather =
    summary?.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temps = rows.map((r) => Number(r.temperature)).filter(isValidNumber);
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

  const card4 = {
    title: "Incident / weather context",
    body: [
      incidentRows > 0
        ? `${incidentRows} zone row(s) include incident or disruption context indicators in this snapshot.`
        : "Few or no incident or disruption context indicators in this snapshot slice.",
      weather || isValidNumber(avgTemp)
        ? ` Weather: ${weather ? String(weather) : "composite fields"}${isValidNumber(avgTemp) ? ` (~${formatDecimal(avgTemp, 1)}°C mean across zones in view).` : "."}`
        : "",
    ]
      .filter(Boolean)
      .join(""),
  };

  const card5 = {
    title: "Planning note",
    body:
      "Review coverage plans around zones with elevated pickup-demand indicators and compare repeated patterns across similar hours.",
  };

  return [card1, card2, card3, card4, card5];
}

/** Safe operational-planning bullets for company stakeholders. */
export function buildCompanyOperationalSuggestions({
  hasHighPredictedZone,
  avgPressureRatio,
  elevatedPressureZones,
  highPressureZones,
  incidentContextRows,
  dominantBoroughName,
  boroughConcentrationShare,
}) {
  const lines = [];
  if (hasHighPredictedZone || highPressureZones >= 4) {
    lines.push("Review service coverage around high predicted-demand zones.");
  }
  const pressureNote = "Monitor zones where demand is above the recent zone baseline (Pressure Ratio).";
  if (Number.isFinite(avgPressureRatio) && avgPressureRatio >= 1.1) {
    lines.push(pressureNote);
  } else if (elevatedPressureZones >= 8 || highPressureZones >= 2) {
    lines.push(pressureNote);
  }
  if (incidentContextRows >= 2) {
    lines.push("Consider incident-context indicators when interpreting demand changes.");
  }
  if (
    dominantBoroughName &&
    Number.isFinite(boroughConcentrationShare) &&
    boroughConcentrationShare >= 0.38
  ) {
    lines.push(`Compare repeated patterns in ${dominantBoroughName} across similar time windows.`);
  }
  const uniq = [...new Set(lines)];
  if (!uniq.length) {
    uniq.push("Continue routine demand monitoring; revisit if pressure or context indicators strengthen.");
  }
  return uniq;
}

export function buildAuthorityMonitoringRecommendations({
  highPressureCount,
  incidentContextRows,
  peakBoroughName,
  boroughTrendDominant,
  weatherPresent,
}) {
  const lines = [];
  if (highPressureCount >= 8) {
    lines.push("Review high-pressure zones and compare them with recurring peak periods.");
  }
  if (incidentContextRows >= 3) {
    lines.push("Cross-check incident-context zones with borough-level stress patterns.");
  }
  if (peakBoroughName && boroughTrendDominant && peakBoroughName === boroughTrendDominant) {
    lines.push(`Prioritize monitoring of ${peakBoroughName} during similar time windows when stress repeats.`);
  }
  if (weatherPresent) {
    lines.push("Consider weather context when interpreting demand pressure.");
  }
  if (!lines.length) {
    lines.push("Continue routine citywide monitoring; revisit if pressure or incident signals strengthen.");
  }
  return lines;
}
