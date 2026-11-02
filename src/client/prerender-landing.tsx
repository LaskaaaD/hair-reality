import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { App } from "./App.js";
import { FlowProvider } from "./flow/flow-state.js";
import { PhotosScreen } from "./flow/PhotosScreen.js";

export { demoE1PreloadTags, landingHeroPreloadTags } from "./lcp-preload.js";

/** Build-time SSR for `/` — hero copy and LCP image markup in initial HTML. */
export function renderLandingMarkup(): string {
  return renderToString(
    <StrictMode>
      <MemoryRouter initialEntries={["/"]} initialIndex={0}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  );
}

/** Build-time SSR for `/demo` — instructions shell (matches demo-shell client after chunk preload). */
export function renderDemoShellMarkup(): string {
  return renderToString(
    <StrictMode>
      <MemoryRouter initialEntries={["/demo"]} initialIndex={0}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <FlowProvider>
          <PhotosScreen />
        </FlowProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}
