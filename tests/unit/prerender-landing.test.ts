import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  demoE1PreloadTags,
  landingHeroPreloadTags,
} from "../../src/client/lcp-preload.js";
import { renderDemoShellMarkup, renderLandingMarkup } from "../../src/client/prerender-landing.js";
import {
  cacheControlForDemoMedia,
  cacheControlForMarketingFont,
  injectBeforeCloseHead,
} from "../../src/server/static-compress.js";

test("renderLandingMarkup includes hero headline and LCP hero image", () => {
  const html = renderLandingMarkup();
  assert.match(html, /Show clients what their hair can hold/);
  assert.match(html, /sample-front/);
  assert.match(html, /fetchpriority="high"|fetchPriority="high"/i);
  assert.doesNotMatch(html, /landing-hero-compare/);
});

test("landingHeroPreloadTags emits sample-front image preload link", () => {
  const tags = landingHeroPreloadTags();
  assert.match(tags, /rel="preload"/);
  assert.match(tags, /as="image"/);
  assert.match(tags, /fetchpriority="high"/);
  assert.match(tags, /sample-front\.jpg/);
  assert.doesNotMatch(tags, /imagesrcset=/);
});

test("renderDemoShellMarkup includes E12 instructions shell", () => {
  const html = renderDemoShellMarkup();
  assert.match(html, /flow-shell e12-shell/);
  assert.match(html, /hr-photos__grid/);
  assert.match(html, /skip-link/);
});

test("demoE1PreloadTags targets first capture example", () => {
  const tags = demoE1PreloadTags();
  assert.match(tags, /sample-front/);
  assert.match(tags, /240w\.webp/);
});

test("injectBeforeCloseHead inserts snippet once", () => {
  const base = "<html><head><title>x</title></head><body></body></html>";
  const snippet = '<link rel="preload" as="image" href="/demo-media/x.webp">';
  const once = injectBeforeCloseHead(base, snippet);
  assert.match(once, /preload/);
  assert.equal(injectBeforeCloseHead(once, snippet), once);
});

test("cacheControlForDemoMedia is seven days public", () => {
  assert.equal(cacheControlForDemoMedia(), "public, max-age=604800");
});

test("cacheControlForMarketingFont applies to woff2 under marketing/fonts", () => {
  assert.match(
    cacheControlForMarketingFont("marketing/fonts/jost-latin-600-normal.woff2") ?? "",
    /immutable/,
  );
  assert.equal(cacheControlForMarketingFont("marketing/other/file.woff2"), undefined);
});

test("built index.html contains prerendered landing root", async () => {
  const indexPath = join(process.cwd(), "dist", "client", "index.html");
  let html: string;
  try {
    html = await readFile(indexPath, "utf8");
  } catch {
    return;
  }
  assert.match(html, /data-hr-hydrate="landing"/);
  assert.match(html, /Show clients what their hair can hold/);
  assert.match(html, /rel="preload"[^>]+as="image"/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /styles-flow-/);
});

test("built demo-shell.html preloads E1 and prerenders demo shell", async () => {
  const shellPath = join(process.cwd(), "dist", "client", "demo-shell.html");
  let html: string;
  try {
    html = await readFile(shellPath, "utf8");
  } catch {
    return;
  }
  assert.doesNotMatch(html, /data-hr-hydrate="landing"/);
  assert.match(html, /240w\.webp/);
  assert.doesNotMatch(html, /landing-hero-compare/);
  assert.match(html, /flow-shell e12-shell/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /rel="stylesheet"[^>]+styles-flow/);
  assert.match(html, /marketing\/fonts\/fonts\.css/);
});
