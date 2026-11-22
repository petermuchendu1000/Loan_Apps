import { createCaaSClient } from "../server/caas.mjs";

const { TALA_CAAS_BASE_URL, TALA_CAAS_CLIENT_ID, TALA_CAAS_CLIENT_SECRET } = process.env;
if (!(TALA_CAAS_BASE_URL && TALA_CAAS_CLIENT_ID && TALA_CAAS_CLIENT_SECRET)) {
  console.error("Configure the three Tala CaaS sandbox environment variables first.");
  process.exitCode = 1;
} else {
  try {
    const api = createCaaSClient({
      baseUrl: TALA_CAAS_BASE_URL, clientId: TALA_CAAS_CLIENT_ID, clientSecret: TALA_CAAS_CLIENT_SECRET,
    });
    const result = await api.call("identityFields");
    console.log("Tala sandbox returned its identity field configuration.", result.metadata.requestId ?? "");
  } catch (error) {
    console.error("Tala sandbox check failed.", { status: error.status, requestId: error.requestId });
    process.exitCode = 1;
  }
}
