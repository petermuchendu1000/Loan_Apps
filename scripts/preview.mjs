import { Miniflare } from "miniflare";
import { migrateLocal } from "./migrate-local.mjs";
import { authPreview } from "./auth-preview.mjs";

const testingRepayment = process.argv.includes("--repayment");
const testingAuth = testingRepayment || process.argv.includes("--auth");
const runtime = new Miniflare({
  ...(testingAuth ? authPreview(testingRepayment) : {
    modules: true,
    scriptPath: "./dist/server/index.js",
    d1Databases: { DB: "tala-demo-local" },
    bindings: { LOCAL_DEMO: "1" },
    port: 8175,
  }),
  compatibilityDate: "2025-01-01",
  host: "127.0.0.1",
});

const database = await runtime.getD1Database("DB");
await migrateLocal(database);
const preview = await runtime.ready;
console.log("Local preview " + preview.href);
if (testingAuth) console.log("Account testing and SMS inbox " + new URL("/_local/auth", preview).href);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await runtime.dispose();
    process.exit(0);
  });
}
