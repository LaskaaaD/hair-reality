import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { pathToFileURL } from "node:url";
import { fillTemplate, fontPreloadTags, fontStylesheetTag } from "./html-template.mjs";

assertNode24();

// Start clean: stale precompressed (.br/.gz) prod output from `npm run build` would otherwise be served instead of dev files.
await rm("dist", { recursive: true, force: true });
await mkdir("dist/client/assets", { recursive: true });
try {
  await cp("public/marketing", "dist/client/assets/marketing", { recursive: true });
} catch {
  /* optional until generate-marketing-assets.mjs has been run */
}
try {
  await cp("public/demo-media", "dist/client/demo-media", { recursive: true });
} catch {
  /* optional until demo-media assets are added */
}

await esbuild.build({
  entryPoints: ["src/client/lcp-preload.ts"],
  outfile: "dist/dev-lcp-preload.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "warning",
});
const { landingHeroPreloadTags, demoE1PreloadTags } = await import(
  pathToFileURL(`${process.cwd()}/dist/dev-lcp-preload.mjs`).href
);

async function writeClientShells() {
  const template = await readFile("src/client/index.html", "utf8");
  const fontPreloads = fontPreloadTags();
  const fontStylesheet = fontStylesheetTag();
  const appStylesheet = `    <link rel="stylesheet" href="/assets/styles.css">`;

  const indexHtml = fillTemplate(template, {
    fontPreloads,
    fontStylesheet,
    landingPreload: landingHeroPreloadTags(),
    appStylesheet,
  });
  await writeFile("dist/client/index.html", indexHtml);

  const demoShell = fillTemplate(
    template.replace('data-hr-hydrate="landing"', ""),
    {
      fontPreloads,
      fontStylesheet,
      landingPreload: demoE1PreloadTags(),
      appStylesheet,
    },
  ).replace(
    /<div id="root"([^>]*)>\s*<\/div>/,
    '<div id="root" data-hr-demo-shell="1"></div>',
  );
  await writeFile("dist/client/demo-shell.html", demoShell);
}

await writeClientShells();

const client = await esbuild.context({
  entryPoints: ["src/client/main.tsx"],
  outfile: "dist/client/assets/main.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  jsx: "automatic",
  sourcemap: true,
  define: { "process.env.NODE_ENV": "\"development\"" },
  loader: { ".jpg": "file", ".png": "file" },
  assetNames: "photos/[name]",
  publicPath: "/assets",
  logLevel: "info",
});

const styles = await esbuild.context({
  entryPoints: ["src/client/styles.css"],
  outfile: "dist/client/assets/styles.css",
  bundle: true,
  sourcemap: true,
  loader: { ".woff2": "file", ".jpg": "file", ".png": "file" },
  assetNames: "fonts/[name]",
  logLevel: "info",
});

await client.watch();
await styles.watch();

const htmlWatch = watch("src/client/index.html", () => {
  void writeClientShells().catch((error) => {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`html_write_failed ${name}`);
  });
});

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "src/server/index.ts"], {
  stdio: "inherit",
});

const worker = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "src/worker/index.ts"], {
  stdio: "inherit",
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  htmlWatch.close();
  server.kill("SIGTERM");
  worker.kill("SIGTERM");
  await client.dispose();
  await styles.dispose();
};

process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});

for (const child of [server, worker]) {
  child.on("exit", (code) => {
    if (!stopping) {
      void stop().finally(() => process.exit(code ?? 1));
    }
  });
}

function assertNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    console.error(`Hair Reality requires Node.js 24. Current version is ${process.versions.node}.`);
    process.exit(1);
  }
}
