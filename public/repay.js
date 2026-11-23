const card = document.querySelector("#repayment");
const paybill = document.querySelector(".repayment-paybill");
const local = ["127.0.0.1", "localhost"].includes(location.hostname);
const money = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: "Africa/Nairobi" });
const open = new Set(["starting", "pending", "awaiting-receipt", "posting", "review"]);
let state;
let draft;
let busy = false;

function text(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shillings(amount) {
  return "KSh " + money.format(amount);
}

const statuses = {
  starting: ["Preparing the M-PESA prompt", "Check status before requesting another payment."],
  pending: ["Waiting for M-PESA", "Approve the M-PESA prompt on your phone, then check status."],
  "awaiting-receipt": ["Waiting for the M-PESA receipt", "M-PESA confirmed the payment. Tala is waiting for the receipt details."],
  posting: ["Posting to Tala", "The M-PESA receipt is recorded. Check again to see when Tala credits your loan."],
  credited: ["Credited to your Tala loan", "The payment is recorded on your Tala account."],
  failed: ["Payment did not complete", "You can request another payment."],
  review: ["Payment needs review", "Share the reference with Tala support if the status stays unchanged."],
};

function paymentStatus(item) {
  const [title, description] = statuses[item.state] ?? statuses.review;
  const heading = item.result === "cancelled" ? "Payment cancelled" : title;
  return `<h3>${heading}</h3><p>${description}</p>
    <dl class="summary-rows">
      <div><dt>Amount</dt><dd>${shillings(item.amount)}</dd></div>
      <div><dt>Reference</dt><dd><code>${text(item.id)}</code></dd></div>
      ${item.receipt ? `<div><dt>M-PESA receipt</dt><dd><strong>${text(item.receipt)}</strong></dd></div>` : ""}
    </dl>
    ${open.has(item.state) ? '<button class="button button-secondary" type="button" data-check>Check status</button>' : ""}`;
}

function history() {
  const payments = state.payments?.filter((item) => item.id !== state.active?.id) ?? [];
  const ledger = state.ledger ?? [];
  return `${payments.length ? `<h3>Recent web payments</h3><dl class="summary-rows">
    ${payments.map((item) => `<div><dt>${date.format(item.createdAt)}<br><small>${item.result === "cancelled" ? "Cancelled" : statuses[item.state]?.[0] ?? "Under review"}${item.receipt ? " · " + text(item.receipt) : ""}</small></dt>
    <dd>${shillings(item.amount)}</dd></div>`).join("")}</dl>` : ""}
    ${ledger.length ? `<h3>Payments on your Tala account</h3><dl class="summary-rows">
    ${ledger.map((item) => `<div><dt>${date.format(new Date(item.date))}<br><small>${text(item.id)}</small></dt>
    <dd>${shillings(item.amountMinor / 100)}</dd></div>`).join("")}</dl>` : ""}`;
}

function form() {
  const max = Math.floor(state.loan.balanceMinor / 100);
  return `<form data-action="prepare">
    <label>Amount (KSh)<input name="amount" type="number" inputmode="numeric" min="1" max="${max}" step="1" required></label>
    ${state.loan.balanceMinor % 100 === 0 ? '<button type="button" class="button-link" data-full>Use full balance</button>' : ""}
    <label>Registered M-PESA number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" required></label>
    ${state.phoneHint ? `<p class="small-copy">Use your verified number ending in <strong>${text(state.phoneHint.slice(-4))}</strong>.</p>` : ""}
    <div class="form-actions"><button class="button button-primary" type="submit">Review payment</button></div>
  </form>`;
}

function render(focus = false) {
  const testing = local || state.environment === "sandbox";
  paybill.hidden = testing;
  let content;
  if (draft) {
    content = `<h2 tabindex="-1">Confirm your payment.</h2>
      <p>Send an M-PESA prompt for <strong>${shillings(draft.amount)}</strong> to the number ending in <strong>${text(draft.phone.replace(/[^0-9]/g, "").slice(-4))}</strong>.</p>
      <form data-action="start"><div class="form-actions"><button class="button button-primary" type="submit">Send M-PESA prompt</button>
      <button class="button-link" type="button" data-back>Change payment</button></div></form>`;
  } else if (state.state === "signin") {
    content = '<h2 tabindex="-1">Sign in to repay online.</h2><a class="button button-primary" href="/signin?next=%2Frepay">Sign in</a>';
  } else if (state.state === "unlinked") {
    content = '<h2 tabindex="-1">Connect your Tala loan.</h2><p>Online payments use a loan linked to your verified web account. Contact Tala about linking your account.</p><a class="text-link" href="https://tala.co.ke/contact/">Contact Tala support</a>';
  } else {
    const loan = state.loan;
    const balance = loan ? `<dl class="summary-rows"><div><dt>Outstanding balance</dt><dd><strong>${shillings(loan.balanceMinor / 100)}</strong></dd></div>
      ${loan.dueDate ? `<div><dt>Due date</dt><dd>${date.format(new Date(loan.dueDate + "T12:00:00+03:00"))}</dd></div>` : ""}</dl>` : "";
    const controls = state.active ? paymentStatus(state.active)
      : state.state === "no-balance" ? "<p>There is no balance due on your linked loan.</p>"
      : state.state === "ready" && state.express && loan.balanceMinor >= 100 ? form()
      : "<p>M-PESA Xpress is currently unavailable. You can use Paybill.</p>";
    content = `<h2 tabindex="-1">M-PESA Xpress</h2>${balance}${controls}${history()}`;
  }
  card.innerHTML = (testing ? '<p class="sample-box small-copy">This environment uses test payments.</p>' : "") +
    content + '<div id="repayment-notice" role="status"></div>';
  if (focus) card.querySelector("h2")?.focus();
}

async function request(action, body = {}, id = null) {
  const response = await fetch("/api/repayments" + (action ? "/" + action : ""), action ? {
    method: "POST", headers: { "Content-Type": "application/json", ...(id ? { "Idempotency-Key": id } : {}) }, body: JSON.stringify(body),
  } : {});
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && !action) return { state: "signin" };
  if (!response.ok) throw new Error(result.error ?? "Online repayment is temporarily unavailable.");
  return result;
}

function notice(message, error = false) {
  const status = card.querySelector("#repayment-notice");
  status.className = error ? "sample-box form-error" : "sample-box form-info";
  status.textContent = message;
}

async function change(action) {
  if (busy) return;
  busy = true;
  const buttons = [...card.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  card.setAttribute("aria-busy", "true");
  try {
    const result = action === "check" ? await request("check", { id: state.active.id })
      : await request("start", { amount: draft.amount, phone: draft.phone, loanId: draft.loanId, confirmed: true }, draft.id);
    draft = null;
    const refreshed = await request().catch(() => null);
    const payment = refreshed?.payments?.find((item) => item.id === result.payment.id) ?? result.payment;
    if (refreshed?.payments) state = refreshed;
    else {
      state.active = open.has(payment.state) ? payment : null;
      state.payments = [payment, ...(state.payments ?? []).filter((item) => item.id !== payment.id)];
    }
    render(true);
    notice(statuses[payment.state]?.[0] ?? "Payment status checked.");
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    card.setAttribute("aria-busy", "false");
    buttons.forEach((button) => { button.disabled = false; });
  }
}

card.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  if (event.target.dataset.action === "start") {
    change("start");
    return;
  }
  const input = new FormData(event.target);
  draft = { amount: Number(input.get("amount")), phone: input.get("phone"), loanId: state.loan.id, id: crypto.randomUUID() };
  render(true);
});

card.addEventListener("click", (event) => {
  if (busy) return;
  if (event.target.closest("[data-check]")) change("check");
  else if (event.target.closest("[data-back]")) {
    draft = null;
    render(true);
  } else if (event.target.closest("[data-full]")) {
    const amount = card.querySelector('[name="amount"]');
    amount.value = Math.floor(state.loan.balanceMinor / 100);
    amount.focus();
  }
});

try {
  state = await request();
  render();
} catch (error) {
  state = { state: "unavailable" };
  render();
  notice(error.message, true);
} finally {
  card.setAttribute("aria-busy", "false");
}
