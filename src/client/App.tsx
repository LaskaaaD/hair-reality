import { lazy, Suspense } from "react";
import { Link, Outlet, Route, Routes } from "react-router";
import { FlowProvider } from "./flow/flow-state.js";
import { BriefPage } from "./BriefPage.js";
import { LandingPage } from "./landing.js";
import { SalonEntry } from "./SalonEntry.js";

const PhotosScreen = lazy(() =>
  import("./flow/PhotosScreen.js").then((module) => ({ default: module.PhotosScreen })),
);
const GoalScreen = lazy(() =>
  import("./flow/GoalScreen.js").then((module) => ({ default: module.GoalScreen })),
);
const RankingScreen = lazy(() =>
  import("./flow/RankingScreen.js").then((module) => ({ default: module.RankingScreen })),
);
const TryonScreen = lazy(() =>
  import("./flow/TryonScreen.js").then((module) => ({ default: module.TryonScreen })),
);

function FlowRouteFallback() {
  return (
    <main id="main" className="flow-page flow-page-e12">
      <p className="flow-inline-notice">Loading demo step…</p>
    </main>
  );
}

function DemoFlowLayout() {
  return (
    <FlowProvider>
      <Suspense fallback={<FlowRouteFallback />}>
        <Outlet />
      </Suspense>
    </FlowProvider>
  );
}

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/s/:slug" element={<SalonEntry />} />
        <Route path="/brief/:token" element={<BriefPage />} />
        <Route element={<DemoFlowLayout />}>
          <Route path="/demo" element={<PhotosScreen />} />
          <Route path="/demo/goal" element={<GoalScreen />} />
          <Route path="/demo/results" element={<RankingScreen />} />
          <Route path="/demo/tryon" element={<TryonScreen />} />
        </Route>
        <Route
          path="*"
          element={
            <main id="main" className="marketing-page not-found-page">
              <div className="not-found-card">
                <h1>Page not found</h1>
                <p>This link does not match a Hair Reality screen.</p>
                <Link className="button" to="/" reloadDocument>
                  Back to Hair Reality
                </Link>
                <Link className="button secondary" to="/demo" reloadDocument>
                  Open the demo
                </Link>
              </div>
            </main>
          }
        />
      </Routes>
    </>
  );
}
