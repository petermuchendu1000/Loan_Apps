const card = document.querySelector("#application");
const privacy = "https://tala.co.ke/privacy-policy-ke/";
const support = "https://tala.co.ke/contact/";
const amountFormat = new Intl.NumberFormat("en-KE");
let busy = false;

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function render(application, focus = false) {
  const testNotice = application.environment === "sandbox"
    ? '<p class="sample-box small-copy">Application testing uses provider-approved test data.</p>'
    : "";
  let content;
  switch (application.state) {
    case "verify":
      content = `<h2 tabindex="-1">Verify your account first.</h2><p>You’ll need to confirm your Kenyan mobile number and national ID before applying.</p>
        ${testNotice}<a class="button button-primary application-link" href="/verify">Verify your account</a>`;
      break;
    case "ready":
      content = `<h2 tabindex="-1">Complete your application.</h2><p>Tala will review the amount you request and your application details.</p>${testNotice}
        <form class="application-form">
          <div class="field-row">
            <label>Amount requested (KSh)<input type="number" name="amount" min="1000" max="50000" step="1" inputmode="numeric" required></label>
            <label>Borrowing purpose<select name="purpose" required>
              <option value="">Choose a purpose</option><option>Business</option><option>Education</option>
              <option>Household</option><option>Emergency</option><option>Other</option>
            </select></label>
          </div>
          <label>Verified mobile number<input type="tel" name="phone" inputmode="tel" maxlength="32" autocomplete="tel" aria-describedby="phone-hint" required></label>
          <p class="small-copy" id="phone-hint">Enter the number you verified, ending in ${escape(application.phoneHint?.slice(-4))}.</p>
          <label class="check-row"><input type="checkbox" name="eligible" required> <span>I am at least 18 and a Kenyan citizen living in Kenya.</span></label>
          <label class="check-row"><input type="checkbox" name="consent" required> <span>I consent to Tala using my verified identity, mobile number and application details to review this request. <a href="${privacy}">Tala privacy policy</a></span></label>
          <div class="form-actions"><button class="button button-primary" type="submit">Submit application</button></div>
        </form>`;
      break;
    case "received":
    case "in-review": {
      const underReview = application.state === "in-review";
      content = `<h2 tabindex="-1">${underReview ? "Application under review." : "Application received."}</h2>
        <p>${underReview ? "A Tala reviewer has started reviewing your application." : "Your application is in the queue for a Tala reviewer."} Return to this page to check its status.</p>
        ${testNotice}
        <dl class="summary-rows application-receipt">
          <div><dt>Reference</dt><dd class="application-reference">${escape(application.reference)}</dd></div>
          <div><dt>Amount requested</dt><dd>KSh ${amountFormat.format(application.amount)}</dd></div>
          <div><dt>Borrowing purpose</dt><dd>${escape(application.purpose)}</dd></div>
        </dl>
        <button class="button button-secondary" type="button" data-refresh>Check status</button>`;
      break;
    }
    default:
      content = `<h2 tabindex="-1">Online applications are unavailable.</h2><p>Phone verification and application review must be ready before you can submit online.</p>
        <a class="text-link application-link" href="${support}">Contact Tala about applying</a>`;
  }
  card.innerHTML = content + '<div id="application-message" role="status"></div>';
  if (focus) card.querySelector("h2")?.focus();
}

async function loadApplication(body) {
  if (busy) return;
  busy = true;
  card.setAttribute("aria-busy", "true");
  const button = card.querySelector("button");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/applications" + (body ? "/submit" : ""), body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {});
    const result = await response.json();
    if (response.status === 401 && result.signIn) {
      location.replace("/signin?next=%2Fapply");
      return;
    }
    if (!response.ok) throw new Error(result.error || "Unable to load your application.");
    render(result.application, Boolean(body || button));
  } catch (error) {
    if (!card.querySelector("#application-message")) {
      card.innerHTML = '<h2>Application unavailable.</h2><div id="application-message" role="status"></div>';
    }
    const message = card.querySelector("#application-message");
    message.className = "sample-box form-error";
    message.textContent = error.message;
  } finally {
    busy = false;
    card.setAttribute("aria-busy", "false");
    if (button) button.disabled = false;
  }
}

card.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  loadApplication({
    phone: fields.get("phone"), amount: Number(fields.get("amount")), purpose: fields.get("purpose"),
    eligible: fields.has("eligible"), consent: fields.has("consent"),
  });
});
card.addEventListener("click", (event) => {
  if (event.target.closest("[data-refresh]")) loadApplication();
});
await loadApplication();
