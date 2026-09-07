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
  return razorpayRequest<RazorpaySubscription>("GET", `/subscriptions/${subscriptionId}`);
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
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw serviceUnavailable("Razorpay request failed", { statusCode: response.status, data });
  }

  return data as T;
}
