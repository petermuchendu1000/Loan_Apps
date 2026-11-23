import { accountView, applyAction, newAccount } from "./sample-lending.mjs";
import { JourneyError } from "./journey-error.mjs";
import { verificationRequest } from "./verification.mjs";
import { VerificationProviderError } from "./verification-providers.mjs";
import { isLendingReviewer, lendingApplicationRequest, lendingReviewRequest } from "./lending-applications.mjs";
import { lendingStore } from "./lending-store.mjs";
import { borrowerAuthRequest, signedInBorrower } from "./borrower-auth.mjs";

const headers = {
  "content-security-policy": "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};
const requestIdPattern = /^[a-f0-9-]{36}$/i;

function json(body, status = 200, cookies = []) {
  const response = Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });
  for (const value of cookies) response.headers.append("set-cookie", value);
  return response;
}

function authenticatedOwner(request, env, url) {
  if (env.LOCAL_DEMO === "1" && ["127.0.0.1", "localhost"].includes(url.hostname)) return "local-demo";
  return request.headers.get("oai-authenticated-user-id");
}

async function requestBody(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new JourneyError("This request must contain JSON.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new JourneyError("A request body is required.");
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new JourneyError("The request exceeds the allowed size.", 413);
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  try {
    const value = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new JourneyError("Send a valid JSON object.");
  }
}

async function changeAccount(db, owner, id, action, body) {
  const input = JSON.stringify({ action, body });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await db.account(owner);
    const state = row ? JSON.parse(row.state) : newAccount();
    const existing = state.receipts.find((receipt) => receipt.id === id);
    if (existing) {
      if (existing.hash !== hash) throw new JourneyError("This request ID is already in use.", 409);
      return existing.result.error
        ? json({ error: existing.result.error }, existing.result.status)
        : json({ account: accountView(state), ...existing.result });
    }

    const result = applyAction(state, action, body);
    state.receipts = [...state.receipts.slice(-95), { id, hash, result }];
    const snapshot = JSON.stringify(state);
    const saved = row ? await db.updateAccount(owner, snapshot, row.revision) : await db.createAccount(owner, snapshot);
    if (saved) {
      return result.error ? json({ error: result.error }, result.status) : json({ account: accountView(state), ...result });
    }
  }
  throw new JourneyError("The account is busy. Try again.", 503);
}

async function handleApi(request, env, url) {
  const db = lendingStore(env);
  const auth = /^\/api\/auth(?:\/(start|verify|finish|signout))?$/.exec(url.pathname);
  if (auth) {
    const action = auth[1] ?? "status";
    if (request.method !== (action === "status" ? "GET" : "POST")) return json({ error: "This endpoint is unavailable." }, 404);
    if (action !== "status" && request.headers.get("origin") !== url.origin) {
      return json({ error: "Open the account page to continue." }, 403);
    }
    if (!db) return json({ error: "The account service is unavailable." }, 503);
    const body = action === "status" ? {} : await requestBody(request);
    const { state, cookies } = await borrowerAuthRequest(request, env, db, action, body.mode ?? url.searchParams.get("mode"), body);
    return json({ state }, 200, cookies);
  }
  const review = /^\/api\/lending-review(?:\/(start-review|contact))?$/.exec(url.pathname);
  const borrowerRoute = !review && env.TALA_BORROWER_AUTH === "web";
  const owner = borrowerRoute ? db && await signedInBorrower(request, env, db) : authenticatedOwner(request, env, url);
  if (!owner) return json(borrowerRoute
    ? { error: "Sign in to your web account to continue.", signIn: "/signin" }
    : { error: "Sign in to the private preview to continue." }, 401);
  if (!db) return json({ error: "The account service is unavailable." }, 503);
  if (url.pathname === "/api/applications" || url.pathname === "/api/applications/submit") {
    if (request.method === "GET" && url.pathname === "/api/applications") {
      return json({ application: await lendingApplicationRequest(env, owner, "status") });
    }
    if (request.method !== "POST" || url.pathname !== "/api/applications/submit") {
      return json({ error: "This endpoint is unavailable." }, 404);
    }
    if (request.headers.get("origin") !== url.origin) return json({ error: "Open the application page to submit." }, 403);
    return json({ application: await lendingApplicationRequest(env, owner, "submit", await requestBody(request)) });
  }
  if (review) {
    if (!isLendingReviewer(env, request.headers.get("oai-authenticated-user-email"))) {
      return json({ error: "This review queue is restricted to authorized Tala staff." }, 403);
    }
    if (request.method === "GET" && !review[1]) {
      return json(await lendingReviewRequest(env, owner, "list", {}, url.searchParams.get("after")));
    }
    if (request.method !== "POST" || !review[1]) return json({ error: "This endpoint is unavailable." }, 404);
    if (request.headers.get("origin") !== url.origin) return json({ error: "Open the review queue to make this request." }, 403);
    return json(await lendingReviewRequest(env, owner, review[1], await requestBody(request)));
  }
  const verification = /^\/api\/verification(?:\/([a-z-]+))?$/.exec(url.pathname);
  if (verification) {
    if (request.method === "GET" && !verification[1]) {
      return json({ verification: await verificationRequest(env, owner, url, "status") });
    }
    if (request.method !== "POST" || !verification[1] || verification[1] === "status") {
      return json({ error: "This endpoint is unavailable." }, 404);
    }
    if (request.headers.get("origin") !== url.origin) return json({ error: "Open the verification page to make this request." }, 403);
    return json({ verification: await verificationRequest(env, owner, url, verification[1], await requestBody(request)) });
  }
  if (request.method === "GET" && url.pathname === "/api/account") {
    const row = await db.account(owner);
    return json({ account: accountView(row ? JSON.parse(row.state) : newAccount()) });
  }
  if (request.method !== "POST") return json({ error: "This endpoint is unavailable." }, 404);
  const match = /^\/api\/account\/([a-z-]+)$/.exec(url.pathname);
  if (!match) return json({ error: "This endpoint is unavailable." }, 404);
  if (request.headers.get("origin") !== url.origin) return json({ error: "Open the borrower portal to make this request." }, 403);
  const id = request.headers.get("idempotency-key");
  if (!id || !requestIdPattern.test(id)) return json({ error: "A request ID is required." }, 400);
  return changeAccount(db, owner, id, match[1], await requestBody(request));
}

function serveAsset(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers });
  const aliases = {
    "/": "/index.html", "/borrow": "/borrow.html", "/borrow/": "/borrow.html",
    "/verify": "/verify.html", "/verify/": "/verify.html",
    "/apply": "/apply.html", "/apply/": "/apply.html",
    "/review": "/review.html", "/review/": "/review.html",
    "/signin": "/auth.html", "/signin/": "/auth.html",
    "/signup": "/auth.html", "/signup/": "/auth.html",
    "/forgot-pin": "/auth.html", "/forgot-pin/": "/auth.html",
  };
  const path = aliases[url.pathname] ?? url.pathname;
  const asset = Object.hasOwn(SITE_ASSETS, path) ? SITE_ASSETS[path] : undefined;
  if (!asset) return new Response("Page not found.", { status: 404, headers });
  const body = request.method === "HEAD" ? null : Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
  return new Response(body, {
    headers: {
      ...headers,
      "content-type": asset.type,
      "cache-control": path.startsWith("/assets/") ? "public, max-age=3600" : "no-cache",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (["/review", "/review/", "/review.html"].includes(url.pathname) &&
        (!authenticatedOwner(request, env, url) || !isLendingReviewer(env, request.headers.get("oai-authenticated-user-email")))) {
      return new Response("Access restricted to authorized Tala reviewers.", {
        status: 403, headers: { ...headers, "cache-control": "no-store" },
      });
    }
    if (!url.pathname.startsWith("/api/")) return serveAsset(request, url);
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      if (error instanceof JourneyError) return json({ error: error.message }, error.status);
      if (error instanceof VerificationProviderError) {
        console.error("Verification provider request failed", { provider: error.provider, status: error.status });
        return json({ error: "The verification service could not complete your request. Wait briefly and try again." }, 502);
      }
      console.error("Borrowing service request failed", { errorType: error?.name });
      return json({ error: "The account service is temporarily unavailable. Please try again." }, 503);
    }
  },
};
