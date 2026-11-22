import { Miniflare } from "miniflare";
import { migrateLocal } from "./migrate-local.mjs";

const runtime = new Miniflare({
  modules: true,
  scriptPath: "./dist/server/index.js",
  compatibilityDate: "2025-01-01",
  d1Databases: { DB: "tala-demo-local" },
  bindings: { LOCAL_DEMO: "1" },
  host: "127.0.0.1",
  port: 8175,
});

const database = await runtime.getD1Database("DB");
await migrateLocal(database);
console.log("Local preview " + (await runtime.ready).href);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await runtime.dispose();
    process.exit(0);
  });
}
