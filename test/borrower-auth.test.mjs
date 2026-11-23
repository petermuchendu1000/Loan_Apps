import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Miniflare, Response } from "miniflare";
import { migrateLocal } from "../scripts/migrate-local.mjs";

test("borrowers can create an account, sign in with an SMS check, reset a PIN, and revoke sessions", async (t) => {
  const origin = "https://tala.test";
  const phone = "+254712345678";
  const idNumber = "80704121";
  const codes = [];
  const sessions = new Map();
  const workflow = crypto.randomUUID();
  const runtime = new Miniflare({
    modules: true,
    scriptPath: "./dist/server/index.js",
    compatibilityDate: "2025-01-01",
    d1Databases: { DB: "auth-test" },
    bindings: {
      VERIFICATION_ENV: "sandbox", AT_SMS_USERNAME: "sandbox", AT_SMS_API_KEY: "sms-fixture",
      OTP_SIGNING_KEY: "fixture-otp-signing-key-containing-more-than-32-characters",
      TALA_BORROWER_AUTH: "web", TALA_BORROWER_AUTH_KEY: randomBytes(32).toString("base64url"),
      DIDIT_WORKFLOW_ID: workflow, DIDIT_API_KEY: "didit-fixture",
      TALA_REVIEWER_EMAILS: "reviewer@example.test", TALA_APPLICATION_KEY: randomBytes(32).toString("base64url"),
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.origin === "https://api.sandbox.africastalking.com") {
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get("to"), phone);
        codes.push(form.get("message").match(/\b\d{6}\b/)[0]);
        return Response.json({ SMSMessageData: { Recipients: [{ number: phone, statusCode: 101 }] } });
      }
      if (url.origin === "https://verification.didit.me" && request.method === "POST") {
        const { workflow_id, vendor_data } = await request.json();
        assert.equal(workflow_id, workflow);
        const id = crypto.randomUUID();
        sessions.set(id, vendor_data);
        return Response.json({
          session_id: id, workflow_id, vendor_data, environment: "sandbox", url: "https://verify.didit.me/test",
        }, { status: 201 });
      }
      const id = url.pathname.match(/^\/v3\/session\/([^/]+)\/decision\/$/)?.[1];
      assert.equal(url.origin, "https://verification.didit.me");
      assert(sessions.has(id));
      return Response.json({
        session_id: id, workflow_id: workflow, vendor_data: sessions.get(id), environment: "sandbox",
        session_kind: "user", status: "Approved",
        id_verifications: [{ status: "Approved", issuing_state: "KEN", document_type: "Identity Card", personal_number: idNumber }],
      });
    },
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  await migrateLocal(db);

  function browser() {
    const cookies = new Map();
    async function send(path, body, headers = {}) {
      const response = await runtime.dispatchFetch(origin + path, {
        method: body ? "POST" : "GET",
        headers: { Cookie: [...cookies.values()].join("; "), ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0];
        const name = pair.split("=")[0];
        if (pair.endsWith("=")) cookies.delete(name);
        else {
          assert.match(value, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=/);
          cookies.set(name, pair);
        }
      }
      return { status: response.status, ...(await response.json()) };
    }
    return { send, cookies };
  }

  async function allowNextSms() {
    await db.prepare("UPDATE verification_sms_limits SET window_started = 0, retry_at = 0").run();
  }
  const first = browser();
  assert.deepEqual(await first.send("/api/auth?mode=signup"), { status: 200, state: "start" });
  assert.equal((await first.send("/api/verification", undefined, { "oai-authenticated-user-id": "sites-visitor" })).status, 401);
  assert.equal((await first.send("/api/auth/start", { mode: "signup", phone }, { Origin: "https://external.test" })).status, 403);
  assert.equal(codes.length, 0);
  assert.deepEqual(await first.send("/api/auth/start", { mode: "signup", phone }), { status: 200, state: "code" });
  assert.equal((await first.send("/api/auth/finish", { mode: "signup", pin: "4826", pinConfirm: "4826" })).status, 409);
  const wrongCode = codes.at(-1) === "000000" ? "000001" : "000000";
  assert.equal((await first.send("/api/auth/verify", { mode: "signup", code: wrongCode })).status, 400);
  assert.deepEqual(await first.send("/api/auth/verify", { mode: "signup", code: codes.at(-1) }), { status: 200, state: "pin" });
  assert.equal((await first.send("/api/auth/finish", { mode: "signup", pin: "4826", pinConfirm: "1234" })).status, 400);
  assert.deepEqual(await first.send("/api/auth/finish", { mode: "signup", pin: "4826", pinConfirm: "4826" }),
    { status: 200, state: "signed-in" });
  const firstToken = first.cookies.get("__Host-tala-session");
  const account = await db.prepare("SELECT pin_hash, pin_salt, phone_hash FROM borrower_accounts").first();
  assert.match(account.pin_hash, /^[a-f0-9]{64}$/);
  assert.match(account.pin_salt, /^[a-f0-9]{32}$/);
  assert.notEqual(account.phone_hash, phone);
  assert.equal((await first.send("/api/verification")).verification.state, "identity");
  assert.equal(codes.length, 1);
  assert.equal((await first.send("/api/verification/start-identity", { consent: true })).verification.identityStatus, "not-started");
  assert.equal((await first.send("/api/verification/refresh-identity", {})).verification.state, "verified");
  assert.equal((await first.send("/api/applications")).application.state, "ready");
  assert.deepEqual(await first.send("/api/auth/signout", {}), { status: 200, state: "signed-out" });
  assert.equal((await first.send("/api/verification", undefined, { Cookie: firstToken })).status, 401);

  await allowNextSms();
  assert.equal((await first.send("/api/auth/start", { mode: "signin", phone, pin: "1111" })).status, 401);
  assert.deepEqual(await first.send("/api/auth/start", { mode: "signin", phone, pin: "4826" }), { status: 200, state: "code" });
  const signInChallenge = first.cookies.get("__Host-tala-signin");
  assert.equal((await first.send("/api/applications")).status, 401);
  assert.deepEqual(await first.send("/api/auth/verify", { mode: "signin", code: codes.at(-1) }), { status: 200, state: "signed-in" });
  assert.equal((await first.send("/api/auth/verify", { mode: "signin", code: codes.at(-1) }, { Cookie: signInChallenge })).status, 409);

  const second = browser();
  await allowNextSms();
  const beforeReset = codes.length;
  assert.deepEqual(await second.send("/api/auth/start", { mode: "reset", phone, idNumber: "12345678" }), { status: 200, state: "code" });
  assert.equal(codes.length, beforeReset);
  assert.equal((await second.send("/api/auth/verify", { mode: "reset", code: codes.at(-1) })).status, 400);
  assert.deepEqual(await second.send("/api/auth/start", { mode: "reset", phone, idNumber }), { status: 200, state: "code" });
  assert.equal(codes.length, beforeReset + 1);
  assert.deepEqual(await second.send("/api/auth/verify", { mode: "reset", code: codes.at(-1) }), { status: 200, state: "pin" });
  const resetChallenge = second.cookies.get("__Host-tala-reset");
  assert.deepEqual(await second.send("/api/auth/finish", { mode: "reset", pin: "5297", pinConfirm: "5297" }),
    { status: 200, state: "pin-reset" });
  assert.equal((await second.send("/api/auth/finish", { mode: "reset", pin: "1234", pinConfirm: "1234" }, { Cookie: resetChallenge })).status, 409);
  assert.equal((await first.send("/api/applications")).status, 401);
  assert.equal((await second.send("/api/auth/start", { mode: "signin", phone, pin: "4826" })).status, 401);
  await allowNextSms();
  assert.equal((await second.send("/api/auth/start", { mode: "signin", phone, pin: "5297" })).state, "code");
  assert.equal((await second.send("/api/auth/verify", { mode: "signin", code: codes.at(-1) })).state, "signed-in");
  assert.equal((await second.send("/api/applications")).application.state, "ready");
  assert.equal((await second.send("/api/lending-review")).status, 401);
});
