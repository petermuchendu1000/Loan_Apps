import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Response } from "miniflare";
import { repaymentFixture } from "./repayment-fixture.mjs";

const localPath = "/_local/auth";
const testId = "80704121";
const validPhone = /^\+25470000000[0-9]$/;
const uuid = /^[a-f0-9-]{36}$/;
const worker = `
import app from "./application.mjs";

async function linkTestLoan(request, env) {
  const token = request.headers.get("cookie")?.match(/(?:^|;\\s*)__Host-tala-session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(\`
    INSERT INTO repayment_accounts (environment, owner, customer_ref, phone_hash)
    SELECT 'sandbox', a.owner, 'local-' || substr(a.owner, 5), a.phone_hash
    FROM borrower_accounts a JOIN borrower_sessions s ON a.owner = s.owner
    JOIN web_verifications v ON v.owner = 'sandbox:' || a.owner
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL
      AND s.pin_version = a.pin_version AND a.environment = 'sandbox' AND v.didit_status = 'approved'
      AND v.phone_hash = a.phone_hash
    ON CONFLICT DO NOTHING
  \`).bind(hash, Date.now()).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.AUTH_PREVIEW_ORIGIN) return new Response("Use the loopback preview address.", { status: 403 });
    if (["/_local/auth", "/_local/auth/identity", "/_local/auth/payment"].includes(url.pathname)) {
      return env.AUTH_PREVIEW.fetch(request);
    }
    const response = await app.fetch(request, env);
    if (!response.ok || !/^\\/api\\/verification(?:\\/|$)/.test(url.pathname)) return response;
    const result = await response.json();
    const link = result.verification?.identityUrl;
    if (link?.startsWith("https://verify.didit.me/session/")) {
      const id = new URL(link).pathname.split("/").at(-1);
      result.verification.identityUrl = "/_local/auth/identity?session=" + encodeURIComponent(id);
    }
    if (env.LOCAL_REPAYMENTS && result.verification?.state === "verified") await linkTestLoan(request, env);
    return Response.json(result, { status: response.status, headers: response.headers });
  }
};
`;

function page(title, content) {
  return new Response(`<!doctype html><html lang="en-KE"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} | Tala local testing</title>
    <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/borrow.css">
    <main class="wrap portal verification"><section class="portal-heading"><h1>${title}</h1></section>
    <section class="portal-card">${content}</section></main></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

export function authPreview(testingRepayment = false) {
  const port = testingRepayment ? 8177 : 8176;
  const authPreviewOrigin = "http://127.0.0.1:" + port;
  const repayment = testingRepayment ? repaymentFixture() : null;
  const workflow = randomUUID();
  const messages = new Map();
  const identities = new Map();
  const appPath = resolve("dist/server/index.js");

  async function outboundService(request) {
    const paymentResponse = await repayment?.fetch(request);
    if (paymentResponse) return paymentResponse;
    const url = new URL(request.url);
    if (url.href === "https://api.sandbox.africastalking.com/version1/messaging" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const number = form.get("to");
      const code = form.get("message")?.match(/\b[0-9]{6}\b/)?.[0];
      if (!validPhone.test(number) || !code) return new Response(null, { status: 400 });
      messages.set(number, { code, expires: Date.now() + 300_000 });
      return Response.json({ SMSMessageData: { Recipients: [{ number, statusCode: 101 }] } });
    }
    if (url.origin !== "https://verification.didit.me") return new Response(null, { status: 502 });
    if (url.pathname === "/v3/session/" && request.method === "POST") {
      const { workflow_id, vendor_data } = await request.json();
      if (workflow_id !== workflow) return new Response(null, { status: 400 });
      const id = randomUUID();
      const url = "https://verify.didit.me/session/" + id;
      identities.set(id, { id, url, vendor: vendor_data, approved: false });
      return Response.json({ session_id: id, workflow_id, vendor_data, environment: "sandbox", url }, { status: 201 });
    }
    const id = url.pathname.match(/^\/v3\/session\/([a-f0-9-]+)\/decision\/$/)?.[1];
    const identity = identities.get(id);
    if (request.method !== "GET" || !identity) return new Response(null, { status: 404 });
    return Response.json({
      session_id: id, session_url: identity.url, session_kind: "user",
      workflow_id: workflow, vendor_data: identity.vendor, environment: "sandbox",
      status: identity.approved ? "Approved" : "Not Started",
      id_verifications: identity.approved ? [{
        status: "Approved", issuing_state: "KEN", document_type: "Identity Card", personal_number: testId,
      }] : [],
    });
  }

  async function previewPage(request, runtime) {
    const url = new URL(request.url);
    if (url.origin !== authPreviewOrigin) return new Response(null, { status: 403 });
    if (url.pathname === localPath && request.method === "GET") {
      const rows = [...messages].filter(([, { expires }]) => expires > Date.now())
        .map(([number, { code }]) => `<div><dt>${number}</dt><dd><strong>${code}</strong></dd></div>`).join("");
      const pending = repayment && [...repayment.payments.values()].filter((payment) => payment.code === null);
      const prompts = pending ? `<h2>M-PESA prompts</h2><p>Complete your simulated identity check to link a test loan. Open Repayments, send a prompt, then refresh this page to approve or cancel it.</p>
        ${pending.length ? pending.map((payment) => `<form method="post" action="${localPath}/payment?checkout=${payment.checkout}">
          <p>KSh ${payment.amount} to the number ending ${payment.phone.slice(-4)}</p>
          <div class="form-actions"><button class="button button-primary" type="submit" name="decision" value="approve">Approve test payment</button>
          <button class="button button-secondary" type="submit" name="decision" value="cancel">Cancel test payment</button></div>
          </form>`).join("") : "<p>There are no pending prompts.</p>"}` : "";
      return page("Account testing", `
        <p>Use <strong>0700 000 000</strong> to create a local test account. Codes appear in this inbox, and identity checks use a synthetic record.</p>
        <div class="form-actions"><a class="button button-primary" href="/signup">Create account</a>
        <a class="button button-secondary" href="/signin">Sign in</a>
        <a class="text-link" href="/forgot-pin">Reset PIN</a>${repayment ? '<a class="text-link" href="/repay">Repayments</a>' : ""}</div>
        <h2>SMS inbox</h2>
        ${rows ? `<dl class="summary-rows">${rows}</dl>` : "<p>There are no active codes yet.</p>"}
        <a class="text-link" href="${localPath}">Refresh SMS inbox</a>
        <p class="small-copy">For PIN recovery, complete the simulated identity check first, then use test ID <strong>${testId}</strong>. Wait one minute between code requests.</p>${prompts}`);
    }
    if (url.pathname === localPath + "/payment" && repayment) {
      if (request.method !== "POST" || request.headers.get("origin") !== authPreviewOrigin) return new Response(null, { status: 403 });
      const checkout = url.searchParams.get("checkout");
      const payment = repayment.payments.get(checkout);
      const decision = (await request.formData()).get("decision");
      if (!payment || payment.code !== null || !["approve", "cancel"].includes(decision)) return new Response(null, { status: 409 });
      const callback = repayment.decide(checkout, decision === "approve" ? "0" : "1032");
      const path = new URL(callback.url);
      const confirmed = await runtime.dispatchFetch(authPreviewOrigin + path.pathname + path.search, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(callback.body),
      });
      if (!confirmed.ok) return new Response("Unable to deliver the simulated callback.", { status: 502 });
      return new Response(null, { status: 303, headers: { location: "/repay", "cache-control": "no-store" } });
    }
    const identity = identities.get(url.searchParams.get("session"));
    if (url.pathname !== localPath + "/identity" || !identity || !uuid.test(identity.id)) {
      return new Response("Start a local identity check from your account.", { status: 404 });
    }
    if (request.method === "POST" && request.headers.get("origin") === authPreviewOrigin) {
      identity.approved = true;
      return new Response(null, { status: 303, headers: {
        location: "/verify?verificationSessionId=" + identity.id,
        "cache-control": "no-store",
      } });
    }
    if (request.method !== "GET") return new Response(null, { status: 403 });
    return page("Simulated identity check", `
      <p>This completes the local identity check with test ID <strong>${testId}</strong>.</p>
      <form method="post" action="${localPath}/identity?session=${identity.id}">
        <button class="button button-primary" type="submit">Complete test check</button>
      </form>`);
  }

  return {
    port,
    modulesRoot: resolve("dist/server"),
    modules: [
      { type: "ESModule", path: resolve("dist/server/auth-preview.mjs"), contents: worker },
      { type: "ESModule", path: resolve("dist/server/application.mjs"), contents: readFileSync(appPath, "utf8") },
    ],
    d1Databases: { DB: "tala-borrower-auth-local" },
    serviceBindings: { AUTH_PREVIEW: previewPage },
    outboundService,
    bindings: {
      AUTH_PREVIEW_ORIGIN: authPreviewOrigin,
      TALA_BORROWER_AUTH: "web",
      TALA_BORROWER_AUTH_KEY: randomBytes(32).toString("base64url"),
      VERIFICATION_ENV: "sandbox",
      AT_SMS_USERNAME: "sandbox",
      AT_SMS_API_KEY: "local-sms",
      OTP_SIGNING_KEY: randomBytes(32).toString("hex"),
      DIDIT_API_KEY: "local-identity",
      DIDIT_WORKFLOW_ID: workflow,
      TALA_APPLICATION_KEY: randomBytes(32).toString("base64url"),
      TALA_REVIEWER_EMAILS: "reviewer@example.test",
      ...(repayment ? { ...repayment.bindings, LOCAL_REPAYMENTS: true } : {}),
    },
  };
}
