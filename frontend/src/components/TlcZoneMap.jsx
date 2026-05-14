import { useCallback, useEffect, useMemo, useRef } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { formatDecimal, formatNumber, formatRatio, pressureTierLabel } from "../lib/format";

function boroughFromFeature(feature, row) {
  const r = row?.borough ?? feature?.properties?.borough ?? feature?.properties?.Borough;
  return r != null && String(r).trim() !== "" ? String(r).trim() : null;
}

function zoneIdFromFeature(feature) {
  const p = feature?.properties ?? {};
  const raw = p.LocationID ?? p.location_id ?? p.zone_id ?? p.objectid ?? p.ObjectID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function incidentIntensity(row) {
  if (!row) return 0;
  return (
    Number(row.zone_incident_count || 0) +
    (Number(row.incident_flag) > 0 ? 2 : 0) +
    (Number(row.road_closure_flag) > 0 ? 1.5 : 0) +
    Number(row.disruption_score || 0) +
    (Number(row.event_active) > 0 || Number(row.event_flag) > 0 ? 1 : 0)
  );
}

function ratioFill(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return "#e2e8f0";
  if (r >= 1.35) return "#B42318";
  if (r >= 1.15) return "#F7B731";
  if (r >= 0.85) return "#6ee7b7";
  return "#DFF7EF";
}

function pickupFill(value, vmax) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(vmax) || vmax <= 0) return "#e2e8f0";
  const t = Math.min(1, Math.log1p(v) / Math.log1p(vmax));
  const l = Math.round(88 - t * 38);
  const s = Math.round(42 + t * 38);
  return `hsl(168 ${s}% ${l}%)`;
}

function incidentFill(score, smax) {
  const s = Number(score);
  if (!Number.isFinite(s) || s <= 0) return "#DFF7EF";
  const sm = Number.isFinite(smax) && smax > 0 ? smax : 8;
  const t = Math.min(1, s / sm);
  const r = Math.round(247 - t * 40);
  const g = Math.round(183 - t * 80);
  const b = Math.round(49 + t * 130);
  return `rgb(${r} ${g} ${b})`;
}

function incidentSummary(row) {
  if (!row) return "N/A";
  const parts = [];
  if (Number(row.zone_incident_count) > 0) parts.push(`Zone incidents: ${formatNumber(row.zone_incident_count, 0)}`);
  if (Number(row.citywide_incident_count) > 0) parts.push(`Citywide incidents: ${formatNumber(row.citywide_incident_count, 0)}`);
  if (Number(row.incident_flag) > 0) parts.push("Incident flag active");
  if (Number(row.event_flag) > 0 || Number(row.event_active) > 0) parts.push("Event context active");
  if (Number(row.road_closure_flag) > 0) parts.push("Road closure signal");
  const d = Number(row.disruption_score);
  if (Number.isFinite(d) && d > 0) parts.push(`Disruption score ${formatDecimal(d, 1)}`);
  return parts.length ? parts.join(" • ") : "No or weak incident/disruption signal";
}

function weatherSummaryLine(row) {
  if (!row) return null;
  const bits = [row.weather_category, row.weather_summary, row.weather_status].filter(
    (x) => x != null && String(x).trim() !== ""
  );
  if (!bits.length) return null;
  return [...new Set(bits.map((x) => String(x)))].join(" · ");
}

function FitBounds({ geojson }) {
  const map = useMap();
  useEffect(() => {
    if (!geojson?.features?.length) return;
    const layer = L.geoJSON(geojson);
    try {
      const b = layer.getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [36, 36], maxZoom: 11, animate: false });
    } catch {
      /* ignore */
    }
  }, [geojson, map]);
  return null;
}

function boroughHighlightMatch(highlightBorough, featureBorough) {
  if (!highlightBorough || String(highlightBorough).toLowerCase() === "all") return true;
  if (!featureBorough) return false;
  return String(featureBorough).toLowerCase() === String(highlightBorough).toLowerCase();
}

export default function TlcZoneMap({
  geojson,
  rows = [],
  mapMetric = "ratio",
  loading = false,
  /** When set (not "all"), zones outside this borough are de-emphasized. */
  highlightBorough = null,
  /** Optional footer line under the legend (e.g. authority-facing copy). */
  legendFooter = null,
}) {
  const gjRef = useRef(null);
  const rowMap = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const id = Number(r.zone_id);
      if (Number.isFinite(id)) m.set(id, r);
    }
    return m;
  }, [rows]);

  const pickupMax = useMemo(() => {
    let mx = 0;
    for (const r of rows) {
      const v = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    return mx;
  }, [rows]);

  const pickupQuantiles = useMemo(() => {
    const vals = rows
      .map((r) => Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour))
      .filter((x) => Number.isFinite(x) && x >= 0)
      .sort((a, b) => a - b);
    if (!vals.length) return null;
    const pick = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * p)))];
    return { q33: pick(0.33), q66: pick(0.66), min: vals[0], max: vals[vals.length - 1] };
  }, [rows]);

  const incidentMax = useMemo(() => {
    let mx = 0;
    for (const r of rows) {
      const s = incidentIntensity(r);
      if (s > mx) mx = s;
    }
    return mx || 1;
  }, [rows]);

  const styleFeature = useCallback(
    (feature) => {
      const id = zoneIdFromFeature(feature);
      const row = id != null ? rowMap.get(id) : null;
      const boro = boroughFromFeature(feature, row);
      const inFocus = boroughHighlightMatch(highlightBorough, boro);
      let fill = "#f1f5f9";
      if (mapMetric === "pickups") {
        fill = pickupFill(row?.predicted_next_hour_pickups ?? row?.target_pickup_count_next_hour, pickupMax);
      } else if (mapMetric === "incident") {
        fill = incidentFill(incidentIntensity(row), incidentMax);
      } else {
        fill = ratioFill(row?.pressure_ratio ?? row?.observed_pressure_ratio);
      }
      return {
        fillColor: fill,
        fillOpacity: inFocus ? 0.78 : 0.2,
        color: inFocus ? "#94a3b8" : "#cbd5e1",
        weight: inFocus ? 0.8 : 0.35,
      };
    },
    [rowMap, mapMetric, pickupMax, incidentMax, highlightBorough]
  );

  const onEachFeature = useCallback(
    (feature, layer) => {
      const id = zoneIdFromFeature(feature);
      const row = id != null ? rowMap.get(id) : null;
      const zname = row?.zone_name || feature?.properties?.zone || feature?.properties?.Zone || `Zone ${id ?? "—"}`;
      const boroughRaw = boroughFromFeature(feature, row);
      const borough = boroughRaw ?? "N/A";
      const pred = row?.predicted_next_hour_pickups ?? row?.target_pickup_count_next_hour;
      const roll = row?.pickup_count_roll_mean_24;
      const ratio = row?.pressure_ratio ?? row?.observed_pressure_ratio;
      const label = row?.pressure_label ?? pressureTierLabel(ratio);
      const wx = weatherSummaryLine(row);
      const predStr = formatNumber(pred, 0);
      const rollStr = Number.isFinite(Number(roll)) ? formatDecimal(roll, 1) : "N/A";
      const ratioStr = formatRatio(ratio);
      const lines = [
        `<div class="tlc-tip"><strong>${zname}</strong><br/>`,
        `Borough: ${borough}<br/><br/>`,
        `Predicted next-hour pickups: <strong>${predStr}</strong><br/>`,
        `Rolling 24h mean: ${rollStr}<br/>`,
        `Pressure ratio: <strong>${ratioStr}</strong><br/>`,
        `Pressure label: ${ratioStr === "N/A" ? "N/A" : label}<br/><br/>`,
        `<strong>Incident context:</strong><br/>${incidentSummary(row)}`,
        wx ? `<br/><br/><strong>Weather signal:</strong><br/>${wx}` : `<br/><br/><strong>Weather signal:</strong> N/A`,
        `</div>`,
      ];
      layer.bindTooltip(lines.join(""), {
        sticky: true,
        direction: "auto",
        opacity: 0.98,
        className: "tlc-map-tooltip",
      });

      layer.on({
        mouseover: (e) => {
          const t = e.target;
          t.setStyle({ weight: 2, color: "#008B78", fillOpacity: 0.9 });
          t.bringToFront();
        },
        mouseout: (e) => {
          const t = e.target;
          const ref = gjRef.current;
          if (ref && typeof ref.resetStyle === "function") ref.resetStyle(t);
          else t.setStyle(styleFeature(feature));
        },
      });
    },
    [rowMap, styleFeature]
  );

  const key = useMemo(() => {
    const n = geojson?.features?.length ?? 0;
    return `${n}-${rows.length}-${mapMetric}-${highlightBorough ?? "all"}`;
  }, [geojson, rows.length, mapMetric, highlightBorough]);

  const legendCaptionDemand =
    "Color shows the selected metric for the selected timestamp. Warmer colors indicate stronger demand pressure or stronger incident context.";
  const legendCaptionPickups =
    "Color shows predicted next-hour pickup volume for the selected timestamp. Warmer colors mean higher predicted next-hour pickup volume.";

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="flex h-[480px] items-center justify-center rounded-xl border border-brand-border bg-brand-mint/25 text-sm font-medium text-brand-muted">
          Loading TLC zone map…
        </div>
      </div>
    );
  }

  if (!geojson?.features?.length) {
    return (
      <div className="rounded-xl border border-dashed border-brand-border bg-brand-mint/20 px-4 py-3 text-sm text-brand-muted">
        <p className="font-semibold text-brand-text">Map unavailable</p>
        <p className="mt-1 text-xs leading-relaxed">
          TLC zone geometry could not be loaded. Check the map export or network, then use Update view to retry.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative h-[480px] w-full overflow-hidden rounded-xl border border-brand-border bg-[#eef6f3]">
        <MapContainer
          center={[40.73, -73.94]}
          zoom={10}
          className="h-full w-full rounded-xl"
          scrollWheelZoom
          aria-label="NYC TLC zone choropleth map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          <FitBounds geojson={geojson} />
          <GeoJSON key={key} ref={gjRef} data={geojson} style={styleFeature} onEachFeature={onEachFeature} />
        </MapContainer>
      </div>

      <div className="rounded-xl border-2 border-brand-primary/25 bg-gradient-to-b from-white to-brand-mint/15 px-4 py-3 shadow-card ring-1 ring-brand-border/80">
        <div className="text-xs font-bold uppercase tracking-wide text-brand-text">Map legend</div>
        {mapMetric === "ratio" ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-brand-text">
              <span className="flex items-center gap-2">
                <span className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm" style={{ background: "#DFF7EF" }} />
                <span>
                  <span className="font-semibold">Low</span>
                  <span className="text-brand-muted"> — pressure ratio below 0.85</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm" style={{ background: "#6ee7b7" }} />
                <span>
                  <span className="font-semibold">Typical</span>
                  <span className="text-brand-muted"> — 0.85–1.15</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm" style={{ background: "#F7B731" }} />
                <span>
                  <span className="font-semibold">Elevated</span>
                  <span className="text-brand-muted"> — 1.15–1.35</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm" style={{ background: "#B42318" }} />
                <span>
                  <span className="font-semibold">High</span>
                  <span className="text-brand-muted"> — 1.35 or higher</span>
                </span>
              </span>
            </div>
            <p className="text-xs font-medium leading-relaxed text-brand-muted">{legendCaptionDemand}</p>
          </div>
        ) : null}

        {mapMetric === "pickups" && pickupQuantiles ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-brand-text">
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm"
                  style={{ background: pickupFill(pickupQuantiles.min, pickupMax) }}
                />
                <span>
                  <span className="font-semibold">Low</span>
                  <span className="text-brand-muted">
                    {" "}
                    — lower volume (≈ below {formatNumber(pickupQuantiles.q33, 0)} pickups, 33rd percentile)
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm"
                  style={{ background: pickupFill((pickupQuantiles.q33 + pickupQuantiles.q66) / 2, pickupMax) }}
                />
                <span>
                  <span className="font-semibold">Medium</span>
                  <span className="text-brand-muted"> — middle band</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm"
                  style={{ background: pickupFill(pickupQuantiles.max, pickupMax) }}
                />
                <span>
                  <span className="font-semibold">High</span>
                  <span className="text-brand-muted">
                    {" "}
                    — higher volume (≈ above {formatNumber(pickupQuantiles.q66, 0)} pickups, 66th percentile)
                  </span>
                </span>
              </span>
            </div>
            <p className="text-xs font-medium leading-relaxed text-brand-muted">{legendCaptionPickups}</p>
          </div>
        ) : null}

        {mapMetric === "pickups" && !pickupQuantiles ? (
          <p className="mt-2 text-xs text-brand-muted">Add snapshot rows with pickup predictions to see Low / Medium / High shading.</p>
        ) : null}

        {mapMetric === "incident" ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-brand-text">
              <span className="flex items-center gap-2">
                <span className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm" style={{ background: "#DFF7EF" }} />
                <span>
                  <span className="font-semibold">Low</span>
                  <span className="text-brand-muted"> / no signal — no or weak incident/disruption signal</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm"
                  style={{ background: incidentFill(incidentMax * 0.45, incidentMax) }}
                />
                <span>
                  <span className="font-semibold">Elevated</span>
                  <span className="text-brand-muted"> — incident/disruption signal present</span>
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-7 shrink-0 rounded border border-brand-border/70 shadow-sm"
                  style={{ background: incidentFill(incidentMax, incidentMax) }}
                />
                <span>
                  <span className="font-semibold">High</span>
                  <span className="text-brand-muted"> — strong disruption signal</span>
                </span>
              </span>
            </div>
            <p className="text-xs font-medium leading-relaxed text-brand-muted">{legendCaptionDemand}</p>
          </div>
        ) : null}
        {legendFooter ? <p className="mt-2 text-xs font-medium leading-relaxed text-brand-muted">{legendFooter}</p> : null}
      </div>
    </div>
  );
}
