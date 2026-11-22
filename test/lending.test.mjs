import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import { CaaSError, createCaaSClient } from "../server/caas.mjs";
import { migrateLocal } from "../scripts/migrate-local.mjs";
import { normalizeKenyanMobile, verificationRequest } from "../server/verification.mjs";
import { isLendingReviewer, lendingApplicationRequest, lendingReviewRequest } from "../server/lending-applications.mjs";

const runtime = new Miniflare({
  modules: true,
  scriptPath: "./dist/server/index.js",
  compatibilityDate: "2025-01-01",
  d1Databases: { DB: "test" },
});
const origin = "http://tala.test";

before(async () => {
  const db = await runtime.getD1Database("DB");
  await migrateLocal(db);
});
after(() => runtime.dispose());

async function send(owner, action, body = {}, options = {}) {
  const headers = owner ? { "oai-authenticated-user-id": owner } : {};
  const url = origin + "/api/account" + (action ? "/" + action : "");
  const settings = action ? {
    method: "POST",
    headers: {
      ...headers, "Content-Type": "application/json", Origin: options.origin ?? origin,
      "Idempotency-Key": options.id ?? crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  } : { headers };
  const response = await runtime.dispatchFetch(url, settings);
  return { status: response.status, ...(await response.json()) };
}

async function success(owner, action, body, options) {
  const result = await send(owner, action, body, options);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.account;
}

async function enrol(owner, scenario = "standard") {
  const start = await success(owner, "start", { scenario });
  assert.equal(start.stage, "otp");
  assert.equal((await send(owner, "verify", { code: "000000" })).status, 400);
  assert.equal((await success(owner, "verify", { code: start.sampleCode })).stage, "identity");
  const state = await success(owner, "identity", { consent: true });
  if (state.stage !== "application") return state;
  return success(owner, "apply", { purpose: "Business", consent: true });
}

test("isolates sample accounts, rejects unsigned and cross-origin activity", async () => {
  assert.equal((await send(null)).status, 401);
  assert.equal((await send("first", "start", { scenario: "standard" }, { origin: "https://other.test" })).status, 403);
  assert.equal((await send("first", "apply", { purpose: "Business", consent: true })).status, 409);
  assert.equal((await enrol("first", "review")).decision.status, "in-review");
  assert.equal((await success("second")).stage, "start");
  assert.equal((await enrol("second", "identity")).stage, "identity-review");
});

test("quotes, disburses, handles failed and partial payments, and restores the credit line", async () => {
  const owner = "borrower";
  const approved = await enrol(owner);
  assert.equal(approved.available, 1_000_000);
  assert.equal((await send(owner, "quote", { amount: 1_000_001, days: 14 })).status, 400);
  const { quote } = await success(owner, "quote", { amount: 200_000, days: 14 });
  assert.equal(quote.total, 211_760);
  const acceptance = { id: quote.id, termsVersion: quote.termsVersion, consent: true };
  const options = { id: crypto.randomUUID() };
  const [first, duplicate] = await Promise.all([
    success(owner, "accept", acceptance, options),
    success(owner, "accept", acceptance, options),
  ]);
  assert.equal(first.pending.id, duplicate.pending.id);
  assert.equal(duplicate.transfers.length, 1);
  assert.equal((await send(owner, "accept", { ...acceptance, consent: false }, options)).status, 409);
  const active = await success(owner, "settle", { id: first.pending.id, outcome: "success" });
  assert.equal(active.loan.status, "active");
  assert.equal(active.balance, 200_840);
  const tryPay = await success(owner, "repay", { amount: 25_000 });
  const failed = await success(owner, "settle", { id: tryPay.pending.id, outcome: "failed" });
  assert.equal(failed.balance, active.balance);
  const partial = await success(owner, "repay", { amount: 50_000 });
  const remainder = await success(owner, "settle", { id: partial.pending.id, outcome: "success" });
  assert.equal(remainder.balance, 150_840);
  const payoff = await success(owner, "repay", { amount: remainder.balance });
  const closed = await success(owner, "settle", { id: payoff.pending.id, outcome: "success" });
  assert.equal(closed.loan.status, "repaid");
  assert.equal(closed.available, approved.available);
  const support = await success(owner, "support", { topic: "Repayment" });
  assert.equal(support.tickets.length, 1);
  assert.equal((await success(owner)).transfers.length, 4);
});

test("a failed disbursement leaves the account ready to quote again", async () => {
  const owner = "failed-transfer";
  await enrol(owner);
  const { quote } = await success(owner, "quote", { amount: 100_000, days: 30 });
  const pending = await success(owner, "accept", { id: quote.id, termsVersion: quote.termsVersion, consent: true });
  const failed = await success(owner, "settle", { id: pending.pending.id, outcome: "failed" });
  assert.equal(failed.available, 1_000_000);
  assert.equal(failed.loan, null);
  assert.equal(failed.transfers[0].status, "failed");
});

test("matches the documented Tala token exchange and v2 loan routes", async () => {
  const calls = [];
  const api = createCaaSClient({
    baseUrl: "https://sandbox.example.test/caas", clientId: "fixture-id", clientSecret: "fixture-secret",
    fetcher: async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("/token")) return Response.json({ access_token: "fixture", expires_in: 900 });
      if (url.endsWith("/missing/loan")) return Response.json({
        data: null, metadata: { statusCode: 404, requestId: "fixture-request" },
      });
      return Response.json({ data: {}, metadata: { statusCode: 200 } });
    },
  });
  await Promise.all([api.call("identityFields"), api.call("offer", { customer: "sample/borrower" })]);
  const offer = { amount: { amount: 2000, isoCode: "KES" }, action: "Accept", dueDate: "2026-12-22", partnerLoanId: "fixture-loan" };
  await api.call("decide", { customer: "sample/borrower", body: offer });
  assert.equal(calls.filter(([url]) => url.endsWith("/token")).length, 1);
  assert.equal(calls[0][1].body.toString(), "grant_type=client_credentials");
  assert.equal(calls[0][1].headers.authorization, "Basic " + btoa("fixture-id:fixture-secret"));
  const [url, init] = calls.at(-1);
  assert.equal(url, "https://sandbox.example.test/caas/api/v2/users/sample%2Fborrower/loan/offer");
  assert.equal(init.method, "PUT");
  assert.equal(init.headers.authorization, "Bearer fixture");
  assert.deepEqual(JSON.parse(init.body), offer);
  await assert.rejects(api.call("loan", { customer: "missing" }), (error) =>
    error instanceof CaaSError && error.status === 404 && error.requestId === "fixture-request");
});

test("the hosted verification route stays closed until provider settings are complete", async () => {
  const url = origin + "/api/verification?status=Approved";
  const anonymous = await runtime.dispatchFetch(url);
  assert.equal(anonymous.status, 401);
  const headers = { "oai-authenticated-user-id": "verify-owner" };
  const response = await runtime.dispatchFetch(url, { headers });
  assert.deepEqual(await response.json(), { verification: { state: "unavailable" } });
  const mutation = await runtime.dispatchFetch(origin + "/api/verification/send-code", {
    method: "POST", headers: { ...headers, Origin: "https://other.test" },
  });
  assert.equal(mutation.status, 403);
});

test("phone verification consumes a signed SMS code and checks the matching Didit result", async () => {
  const db = await runtime.getD1Database("DB");
  const env = {
    DB: db, VERIFICATION_ENV: "sandbox", AT_SMS_USERNAME: "sandbox", AT_SMS_API_KEY: "sms-fixture",
    DIDIT_API_KEY: "identity-fixture", DIDIT_WORKFLOW_ID: crypto.randomUUID(),
    OTP_SIGNING_KEY: "test-key-containing-at-least-thirty-two-characters",
  };
  const owner = "verification-fixture";
  const decisionId = crypto.randomUUID();
  let time = 1_795_355_000_000;
  let code;
  let reference;
  let providerState = "In Review";
  let records = [];
  let smsCount = 0;
  let identityCount = 0;
  let wrongReference = false;
  const settings = {
    now: () => time,
    fetcher: async (url, request) => {
      if (url === "https://api.sandbox.africastalking.com/version1/messaging") {
        smsCount += 1;
        assert.equal(request.headers.apikey, "sms-fixture");
        assert.equal(request.body.get("username"), "sandbox");
        assert.equal(request.body.get("to"), "+254712345678");
        code = /\b\d{6}\b/.exec(request.body.get("message"))[0];
        return Response.json({ SMSMessageData: { Recipients: [{ number: "+254712345678", statusCode: 101 }] } });
      }
      assert.equal(request.headers["x-api-key"], "identity-fixture");
      if (url === "https://verification.didit.me/v3/session/") {
        identityCount += 1;
        const body = JSON.parse(request.body);
        assert.deepEqual(body.expected_details, { id_country: "KEN", expected_document_types: ["ID"] });
        assert.equal(body.callback, "https://tala.test/verify");
        assert.equal(body.workflow_id, env.DIDIT_WORKFLOW_ID);
        assert.equal(body.sandbox_scenario, "approve");
        assert.ok(request.headers["idempotency-key"]);
        reference = body.vendor_data;
        assert.notEqual(reference, owner);
        return Response.json({ session_id: decisionId, url: "https://verify.didit.me/session-token" });
      }
      assert.equal(url, "https://verification.didit.me/v3/session/" + decisionId + "/decision/");
      return Response.json({
        session_id: decisionId, workflow_id: env.DIDIT_WORKFLOW_ID, session_kind: "user",
        vendor_data: wrongReference ? "unrelated-account" : reference, status: providerState,
        id_verifications: records, session_url: "https://verify.didit.me/session-token",
      });
    },
  };
  const call = (action, body) => verificationRequest(env, owner, new URL("https://tala.test/verify"), action, body, settings);
  assert.equal(normalizeKenyanMobile(" (0712) 345-678 "), "+254712345678");
  assert.equal(normalizeKenyanMobile("+254 112 345 678"), "+254112345678");
  assert.equal(normalizeKenyanMobile("0201234567"), null);
  assert.equal((await call("status")).state, "phone");
  await assert.rejects(call("start-identity", { consent: true }), { status: 409 });
  const challenge = await call("send-code", { phone: "0712345678" });
  assert.equal(challenge.state, "code");
  assert.equal(challenge.phoneHint, "+254 ••• ••5678");
  assert.deepEqual(Object.keys(challenge).sort(), ["environment", "phoneHint", "retryAt", "state"]);
  await assert.rejects(call("send-code", { phone: "0712345678" }), { status: 429 });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(call("confirm-code", { code: code === "000000" ? "111111" : "000000" }), { status: 400 });
  }
  await assert.rejects(call("confirm-code", { code }), { status: 409 });
  time += 60_001;
  await call("send-code", { phone: "+254712345678" });
  assert.equal(smsCount, 2);
  assert.equal((await call("confirm-code", { code })).state, "identity");
  const dbRow = await db.prepare("SELECT phone_hash, otp_hash FROM web_verifications WHERE owner = ?").bind("sandbox:" + owner).first();
  assert.notEqual(dbRow.phone_hash, "+254712345678");
  assert.equal(dbRow.otp_hash, null);
  await assert.rejects(call("start-identity", { consent: false }), { status: 400 });
  assert.equal((await call("start-identity", { consent: true })).identityUrl, "https://verify.didit.me/session-token");
  await call("start-identity", { consent: true });
  assert.equal(identityCount, 1);
  assert.equal((await call("refresh-identity")).identityStatus, "in-review");
  time += 9_000;
  providerState = "APPROVED";
  assert.equal((await call("refresh-identity")).identityStatus, "in-review");
  time += 9_000;
  wrongReference = true;
  await assert.rejects(call("refresh-identity"), { status: 502 });
  time += 9_000;
  wrongReference = false;
  records = [{ status: "Approved", document_number: "must-stay-with-the-provider" }];
  const final = await call("refresh-identity");
  assert.equal(final.state, "verified");
  assert.equal(JSON.stringify(final).includes("must-stay-with-the-provider"), false);
  const liveEnv = { ...env, VERIFICATION_ENV: "live", AT_SMS_USERNAME: "live-fixture", AT_SMS_SENDER_ID: "TALA" };
  const liveState = await verificationRequest(liveEnv, owner, new URL("https://tala.test/verify"), "status", {}, settings);
  assert.equal(liveState.state, "phone");
});

test("application endpoints stay gated and the review queue rejects unlisted users", async () => {
  const headers = { "oai-authenticated-user-id": "application-owner", "oai-authenticated-user-email": "applicant@example.test" };
  const response = await runtime.dispatchFetch(origin + "/api/applications", { headers });
  assert.deepEqual(await response.json(), { application: { state: "unavailable" } });
  assert.equal((await runtime.dispatchFetch(origin + "/api/lending-review", { headers })).status, 403);
  assert.equal((await runtime.dispatchFetch(origin + "/review", { headers })).status, 403);
});

test("verified intake records one application, encrypts contact and audits staff review", async () => {
  const db = await runtime.getD1Database("DB");
  const env = {
    DB: db, VERIFICATION_ENV: "live", AT_SMS_USERNAME: "sms-app", AT_SMS_API_KEY: "sms-fixture",
    AT_SMS_SENDER_ID: "TALA", DIDIT_API_KEY: "id-fixture", DIDIT_WORKFLOW_ID: crypto.randomUUID(),
    OTP_SIGNING_KEY: "fixture-otp-signing-key-for-test-purposes",
    TALA_APPLICATION_KEY: randomBytes(32).toString("base64url"),
    TALA_REVIEWER_EMAILS: "authorized@example.test",
  };
  const phone = "+254712345678";
  const phoneHash = createHmac("sha256", env.OTP_SIGNING_KEY).update("phone:live:" + phone).digest("base64");
  const identityId = crypto.randomUUID();
  const identityReference = crypto.randomUUID();
  const applicant = "application-fixture";
  const otherAccount = "second-verified-account";
  const applicantRecord = (user) => db.prepare(`
    INSERT INTO web_verifications (owner, phone_hash, phone_hint, phone_verified_at, id_reference, didit_id, didit_status)
    VALUES (?, ?, ?, 1795361000000, ?, ?, 'approved')
  `).bind("live:" + user, phoneHash, "+254 ••• ••5678", identityReference, identityId).run();
  await applicantRecord(applicant);
  await applicantRecord(otherAccount);
  let applicableCountry = "KEN";
  let providerEnvironment = "live";
  const dependencies = { fetcher: async (url) => {
    assert.equal(url, "https://verification.didit.me/v3/session/" + identityId + "/decision/");
    return Response.json({
      session_id: identityId, workflow_id: env.DIDIT_WORKFLOW_ID, vendor_data: identityReference,
      status: "Approved", session_kind: "user", environment: providerEnvironment,
      id_verifications: [{ status: "Approved", issuing_state: applicableCountry, document_type: "Identity Card", document_number: "TEST-ID-REDACTED" }],
    });
  } };
  const body = { phone: "0712 345 678", amount: 2000, purpose: "Education", eligible: true, consent: true };
  const send = (user, action, request) => lendingApplicationRequest(env, user, action, request, dependencies);
  assert.equal((await send("unverified-account", "status")).state, "verify");
  assert.equal((await send(applicant, "status")).state, "ready");
  await assert.rejects(send(applicant, "submit", { ...body, consent: false }), { status: 400 });
  await assert.rejects(send(applicant, "submit", { ...body, phone: "0712345679" }), { status: 400 });
  await assert.rejects(send(applicant, "submit", { ...body, amount: 50_001 }), { status: 400 });
  applicableCountry = "USA";
  await assert.rejects(send(applicant, "submit", body), { status: 409 });
  applicableCountry = "KEN";
  providerEnvironment = undefined;
  await assert.rejects(send(applicant, "submit", body), { status: 409 });
  providerEnvironment = "live";
  const [first, duplicate] = await Promise.all([send(applicant, "submit", body), send(applicant, "submit", body)]);
  assert.equal(first.state, "received");
  assert.equal(duplicate.reference, first.reference);
  await assert.rejects(send(otherAccount, "submit", body), { status: 409 });
  assert.equal((await send(otherAccount, "status")).state, "ready");
  const row = await db.prepare("SELECT * FROM lending_applications WHERE reference = ?").bind(first.reference).first();
  assert.ok(row.phone_sealed && !Object.values(row).includes(phone));
  assert.ok(!Object.values(row).includes("TEST-ID-REDACTED"));
  assert.equal(isLendingReviewer(env, "AUTHORIZED@example.test"), true);
  assert.equal(isLendingReviewer(env, "unlisted@example.test"), false);
  const queue = await lendingReviewRequest(env, "staff-1", "list");
  assert.equal(queue.applications.length, 1);
  assert.equal(queue.applications[0].phoneHint, "+254 ••• ••5678");
  assert.ok(!Object.hasOwn(queue.applications[0], "phone"));
  assert.deepEqual(await lendingReviewRequest(env, "staff-1", "contact", { reference: first.reference }), { phone });
  const audit = await db.prepare("SELECT reviewer FROM lending_contact_access WHERE application_reference = ?").bind(first.reference).first();
  assert.equal(audit.reviewer, "staff-1");
  await lendingReviewRequest(env, "staff-1", "start-review", { reference: first.reference });
  assert.equal((await send(applicant, "status")).state, "in-review");
  assert.deepEqual((await lendingReviewRequest({ ...env, VERIFICATION_ENV: "sandbox" }, "staff-1", "list")).applications, []);
});
