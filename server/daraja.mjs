const bases = {
  sandbox: "https://sandbox.safaricom.co.ke",
  live: "https://api.safaricom.co.ke",
};
const identifier = /^[A-Za-z0-9_-]{1,96}$/;
const receiptPattern = /^[A-Z0-9]{6,32}$/;
const definitiveFailures = new Set(["1", "1032", "1037", "2001"]);

export function darajaConfiguration(env, environment) {
  const { MPESA_CONSUMER_KEY: consumerKey, MPESA_CONSUMER_SECRET: consumerSecret,
    MPESA_SHORTCODE: shortcode, MPESA_PASSKEY: passkey, MPESA_CALLBACK_URL: callback,
    MPESA_CALLBACK_KEY: callbackKey } = env;
  if (!bases[environment] || !consumerKey || !consumerSecret || !/^\d{5,7}$/.test(shortcode ?? "") || !passkey ||
      !/^[A-Za-z0-9_-]{43}$/.test(callbackKey ?? "")) return null;
  try {
    const url = new URL(callback);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname === "/") return null;
    return { environment, consumerKey, consumerSecret, shortcode, passkey, callback: url.href, callbackKey };
  } catch {
    return null;
  }
}

function timestamp(now) {
  const inNairobi = new Date(now + 3 * 60 * 60_000).toISOString();
  return inNairobi.slice(0, 19).replace(/\D/g, "");
}

function transactionTime(value) {
  const digits = String(value ?? "");
  if (!/^\d{14}$/.test(digits)) return null;
  const time = digits.replace(/^(....)(..)(..)(..)(..)(..)$/, "$1-$2-$3T$4:$5:$6+03:00");
  const date = new Date(time);
  return Number.isFinite(date.valueOf()) && timestamp(date.valueOf()) === digits ? date.toISOString() : null;
}

function requestIds(body) {
  const { CheckoutRequestID: checkout, MerchantRequestID: merchant } = body ?? {};
  return identifier.test(checkout ?? "") && identifier.test(merchant ?? "") ? { checkout, merchant } : null;
}

export function callbackEvidence(payload) {
  const callback = payload?.Body?.stkCallback;
  const ids = requestIds(callback);
  const resultCode = String(callback?.ResultCode ?? "");
  if (!ids || !/^\d{1,8}$/.test(resultCode)) return null;
  if (resultCode !== "0") return { ...ids, resultCode };
  const items = callback.CallbackMetadata?.Item;
  if (!Array.isArray(items)) return null;
  const metadata = Object.fromEntries(items.filter((item) => typeof item?.Name === "string")
    .map(({ Name, Value }) => [Name, Value]));
  const amount = Number(metadata.Amount);
  const receipt = String(metadata.MpesaReceiptNumber ?? "").trim().toUpperCase();
  const paidAt = transactionTime(metadata.TransactionDate);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !receiptPattern.test(receipt) || !paidAt ||
      !/^254[17]\d{8}$/.test(String(metadata.PhoneNumber ?? ""))) return null;
  return { ...ids, resultCode, amount, receipt, paidAt, phone: "+" + metadata.PhoneNumber };
}

export class DarajaError extends Error {
  constructor(rejected = false) {
    super("M-PESA could not complete the request.");
    this.rejected = rejected;
  }
}

export function createDarajaClient(settings, fetcher = fetch) {
  const base = bases[settings.environment];
  let token;
  async function call(path, options) {
    try {
      const response = await fetcher(base + path, { ...options, redirect: "manual", signal: AbortSignal.timeout(12_000) });
      return { ok: response.ok, body: await response.json().catch(() => null) };
    } catch {
      throw new DarajaError();
    }
  }
  async function authorize() {
    const { ok, body } = await call("/oauth/v1/generate?grant_type=client_credentials", {
      headers: { authorization: "Basic " + btoa(settings.consumerKey + ":" + settings.consumerSecret) },
    }).catch(() => { throw new DarajaError(true); });
    if (!ok || typeof body?.access_token !== "string" || !body.access_token) throw new DarajaError(true);
    return body.access_token;
  }
  async function send(path, fields, now) {
    token ??= await authorize();
    const at = timestamp(now);
    return call(path, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: settings.shortcode, Password: btoa(settings.shortcode + settings.passkey + at),
        Timestamp: at, ...fields,
      }),
    });
  }
  return {
    async start(amount, phone, callback, now) {
      const digits = phone.slice(1);
      const { ok, body } = await send("/mpesa/stkpush/v1/processrequest", {
        TransactionType: "CustomerPayBillOnline", Amount: amount,
        PartyA: digits, PartyB: settings.shortcode, PhoneNumber: digits,
        CallBackURL: callback, AccountReference: "0" + phone.slice(4), TransactionDesc: "Tala repayment",
      }, now);
      const ids = requestIds(body);
      if (ok && String(body?.ResponseCode ?? "") === "0" && ids) return ids;
      const code = String(body?.ResponseCode ?? "");
      throw new DarajaError(ok && /^\d+$/.test(code) && code !== "0" && !ids);
    },
    async check(checkout, merchant, now) {
      const { ok, body } = await send("/mpesa/stkpushquery/v1/query", { CheckoutRequestID: checkout }, now);
      if (!ok || String(body?.ResponseCode ?? "") !== "0") return { state: "pending" };
      const ids = requestIds(body);
      if (!ids || ids.checkout !== checkout || ids.merchant !== merchant) return { state: "pending" };
      const code = String(body.ResultCode ?? "");
      if (code === "0") return { state: "confirmed", code };
      return definitiveFailures.has(code) ? { state: "failed", code } : { state: "pending" };
    },
  };
}
