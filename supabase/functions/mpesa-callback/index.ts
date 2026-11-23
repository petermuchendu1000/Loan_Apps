const encoder = new TextEncoder();
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const signaturePattern = /^[a-f0-9]{64}$/;
const maxBody = 4096;

async function readBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(maxBody);
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return size ? bytes.slice(0, size) : null;
    if (size + value.length > maxBody) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, size);
    size += value.length;
  }
}

Deno.serve(async (request: Request) => {
  const environment = Deno.env.get("TALA_REPAYMENT_ENV") ?? "";
  const secret = Deno.env.get("MPESA_CALLBACK_KEY") ?? "";
  const serviceToken = Deno.env.get("TALA_SITE_SERVICE_TOKEN");
  const upstreamValue = Deno.env.get("TALA_SITE_CALLBACK_URL");
  const url = new URL(request.url);
  const payment = url.searchParams.get("payment") ?? "";
  const proof = url.searchParams.get("proof") ?? "";
  if (request.method !== "POST" || !uuid.test(payment) || !signaturePattern.test(proof)) return new Response(null, { status: 404 });
  if (!["sandbox", "live"].includes(environment) || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !serviceToken || !upstreamValue) {
    return new Response(null, { status: 503 });
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(proof.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, bytes, encoder.encode("mpesa-callback-v1:" + environment + ":" + payment))) {
    return new Response(null, { status: 404 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  const body = await readBody(request);
  if (!body) return new Response(null, { status: 400 });
  try {
    const upstream = new URL(upstreamValue);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.hash ||
      upstream.search || upstream.pathname !== "/api/repayments/mpesa-callback") return new Response(null, { status: 503 });
    upstream.searchParams.set("payment", payment);
    upstream.searchParams.set("proof", proof);
    const response = await fetch(upstream, {
      method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(12_000),
      headers: { "content-type": "application/json", "OAI-Sites-Authorization": "Bearer " + serviceToken },
    });
    if (!response.ok) return new Response(null, { status: response.status < 500 && response.status >= 400 ? response.status : 502 });
    return Response.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch {
    return new Response(null, { status: 502 });
  }
});
