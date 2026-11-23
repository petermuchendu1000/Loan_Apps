import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { Miniflare, Response } from "miniflare";
import { migrateLocal } from "../scripts/migrate-local.mjs";
import { repaymentFixture } from "../scripts/repayment-fixture.mjs";

test("M-PESA repayments keep one prompt, verify receipts and credit only when Tala confirms", async (t) => {
  const fixture = repaymentFixture();
  const origin = "https://tala.test";
  const phone = "+254700000009";
  const key = "repayment-test-signing-key-at-least-32-bytes";
  let queryVisible = false;
  let ledgerVisible = false;
  const runtime = new Miniflare({
    modules: true, scriptPath: "./dist/server/index.js", compatibilityDate: "2025-01-01",
    d1Databases: { DB: "repayment-test" },
    bindings: {
      ...fixture.bindings, VERIFICATION_ENV: "sandbox", AT_SMS_USERNAME: "sandbox", AT_SMS_API_KEY: "sms",
      DIDIT_WORKFLOW_ID: crypto.randomUUID(), DIDIT_API_KEY: "identity", OTP_SIGNING_KEY: key,
      TALA_APPLICATION_KEY: randomBytes(32).toString("base64url"),
    },
    async outboundService(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/stkpushquery/v1/query") && !queryVisible) return Response.json({}, { status: 404 });
      if (path.endsWith("/status") && !ledgerVisible) return Response.json({}, { status: 404 });
      const response = await fixture.fetch(request);
      assert(response, "Unexpected outbound request");
      // The provider records the payment before the client observes this temporary error.
      return path.endsWith("/repayment/notification") ? Response.json({}, { status: 503 }) : response;
    },
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  await migrateLocal(db);
  const phoneHash = createHmac("sha256", key).update("phone:sandbox:" + phone).digest("base64");
  await db.prepare(`INSERT INTO web_verifications (owner, phone_hash, phone_hint, phone_verified_at, didit_status, didit_id, id_reference)
    VALUES ('sandbox:borrower', ?, '+254 ••• ••0009', 1, 'approved', ?, ?)`).bind(phoneHash, crypto.randomUUID(), crypto.randomUUID()).run();
  await db.prepare(`INSERT INTO repayment_accounts (environment, owner, customer_ref, phone_hash)
    VALUES ('sandbox', 'borrower', 'fixture-customer', ?)`).bind(phoneHash).run();

  async function request(path = "", body, options = {}) {
    const { owner = "borrower", id, source = origin } = options;
    const headers = { ...(owner ? { "oai-authenticated-user-id": owner } : {}),
      ...(body ? { "Content-Type": "application/json", Origin: source } : {}), ...(id ? { "Idempotency-Key": id } : {}) };
    const response = await runtime.dispatchFetch(origin + "/api/repayments" + path, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, ...(await response.json()) };
  }

  const allowCheck = (id) => db.prepare("UPDATE repayment_attempts SET next_check_at = 0 WHERE id = ?").bind(id).run();
  const initial = await request();
  assert.equal(initial.state, "ready");
  assert.equal(initial.loan.balanceMinor, 425_000);
  assert.equal((await request("", undefined, { owner: null })).status, 401);
  assert.equal((await request("", undefined, { owner: "other" })).state, "unlinked");

  const id = crypto.randomUUID();
  const payment = { amount: 1250, phone, confirmed: true, loanId: initial.loan.id };
  assert.equal((await request("/start", payment, { id, source: "https://another.test" })).status, 403);
  assert.equal((await request("/start", { ...payment, phone: "0700000000" }, { id })).status, 400);
  assert.equal((await request("/start", { ...payment, amount: 4251 }, { id })).status, 409);
  const [first, duplicate] = await Promise.all([request("/start", payment, { id }), request("/start", payment, { id })]);
  assert.equal(first.payment.id, id);
  assert.equal(duplicate.payment.id, id);
  assert.equal(fixture.payments.size, 1);
  assert.equal((await request("/start", payment, { id: crypto.randomUUID() })).status, 409);
  assert.equal((await request("/start", { ...payment, amount: 1251 }, { id })).status, 409);
  assert.equal((await request("/check", { id }, { owner: "different" })).status, 404);
  assert.equal((await request("/check", { id })).payment.state, "pending");

  const [checkout] = fixture.payments.keys();
  const callback = fixture.decide(checkout);
  const proof = new URL(callback.url).search;
  const callbackPath = "/mpesa-callback" + proof;
  assert.equal((await request("/mpesa-callback?payment=" + id, callback.body, { owner: null })).status, 404);
  const badAmount = structuredClone(callback.body);
  badAmount.Body.stkCallback.CallbackMetadata.Item[0].Value = 1300;
  assert.equal((await request(callbackPath, badAmount, { owner: null })).status, 409);
  assert.equal((await request(callbackPath, callback.body, { owner: null })).ResultCode, 0);
  assert.equal(fixture.posts.length, 0);
  assert.equal((await request()).active.receipt, null);

  queryVisible = true;
  await allowCheck(id);
  let posting;
  for (let attempt = 0; attempt < 6 && !posting; attempt += 1) {
    const result = await request("/check", { id });
    if (result.payment.state === "posting") posting = result.payment;
    else {
      await allowCheck(id);
      await setTimeout(15);
    }
  }
  assert.equal(posting?.state, "posting");
  assert.equal(posting.receipt, null);
  assert.equal(fixture.posts.length, 1);
  assert.equal((await request(callbackPath, callback.body, { owner: null })).ResultCode, 0);
  await allowCheck(id);
  assert.equal((await request("/check", { id })).payment.state, "posting");
  assert.equal(fixture.posts.length, 1);

  ledgerVisible = true;
  await allowCheck(id);
  const credited = await request("/check", { id });
  const receipt = callback.body.Body.stkCallback.CallbackMetadata.Item[1].Value;
  assert.equal(credited.payment.receipt, receipt);
  assert.equal(credited.payment.state, "credited");
  const refreshed = await request();
  assert.equal(refreshed.loan.balanceMinor, 300_000);
  assert.equal(refreshed.ledger[0].amountMinor, 125_000);
  assert.equal(fixture.posts.length, 1);

  const secondId = crypto.randomUUID();
  assert.equal((await request("/start", { ...payment, amount: 3000 }, { id: secondId })).payment.state, "pending");
  const lastCheckout = [...fixture.payments.keys()].at(-1);
  fixture.decide(lastCheckout, "1032");
  const cancelled = await request("/check", { id: secondId });
  assert.equal(cancelled.payment.result, "cancelled");
  assert.equal(cancelled.payment.state, "failed");
  assert.equal((await request()).loan.balanceMinor, 300_000);
});
