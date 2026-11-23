const path = location.pathname.replace(/\/$/, "");
const mode = { "/signup": "signup", "/forgot-pin": "reset" }[path] ?? "signin";
const requested = new URLSearchParams(location.search).get("next");
const next = ["/apply", "/verify", "/borrow"].includes(requested) ? requested : "/verify";
const suffix = "?next=" + encodeURIComponent(next);
const card = document.querySelector("#account");
const support = "https://tala.co.ke/contact/";
let busy = false;

const copy = {
  signup: ["Create your online account.", "Verify your Kenyan mobile number and choose a PIN for this website."],
  signin: ["Sign in to your online account.", "Use your registered mobile number and the PIN you created for this website."],
  reset: ["Reset your web PIN.", "Use your registered mobile number and verified ID to recover your online account."],
};
document.querySelector("#account-heading").textContent = copy[mode][0];
document.querySelector("#account-description").textContent = copy[mode][1];

const phone = '<label>Kenyan mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" maxlength="32" required></label>';
const currentPin = '<label>Web PIN<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4}" maxlength="4" required></label>';
const newPin = '<label>New web PIN<input name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required></label>';
const confirmation = '<label>Confirm web PIN<input name="pinConfirm" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required></label>';
const id = '<label>National ID number<input name="idNumber" type="text" inputmode="text" autocomplete="off" maxlength="32" required></label>';
const code = '<label>SMS verification code<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>';

function form(action, fields, label, reset = false) {
  const back = reset ? '<button type="button" class="button-link" data-restart>Start again</button>' : "";
  return `<form data-action="${action}">${fields}<div class="form-actions">
    <button class="button button-primary" type="submit">${label}</button>${back}</div></form>`;
}

function startPage() {
  if (mode === "signin") {
    return `<h2 tabindex="-1">Enter your account details.</h2>${form("start", phone + currentPin, "Continue")}
      <div class="secondary-links"><a class="text-link" href="/forgot-pin${suffix}">Forgot PIN?</a>
      <a class="text-link" href="/signup${suffix}">Create a web account</a></div>`;
  }
  if (mode === "reset") {
    return `<h2 tabindex="-1">Confirm your identity.</h2>
      <p>Enter the national ID number you previously verified for this web account.</p>
      ${form("start", phone + id, "Request temporary PIN")}
      <div class="secondary-links"><a class="text-link" href="/signin${suffix}">Back to sign in</a>
      <a class="text-link" href="${support}">Contact support</a></div>`;
  }
  return `<h2 tabindex="-1">Enter your mobile number.</h2><p>We’ll send you a six-digit SMS code.</p>
    ${form("start", phone, "Send code")}
    <div class="secondary-links"><a class="text-link" href="/signin${suffix}">Already have a web account? Sign in</a></div>`;
}

function render(state, focus = false) {
  let content;
  switch (state) {
    case "start":
    case "signed-out":
      content = startPage();
      break;
    case "code":
      content = mode === "reset"
        ? `<h2 tabindex="-1">Enter your temporary PIN.</h2><p>If the details match a verified web account, you’ll get a code by SMS.</p>${form("verify", code, "Continue", true)}`
        : `<h2 tabindex="-1">Enter your SMS code.</h2><p>The six-digit code expires in five minutes.</p>${form("verify", code, "Verify code", true)}`;
      break;
    case "pin":
      content = `<h2 tabindex="-1">Choose a four-digit web PIN.</h2><p>You’ll use this PIN to sign in to this website.</p>
        ${form("finish", newPin + confirmation, mode === "reset" ? "Set new PIN" : "Create account", true)}`;
      break;
    case "signed-in":
      content = `<h2 tabindex="-1">You’re signed in.</h2><div class="form-actions">
        <a class="button button-primary" href="${next}">Continue</a>${form("signout", "", "Sign out")}</div>`;
      break;
    case "pin-reset":
      content = `<h2 tabindex="-1">Your web PIN has been reset.</h2><a class="button button-primary" href="/signin${suffix}">Sign in with your new PIN</a>`;
      break;
    default:
      content = `<h2 tabindex="-1">Online account access is unavailable.</h2>
        <p>Contact Tala support for help with your account.</p><a class="text-link" href="${support}">Contact Tala support</a>`;
  }
  card.innerHTML = content + '<div id="account-message" role="status" aria-live="polite"></div>';
  if (focus) card.querySelector("h2")?.focus();
}

function notice(error) {
  const element = card.querySelector("#account-message");
  element.className = "sample-box form-error";
  element.textContent = error.message;
}

async function request(action, fields = {}) {
  const response = await fetch(action ? "/api/auth/" + action : "/api/auth?mode=" + mode, action ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, mode }),
  } : {});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Account access is temporarily unavailable.");
  return result.state;
}

card.addEventListener("click", (event) => {
  if (!busy && event.target.closest("[data-restart]")) render("start", true);
});

card.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const action = event.target.dataset.action;
  const data = Object.fromEntries(new FormData(event.target));
  const controls = Array.from(card.querySelectorAll("button"));
  busy = true;
  card.setAttribute("aria-busy", "true");
  controls.forEach((control) => { control.disabled = true; });
  try {
    const state = await request(action, data);
    if (state === "signed-in") location.assign(next);
    else if (state === "signed-out") location.replace("/signin" + suffix);
    else render(state, true);
  } catch (error) {
    notice(error);
  } finally {
    busy = false;
    card.setAttribute("aria-busy", "false");
    controls.forEach((control) => { control.disabled = false; });
  }
});

try {
  render(await request());
} catch (error) {
  render("unavailable");
  notice(error);
} finally {
  card.setAttribute("aria-busy", "false");
}
