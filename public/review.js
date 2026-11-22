const list = document.querySelector("#review-list");
const message = document.querySelector("#review-message");
const more = document.querySelector("#review-more");
const refresh = document.querySelector("#refresh");
const dates = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: "Africa/Nairobi" });
const numbers = new Intl.NumberFormat("en-KE");
let cursor;
let loading = false;

async function api(path = "", body) {
  const response = await fetch("/api/lending-review" + path, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to load the application queue.");
  return data;
}

function row(label, value) {
  const container = document.createElement("div");
  const term = document.createElement("dt");
  const definition = document.createElement("dd");
  term.textContent = label;
  definition.textContent = value;
  container.append(term, definition);
  return container;
}

function drawApplication(application) {
  const item = document.createElement("li");
  item.innerHTML = '<h2 class="application-reference"></h2><dl class="summary-rows"></dl><div class="form-actions"></div><p class="small-copy" role="status"></p>';
  item.querySelector("h2").textContent = application.reference;
  const summary = item.querySelector("dl");
  summary.append(
    row("Status", application.state === "in-review" ? "Under review" : "Received"),
    row("Received", dates.format(application.receivedAt)),
    row("Amount requested", "KSh " + numbers.format(application.amount)),
    row("Purpose", application.purpose),
    row("Verified phone", application.phoneHint),
    row("Didit session", application.identityId),
  );
  const actions = item.querySelector(".form-actions");
  if (application.state === "received") {
    const start = document.createElement("button");
    start.className = "button button-primary";
    start.type = "button";
    start.textContent = "Start review";
    start.addEventListener("click", async () => {
      start.disabled = true;
      try {
        const result = await api("/start-review", { reference: application.reference });
        item.replaceWith(drawApplication(result.application));
      } catch (error) {
        item.querySelector('[role="status"]').textContent = error.message;
        start.disabled = false;
      }
    });
    actions.append(start);
  }
  const contact = document.createElement("button");
  contact.className = "button button-secondary";
  contact.type = "button";
  contact.textContent = "Show contact number";
  contact.addEventListener("click", async () => {
    const notice = item.querySelector('[role="status"]');
    if (contact.textContent === "Hide contact number") {
      notice.textContent = "";
      contact.textContent = "Show contact number";
      return;
    }
    contact.disabled = true;
    try {
      const result = await api("/contact", { reference: application.reference });
      notice.textContent = "Verified mobile number " + result.phone;
      contact.textContent = "Hide contact number";
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      contact.disabled = false;
    }
  });
  actions.append(contact);
  return item;
}

async function load(append = false) {
  if (loading) return;
  loading = true;
  refresh.disabled = more.disabled = true;
  try {
    const result = await api(append && cursor ? "?after=" + encodeURIComponent(cursor) : "");
    if (!append) list.replaceChildren();
    list.append(...result.applications.map(drawApplication));
    cursor = result.next;
    more.hidden = !cursor;
    const note = result.environment === "sandbox" ? "Test applications. " : "";
    message.textContent = note + (list.children.length ? "Newest applications first." : "No applications received yet.");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    loading = false;
    refresh.disabled = more.disabled = false;
  }
}

refresh.addEventListener("click", () => load());
more.addEventListener("click", () => load(true));
await load();
