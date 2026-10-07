import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";
import { serviceUnavailable } from "../errors.js";

export type RazorpaySubscription = {
  id: string;
  plan_id?: string;
  status?: string | null;
  short_url?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  created_at?: number | null;
  notes?: Record<string, unknown>;
  [key: string]: unknown;
};

export function isRazorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_ENABLED && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export async function validateRazorpayPlan(): Promise<void> {
  if (!env.RAZORPAY_SUBSCRIPTION_PLAN_ID || !env.RAZORPAY_WEBHOOK_SECRET) throw serviceUnavailable("Razorpay plan and webhook must be configured before checkout");
  const remote = await razorpayRequest<{ id: string; period: string; interval: number; item?: { amount: number; currency: string; active?: boolean } }>("GET", `/plans/${encodeURIComponent(env.RAZORPAY_SUBSCRIPTION_PLAN_ID)}`);
  if (remote.id !== env.RAZORPAY_SUBSCRIPTION_PLAN_ID || remote.period !== env.PLAN_INTERVAL || remote.interval !== 1 || remote.item?.amount !== env.PLAN_AMOUNT || remote.item?.currency !== env.PLAN_CURRENCY || remote.item?.active === false) {
    throw serviceUnavailable("The payment plan does not match the advertised price. Checkout is unavailable.");
  }
}

export async function createRazorpaySubscription(input: {
  userId: string;
  email?: string;
  name?: string;
}): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>("POST", "/subscriptions", {
    plan_id: env.RAZORPAY_SUBSCRIPTION_PLAN_ID,
    total_count: env.RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
    quantity: 1,
    customer_notify: true,
    notes: {
      app: "eva-ai-companion",
      userId: input.userId,
      email: input.email ?? "",
      name: input.name ?? ""
    }
  });
}

export async function fetchRazorpaySubscription(subscriptionId: string): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function cancelRazorpaySubscription(id: string): Promise<RazorpaySubscription> {
  return razorpayRequest("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
}

export type RazorpayPayment = {
  id: string; amount: number; currency: string; status: string; created_at: number;
  invoice_id?: string; subscription_id?: string; amount_refunded?: number;
  [key: string]: unknown;
};

export async function fetchRazorpayPayment(id: string): Promise<RazorpayPayment> {
  return razorpayRequest("GET", `/payments/${encodeURIComponent(id)}`);
}

export async function fetchRazorpayInvoice(id: string): Promise<{ subscription_id?: string; payment_id?: string }> {
  return razorpayRequest("GET", `/invoices/${encodeURIComponent(id)}`);
}

export async function fetchRazorpayRefund(id: string): Promise<{ id: string; payment_id: string; amount: number; status: string; created_at: number }> {
  return razorpayRequest("GET", `/refunds/${encodeURIComponent(id)}`);
}

export async function fetchInitialRazorpayPayment(subscriptionId: string): Promise<RazorpayPayment> {
  const paid = await fetchPaidSubscriptionInvoices(subscriptionId);
  const first = paid[0];
  if (!first) throw serviceUnavailable("Initial paid subscription invoice is not available yet");
  return fetchRazorpayPayment(first.payment_id);
}

export async function fetchPaidSubscriptionInvoices(subscriptionId: string): Promise<Array<{ payment_id: string; created_at: number }>> {
  const paid: Array<{ payment_id: string; created_at: number }> = [];
  for (let skip = 0; skip < 1000; skip += 100) {
    const page = await razorpayRequest<{ items: Array<{ status: string; amount: number; payment_id?: string; created_at: number }> }>(
      "GET", `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100&skip=${skip}`
    );
    for (const invoice of page.items) {
      if (invoice.status === "paid" && invoice.amount === env.PLAN_AMOUNT && invoice.payment_id) {
        paid.push({ payment_id: invoice.payment_id, created_at: invoice.created_at });
      }
    }
    if (page.items.length < 100) {
      return paid.sort((left, right) => left.created_at - right.created_at);
    }
  }
  throw serviceUnavailable("Subscription invoice history needs reconciliation before external reporting");
}

export function verifyRazorpayCheckoutSignature(input: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
}): boolean {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const body = `${input.paymentId}|${input.subscriptionId}`;
  return compareHmac(body, env.RAZORPAY_KEY_SECRET, input.signature);
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  return compareHmac(rawBody, env.RAZORPAY_WEBHOOK_SECRET, signature);
}

function compareHmac(body: string | Buffer, secret: string, supplied: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied.trim());
  return left.length === right.length && timingSafeEqual(left, right);
}

async function razorpayRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  if (!isRazorpayConfigured()) {
    throw serviceUnavailable("Razorpay is not configured");
  }

  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw serviceUnavailable("Razorpay request failed", { statusCode: response.status });
  }

  return data as T;
}
