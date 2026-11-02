import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}
const root = rootElement;

const appTree = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

const pathname = window.location.pathname;
const shouldHydrateLanding =
  root.dataset.hrHydrate === "landing" && pathname === "/";

async function mount() {
  if (pathname.startsWith("/demo")) {
    await import("./flow/PhotosScreen.js");
  }

  if (shouldHydrateLanding) {
    hydrateRoot(root, appTree);
  } else {
    const reactRoot = createRoot(root);
    flushSync(() => reactRoot.render(appTree));
    // The prerendered /demo shell is inert until the live tree replaces it.
    root.removeAttribute("inert");
  }
}

void mount();
