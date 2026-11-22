import { readFile, readdir, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const assets = {};
for (const entry of await readdir("public", { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const parent = entry.parentPath ?? entry.path;
  const path = parent.replaceAll("\\", "/").slice("public".length) + "/" + entry.name;
  const extension = entry.name.slice(entry.name.lastIndexOf("."));
  if (!types[extension]) throw Error("Unknown asset type for " + path);
  assets[path] = { type: types[extension], data: (await readFile("public" + path)).toString("base64") };
}

await mkdir("dist/server", { recursive: true });
await build({
  entryPoints: ["server/index.mjs"],
  bundle: true,
  format: "esm",
  target: "es2022",
  define: { SITE_ASSETS: JSON.stringify(assets) },
  outfile: "dist/server/index.js",
});
