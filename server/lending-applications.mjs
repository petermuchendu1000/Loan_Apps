import { JourneyError } from "./journey-error.mjs";
import { lendingStore } from "./lending-store.mjs";
import { readApplicantVerification, verificationConfiguration } from "./verification.mjs";
import { createVerificationProviders, uuidPattern } from "./verification-providers.mjs";

const PURPOSES = ["Business", "Education", "Household", "Emergency", "Other"];
const CONSENT_VERSION = "credit-application-1";
const encoder = new TextEncoder();

function reviewerEmails(env) {
  return new Set(String(env.TALA_REVIEWER_EMAILS ?? "").split(",")
    .map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)));
}

export function isLendingReviewer(env, email) {
  return typeof email === "string" && reviewerEmails(env).has(email.trim().toLowerCase());
}

function environmentOf(env) {
  return ["sandbox", "live"].includes(env.VERIFICATION_ENV) ? env.VERIFICATION_ENV : null;
}

function unbase64(value) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function vaultKey(env) {
  const value = env.TALA_APPLICATION_KEY;
  if (typeof value !== "string" || !/^[\w-]{43}$/.test(value)) return null;
  return crypto.subtle.importKey("raw", unbase64(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealPhone(key, phone, reference) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(reference) }, key, encoder.encode(phone));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
}

async function openPhone(key, ciphertext, reference) {
  const bytes = unbase64(ciphertext);
  const phone = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(reference) }, key, bytes.slice(12));
  return new TextDecoder().decode(phone);
}

function applicationView(row, environment) {
  return {
    state: row.review_started_at === null ? "received" : "in-review",
    environment, reference: row.reference, amount: row.amount, purpose: row.purpose,
    receivedAt: row.received_at, reviewStartedAt: row.review_started_at,
  };
}

export async function lendingApplicationRequest(env, user, action, body = {}, dependencies = {}) {
  const environment = environmentOf(env);
  const owner = environment && environment + ":" + user;
  const db = lendingStore(env);
  const existing = owner && await db.application(owner);
  if (existing) return applicationView(existing, environment);
  const settings = verificationConfiguration(env);
  const key = settings && reviewerEmails(env).size ? await vaultKey(env) : null;
  if (!key) {
    if (action === "status") return { state: "unavailable" };
    throw new JourneyError("Online applications are currently unavailable.", 503);
  }
  if (action === "status") {
    const evidence = await readApplicantVerification(env, user);
    return { state: evidence ? "ready" : "verify", environment, phoneHint: evidence?.phoneHint };
  }
  if (action !== "submit") throw new JourneyError("This application action is unavailable.", 404);
  if (body.consent !== true || body.eligible !== true) {
    throw new JourneyError("Confirm the declarations before submitting.");
  }
  if (!Number.isInteger(body.amount) || body.amount < 1000 || body.amount > 50_000 || !PURPOSES.includes(body.purpose)) {
    throw new JourneyError("Choose a purpose and enter a whole amount from KSh 1,000 to KSh 50,000.");
  }
  if (typeof body.phone !== "string") throw new JourneyError("Enter your verified mobile number.");
  const evidence = await readApplicantVerification(env, user, body.phone);
  if (!evidence) throw new JourneyError("Verify your phone and identity before applying.", 409);
  const providers = createVerificationProviders(settings, dependencies.fetcher);
  if (!await providers.hasApprovedKenyanId(evidence.identity)) {
    throw new JourneyError("An approved Kenyan national ID check is required. Contact Tala support for help.", 409);
  }
  const reference = crypto.randomUUID();
  const receivedAt = dependencies.now?.() ?? Date.now();
  const phoneSealed = await sealPhone(key, evidence.number, reference);
  await db.createApplication({
    owner, reference, environment, phone_hash: evidence.phoneHash, phone_hint: evidence.phoneHint,
    phone_sealed: phoneSealed, identity_id: evidence.identity.id, amount: body.amount, purpose: body.purpose,
    consent_version: CONSENT_VERSION, received_at: receivedAt,
  });
  const received = await db.application(owner);
  if (!received) throw new JourneyError("An application already exists for this mobile number. Contact Tala support.", 409);
  return applicationView(received, environment);
}

function reviewerView(row) {
  return {
    ...applicationView(row, row.environment),
    phoneHint: row.phone_hint,
    identityId: row.identity_id,
  };
}

export async function lendingReviewRequest(env, reviewer, action, body = {}, cursor = null) {
  const environment = environmentOf(env);
  if (!environment) throw new JourneyError("The review queue is unavailable.", 503);
  const db = lendingStore(env);
  if (action === "list") {
    if (cursor && !uuidPattern.test(cursor)) throw new JourneyError("Invalid review page.");
    const previous = cursor && await db.reviewApplication(environment, cursor);
    if (cursor && !previous) throw new JourneyError("Invalid review page.");
    const results = await db.reviewQueue(environment, previous);
    return { environment, applications: results.slice(0, 20).map(reviewerView),
      next: results.length > 20 ? results[19].reference : null };
  }
  if (!uuidPattern.test(body.reference)) throw new JourneyError("Invalid application reference.");
  const row = await db.reviewApplication(environment, body.reference);
  if (!row) throw new JourneyError("Application not found.", 404);
  const now = Date.now();
  if (action === "start-review") {
    await db.startReview(environment, row.reference, reviewer, now);
    const current = await db.reviewApplication(environment, row.reference);
    return { application: reviewerView(current) };
  }
  if (action === "contact") {
    const key = await vaultKey(env);
    if (!key) throw new JourneyError("Contact details are temporarily unavailable.", 503);
    const contact = await db.applicationContact(environment, row.reference);
    if (!contact) throw new JourneyError("Application not found.", 404);
    const phone = await openPhone(key, contact.phone_sealed, row.reference);
    if (!await db.recordContactAccess(crypto.randomUUID(), row.reference, reviewer, now)) {
      throw new JourneyError("Contact details are temporarily unavailable.", 503);
    }
    return { phone };
  }
  throw new JourneyError("This review action is unavailable.", 404);
}
