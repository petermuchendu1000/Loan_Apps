import { JourneyError } from "./journey-error.mjs";
import { lendingStore } from "./lending-store.mjs";
import { createVerificationProviders, uuidPattern } from "./verification-providers.mjs";

const OTP_EXPIRY = 300_000;
const SMS_COOLDOWN = 60_000;
const SMS_WINDOW = 900_000;
const MAX_ATTEMPTS = 5;
const ID_RETRY = 30_000;
const STATUS_POLL_INTERVAL = 8_000;
const CONSENT_VERSION = "web-id-verification-1";
const retryableIdentity = new Set(["expired", "abandoned"]);
const resumableIdentity = new Set(["not-started", "in-progress", "resubmitted"]);
const utf8 = new TextEncoder();

export function phoneConfiguration(env) {
  const environment = env.VERIFICATION_ENV;
  if (!["sandbox", "live"].includes(environment) ||
      !env.AT_SMS_USERNAME || !env.AT_SMS_API_KEY || (env.OTP_SIGNING_KEY?.length ?? 0) < 32 ||
      (environment === "live" && (!env.AT_SMS_SENDER_ID || env.AT_SMS_USERNAME === "sandbox")) ||
      (environment === "sandbox" && env.AT_SMS_USERNAME !== "sandbox")) return null;

  return {
    environment,
    smsUser: env.AT_SMS_USERNAME,
    smsKey: env.AT_SMS_API_KEY,
    smsSender: env.AT_SMS_SENDER_ID,
    signingKey: env.OTP_SIGNING_KEY,
  };
}

export function verificationConfiguration(env) {
  const phone = phoneConfiguration(env);
  if (!phone || !env.DIDIT_API_KEY || !uuidPattern.test(env.DIDIT_WORKFLOW_ID)) return null;
  return { ...phone, diditKey: env.DIDIT_API_KEY, workflow: env.DIDIT_WORKFLOW_ID };
}

export function normalizeKenyanMobile(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const number = value.trim().replace(/[ ()-]/g, "");
  const match = /^(?:\+?254|0)([17]\d{8})$/.exec(number);
  return match ? "+254" + match[1] : null;
}

export async function readApplicantVerification(env, user, phone) {
  const settings = verificationConfiguration(env);
  if (!settings) return null;
  const owner = settings.environment + ":" + user;
  const row = await lendingStore(env).verification(owner);
  if (!row?.phone_verified_at || row.didit_status !== "approved" || !row.didit_id || !row.id_reference) return null;
  let number;
  if (phone !== undefined) {
    number = normalizeKenyanMobile(phone);
    const key = await importKey(settings.signingKey);
    if (!number || !row.phone_hash || !await validCode(key, row.phone_hash, "phone:" + settings.environment + ":" + number)) {
      throw new JourneyError("Enter the same Kenyan mobile number you verified.");
    }
  }
  return { owner, number, phoneHash: row.phone_hash, phoneHint: row.phone_hint, identity: { id: row.didit_id, reference: row.id_reference } };
}

function otpCode() {
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= 4_294_000_000);
  return String(values[0] % 1_000_000).padStart(6, "0");
}

async function importKey(secret) {
  return crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signature(key, value) {
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(value)));
  return btoa(String.fromCharCode(...bytes));
}

export async function verifiedPhoneHash(settings, phone) {
  return signature(await importKey(settings.signingKey), "phone:" + settings.environment + ":" + phone);
}

function validCode(key, hash, value) {
  return crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(hash), (character) => character.charCodeAt(0)), utf8.encode(value));
}

function view(row, settings, now) {
  if (!settings) return { state: "unavailable" };
  const state = {
    environment: settings.environment,
    phoneHint: row?.phone_hint ?? null,
    retryAt: row?.sms_retry_at ?? 0,
  };
  if (!row?.phone_verified_at) {
    const waitingForCode = row?.otp_hash && row.otp_expires_at > now && row.otp_attempts < MAX_ATTEMPTS;
    return { ...state, state: waitingForCode ? "code" : "phone" };
  }
  const status = row.didit_status ?? null;
  return {
    ...state,
    state: status === "approved" ? "verified" : "identity",
    identityStatus: status,
    identityUrl: resumableIdentity.has(status) ? row.didit_url : null,
    canStartIdentity: !row.didit_id || retryableIdentity.has(status),
  };
}

export async function sendVerificationCode(db, owner, body, row, settings, providers, now) {
  const phone = normalizeKenyanMobile(body.phone);
  if (!phone) throw new JourneyError("Enter a Kenyan mobile number, for example 0712 345 678.");
  if (row?.phone_verified_at) throw new JourneyError("Your phone is already verified.", 409);
  if (row?.sms_retry_at > now) throw new JourneyError("Wait one minute before requesting another code.", 429);
  const key = await importKey(settings.signingKey);
  const phoneHash = await signature(key, "phone:" + settings.environment + ":" + phone);
  const retryAt = now + SMS_COOLDOWN;
  if (!await db.reserveSms(phoneHash, now, now - SMS_WINDOW, retryAt)) {
    throw new JourneyError("Too many code requests for this number. Wait and try again.", 429);
  }

  const challenge = crypto.randomUUID();
  const hint = "+254 ••• ••" + phone.slice(-4);
  if (!await db.reserveCode(owner, phoneHash, hint, challenge, retryAt, now)) {
    throw new JourneyError("A verification code was just requested.", 429);
  }

  const code = otpCode();
  await providers.sms(phone, code);
  const hash = await signature(key, "otp:" + owner + ":" + challenge + ":" + code);
  await db.saveCode(owner, challenge, hash, now + OTP_EXPIRY);
}

export async function confirmVerificationCode(db, owner, body, row, settings, now) {
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) throw new JourneyError("Enter the six-digit code.");
  if (row?.phone_verified_at) return;
  if (!row?.otp_hash || row.otp_expires_at <= now || row.otp_attempts >= MAX_ATTEMPTS) {
    throw new JourneyError("Request a new verification code.", 409);
  }
  const key = await importKey(settings.signingKey);
  const valid = await validCode(key, row.otp_hash, "otp:" + owner + ":" + row.otp_id + ":" + body.code);
  if (!await db.confirmCode(owner, row.otp_id, now, MAX_ATTEMPTS, valid)) {
    throw new JourneyError("The code expired or changed. Refresh and try again.", 409);
  }
  if (!valid) throw new JourneyError("That code did not match.", 400);
}

async function startIdentity(db, owner, body, row, providers, url, now) {
  if (!row?.phone_verified_at) throw new JourneyError("Verify your phone before continuing.", 409);
  if (row.didit_id && !retryableIdentity.has(row.didit_status)) return;
  if (body.consent !== true) throw new JourneyError("Confirm the identity verification notice to continue.");
  const requestId = (!row.didit_id && row.id_request) || crypto.randomUUID();
  const reference = row.id_reference || crypto.randomUUID();
  if (!await db.reserveIdentity(owner, requestId, reference, now, CONSENT_VERSION, now + ID_RETRY)) {
    throw new JourneyError("A verification session is being prepared. Try again shortly.", 429);
  }
  const outcome = await providers.startIdentity(reference, new URL("/verify", url.origin).href, requestId);
  await db.saveIdentity(owner, requestId, outcome.id, outcome.url);
}

async function refreshIdentity(db, owner, row, providers, now) {
  if (!row?.didit_id || row.id_poll_at > now) return;
  const pollAt = now + STATUS_POLL_INTERVAL;
  if (!await db.reserveIdentityPoll(owner, row.didit_id, now, pollAt)) return;
  const result = await providers.checkIdentity({ id: row.didit_id, reference: row.id_reference });
  await db.saveIdentityDecision(owner, row.didit_id, pollAt, result.status, result.url);
}

export async function verificationRequest(env, user, url, action, body = {}, dependencies = {}) {
  const settings = verificationConfiguration(env);
  if (!settings) {
    if (action === "status") return view(null, null, 0);
    throw new JourneyError("Phone and identity verification are being set up.", 503);
  }
  const owner = settings.environment + ":" + user;
  const now = dependencies.now?.() ?? Date.now();
  const db = lendingStore(env);
  const row = await db.verification(owner);
  if (action === "status") return view(row, settings, now);
  const providers = createVerificationProviders(settings, dependencies.fetcher);
  switch (action) {
    case "send-code": await sendVerificationCode(db, owner, body, row, settings, providers, now); break;
    case "confirm-code": await confirmVerificationCode(db, owner, body, row, settings, now); break;
    case "start-identity": await startIdentity(db, owner, body, row, providers, url, now); break;
    case "refresh-identity": await refreshIdentity(db, owner, row, providers, now); break;
    default: throw new JourneyError("This verification action is unavailable.", 404);
  }
  return view(await db.verification(owner), settings, now);
}
