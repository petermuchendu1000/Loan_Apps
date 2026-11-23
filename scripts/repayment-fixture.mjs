import { randomBytes, randomUUID } from "node:crypto";
import { Response } from "miniflare";

const tala = "https://tala-caas.example.test";
const safaricom = "https://sandbox.safaricom.co.ke";
const loanId = "LOCAL-LOAN-1";
const startingBalance = 4250;
const callbackBase = "https://local-relay.example.test/api/repayments/mpesa-callback";
const json = (data, status = 200) => Response.json(data, { status });
const ledger = (data, status = 200) => json({ data, metadata: { statusCode: status } }, status);
const kes = (amount) => ({ amount, isoCode: "KES" });

export function repaymentFixture() {
  const payments = new Map();
  const posts = [];
  const accounts = new Map();
  const bindings = {
    TALA_REPAYMENT_ENV: "sandbox", TALA_CAAS_BASE_URL: tala,
    TALA_CAAS_CLIENT_ID: "local-partner", TALA_CAAS_CLIENT_SECRET: "local-secret",
    MPESA_CONSUMER_KEY: "local-consumer", MPESA_CONSUMER_SECRET: "local-secret",
    MPESA_SHORTCODE: "174379", MPESA_PASSKEY: "local-passkey",
    MPESA_CALLBACK_URL: callbackBase, MPESA_CALLBACK_KEY: randomBytes(32).toString("base64url"),
  };

  function account(customer) {
    if (!accounts.has(customer)) accounts.set(customer, { balance: startingBalance, transactions: [] });
    return accounts.get(customer);
  }

  function decide(checkout, code = "0", now = Date.now()) {
    const payment = payments.get(checkout);
    if (!payment || payment.code !== null) throw new Error("Test payment is not awaiting a decision.");
    payment.code = code;
    payment.receipt = "TEST" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const transactionDate = new Date(now + 3 * 60 * 60_000).toISOString().slice(0, 19).replace(/\D/g, "");
    const body = { Body: { stkCallback: {
      MerchantRequestID: payment.merchant, CheckoutRequestID: checkout, ResultCode: Number(code),
      ...(code === "0" ? { CallbackMetadata: { Item: [
        { Name: "Amount", Value: payment.amount }, { Name: "MpesaReceiptNumber", Value: payment.receipt },
        { Name: "PhoneNumber", Value: Number(payment.phone) }, { Name: "TransactionDate", Value: Number(transactionDate) },
      ] } } : {}),
    } } };
    return { url: payment.callback, body };
  }

  async function fetch(request) {
    const url = new URL(request.url);
    if (url.origin === safaricom) {
      if (url.pathname === "/oauth/v1/generate") return json({ access_token: "local-daraja-token" });
      if (request.headers.get("authorization") !== "Bearer local-daraja-token") return json({}, 401);
      const body = await request.json();
      if (url.pathname === "/mpesa/stkpush/v1/processrequest") {
        if (body.PartyB !== bindings.MPESA_SHORTCODE || body.PhoneNumber !== body.PartyA ||
            body.TransactionType !== "CustomerPayBillOnline" || body.AccountReference !== "0" + body.PartyA.slice(3) ||
            !Number.isInteger(body.Amount) || body.Amount <= 0 || !body.CallBackURL.startsWith(callbackBase + "?")) return json({}, 400);
        const checkout = "checkout-" + randomUUID();
        const merchant = "merchant-" + randomUUID();
        payments.set(checkout, { checkout, merchant, callback: body.CallBackURL, amount: body.Amount, phone: body.PartyA, code: null });
        return json({ ResponseCode: "0", CheckoutRequestID: checkout, MerchantRequestID: merchant });
      }
      if (url.pathname === "/mpesa/stkpushquery/v1/query") {
        const payment = payments.get(body.CheckoutRequestID);
        if (!payment || payment.code === null) return json({ errorCode: "500.001.1001" }, 404);
        return json({ ResponseCode: "0", ResultCode: payment.code, CheckoutRequestID: payment.checkout, MerchantRequestID: payment.merchant });
      }
      return json({}, 404);
    }
    if (url.origin !== tala) return null;
    if (url.pathname === "/token") return json({ access_token: "local-tala-token", expires_in: 300 });
    if (request.headers.get("authorization") !== "Bearer local-tala-token") return ledger(null, 401);
    const match = /^\/api\/v[12]\/users\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match) return ledger(null, 404);
    const [, customer, operation] = match;
    const row = account(customer);
    if (operation === "loan") {
      return ledger({
        loanId, status: row.balance > 0 ? "drawn" : "closed", outstandingBalances: { totalBalance: kes(row.balance) },
        dueDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      });
    }
    if (operation === "transactions") return ledger({ transactions: row.transactions });
    if (operation === "repayment/notification") {
      const body = await request.json();
      posts.push(body);
      const payment = [...payments.values()].find((entry) => entry.receipt === body.externalTransactionId && entry.code === "0");
      if (!payment || body.transactionReceipt !== payment.receipt || body.transactionAmount?.isoCode !== "KES" ||
          body.transactionAmount?.amount !== payment.amount || body.loanId !== loanId || body.msisdn !== "+" + payment.phone ||
          body.billRefNumber !== "0" + payment.phone.slice(3) || body.repaymentType !== "CUSTOMER_INITIATED") return ledger(null, 400);
      if (!row.transactions.some((entry) => entry.transactionId === payment.receipt)) {
        row.balance -= payment.amount;
        row.transactions.unshift({
          transactionId: payment.receipt, transactionType: "REPAYMENT", amount: kes(payment.amount), transactionDate: body.transactionTime,
        });
      }
      return ledger({ transactionId: payment.receipt, loanId }, 202);
    }
    const receipt = /^repayment\/([A-Z0-9]+)\/status$/.exec(operation)?.[1];
    const posted = row.transactions.find((entry) => entry.transactionId === receipt);
    return posted ? ledger({ loanId, externalTransactionId: receipt, transactionAmount: posted.amount }) : ledger(null, 404);
  }

  return { bindings, payments, posts, decide, fetch };
}
