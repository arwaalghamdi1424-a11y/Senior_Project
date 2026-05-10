import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { RefreshCcw, Database, Sparkles, Layers, ImageIcon, Table2, CloudSun } from "lucide-react";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import DataTable from "../components/DataTable";
import GlassButton from "../components/GlassButton";
import {
  getDataInfo,
  getFigures,
  apiUrl,
  peekCachedApiUrl,
  peekCachedDataInfo,
} from "../lib/api";
import { formatNumber } from "../lib/format";

const LOG = "[MASEER]";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "quality", label: "Data Quality" },
  { id: "features", label: "Feature Dictionary" },
  { id: "events", label: "Event Integration" },
  { id: "figures", label: "Figures Gallery" },
];

const PIPE = [
  { title: "Taxi Data", body: "TLC Yellow exports & zone geometries", Icon: Database },
  { title: "Cleaning", body: "Deduplication & invalid zone trims", Icon: Layers },
  { title: "Feature Engineering", body: "Temporal + lag features", Icon: Sparkles },
  { title: "Context Integration", body: "Weather + incident composites", Icon: CloudSun },
  { title: "Training", body: "Tabular + sequence artifacts", Icon: Layers },
  { title: "Dashboard", body: "Proxy visualization & API layering", Icon: Table2 },
];

export default function DataInfo({ refreshHealth, apiOnline }) {
  const subtitle =
    "Traceability for `target_pickup_count_next_hour` across curated TLC merges — every metric remains a pickup proxy.";

  const [tab, setTab] = useState("overview");
  const [bundle, setBundle] = useState(() => peekCachedDataInfo()?.data ?? null);
  const [figures, setFigures] = useState(() => {
    const peek = peekCachedApiUrl(apiUrl("figures"));
    if (peek?.ok && Array.isArray(peek.data?.figures)) return peek.data.figures;
    if (peek?.ok && Array.isArray(peek.data?.rows)) return peek.data.rows;
    return [];
  });
  const [featQ, setFeatQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [softRefreshing, setSoftRefreshing] = useState(false);
  const [fetchErrors, setFetchErrors] = useState({});

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const peekedBundle = peekCachedDataInfo();
    if (peekedBundle?.data) {
      setBundle((prev) => prev ?? peekedBundle.data);
    }
    const figPeek = peekCachedApiUrl(apiUrl("figures"));
    if (figPeek?.ok) {
      const next = Array.isArray(figPeek.data?.figures)
        ? figPeek.data.figures
        : Array.isArray(figPeek.data?.rows)
          ? figPeek.data.rows
          : null;
      if (next) setFigures((prev) => (prev?.length ? prev : next));
    }
  }, [apiOnline]);

  const load = async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    const allowStaticFallback = apiOnline !== true;
    if (!bundle || forceRefresh) {
      if (!bundle) setLoading(true);
      else setSoftRefreshing(true);
    }
    try {
      const [di, fg] = await Promise.all([
        getDataInfo({ allowStaticFallback, forceRefresh }),
        getFigures({ allowStaticFallback, forceRefresh }),
      ]);
      setBundle(di.data ?? null);
      const nextErr = {};
      if (di.ok === false) {
        const parts = [di.errors?.overview, di.errors?.modelMetrics].filter(Boolean).join(" • ");
        console.warn(`${LOG} data info partial failure:`, parts || "overview or model metrics");
        nextErr.dataInfo = parts || "Some API slices failed; static files still shown where available.";
      }
      if (fg.ok === false) {
        console.warn(`${LOG} figures:`, fg.error);
        nextErr.figures = fg.error || "Figures API failed";
      }
      setFetchErrors(nextErr);
      if (fg.ok !== false) setFigures(fg.rows ?? []);
    } finally {
      setLoading(false);
      setSoftRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOnline]);

  const ds = bundle?.dataset_summary ?? {};
  const feats = bundle?.feature_dictionary ?? [];
  const events = bundle?.event_integration_summary ?? [];
  const dq = bundle?.data_quality_summary ?? null;
  const targ = bundle?.target_explanation ?? {};

  const filteredFeats = useMemo(() => {
    const q = featQ.trim().toLowerCase();
    if (!q) return feats;
    return feats.filter((row) =>
      [`${row.column ?? ""}`, `${row.feature_group ?? ""}`, `${row.description ?? ""}`]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [featQ, feats]);

  const imgs = figures.filter((f) => Boolean(f.url));

  return (
    <div className="space-y-5">
      <PageHeader title="Data Info" subtitle={subtitle}>
        <GlassButton
          variant="primary"
          onClick={async () => {
            await refreshHealth?.({ forceRefresh: true });
            await load({ forceRefresh: true });
          }}
        >
          <RefreshCcw size={16} strokeWidth={1.75} />
          Refresh
        </GlassButton>
      </PageHeader>

      {apiOnline === null || (loading && bundle == null) ? (
        <div className="rounded-xl border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">Refreshing metadata…</div>
      ) : null}

      {softRefreshing ? (
        <p className="text-xs font-semibold text-brand-muted">Updating…</p>
      ) : null}

      {fetchErrors.dataInfo || fetchErrors.figures ? (
        <div className="space-y-1 text-xs text-rose-600">
          {fetchErrors.dataInfo ? <p>{fetchErrors.dataInfo}</p> : null}
          {fetchErrors.figures ? <p>Figures: {fetchErrors.figures}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={Database} accent="teal" label="Rows" value={formatNumber(ds.rows, 0)} subtext={`${formatNumber(ds.columns, 0)} columns engineered`} />
        <KpiCard icon={Table2} accent="mint" label="Feature Count (summary)" value={formatNumber(ds.feature_count ?? feats.length ?? 0, 0)} subtext={`Dictionary rows: ${feats.length}`} />
        <KpiCard icon={Layers} accent="neutral" label="Zones" value={formatNumber(ds.number_of_zones, 0)} subtext={`${ds.time_range_start ?? "—"} → ${ds.time_range_end ?? ""}`} />
        <KpiCard
          icon={ImageIcon}
          accent="warn"
          label="Figures surfaced"
          value={formatNumber(imgs.length, 0)}
          subtext={
            figures.length > imgs.length
              ? `${formatNumber(figures.length - imgs.length, 0)} entries without public URL`
              : "Manifest linked to reachable assets"
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-brand-border bg-white p-2 shadow-card">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              tab === t.id ? "bg-brand-primary text-white shadow-card" : "text-brand-muted hover:bg-brand-bg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SectionCard title="Data Pipeline Trace" subtitle="Synthetic process map aligning with TLC governance storytelling">
        <div className="grid gap-3 md:grid-cols-6">
          {PIPE.map(({ title, body, Icon }, idx) => (
            <div
              key={title}
              className="rounded-xl border border-brand-border bg-brand-bg px-3 py-3 text-xs shadow-inner"
              style={{
                animationDelay: `${idx * 70}ms`,
              }}
            >
              <Icon className="mb-2 text-brand-primary" size={20} strokeWidth={1.7} />
              <div className="font-semibold text-brand-text">{title}</div>
              <p className="mt-1 leading-relaxed text-brand-muted">{body}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      {tab === "overview" ? (
        <div className="space-y-4">
          <SectionCard title="Target Variable Definition" subtitle="Ground truth alignment">
            <div className="rounded-xl border border-brand-mint bg-maseer-mint/35 p-4 text-sm leading-relaxed text-brand-text">
              <p className="text-base font-semibold">{targ.target_column ?? ds.target_column}</p>
              <p className="mt-2 text-brand-muted">{targ.target_definition}</p>
              <p className="mt-3 text-brand-text">{targ.proxy_note ?? ds.proxy_hint}</p>
              <span className="mt-4 inline-flex rounded-full bg-brand-primary px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                Regression on continuous pickups
              </span>
            </div>
          </SectionCard>

          <SectionCard title="Dataset Snapshot" subtitle="Aggregated parquet / JSON synopsis">
            <DataTable
              rows={datasetRows(ds)}
              columns={[
                { key: "metric", label: "Metric", render: (v) => v },
                { key: "value", label: "Value" },
              ]}
              maxRows={22}
            />
            <div className="mt-6">
              <h4 className="text-xs font-semibold uppercase text-brand-muted">Authoritative sources</h4>
              <ul className="mt-3 space-y-2 text-sm text-brand-text">
                {(bundle?.data_sources ?? ds.data_sources ?? []).map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === "quality" ? (
        <SectionCard title="Data Quality Notes" subtitle="Latest run summaries from artifacts/metadata when present">
          {dq ? (
            <pre className="overflow-auto rounded-xl border border-brand-border bg-brand-bg p-4 text-[12px] leading-relaxed text-brand-text">
              {JSON.stringify(dq, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-brand-muted">
              No `run_summary.json` detected locally — hydrate this tab by exporting training metadata or powering the `/api/data-info`
              endpoint.
            </p>
          )}
          {ds.available_weather_columns ? (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase text-brand-muted">Tracked weather/feature families</h4>
              <p className="mt-2 font-mono text-[11px] text-brand-muted">
                {(ds.available_weather_columns ?? []).join(", ") || "—"}
              </p>
            </div>
          ) : null}
          {ds.available_event_columns ? (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase text-brand-muted">Event composites</h4>
              <p className="mt-2 font-mono text-[11px] text-brand-muted">{(ds.available_event_columns ?? []).join(", ") || "—"}</p>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {tab === "features" ? (
        <SectionCard title="Feature Dictionary" subtitle={`Search among ${feats.length} documented columns`}>
          <label className="mb-4 block">
            <span className="text-[11px] font-semibold uppercase text-brand-muted">Search</span>
            <input
              value={featQ}
              onChange={(e) => setFeatQ(e.target.value)}
              placeholder="Filter by column, group, notes…"
              className="mt-2 w-full rounded-lg border border-brand-border px-3 py-2 text-sm shadow-inner focus:border-brand-primary focus:outline-none"
            />
          </label>
          <DataTable
            rows={filteredFeats}
            columns={[
              { key: "column", label: "Feature" },
              { key: "feature_group", label: "Group" },
              {
                key: "dtype",
                label: "Type",
                render: (v, r) => String(v ?? r.data_type ?? "—"),
              },
              {
                key: "description",
                label: "Notes",
                render: (v) => `${(v ?? "—").toString().slice(0, 160)}`,
              },
            ]}
            maxRows={180}
          />
        </SectionCard>
      ) : null}

      {tab === "events" ? (
        <SectionCard title="Event Integration Summary" subtitle={`${events?.length ?? 0} synthesized rows — align with TLC external feeds where possible`}>
          {events?.length ? (
            <DataTable
              rows={events}
              columns={Object.keys(events[0] ?? {}).slice(0, 8).map((k) => ({
                key: k,
                label: k.replace(/_/g, " "),
              }))}
              maxRows={120}
            />
          ) : (
            <EmptyTab />
          )}
        </SectionCard>
      ) : null}

      {tab === "figures" ? (
        <SectionCard title="Artifacts Gallery" subtitle="Bundled visuals from frontend/public + reports manifests">
          {imgs.length ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {imgs.map((fig, idx) => (
                <figure key={`${fig.path}-${idx}`} className="rounded-xl border border-brand-border bg-white p-4 shadow-soft">
                  {fig.url ? (
                    <img src={fig.url} alt={`${fig.title ?? "Figure"} preview`} className="h-48 w-full rounded-lg object-cover" />
                  ) : (
                    <div className="flex h-48 items-center justify-center rounded-lg bg-brand-bg text-sm text-brand-muted">
                      Absolute path • see reports/
                    </div>
                  )}
                  <figcaption className="mt-3 text-sm font-semibold text-brand-text">{fig.title ?? "Figure"}</figcaption>
                  <p className="text-[11px] text-brand-muted">{fig.category ?? "General"}</p>
                </figure>
              ))}
            </div>
          ) : figures.length === 0 ? (
            <EmptyTab message="Expose PNG/SVG artifacts under frontend/public/figures or mount /api/figures to populate this masonry grid." />
          ) : (
            <EmptyTab />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

function datasetRows(ds) {
  return [
    ["Total rows", formatNumber(ds.rows, 0)],
    ["Columns", formatNumber(ds.columns, 0)],
    ["Distinct zones", formatNumber(ds.number_of_zones, 0)],
    ["Feature tally", formatNumber(ds.feature_count, 0)],
    ["Temporal start", ds.time_range_start ?? "—"],
    ["Temporal end", ds.time_range_end ?? "—"],
    ["Target column", ds.target_column ?? "target_pickup_count_next_hour"],
  ].map(([metric, value]) => ({ metric, value }));
}

function EmptyTab({ message }) {
  return (
    <p className="rounded-xl border border-dashed border-brand-border bg-brand-bg/60 px-6 py-10 text-center text-sm leading-relaxed text-brand-muted">
      {message ??
        "No supplemental rows for this section — rerun `scripts/export_dashboard_data.py` once updated dataset summaries arrive."}
    </p>
  );
}
