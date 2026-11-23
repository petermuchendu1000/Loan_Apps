const card = document.querySelector("#verification");
const returned = new URL(location.href).searchParams.has("verificationSessionId");
if (returned) history.replaceState(null, "", "/verify");
let verification;
let changePhone = false;
let busy = false;

function text(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function progress(step) {
  return `<ol class="verification-progress" aria-label="Verification progress">
    <li ${step === "phone" ? 'aria-current="step"' : ""}>Phone</li>
    <li ${step === "identity" ? 'aria-current="step"' : ""}>Identity</li>
  </ol>`;
}

function sandboxNote() {
  return verification.environment === "sandbox"
    ? '<p class="sample-box small-copy">Verification testing uses the SMS simulator and provider-approved test identity data.</p>'
    : "";
}

function phonePage() {
  const heading = verification.phoneHint ? "Request a verification code." : "Verify your mobile number.";
  return `${progress("phone")}<h2 tabindex="-1">${heading}</h2>
    <p>We’ll send a six-digit code to your Kenyan mobile number.</p>${sandboxNote()}
    <form data-action="send-code">
      <label>Mobile number <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" maxlength="32" required></label>
      <p class="small-copy">Africa’s Talking delivers this message for Tala. <a href="https://tala.co.ke/privacy-policy-ke/">Tala privacy policy</a></p>
      <div class="form-actions"><button type="submit" class="button button-primary">Send code</button>
      ${changePhone ? '<button type="button" class="button-link" data-back>Back to code entry</button>' : ""}</div>
    </form>`;
}

function codePage() {
  return `${progress("phone")}<h2 tabindex="-1">Enter your code.</h2>
    <p>Enter the six-digit code sent to <strong>${text(verification.phoneHint)}</strong>. It expires in five minutes.</p>${sandboxNote()}
    <form data-action="confirm-code">
      <label>Verification code <input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
      <div class="form-actions"><button type="submit" class="button button-primary">Verify phone</button>
      <button type="button" class="button-link" data-change>Request another code</button></div>
    </form>`;
}

function identityPage() {
  const status = verification.identityStatus;
  if (verification.canStartIdentity) {
    const lead = status ? "Your last verification session ended. You can start a new one." : "You’ll continue to Didit to capture your Kenyan national ID and complete any required selfie or liveness check.";
    return `${progress("identity")}<h2 tabindex="-1">Verify your identity.</h2><p>${lead}</p>${sandboxNote()}
      <form data-action="start-identity">
        <p class="small-copy">Didit processes the document and biometric checks for Tala. Read <a href="https://tala.co.ke/privacy-policy-ke/">Tala’s privacy policy</a> and <a href="https://didit.me/terms/verification-privacy-notice/">Didit’s verification privacy notice</a>.</p>
        <label class="check-row"><input name="consent" type="checkbox" required><span>I agree to use Didit for identity verification, including any required document and selfie checks.</span></label>
        <div class="form-actions"><button type="submit" class="button button-primary">Continue to Didit</button></div>
      </form>`;
  }
  const descriptions = {
    "in-review": ["Identity check under review.", "Your verification is being reviewed. Check back for an update."],
    "declined": ["Identity verification needs attention.", "Contact Tala support for information about your verification."],
    "resubmitted": ["Continue your identity check.", "Didit has requested another verification step."],
  };
  const [heading, copy] = descriptions[status] ?? ["Continue your identity check.", "Complete verification with Didit and return here to check your status."];
  return `${progress("identity")}<h2 tabindex="-1">${heading}</h2><p>${copy}</p>
    <form data-action="refresh-identity"><div class="form-actions">
      ${verification.identityUrl ? `<a class="button button-primary" rel="noreferrer" href="${text(verification.identityUrl)}">Open Didit</a>` : ""}
      <button type="submit" class="button button-secondary">Check status</button>
    </div></form>`;
}

function render(focus = false) {
  let content;
  switch (verification.state) {
    case "verified":
      content = `${progress("identity")}<h2 tabindex="-1">Identity verified.</h2>
        <p>Your mobile number and identity checks are complete.</p>
        <form data-action="refresh-identity"><div class="form-actions"><a class="button button-primary" href="/apply">Continue to application</a>
        <button type="submit" class="button button-secondary">Check status</button></div></form>`;
      break;
    case "identity": content = identityPage(); break;
    case "code": content = changePhone ? phonePage() : codePage(); break;
    case "phone": content = phonePage(); break;
    default:
      content = '<h2 tabindex="-1">Verification is unavailable.</h2><p>Phone verification is being set up for online applications.</p><div class="secondary-links"><a class="text-link" href="https://tala.co.ke/contact/">Contact Tala support</a></div>';
  }
  card.innerHTML = content + '<div id="verification-notice" role="status"></div>';
  if (focus) card.querySelector("h2")?.focus();
}

function notice(message, error = false) {
  const element = card.querySelector("#verification-notice");
  element.className = error ? "sample-box form-error" : "sample-box form-info";
  element.textContent = message;
}

async function request(action, body = {}) {
  const path = "/api/verification" + (action ? "/" + action : "");
  const options = action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.signIn) location.replace("/signin?next=%2Fverify");
  if (!response.ok) throw new Error(payload.error ?? "Verification is temporarily unavailable. Please try again.");
  return payload.verification;
}

card.addEventListener("click", (event) => {
  if (busy) return;
  const control = event.target.closest("button");
  if (control?.hasAttribute("data-change")) changePhone = true;
  else if (control?.hasAttribute("data-back")) changePhone = false;
  else return;
  render(true);
});

card.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const action = form.dataset.action;
  const body = Object.fromEntries(new FormData(form));
  if (action === "start-identity") body.consent = body.consent === "on";
  busy = true;
  card.setAttribute("aria-busy", "true");
  const controls = [...card.querySelectorAll("button")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    verification = await request(action, body);
    changePhone = false;
    render(true);
    if (action === "start-identity" && verification.identityUrl) location.assign(verification.identityUrl);
    if (action === "refresh-identity") notice("Verification status checked.");
  } catch (error) {
    if (action === "confirm-code") {
      try {
        verification = await request();
        if (verification.state !== "code") render();
      } catch {
        // Keep the current form available if the follow-up status read fails.
      }
    }
    notice(error.message, true);
  } finally {
    busy = false;
    card.setAttribute("aria-busy", "false");
    controls.forEach((control) => { control.disabled = false; });
  }
});

try {
  verification = await request();
  render();
  if (returned && verification.identityStatus) {
    try {
      verification = await request("refresh-identity");
      render();
    } catch (error) {
      notice(error.message, true);
    }
  }
} catch (error) {
  card.innerHTML = '<h2>Verification unavailable.</h2><div id="verification-notice" role="status"></div><a class="text-link" href="/verify">Try again</a>';
  notice(error.message, true);
} finally {
  card.setAttribute("aria-busy", "false");
}
