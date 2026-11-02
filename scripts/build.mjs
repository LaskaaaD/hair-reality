import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fillTemplate, fontPreloadTags, fontStylesheetTag } from "./html-template.mjs";

assertNode24();

await rm("dist", { recursive: true, force: true });
await mkdir("dist/client/assets", { recursive: true });

try {
  await cp("public/marketing", "dist/client/assets/marketing", { recursive: true });
} catch {
  /* optional until generate-marketing-assets.mjs has been run */
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  minify: true,
  legalComments: "none",
};

const clientResult = await esbuild.build({
  ...shared,
  entryPoints: ["src/client/main.tsx"],
  outdir: "dist/client/assets",
  format: "esm",
  splitting: true,
  platform: "browser",
  target: "es2023",
  jsx: "automatic",
  entryNames: "[name]-[hash]",
  chunkNames: "[name]-[hash]",
  define: { "process.env.NODE_ENV": "\"production\"" },
  drop: ["console", "debugger"],
  loader: { ".jpg": "file", ".png": "file", ".json": "json" },
  assetNames: "photos/[name]",
  publicPath: "/assets/",
  metafile: true,
});

const cssShared = {
  ...shared,
  outdir: "dist/client/assets",
  entryNames: "[name]-[hash]",
  loader: { ".woff2": "file", ".jpg": "file", ".png": "file" },
  assetNames: "fonts/[name]",
  metafile: true,
};

const landingCssResult = await esbuild.build({
  ...cssShared,
  entryPoints: ["src/client/styles-landing.css"],
});

const flowCssResult = await esbuild.build({
  ...cssShared,
  entryPoints: ["src/client/styles-flow.css"],
});

const mainJs = outputBasename(clientResult.metafile, "src/client/main.tsx");
const landingCss = outputBasename(landingCssResult.metafile, "src/client/styles-landing.css");
const flowCss = outputBasename(flowCssResult.metafile, "src/client/styles-flow.css");
if (!mainJs || !landingCss || !flowCss) {
  console.error("Build failed to produce hashed main or route styles entries.");
  process.exit(1);
}

const landingCssText = stripCssSourceMapComment(
  await readFile(join("dist/client/assets", landingCss), "utf8"),
);
const flowCssText = stripCssSourceMapComment(
  await readFile(join("dist/client/assets", flowCss), "utf8"),
);
const landingStyleHash = cspSha256(landingCssText);
const flowStyleHash = cspSha256(flowCssText);

const prerenderBundle = join("dist", "build-prerender.mjs");
await esbuild.build({
  ...shared,
  minify: false,
  entryPoints: ["src/client/prerender-landing.tsx"],
  outfile: prerenderBundle,
  platform: "node",
  format: "esm",
  bundle: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": "\"production\"" },
  packages: "external",
});

const prerenderUrl = pathToFileURL(join(process.cwd(), prerenderBundle)).href;
const {
  renderLandingMarkup,
  renderDemoShellMarkup,
  landingHeroPreloadTags,
  demoE1PreloadTags,
} = await import(prerenderUrl);

let htmlTemplate = await readFile("src/client/index.html", "utf8");
htmlTemplate = htmlTemplate.replace("/assets/main.js", `/assets/${mainJs}`);

const marketingFontPreloads = fontPreloadTags();
const marketingFontStylesheet = fontStylesheetTag();
const landingInlineStyles = `    <style>${landingCssText}</style>
`;
const flowInlineStyles = `    <style>${flowCssText}</style>
`;

const modulePreload = `    <link rel="modulepreload" href="/assets/${mainJs}">
`;

const landingPreload = landingHeroPreloadTags();
let indexHtml = fillTemplate(htmlTemplate, {
  fontPreloads: marketingFontPreloads,
  fontStylesheet: marketingFontStylesheet,
  landingPreload,
  appStylesheet: landingInlineStyles,
});
const landingMarkup = renderLandingMarkup();
indexHtml = injectPrerenderedRoot(indexHtml, landingMarkup);
indexHtml = indexHtml.replace("</head>", `${modulePreload}  </head>`);
await writeFile("dist/client/index.html", indexHtml);

const demoMarkup = renderDemoShellMarkup();
let demoShell = fillTemplate(htmlTemplate, {
  fontPreloads: marketingFontPreloads,
  fontStylesheet: marketingFontStylesheet,
  landingPreload: demoE1PreloadTags(),
  appStylesheet: flowInlineStyles,
});
demoShell = injectPrerenderedRoot(demoShell, demoMarkup, { hydrate: false });
demoShell = demoShell.replace("</head>", `${modulePreload}  </head>`);
await writeFile("dist/client/demo-shell.html", demoShell);

await writeFile(
  join("dist/client", "csp-style-hashes.json"),
  `${JSON.stringify([landingStyleHash, flowStyleHash])}\n`,
);

try {
  await cp("public/demo-media", "dist/client/demo-media", { recursive: true });
} catch {
  /* optional until demo-media assets are added */
}
try {
  await cp("node_modules/@mediapipe/tasks-vision/wasm", "dist/client/demo-media/mediapipe/wasm", { recursive: true });
} catch {
  console.warn("MediaPipe wasm missing; guided camera falls back to manual capture.");
}
try {
  await cp("public/robots.txt", "dist/client/robots.txt");
} catch {
  console.warn("public/robots.txt missing; /robots.txt will 404 until added.");
}

await precompressTree("dist/client");
await precompressTree("dist/client/assets");

await esbuild.build({
  ...shared,
  minify: false,
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.js",
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
});

await esbuild.build({
  ...shared,
  minify: false,
  entryPoints: { "purge-demo": "src/server/demo/purge-cli.ts" },
  outdir: "dist/server",
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
});

await esbuild.build({
  ...shared,
  minify: false,
  entryPoints: ["src/worker/index.ts"],
  outfile: "dist/worker/index.js",
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
});

function outputBasename(metafile, entryPoint) {
  for (const [outPath, info] of Object.entries(metafile.outputs)) {
    if (info.entryPoint === entryPoint) {
      return outPath.replace(/^dist[/\\]client[/\\]assets[/\\]/, "").replace(/\\/g, "/");
    }
  }
  return null;
}

function cspSha256(styleText) {
  return createHash("sha256").update(styleText, "utf8").digest("base64");
}

function stripCssSourceMapComment(css) {
  return css.replace(/\n?\/\*# sourceMappingURL=.*?\*\/\s*$/u, "");
}

async function precompressTree(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await precompressTree(full);
      continue;
    }
    if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
    if (!shouldPrecompress(entry.name)) continue;
    const data = await readFile(full);
    await writeFile(`${full}.gz`, gzipSync(data));
    await writeFile(`${full}.br`, brotliCompressSync(data));
  }
}

function shouldPrecompress(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".woff2") || lower.endsWith(".webp") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")) {
    return false;
  }
  return (
    lower.endsWith(".js")
    || lower.endsWith(".css")
    || lower.endsWith(".html")
    || lower.endsWith(".json")
    || lower.endsWith(".map")
    || lower.endsWith(".svg")
    || lower.endsWith(".txt")
  );
}

function assertNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    console.error(`Hair Reality requires Node.js 24. Current version is ${process.versions.node}.`);
    process.exit(1);
  }
}

function injectPrerenderedRoot(html, markup, options = { hydrate: true }) {
  const replaced = html.replace(
    /<div id="root"([^>]*)>\s*<\/div>/,
    (_match, attrs) => {
      let rootAttrs = options.hydrate ? attrs : "";
      if (!options.hydrate) {
        // Static shell stays inert until the client mounts (main.tsx drops it) so early input is not lost.
        rootAttrs = ' data-hr-demo-shell="1" inert';
      }
      return `<div id="root"${rootAttrs}>${markup}</div>`;
    },
  );
  if (replaced === html) {
    throw new Error("index.html missing empty #root element");
  }
  return replaced;
}
