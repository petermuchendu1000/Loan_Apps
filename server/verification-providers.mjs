const DIDIT_URL = "https://verification.didit.me/v3";
const OTP_URLS = {
  sandbox: "https://api.sandbox.africastalking.com/version1/messaging",
  live: "https://api.africastalking.com/version1/messaging",
};
const statusMap = new Map([
  ["not started", "not-started"], ["in progress", "in-progress"], ["approved", "approved"],
  ["declined", "declined"], ["in review", "in-review"], ["awaiting user", "in-review"],
  ["resubmitted", "resubmitted"], ["expired", "expired"], ["abandoned", "abandoned"],
  ["kyc expired", "expired"],
]);

export const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export class VerificationProviderError extends Error {
  constructor(provider, status) {
    super("The verification provider could not complete the request.");
    this.provider = provider;
    this.status = status;
  }
}

function statusFor(value) {
  return typeof value === "string" ? statusMap.get(value.trim().toLowerCase()) : undefined;
}

function diditLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://verify.didit.me" && !url.username && !url.password && url.pathname !== "/" ? url.href : null;
  } catch {
    return null;
  }
}

async function providerJson(fetcher, provider, url, options) {
  try {
    const response = await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new VerificationProviderError(provider, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof VerificationProviderError) throw error;
    throw new VerificationProviderError(provider, 502);
  }
}

export function createVerificationProviders(settings, fetcher = fetch) {
  const diditHeaders = { "x-api-key": settings.diditKey, accept: "application/json" };
  const workflow = settings.workflow;

  async function decision({ id, reference }) {
    if (!uuidPattern.test(id)) throw new VerificationProviderError("didit", 502);
    const result = await providerJson(fetcher, "didit", DIDIT_URL + "/session/" + id + "/decision/", { headers: diditHeaders });
    const state = statusFor(result?.status);
    if (result?.session_id !== id || result?.workflow_id !== workflow || result?.vendor_data !== reference ||
        (result.session_kind && result.session_kind !== "user") ||
        (result.environment && result.environment !== settings.environment) || !state) {
      throw new VerificationProviderError("didit", 502);
    }
    const checks = Array.isArray(result.id_verifications) ? result.id_verifications : [];
    return { result, state, approvedChecks: checks.filter((check) => statusFor(check?.status) === "approved") };
  }

  async function approvedNationalIds(identity) {
    const { result, state, approvedChecks } = await decision(identity);
    if (result.environment !== settings.environment || state !== "approved") return [];
    return approvedChecks.filter((check) => settings.environment === "sandbox" ||
      (["KE", "KEN"].includes(check.issuing_state) &&
        ["ID", "ID CARD", "IDENTITY CARD"].includes(String(check.document_type).trim().toUpperCase().replaceAll("_", " "))));
  }

  return {
    async sms(phone, code) {
      const form = new URLSearchParams({
        username: settings.smsUser,
        to: phone,
        message: "Your Tala verification code is " + code + ". It expires in 5 minutes. Do not share it.",
      });
      if (settings.smsSender) form.set("from", settings.smsSender);
      const result = await providerJson(fetcher, "africas-talking", OTP_URLS[settings.environment], {
        method: "POST",
        headers: { apikey: settings.smsKey, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: form,
      });
      const matching = result?.SMSMessageData?.Recipients?.find?.((entry) => entry.number === phone);
      if (![100, 101, 102].includes(Number(matching?.statusCode))) {
        throw new VerificationProviderError("africas-talking", Number(matching?.statusCode) || 502);
      }
    },

    async startIdentity(reference, callback, requestId) {
      const result = await providerJson(fetcher, "didit", DIDIT_URL + "/session/", {
        method: "POST",
        headers: { ...diditHeaders, "content-type": "application/json", "idempotency-key": requestId },
        body: JSON.stringify({
          workflow_id: workflow,
          vendor_data: reference,
          callback,
          callback_method: "initiator",
          language: "en",
          expected_details: { id_country: "KEN", expected_document_types: ["ID"] },
          ...(settings.environment === "sandbox" ? { sandbox_scenario: "approve" } : {}),
        }),
      });
      const url = diditLink(result?.url);
      if (!uuidPattern.test(result?.session_id) || !url || (result.workflow_id && result.workflow_id !== workflow) ||
          (result.environment && result.environment !== settings.environment)) {
        throw new VerificationProviderError("didit", 502);
      }
      return { id: result.session_id, url };
    },

    async checkIdentity(identity) {
      const { result, state, approvedChecks } = await decision(identity);
      if (state === "approved" && !approvedChecks.length) {
        return { status: "in-review", url: null };
      }
      return { status: state, url: diditLink(result.session_url) };
    },

    async hasApprovedKenyanId(identity) {
      return (await approvedNationalIds(identity)).length > 0;
    },

    async matchesApprovedNationalId(identity, number) {
      return (await approvedNationalIds(identity)).some((check) => {
        const recorded = check.personal_number || check.document_number;
        return typeof recorded === "string" && recorded.replace(/[ -]/g, "").toUpperCase() === number;
      });
    },
  };
}
