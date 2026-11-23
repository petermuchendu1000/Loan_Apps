import { JourneyError } from "./journey-error.mjs";
import {
  confirmVerificationCode, normalizeKenyanMobile, phoneConfiguration, readApplicantVerification,
  sendVerificationCode, verificationConfiguration, verifiedPhoneHash,
} from "./verification.mjs";
import { createVerificationProviders } from "./verification-providers.mjs";
import { lendingStore } from "./lending-store.mjs";

const sessionName = "__Host-tala-session";
const flowLifetime = 10 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const limitWindow = 15 * 60_000;
const modes = new Set(["signup", "signin", "reset"]);
const tokenPattern = /^[a-f0-9]{64}$/;
const pinPattern = /^\d{4}$/;
const encoder = new TextEncoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

async function hash(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

async function keyed(settings, text) {
  const key = await crypto.subtle.importKey("raw", settings.authKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(text));
}

async function pinHash(settings, pin, salt) {
  const secret = await keyed(settings, "web-pin:" + pin);
  const key = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000,
  }, key, 256));
}

function pinMatches(derived, stored) {
  if (!tokenPattern.test(stored)) return false;
  let difference = 0;
  for (let i = 0; i < derived.length; i += 1) difference |= derived.charCodeAt(i) ^ stored.charCodeAt(i);
  return difference === 0;
}

function authConfiguration(env) {
  const phone = phoneConfiguration(env);
  if (env.TALA_BORROWER_AUTH !== "web" || !phone || !/^[A-Za-z0-9_-]{43}$/.test(env.TALA_BORROWER_AUTH_KEY ?? "")) return null;
  return { ...phone, authKey: decode(env.TALA_BORROWER_AUTH_KEY) };
}

function readCookie(request, name) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))?.slice(name.length + 1) ?? "";
}

function cookie(name, value, lifetime) {
  return name + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(lifetime / 1_000);
}

function flowCookie(mode) {
  return "__Host-tala-" + mode;
}

async function flowKey(settings) {
  const bytes = await keyed(settings, "borrower-auth:flow-cookie:v1");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function flowCipher(settings, mode, iv) {
  return { name: "AES-GCM", iv, additionalData: encoder.encode(settings.environment + ":" + mode) };
}

async function sealFlow(settings, mode, flow) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(flowCipher(settings, mode, iv),
    await flowKey(settings), encoder.encode(JSON.stringify(flow))));
  return btoa(String.fromCharCode(...iv, ...cipher)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function openFlow(request, settings, mode, now) {
  const token = readCookie(request, flowCookie(mode));
  if (!/^[A-Za-z0-9_-]{120,280}$/.test(token)) return null;
  try {
    const bytes = decode(token);
    const plain = await crypto.subtle.decrypt(flowCipher(settings, mode, bytes.slice(0, 12)),
      await flowKey(settings), bytes.slice(12));
    const flow = JSON.parse(new TextDecoder().decode(plain));
    return flow.expires > now && tokenPattern.test(flow.id) && Number.isSafeInteger(flow.version) ? flow : null;
  } catch {
    return null;
  }
}

async function flowOwner(settings, mode, flow) {
  const id = await hash(flow.id);
  const owner = mode === "signup" ? "web:" + id : "web-" + mode + ":" + id;
  return { owner, verificationOwner: settings.environment + ":" + owner };
}

export async function signedInBorrower(request, env, database, now = Date.now()) {
  const settings = authConfiguration(env);
  const token = readCookie(request, sessionName);
  if (!settings || !tokenPattern.test(token)) return null;
  return (await database.borrowerSession(settings.environment, await hash(token), now))?.owner ?? null;
}

async function limit(db, settings, scope, now, cap) {
  const key = hex(await keyed(settings, "web-auth-limit:" + settings.environment + ":" + scope));
  if (!await db.consumeAuthLimit(key, now, now - limitWindow, cap)) {
    throw new JourneyError("Too many attempts. Wait 15 minutes and try again.", 429);
  }
}

async function start(db, request, env, settings, mode, body, now, fetcher) {
  const phone = normalizeKenyanMobile(body.phone);
  if (!phone) throw new JourneyError("Enter your Kenyan mobile number.");
  const phoneHash = await verifiedPhoneHash(settings, phone);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip && /^[\da-f:.]{3,45}$/i.test(ip)) await limit(db, settings, mode + ":network:" + ip, now, 30);
  await limit(db, settings, mode + ":phone:" + phoneHash, now, mode === "signup" ? 6 : 5);

  let account = null;
  let send = true;
  if (mode === "signin") {
    if (typeof body.pin !== "string" || !pinPattern.test(body.pin)) throw new JourneyError("Enter your four-digit web PIN.");
    account = await db.borrower(settings.environment, phoneHash);
    const derived = await pinHash(settings, body.pin, account?.pin_salt ?? "0".repeat(32));
    if (!account || !pinMatches(derived, account.pin_hash)) throw new JourneyError("The number or web PIN did not match.", 401);
  } else if (mode === "reset") {
    const verification = verificationConfiguration(env);
    if (!verification) throw new JourneyError("PIN recovery is temporarily unavailable. Contact Tala support.", 503);
    const number = typeof body.idNumber === "string" && body.idNumber.length <= 32
      ? body.idNumber.trim().replace(/[ -]/g, "").toUpperCase() : "";
    if (!/^[A-Z0-9]{5,20}$/.test(number)) throw new JourneyError("Enter the national ID number you verified.");
    account = await db.borrower(settings.environment, phoneHash);
    const evidence = account && await readApplicantVerification(env, account.owner);
    const providers = createVerificationProviders(verification, fetcher);
    send = Boolean(evidence && await providers.matchesApprovedNationalId(evidence.identity, number));
  }

  const flow = { id: randomHex(32), expires: now + flowLifetime, version: send ? account?.pin_version ?? 0 : 0 };
  const { verificationOwner } = await flowOwner(settings, mode, flow);
  if (send) {
    const providers = createVerificationProviders(settings, fetcher);
    await sendVerificationCode(db, verificationOwner, { phone }, null, settings, providers, now);
  }
  return { state: "code", cookies: [cookie(flowCookie(mode), await sealFlow(settings, mode, flow), flowLifetime)] };
}

async function issueSession(db, owner, version, verificationOwner, mode, now) {
  const token = randomHex(32);
  if (!await db.createBorrowerSession(await hash(token), verificationOwner, owner, version, now + sessionLifetime)) {
    throw new JourneyError("This sign-in attempt has ended. Start again.", 409);
  }
  return { state: "signed-in", cookies: [cookie(sessionName, token, sessionLifetime), cookie(flowCookie(mode), "", 0)] };
}

export async function borrowerAuthRequest(request, env, db, action, mode, body = {}, dependencies = {}) {
  const settings = authConfiguration(env);
  if (!settings) {
    if (action === "status") return { state: "unavailable" };
    throw new JourneyError("Online account access is temporarily unavailable.", 503);
  }
  const now = dependencies.now?.() ?? Date.now();
  if (action === "signout") {
    const token = readCookie(request, sessionName);
    if (tokenPattern.test(token)) await db.revokeBorrowerSession(await hash(token), now);
    return { state: "signed-out", cookies: [cookie(sessionName, "", 0), ...[...modes].map((mode) => cookie(flowCookie(mode), "", 0))] };
  }
  if (!modes.has(mode)) throw new JourneyError("Choose an account action.");
  if (action === "status" && mode !== "reset" && await signedInBorrower(request, env, db, now)) {
    return { state: "signed-in" };
  }
  if (action === "start") return start(db, request, env, settings, mode, body, now, dependencies.fetcher);

  const flow = await openFlow(request, settings, mode, now);
  if (!flow) {
    if (action === "status") return { state: "start" };
    throw new JourneyError("Your verification expired. Start again.", 409);
  }
  const { owner, verificationOwner } = await flowOwner(settings, mode, flow);
  const row = await db.verification(verificationOwner);
  if (action === "status") return { state: row?.phone_verified_at && mode !== "signin" ? "pin" : "code" };
  if (action === "verify") {
    if (!row) throw new JourneyError("The code did not match or has expired.", 400);
    if (mode === "signin" && row.phone_verified_at) throw new JourneyError("This code was already used. Sign in again.", 409);
    await confirmVerificationCode(db, verificationOwner, body, row, settings, now);
    if (mode !== "signin") return { state: "pin" };
    const account = await db.borrower(settings.environment, row.phone_hash);
    if (!account || account.pin_version !== flow.version) throw new JourneyError("Your PIN changed. Sign in again.", 409);
    return issueSession(db, account.owner, flow.version, verificationOwner, mode, now);
  }
  if (action !== "finish" || mode === "signin") throw new JourneyError("This account action is unavailable.", 404);
  if (!row?.phone_verified_at) throw new JourneyError("Verify your mobile number first.", 409);
  if (typeof body.pin !== "string" || !pinPattern.test(body.pin) || body.pin !== body.pinConfirm) {
    throw new JourneyError("Enter the same four-digit PIN in both fields.");
  }
  const salt = randomHex(16);
  const derived = await pinHash(settings, body.pin, salt);
  if (mode === "signup") {
    if (!await db.createBorrower(owner, settings.environment, verificationOwner, salt, derived, now, now - flowLifetime)) {
      throw new JourneyError("This mobile number already has a web account. Sign in or reset your web PIN.", 409);
    }
    return issueSession(db, owner, 1, verificationOwner, mode, now);
  }
  const account = await db.borrower(settings.environment, row.phone_hash);
  if (!account || !await db.resetBorrowerPin(account.owner, verificationOwner, flow.version, salt, derived, now - flowLifetime)) {
    throw new JourneyError("This PIN reset has ended. Start again.", 409);
  }
  return { state: "pin-reset", cookies: [cookie(flowCookie(mode), "", 0), cookie(sessionName, "", 0)] };
}
