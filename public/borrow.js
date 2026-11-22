const journey = document.querySelector("#journey");
const shillings = new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", currencyDisplay: "code", minimumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat("en-KE", {
  timeZone: "Africa/Nairobi", day: "numeric", month: "short", year: "numeric",
});
const safe = (text) => String(text).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const money = (minor) => shillings.format(minor / 100).replace("KES", "KSh");
const date = (value) => dateFormat.format(new Date(value));
let account;
let panel = "account";
let busy = false;

function intro(step, heading, copy) {
  return `<p class="eyebrow"><span></span>${step}</p><h2 tabindex="-1">${heading}</h2><p>${copy}</p>`;
}

function button(text, style = "primary") {
  return `<button class="button button-${style}" type="submit">${text}</button>`;
}

function field(label, name, options) {
  return `<label>${label}<select name="${name}" required>${options.map(([value, title]) => `<option value="${value}">${title}</option>`).join("")}</select></label>`;
}

function confirm(text) {
  return `<label class="check-row"><input type="checkbox" name="consent" required><span>${text}</span></label>`;
}

function row(label, value, className = "") {
  return `<div class="${className}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function backButton() {
  return '<button class="button-link" type="button" data-panel="account">Back to my account</button>';
}

function startView() {
  return `${intro("Phone verification", "Start with a sample account.", "Choose a scenario to try the online borrowing journey.")}
    <form data-action="start">
      ${field("Sample scenario", "scenario", [["standard", "Eligible borrower"], ["review", "Application in review"], ["identity", "Identity needs review"]])}
      <div class="sample-box small-copy">Sample phone <strong>+254 ••• ••0184</strong>. The verification code appears here on the next screen.</div>
      <div class="form-actions">${button("Get sample code")}</div>
    </form>`;
}

function verificationView() {
  const box = account.sampleCode
    ? `<p class="sample-box">Sample verification code <strong>${safe(account.sampleCode)}</strong></p>`
    : '<p class="sample-box">The code has expired. Request a new sample code below.</p>';
  return `${intro("Phone verification", "Enter the verification code.", "This exercise uses a sample code in place of an SMS.")}
    ${box}
    <form data-action="verify">
      <label>Six-digit code <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>
      <div class="form-actions">${button("Verify phone")} <button class="button-link" type="button" data-panel="start">Request a new code</button></div>
    </form>`;
}

function identityView() {
  return `${intro("Identity check", "Verify your sample identity.", "This step represents verification of a Kenyan national ID.")}
    <div class="sample-box"><strong>Sample borrower</strong><br>Kenyan national ID ending in 0184</div>
    <form data-action="identity">
      ${confirm("Use this sample identity for the verification check.")}
      <div class="form-actions">${button("Verify sample identity")}</div>
    </form>`;
}

function applicationView() {
  return `${intro("Application", "Tell us what you need credit for.", "Choose a borrowing purpose and submit your sample application.")}
    <form data-action="apply">
      ${field("Borrowing purpose", "purpose", ["Business", "Household", "Education", "Emergency"].map((item) => [item, item]))}
      ${confirm("Submit this sample application using the sample identity.")}
      <div class="form-actions">${button("Submit sample application")}</div>
    </form>`;
}

function reviewView() {
  return `${intro("Identity check", "Your identity check needs review.", "This sample scenario pauses at verification. Use Support to see how a request is recorded.")}
    <div class="account-links">
      <button class="button-link" type="button" data-panel="support">Support</button>
      <button class="button-link" type="button" data-panel="reset">Try another scenario</button>
    </div>`;
}

function quoteView(quote) {
  return `<section class="sample-box"><h3>Your borrowing summary</h3>
    <dl class="summary-rows">
      ${row("Credit to receive", money(quote.amount))}
      ${row("Daily interest rate", (quote.dailyRateBps / 100).toFixed(2) + "%")}
      ${row("Interest over " + quote.days + " days", money(quote.interest))}
      ${row("Sample tax", money(quote.tax))}
      ${row("Estimated total at due date", money(quote.total), "summary-total")}
      ${row("Repay by", date(quote.due))}
    </dl>
    <form data-action="accept">
      ${confirm("Accept this sample offer and its displayed repayment terms.")}
      <div class="form-actions">${button("Accept sample offer")}</div>
    </form></section>`;
}

function drawView() {
  return `<form data-action="quote">
      <div class="field-row">
        <label>Amount in KSh
          <input type="number" name="amount" min="1000" max="${account.available / 100}" step="1" inputmode="numeric" placeholder="2,000" required>
        </label>
        ${field("Repayment term", "days", [[14, "14 days"], [30, "30 days"], [60, "60 days"]])}
      </div>
      <div class="form-actions">${button(account.quote ? "Update quote" : "Review borrowing cost", account.quote ? "secondary" : "primary")}</div>
    </form>${account.quote ? quoteView(account.quote) : ""}`;
}

function loanView() {
  return `<h3>Repay your balance</h3>
    <p>Due ${date(account.loan.due)}. Your balance reflects charges accrued so far.</p>
    <form data-action="repay">
      <label>Payment amount in KSh
        <input type="number" name="amount" min="0.01" max="${(account.balance / 100).toFixed(2)}" step="0.01" inputmode="decimal" required>
      </label>
      <div class="form-actions">${button("Request sample M-PESA payment")} <button class="button-link" type="button" data-fill-balance>Use full balance</button></div>
    </form>`;
}

function transferView(transfer) {
  const name = transfer.type === "repayment" ? "Repayment" : "Disbursement";
  return `<div class="sample-box">
    <h3>${name} pending</h3><p>${money(transfer.amount)} · Sample M-PESA wallet</p>
    <form data-action="settle">
      <div class="form-actions">
        <button class="button button-primary" type="submit" name="outcome" value="success">Simulate success</button>
        <button class="button button-secondary" type="submit" name="outcome" value="failed">Simulate failure</button>
      </div>
    </form>
  </div>`;
}

function accountView() {
  if (account.stage === "identity-review") return reviewView();
  const eligible = account.decision?.status === "eligible";
  return `${intro("My Tala", "Your credit account.", eligible ? "Review your credit, manage a draw and track repayments." : "Your sample application is in review.")}
    <div class="account-links">
      <button class="button-link" type="button" data-panel="history">Transaction history</button>
      <button class="button-link" type="button" data-panel="support">Support</button>
      <button class="button-link" type="button" data-panel="referrals">Referrals</button>
      <button class="button-link" type="button" data-panel="reset">Restart sample account</button>
    </div>
    <dl class="account-metrics">
      ${row("Available credit", money(account.available))}
      ${row("Current balance", money(account.balance))}
    </dl>
    ${account.pending ? transferView(account.pending) : ""}
    ${!account.pending && account.loan?.status === "active" ? loanView() : ""}
    ${account.loan?.status === "repaid" ? '<p class="form-info"><strong>Credit repaid.</strong> Your available credit has been restored.</p>' : ""}
    ${account.available ? drawView() : ""}`;
}

function historyView() {
  const entries = account.transfers.map((entry) => `<li>
    <strong>${entry.type === "repayment" ? "Repayment" : "Disbursement"}</strong>
    <span>${money(entry.amount)}</span>
    <small>${date(entry.createdAt)} · ${safe(entry.status)} · ${safe(entry.id.slice(0, 8))}</small>
  </li>`).join("");
  return `${intro("My Tala", "Transaction history.", "Review sample M-PESA disbursements and repayments.")}
    ${entries ? `<ul class="timeline">${entries}</ul>` : '<p class="sample-box">There are no transactions yet.</p>'}${backButton()}`;
}

function supportView() {
  const tickets = account.tickets.map((ticket) => `<li><strong>${safe(ticket.topic)}</strong><span>${safe(ticket.id)}</span><small>${date(ticket.createdAt)} · Open</small></li>`).join("");
  return `${intro("My Tala", "Support requests.", "Choose a topic to create a sample support request.")}
    <form data-action="support">
      ${field("Topic", "topic", ["Application", "M-PESA transfer", "Repayment", "Account access"].map((item) => [item, item]))}
      <div class="form-actions">${button("Create sample request")}</div>
    </form>
    ${tickets ? `<ul class="timeline">${tickets}</ul>` : ""}
    <div class="account-links">${backButton()}<a class="text-link" href="https://tala.co.ke/contact/">Contact Tala Kenya</a></div>`;
}

function referralsView() {
  return `${intro("My Tala", "Your referral code.", "Copy this sample referral code.")}
    <p class="sample-box"><strong>${safe(account.referral)}</strong></p>
    <div class="account-links"><button type="button" class="button-link" data-copy>Copy sample code</button>${backButton()}</div>`;
}

function resetView() {
  return `${intro("Sample account", "Start another scenario?", "Restarting clears this sample account’s application, transfers and support requests.")}
    <form data-action="reset"><div class="form-actions">${button("Restart sample account")}${backButton()}</div></form>`;
}

const stageViews = {
  start: startView,
  otp: verificationView,
  identity: identityView,
  application: applicationView,
  account: accountView,
  "identity-review": reviewView,
};
const panels = { start: startView, history: historyView, support: supportView, referrals: referralsView, reset: resetView };

function render({ focus = false, message = "" } = {}) {
  const view = panels[panel] ?? stageViews[account.stage];
  journey.innerHTML = `${view()}<div id="notice" role="status"></div>`;
  journey.setAttribute("aria-busy", "false");
  if (message) announce(message);
  if (focus) journey.querySelector("h2")?.focus();
}

function announce(message, error = false) {
  const notice = journey.querySelector("#notice");
  notice.className = error ? "sample-box form-error" : "sample-box form-info";
  notice.textContent = message;
}

async function api(path = "", settings) {
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("/api/account" + path, settings);
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Unable to complete the request.");
  return payload;
}

function minorUnits(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function actionBody(action, data, submitter) {
  switch (action) {
    case "identity": return { consent: data.get("consent") === "on" };
    case "apply": return { purpose: data.get("purpose"), consent: data.get("consent") === "on" };
    case "quote": return { amount: minorUnits(data.get("amount")), days: Number(data.get("days")) };
    case "accept": return { id: account.quote.id, termsVersion: account.quote.termsVersion, consent: data.get("consent") === "on" };
    case "repay": return { amount: minorUnits(data.get("amount")) };
    case "settle": return { id: account.pending.id, outcome: submitter?.value };
    default: return Object.fromEntries(data);
  }
}

journey.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const action = form.dataset.action;
  const body = actionBody(action, new FormData(form), event.submitter);
  busy = true;
  journey.setAttribute("aria-busy", "true");
  const controls = Array.from(journey.querySelectorAll("button"));
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await api("/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    account = result.account;
    panel = action === "support" ? "support" : "account";
    render({
      focus: true,
      message: action === "support" ? "Your sample support request was recorded." : "",
    });
    if (action === "quote") journey.querySelector(".sample-box h3")?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    announce(error.message || "The request failed. Please try again.", true);
  } finally {
    busy = false;
    journey.setAttribute("aria-busy", "false");
    controls.forEach((control) => { control.disabled = false; });
  }
});

journey.addEventListener("click", async (event) => {
  const control = event.target.closest("button");
  if (!control || busy) return;
  if (control.dataset.panel) {
    panel = control.dataset.panel;
    render({ focus: true });
  } else if (control.hasAttribute("data-fill-balance")) {
    const field = journey.querySelector('input[name="amount"]');
    field.value = (account.balance / 100).toFixed(2);
    field.focus();
  } else if (control.hasAttribute("data-copy")) {
    try {
      await navigator.clipboard.writeText(account.referral);
      announce("Sample code copied.");
    } catch {
      announce("Select and copy the sample code shown above.", true);
    }
  }
});

try {
  ({ account } = await api());
  render();
} catch (error) {
  journey.setAttribute("aria-busy", "false");
  journey.innerHTML = '<h2>Account unavailable</h2><p role="alert"></p><a class="text-link" href="/borrow">Try again</a>';
  journey.querySelector('[role="alert"]').textContent = error.message;
}
