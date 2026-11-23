import { CaaSError, createCaaSClient } from "./caas.mjs";
import { callbackEvidence, createDarajaClient, darajaConfiguration, DarajaError } from "./daraja.mjs";
import { JourneyError } from "./journey-error.mjs";
import { openPhone, sealPhone, vaultKey } from "./phone-vault.mjs";
import { readApplicantVerification } from "./verification.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const terminal = new Set(["credited", "failed"]);
const payable = new Set(["drawn", "delinquent"]);
const encoder = new TextEncoder();
const refreshInterval = 10_000;

function configuration(env, fetcher) {
  const environment = env.TALA_REPAYMENT_ENV;
  if (!["sandbox", "live"].includes(environment) || environment !== env.VERIFICATION_ENV ||
      !env.TALA_CAAS_BASE_URL || !env.TALA_CAAS_CLIENT_ID || !env.TALA_CAAS_CLIENT_SECRET) return null;
  const caas = createCaaSClient({
    baseUrl: env.TALA_CAAS_BASE_URL, clientId: env.TALA_CAAS_CLIENT_ID, clientSecret: env.TALA_CAAS_CLIENT_SECRET, fetcher,
  });
  const mpesa = darajaConfiguration(env, environment);
  return { environment, caas, mpesa, daraja: mpesa ? createDarajaClient(mpesa, fetcher) : null };
}

function moneyToMinor(value) {
  const scaled = value?.amount * 100;
  const minor = Math.round(scaled);
  return value?.isoCode === "KES" && typeof value.amount === "number" && Number.isSafeInteger(minor) &&
    minor >= 0 && Math.abs(minor - scaled) < 0.001 ? minor : null;
}

async function loanFor(settings, customer) {
  try {
    const { data } = await settings.caas.call("loan", { customer });
    if (!data || !payable.has(data.status)) return null;
    const balanceMinor = moneyToMinor(data.outstandingBalances?.totalBalance);
    if (balanceMinor === null || typeof data.loanId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(data.loanId)) {
      throw new CaaSError(502);
    }
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(data.dueDate ?? "") && Number.isFinite(Date.parse(data.dueDate))
      ? data.dueDate : null;
    return {
      id: data.loanId, balanceMinor,
      dueDate,
    };
  } catch (error) {
    if (error instanceof CaaSError && error.status === 404) return null;
    throw error;
  }
}

async function ledgerHistory(settings, customer) {
  const { data } = await settings.caas.call("transactions", { customer, query: { page: 0, size: 20 } });
  if (!Array.isArray(data?.transactions)) throw new CaaSError(502);
  return data.transactions.filter((item) => item?.transactionType === "REPAYMENT").map((item) => ({
    id: typeof item.transactionId === "string" ? item.transactionId.slice(0, 96) : null,
    amountMinor: moneyToMinor(item.amount),
    date: typeof item.transactionDate === "string" && Number.isFinite(Date.parse(item.transactionDate))
      ? new Date(item.transactionDate).toISOString() : null,
  })).filter((item) => item.id && item.amountMinor !== null && item.date);
}

function view(row, now) {
  const state = row.state === "starting" && now - row.created_at >= 90_000 ? "review" : row.state;
  return {
    id: row.id, amount: row.amount, state, receipt: state === "credited" ? row.receipt : null,
    result: state === "failed" && row.result_code === "1032" ? "cancelled" : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function signCallback(settings, id, proof) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(settings.mpesa.callbackKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const message = encoder.encode("mpesa-callback-v1:" + settings.environment + ":" + id);
  if (proof !== undefined) {
    if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
    const bytes = Uint8Array.from(proof.match(/../g), (part) => Number.parseInt(part, 16));
    return crypto.subtle.verify("HMAC", key, bytes, message);
  }
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function transition(db, row, values, now) {
  const changes = { ...row, ...values, updated_at: now };
  return await db.updateRepayment(changes) ? { ...changes, revision: row.revision + 1 } : null;
}

async function start(db, env, settings, owner, id, body, now) {
  if (!uuid.test(id ?? "") || !Number.isSafeInteger(body.amount) || body.amount <= 0 || body.amount > 2_147_483_647 ||
      body.confirmed !== true || typeof body.phone !== "string" || typeof body.loanId !== "string") {
    throw new JourneyError("Confirm a whole-shilling amount and enter your registered M-PESA number.");
  }
  const existing = await db.repayment(settings.environment, id);
  if (existing) {
    if (existing.owner !== owner || existing.amount !== body.amount || existing.loan_id !== body.loanId) {
      throw new JourneyError("Start again with a new payment reference.", 409);
    }
    return existing;
  }
  const key = await vaultKey(env);
  if (!key || !settings.daraja) throw new JourneyError("M-PESA Xpress is unavailable. You can use Tala’s Paybill.", 503);
  const [link, evidence, active] = await Promise.all([
    db.repaymentAccount(settings.environment, owner), readApplicantVerification(env, owner, body.phone),
    db.activeRepayment(settings.environment, owner),
  ]);
  if (!link || !evidence || link.phone_hash !== evidence.phoneHash) {
    throw new JourneyError("Connect your verified web account to your Tala loan before requesting a payment.", 409);
  }
  if (active) throw new JourneyError("Check the status of your current payment before starting another.", 409);
  const loan = await loanFor(settings, link.customer_ref);
  if (!loan || body.loanId !== loan.id || body.amount * 100 > loan.balanceMinor) {
    throw new JourneyError("Your repayment balance changed. Refresh it and choose an amount again.", 409);
  }
  const callback = new URL(settings.mpesa.callback);
  callback.searchParams.set("payment", id);
  callback.searchParams.set("proof", await signCallback(settings, id));
  const phoneSealed = await sealPhone(key, evidence.number, "repayment:" + id);
  const added = await db.createRepayment({
    id, environment: settings.environment, owner, customer_ref: link.customer_ref, loan_id: loan.id,
    amount: body.amount, phone_sealed: phoneSealed, phone_hash: evidence.phoneHash, created_at: now,
  });
  let row = await db.repayment(settings.environment, id);
  if (!added) {
    if (row?.owner === owner && row.amount === body.amount && row.loan_id === loan.id) return row;
    throw new JourneyError("Check your current repayment before starting another.", 409);
  }
  let issued;
  try {
    issued = await settings.daraja.start(row.amount, evidence.number, callback.href, now);
  } catch (error) {
    row = await db.repayment(settings.environment, id);
    if (row.state !== "starting" || row.checkout_id) return row;
    const state = error instanceof DarajaError && error.rejected ? "failed" : "review";
    return await transition(db, row, { state }, Date.now()) ?? await db.repayment(settings.environment, id);
  }
  row = await db.repayment(settings.environment, id);
  if (row.checkout_id) return row;
  return await transition(db, row, { state: "pending", checkout_id: issued.checkout, merchant_id: issued.merchant }, Date.now())
    ?? await db.repayment(settings.environment, id);
}

async function talaResult(settings, row) {
  try {
    const { data } = await settings.caas.call("repaymentStatus", { customer: row.customer_ref, transaction: row.receipt });
    return data?.externalTransactionId === row.receipt && data?.loanId === row.loan_id &&
      moneyToMinor(data?.transactionAmount) === row.amount * 100 ? "credited" : "unknown";
  } catch (error) {
    return error instanceof CaaSError && error.status === 404 ? "missing" : "unknown";
  }
}

async function setCredited(db, row, now) {
  return await transition(db, row, { state: "credited", next_check_at: 0 }, now) ?? await db.repayment(row.environment, row.id);
}

async function reconcile(db, env, settings, row, now) {
  if (terminal.has(row.state) || !row.checkout_id || row.next_check_at > now) return row;
  const claimed = await transition(db, row, { next_check_at: now + refreshInterval }, now);
  if (!claimed) return db.repayment(settings.environment, row.id);
  if (claimed.state === "posting") {
    return await talaResult(settings, claimed) === "credited" ? setCredited(db, claimed, now) : claimed;
  }
  if (!settings.daraja) return claimed;
  let outcome;
  try {
    outcome = await settings.daraja.check(claimed.checkout_id, claimed.merchant_id, now);
  } catch {
    return claimed;
  }
  if (outcome.state === "pending") return claimed;
  const current = await db.repayment(settings.environment, row.id);
  if (current.revision !== claimed.revision) return current;
  if (outcome.state === "failed") {
    if (claimed.receipt || claimed.state === "awaiting-receipt") return claimed;
    return await transition(db, claimed, { state: "failed", result_code: outcome.code }, now)
      ?? await db.repayment(settings.environment, row.id);
  }
  if (!claimed.receipt) {
    return await transition(db, claimed, { state: "awaiting-receipt" }, now)
      ?? await db.repayment(settings.environment, row.id);
  }
  const existing = await talaResult(settings, claimed);
  if (existing === "credited") return setCredited(db, claimed, now);
  if (existing !== "missing") return claimed;
  const key = await vaultKey(env);
  if (!key) return claimed;
  const phone = await openPhone(key, claimed.phone_sealed, "repayment:" + claimed.id);
  // Record the posting attempt before calling Tala. A timeout is checked via the ledger using the same receipt.
  const posting = await transition(db, claimed, { state: "posting" }, now);
  if (!posting) return db.repayment(settings.environment, row.id);
  try {
    await settings.caas.call("repaymentNotification", { customer: posting.customer_ref, body: {
      msisdn: phone, transactionAmount: { amount: posting.amount, isoCode: "KES" },
      externalTransactionId: posting.receipt, transactionTime: posting.paid_at, transactionReceipt: posting.receipt,
      billRefNumber: "0" + phone.slice(4), loanId: posting.loan_id, repaymentType: "CUSTOMER_INITIATED",
    } });
  } catch {
    // The provider may have accepted the request even when the response was lost.
  }
  return await talaResult(settings, posting) === "credited" ? setCredited(db, posting, now) : posting;
}

export async function repaymentRequest(db, env, owner, action, id, body = {}, dependencies = {}) {
  const settings = configuration(env, dependencies.fetcher);
  const now = dependencies.now?.() ?? Date.now();
  if (!settings && action === "status") return { state: "unavailable", express: false };
  if (!settings) throw new JourneyError("Online repayments are unavailable.", 503);
  if (action === "start") return { payment: view(await start(db, env, settings, owner, id, body, now), now) };
  if (action === "check") {
    if (!uuid.test(id ?? "")) throw new JourneyError("Payment reference not found.", 404);
    const row = await db.repayment(settings.environment, id);
    if (row?.owner !== owner) throw new JourneyError("Payment reference not found.", 404);
    return { payment: view(await reconcile(db, env, settings, row, now), now) };
  }
  const link = await db.repaymentAccount(settings.environment, owner);
  const evidence = link && await readApplicantVerification(env, owner);
  if (!link || !evidence || link.phone_hash !== evidence.phoneHash) return { state: "unlinked", express: false };
  const payments = await db.listRepayments(settings.environment, owner);
  const active = payments.find((payment) => !terminal.has(payment.state));
  const [loan, ledger] = await Promise.allSettled([loanFor(settings, link.customer_ref), ledgerHistory(settings, link.customer_ref)]);
  return {
    state: loan.status === "rejected" ? "unavailable" : loan.value?.balanceMinor > 0 ? "ready" : "no-balance",
    environment: settings.environment, express: Boolean(settings.daraja && await vaultKey(env)),
    loan: loan.status === "fulfilled" ? loan.value : null, phoneHint: evidence.phoneHint,
    active: active ? view(active, now) : null, payments: payments.map((payment) => view(payment, now)),
    ledger: ledger.status === "fulfilled" ? ledger.value : null,
  };
}

export async function repaymentCallback(db, env, url, readBody, dependencies = {}) {
  const settings = configuration(env, dependencies.fetcher);
  const id = url.searchParams.get("payment");
  const now = dependencies.now?.() ?? Date.now();
  if (!settings?.mpesa || !uuid.test(id ?? "") || !await signCallback(settings, id, url.searchParams.get("proof"))) {
    throw new JourneyError("Callback not found.", 404);
  }
  const evidence = callbackEvidence(await readBody());
  if (!evidence) throw new JourneyError("Invalid M-PESA callback.", 400);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await db.repayment(settings.environment, id);
    if (!row) throw new JourneyError("Callback not found.", 404);
    if (row.checkout_id && (row.checkout_id !== evidence.checkout || row.merchant_id !== evidence.merchant)) {
      throw new JourneyError("The M-PESA reference did not match.", 409);
    }
    if (terminal.has(row.state) || row.state === "posting") return;
    if (evidence.receipt) {
      const key = await vaultKey(env);
      if (!key) throw new JourneyError("Repayment verification is unavailable.", 503);
      const phone = await openPhone(key, row.phone_sealed, "repayment:" + row.id);
      const at = Date.parse(evidence.paidAt);
      if (evidence.amount !== row.amount || evidence.phone !== phone || at < row.created_at - 60_000 || at > now + 300_000 ||
          (row.receipt && row.receipt !== evidence.receipt)) {
        throw new JourneyError("The M-PESA receipt did not match.", 409);
      }
    }
    if (row.checkout_id && (!evidence.receipt || row.receipt === evidence.receipt)) return;
    const updated = await transition(db, row, {
      state: ["starting", "review"].includes(row.state) ? "pending" : row.state,
      checkout_id: evidence.checkout, merchant_id: evidence.merchant,
      receipt: evidence.receipt ?? row.receipt, paid_at: evidence.paidAt ?? row.paid_at, next_check_at: 0,
    }, now);
    if (updated) {
      return () => reconcile(db, env, settings, updated, now);
    }
  }
  throw new JourneyError("Try sending this callback again.", 503);
}
