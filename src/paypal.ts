import crypto from "node:crypto";

const ID = process.env.PAYPAL_CLIENT_ID ?? "";
const SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
export const MOCK = !ID || !SECRET;

let token: { v: string; exp: number } | null = null;
async function auth() {
  if (token && token.exp > Date.now()) return token.v;
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`PayPal auth failed: ${r.status} ${await r.text()}`);
  const j: any = await r.json();
  token = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.v;
}

async function api(method: string, p: string, body?: unknown, requestId?: string) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      Authorization: `Bearer ${await auth()}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PayPal ${method} ${p} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const mid = (p: string) => `${p}-MOCK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/** 1. Create an order with intent AUTHORIZE: PayPal *holds* the payer's funds, nothing moves yet. */
export async function createHold(contractId: string, amount: string, currency: string, desc: string, baseUrl: string) {
  if (MOCK) { const orderId = mid("ORDER"); return { orderId, approveUrl: `${baseUrl}/mock/approve/${contractId}` }; }
  const o = await api("POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ custom_id: contractId, description: desc.slice(0, 120), amount: { currency_code: currency, value: amount } }],
    payment_source: { paypal: { experience_context: {
      brand_name: "Pay-When", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
      return_url: `${baseUrl}/paypal/return?c=${contractId}`, cancel_url: `${baseUrl}/?cancelled=${contractId}`,
    } } },
  }, `create-${contractId}`);
  const link = o.links.find((l: any) => l.rel === "payer-action" || l.rel === "approve");
  return { orderId: o.id as string, approveUrl: link.href as string };
}

/** 2. After payer approval, authorize the order -> funds are now held (up to 29 days). */
export async function authorize(orderId: string) {
  if (MOCK) return { authId: mid("AUTH") };
  const r = await api("POST", `/v2/checkout/orders/${orderId}/authorize`, undefined, `auth-${orderId}`);
  return { authId: r.purchase_units[0].payments.authorizations[0].id as string };
}

/** 3a. Condition met: capture the held funds, then pay out to the payee. */
export async function captureAndPay(authId: string, amount: string, currency: string, payeeEmail: string, contractId: string, note: string) {
  if (MOCK) return { captureId: mid("CAP"), payoutBatchId: mid("PAYOUT") };
  const cap = await api("POST", `/v2/payments/authorizations/${authId}/capture`, { final_capture: true, amount: { currency_code: currency, value: amount } }, `cap-${contractId}`);
  const payout = await api("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: `pw-${contractId}`, email_subject: "You got paid via Pay-When", email_message: note },
    items: [{ recipient_type: "EMAIL", receiver: payeeEmail, amount: { value: amount, currency }, note, sender_item_id: contractId }],
  });
  return { captureId: cap.id as string, payoutBatchId: payout.batch_header.payout_batch_id as string };
}

/** 3b. Deadline passed / cancelled: void the authorization, payer's money is released back. */
export async function voidHold(authId: string) {
  if (MOCK) return;
  await api("POST", `/v2/payments/authorizations/${authId}/void`, undefined, `void-${authId}`);
}
