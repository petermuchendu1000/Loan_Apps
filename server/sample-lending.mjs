const DAY = 86_400_000;
const NAIROBI_OFFSET = 3 * 3_600_000;
const MINIMUM = 100_000;
const SAMPLE_CODE = "246810";
const DAILY_RATE_BPS = 35;
const TAX_PERCENT = 20;
const SAMPLE_TERMS = "sample-credit-agreement-1";
const PURPOSES = ["Business", "Household", "Education", "Emergency"];
const TOPICS = ["Application", "M-PESA transfer", "Repayment", "Account access"];
const SCENARIOS = {
  standard: { identity: true, limit: 1_000_000 },
  review: { identity: true, limit: 0 },
  identity: { identity: false, limit: 0 },
};

function requireState(condition, message, status = 409) {
  if (!condition) throw new JourneyError(message, status);
}

function amountInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function dayAt(time) {
  return Math.floor((time + NAIROBI_OFFSET) / DAY);
}

function dueDateAt(time, days) {
  return new Date((dayAt(time) + days) * DAY).toISOString().slice(0, 10);
}

export function newAccount() {
  return {
    stage: "start",
    scenario: null,
    challenge: null,
    decision: null,
    quote: null,
    loan: null,
    transfers: [],
    tickets: [],
    referral: null,
    receipts: [],
  };
}

function currentBalance(loan, now) {
  if (!loan?.fundedAt || loan.status === "repaid") return { principal: 0, interest: 0, tax: 0, total: 0 };
  const lastBillableDay = Math.floor(Date.parse(loan.due) / DAY) - 1;
  const through = Math.max(dayAt(loan.fundedAt), Math.min(lastBillableDay, dayAt(now)));
  const extraDays = Math.max(0, through - loan.accruedThrough);
  const accruedInterest = Math.round(loan.principalRemaining * DAILY_RATE_BPS * extraDays / 10_000);
  const tax = loan.taxRemaining + Math.round(accruedInterest * TAX_PERCENT / 100);
  const interest = loan.interestRemaining + accruedInterest;
  const principal = loan.principalRemaining;
  return { principal, interest, tax, total: principal + interest + tax, accruedThrough: through };
}

function activeTransfer(state) {
  return state.transfers.find((transfer) => transfer.status === "pending");
}

function availableCredit(state) {
  if (!state.decision?.limit || (state.loan && state.loan.status !== "repaid")) return 0;
  return state.decision.limit;
}

export function accountView(state, now = Date.now()) {
  const loan = state.loan;
  const quote = state.quote;
  return {
    mode: "sample",
    stage: state.stage,
    sampleCode: state.challenge?.expiresAt > now ? SAMPLE_CODE : null,
    decision: state.decision,
    quote: quote?.expiresAt >= now ? quote : null,
    available: availableCredit(state),
    loan: loan ? { id: loan.id, status: loan.status, amount: loan.amount, due: loan.due } : null,
    balance: currentBalance(loan, now).total,
    pending: activeTransfer(state) ?? null,
    transfers: state.transfers.slice(0, 25),
    tickets: state.tickets.slice(0, 15).map((ticket) => ({ ...ticket, id: ticket.id.replace(/^DEMO-/, "SAMPLE-") })),
    referral: state.referral?.replace(/^DEMO-/, "SAMPLE-") ?? null,
  };
}

function makeTransfer(state, type, amount, now) {
  const transfer = { id: crypto.randomUUID(), type, amount, status: "pending", createdAt: now };
  state.transfers.unshift(transfer);
  return transfer;
}

function settleTransfer(state, body, now) {
  const transfer = activeTransfer(state);
  requireState(transfer && transfer.id === body.id, "That transfer is no longer pending.");
  requireState(["success", "failed"].includes(body.outcome), "Choose a valid transfer outcome.", 400);
  transfer.status = body.outcome === "success" ? "completed" : "failed";
  transfer.completedAt = now;
  const loan = state.loan;
  if (transfer.type === "disbursement") {
    if (transfer.status === "failed") {
      state.loan = null;
      return;
    }
    const firstDayInterest = Math.round(loan.amount * DAILY_RATE_BPS / 10_000);
    Object.assign(loan, {
      status: "active",
      fundedAt: now,
      accruedThrough: dayAt(now),
      principalRemaining: loan.amount,
      interestRemaining: firstDayInterest,
      taxRemaining: Math.round(firstDayInterest * TAX_PERCENT / 100),
    });
    return;
  }
  if (transfer.status === "failed") return;
  const balance = currentBalance(loan, now);
  const taxesPaid = Math.min(transfer.amount, balance.tax);
  const interestPaid = Math.min(transfer.amount - taxesPaid, balance.interest);
  const principalPaid = Math.min(transfer.amount - taxesPaid - interestPaid, balance.principal);
  loan.taxRemaining = balance.tax - taxesPaid;
  loan.interestRemaining = balance.interest - interestPaid;
  loan.principalRemaining = balance.principal - principalPaid;
  loan.accruedThrough = balance.accruedThrough;
  if (loan.taxRemaining + loan.interestRemaining + loan.principalRemaining === 0) loan.status = "repaid";
}

export function applyAction(state, action, body, now = Date.now()) {
  switch (action) {
    case "start": {
      requireState(state.stage === "start" || state.stage === "otp", "This sample account has already been verified.");
      requireState(Object.hasOwn(SCENARIOS, body.scenario), "Select a sample scenario.", 400);
      requireState(!state.challenge || now >= state.challenge.createdAt + 10_000, "Wait a few seconds before requesting a new code.", 429);
      state.scenario = body.scenario;
      state.stage = "otp";
      state.challenge = { createdAt: now, expiresAt: now + 5 * 60_000, attempts: 0 };
      return { code: SAMPLE_CODE };
    }
    case "verify": {
      const challenge = state.challenge;
      requireState(state.stage === "otp" && challenge?.expiresAt > now, "The code expired. Request a new sample code.");
      requireState(challenge.attempts < 5, "Too many incorrect attempts. Request a new sample code.", 429);
      if (body.code !== SAMPLE_CODE) {
        challenge.attempts += 1;
        return { error: "The sample code is incorrect.", status: 400 };
      }
      state.challenge = null;
      state.stage = "identity";
      return {};
    }
    case "identity": {
      requireState(state.stage === "identity", "Verify the sample phone first.");
      requireState(body.consent === true, "Confirm the use of the sample identity.", 400);
      state.stage = SCENARIOS[state.scenario].identity ? "application" : "identity-review";
      return {};
    }
    case "apply": {
      requireState(state.stage === "application", "Complete the identity check before applying.");
      requireState(PURPOSES.includes(body.purpose) && body.consent === true, "Select a purpose and confirm the sample application.", 400);
      const { limit } = SCENARIOS[state.scenario];
      state.decision = { id: crypto.randomUUID(), limit, status: limit ? "eligible" : "in-review", purpose: body.purpose, createdAt: now };
      state.stage = "account";
      state.referral = "SAMPLE-" + crypto.randomUUID().slice(0, 8).toUpperCase();
      return {};
    }
    case "quote": {
      const limit = availableCredit(state);
      requireState(limit > 0, "There is no credit available to draw.");
      requireState(amountInRange(body.amount, MINIMUM, limit) && [14, 30, 60].includes(body.days), "Choose an amount within your limit and an available term.", 400);
      const interest = Math.round(body.amount * DAILY_RATE_BPS * body.days / 10_000);
      const tax = Math.round(interest * TAX_PERCENT / 100);
      state.quote = {
        id: crypto.randomUUID(), amount: body.amount, days: body.days, interest, tax,
        total: body.amount + interest + tax, due: dueDateAt(now, body.days),
        dailyRateBps: DAILY_RATE_BPS, termsVersion: SAMPLE_TERMS, expiresAt: now + 10 * 60_000,
      };
      return {};
    }
    case "accept": {
      const quote = state.quote;
      requireState(quote && quote.id === body.id && quote.expiresAt >= now, "That quote expired or changed. Request a fresh quote.");
      requireState(quote.amount <= availableCredit(state), "There is no credit available to draw.");
      requireState(body.consent === true && body.termsVersion === quote.termsVersion, "Confirm the displayed sample terms.", 400);
      state.loan = { ...quote, status: "pending", acceptedAt: now };
      state.quote = null;
      makeTransfer(state, "disbursement", quote.amount, now);
      return {};
    }
    case "settle":
      settleTransfer(state, body, now);
      return {};
    case "repay": {
      requireState(state.loan?.status === "active" && !activeTransfer(state), "There is no active credit ready for repayment.");
      const balance = currentBalance(state.loan, now).total;
      requireState(amountInRange(body.amount, 1, balance), "Choose an amount up to the current balance.", 400);
      makeTransfer(state, "repayment", body.amount, now);
      return {};
    }
    case "support": {
      requireState(TOPICS.includes(body.topic), "Choose a support topic.", 400);
      requireState(state.tickets.length < 30, "This sample account has reached its ticket limit.");
      state.tickets.unshift({ id: "SAMPLE-" + crypto.randomUUID().slice(0, 8).toUpperCase(), topic: body.topic, createdAt: now });
      return {};
    }
    case "reset":
      Object.assign(state, { ...newAccount(), receipts: state.receipts });
      return {};
    default:
      throw new JourneyError("This action is unavailable.", 404);
  }
}
import { JourneyError } from "./journey-error.mjs";

