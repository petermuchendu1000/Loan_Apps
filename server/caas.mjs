const operations = {
  optIn: ["POST", "/api/v1/users/opt-in"],
  optOut: ["PATCH", "/api/v1/users/{customer}/opt-out"],
  identityFields: ["GET", "/api/v1/loan/data"],
  submitIdentity: ["POST", "/api/v1/users/{customer}/loan/data"],
  onboardingRequirements: ["GET", "/api/v1/users/{customer}/requirements"],
  submitSurvey: ["PATCH", "/api/v1/users/{customer}/survey"],
  offer: ["GET", "/api/v1/users/{customer}/loan/offer"],
  terms: ["POST", "/api/v1/users/{customer}/loan/terms"],
  decide: ["PUT", "/api/v2/users/{customer}/loan/offer"],
  disbursementNotification: ["POST", "/api/v2/users/{customer}/disbursement/notification"],
  repaymentCredential: ["POST", "/api/v1/users/{customer}/repayment/credential"],
  repaymentNotification: ["POST", "/api/v1/users/{customer}/repayment/notification"],
  repaymentStatus: ["GET", "/api/v1/users/{customer}/repayment/{transaction}/status"],
  loan: ["GET", "/api/v2/users/{customer}/loan"],
  balance: ["GET", "/api/v1/users/{customer}/loan/balance"],
  history: ["GET", "/api/v2/users/{customer}/loan/history"],
  transactions: ["GET", "/api/v1/users/{customer}/transactions"],
};

export class CaaSError extends Error {
  constructor(status, metadata) {
    super("Tala CaaS returned an error (" + status + ").");
    this.status = status;
    this.requestId = metadata?.requestId;
    this.errorCode = metadata?.errorCode;
  }
}

function pathPart(value) {
  if (typeof value !== "string" || !value || value === "." || value === "..") {
    throw new TypeError("A valid Tala partner reference is required.");
  }
  return encodeURIComponent(value);
}

function basicAuth(clientId, secret) {
  const bytes = new TextEncoder().encode(clientId + ":" + secret);
  return "Basic " + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function createCaaSClient({ baseUrl, clientId, clientSecret, fetcher = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new TypeError("Use the Tala-issued HTTPS sandbox base URL.");
  }
  if (!clientId || !clientSecret) throw new TypeError("Tala partner credentials are required.");
  const prefix = base.href.replace(/\/$/, "");
  let token;
  let expiresAt = 0;
  let tokenRequest;

  async function send(path, init) {
    const response = await fetcher(prefix + path, {
      ...init, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body ||
        (Number.isInteger(body.metadata?.statusCode) && body.metadata.statusCode >= 400)) {
      throw new CaaSError(response.ok ? body?.metadata?.statusCode ?? 502 : response.status, body?.metadata);
    }
    return body;
  }

  async function issueToken() {
    const result = await send("/token", {
      method: "POST",
      headers: {
        authorization: basicAuth(clientId, clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (typeof result.access_token !== "string" || !result.access_token || !(result.expires_in > 0)) {
      throw new CaaSError(502);
    }
    token = result.access_token;
    const buffer = Math.min(60, result.expires_in / 4);
    expiresAt = Date.now() + (result.expires_in - buffer) * 1000;
    return token;
  }

  async function getToken() {
    if (token && expiresAt > Date.now()) return token;
    tokenRequest ??= issueToken().finally(() => { tokenRequest = undefined; });
    return tokenRequest;
  }

  return {
    async call(operation, { customer, transaction, query, body } = {}) {
      if (!Object.hasOwn(operations, operation)) throw new TypeError("Unknown Tala API operation.");
      const [method, template] = operations[operation];
      let path = template.replace(/\{(customer|transaction)\}/g, (_, name) =>
        pathPart(name === "customer" ? customer : transaction));
      if (query) path += "?" + new URLSearchParams(query);
      const accessToken = await getToken();
      const headers = { authorization: "Bearer " + accessToken, accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      try {
        const result = await send(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!Object.hasOwn(result, "data") || !result.metadata) throw new CaaSError(502);
        return result;
      } catch (error) {
        if (error.status === 401 && token === accessToken) expiresAt = 0;
        throw error;
      }
    },
  };
}
