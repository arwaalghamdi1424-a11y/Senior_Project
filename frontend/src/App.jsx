import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import Footer from "./components/Footer";
import Dashboard from "./pages/Dashboard";
import TransportAuthority from "./pages/TransportAuthority";
import RideHailingOps from "./pages/RideHailingOps";
import ModelPerformance from "./pages/ModelPerformance";
import SimulationLab from "./pages/SimulationLab";
import DataInfo from "./pages/DataInfo";
import { getHealth, getOverview, logFallbackMode, prefetchCoreData } from "./lib/api";
import { isoToDisplay } from "./lib/format";

const LOG = "[MASEER]";

const PAGES = [
  { id: "dashboard", label: "Dashboard", component: Dashboard },
  { id: "transport", label: "Transport Authority", component: TransportAuthority },
  { id: "ops", label: "Ride-Hailing Companies", component: RideHailingOps },
  { id: "models", label: "Model Performance", component: ModelPerformance },
  { id: "simulation", label: "Simulation Lab", component: SimulationLab },
  { id: "data", label: "Data Info", component: DataInfo },
];

export default function App() {
  const [activePage, setActivePage] = useState("dashboard");
  const [overview, setOverview] = useState(null);
  /** `null` until the first `/api/health` check completes — avoids treating "unknown" as fallback. */
  const [apiOnline, setApiOnline] = useState(null);
  const [lastRefreshDisplay, setLastRefreshDisplay] = useState("");
  const healthRefreshGen = useRef(0);
  const prefetchOnce = useRef(false);

  const refreshMeta = useCallback(async (opts = {}) => {
    const forceRefresh = opts.forceRefresh === true;
    const id = ++healthRefreshGen.current;

    const health = await getHealth();
    if (id !== healthRefreshGen.current) return;

    if (health.ok) {
      console.info(`${LOG} /api/health → OK (status=${health.status})`);
      setApiOnline(true);

      if (!prefetchOnce.current) {
        prefetchOnce.current = true;
        void prefetchCoreData();
      }

      const ov = await getOverview({ allowStaticFallback: false, forceRefresh });
      if (id !== healthRefreshGen.current) return;

      if (ov.ok !== false) {
        setOverview(ov.data ?? null);
      } else {
        console.warn(`${LOG} /api/overview failed while API is online; keeping prior overview if any.`, ov.error ?? "");
      }
    } else {
      console.warn(`${LOG} /api/health → FAIL (status=${health.status})`);
      prefetchOnce.current = false;
      setApiOnline(false);
      logFallbackMode(`/api/health did not succeed (status=${health.status}); loading exported JSON snapshots.`);

      const ov = await getOverview({ allowStaticFallback: true });
      if (id !== healthRefreshGen.current) return;
      setOverview(ov.data ?? null);
    }

    setLastRefreshDisplay(isoToDisplay(new Date().toISOString()));
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const ActiveComponent = useMemo(
    () => PAGES.find((p) => p.id === activePage)?.component ?? Dashboard,
    [activePage]
  );

  const pageCfg = PAGES.find((p) => p.id === activePage);

  const badgeApi = apiOnline === true;
  const badgeFallback = apiOnline === false;

  return (
    <div className="min-h-screen bg-brand-bg antialiased">
      <Sidebar
        pages={PAGES}
        activePage={activePage}
        setActivePage={setActivePage}
        apiOnline={apiOnline}
        lastRefresh={lastRefreshDisplay}
      />
      <main className="min-h-screen pl-[240px]">
        <div
          className={`pointer-events-none fixed right-5 top-6 z-30 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide opacity-95 shadow-soft ${
            badgeApi
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : badgeFallback
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
          title="Backed by GET /api/health"
        >
          {apiOnline === null ? "Checking API…" : badgeApi ? "API Online" : "Exported Data Fallback"}
        </div>
        <div className="mx-auto max-w-[1600px] px-5 pt-14 pb-10">
          <ActiveComponent
            pageMeta={{ label: pageCfg?.label ?? "Dashboard", apiOnline }}
            overview={overview}
            refreshHealth={refreshMeta}
            apiOnline={apiOnline}
          />
          <Footer />
        </div>
      </main>
    </div>
  );
}
