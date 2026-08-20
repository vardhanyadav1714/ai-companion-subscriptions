import { Buffer } from "node:buffer";

import { env } from "../config/index.js";
import { AppError } from "../errors/app-error.js";

export type PremiumPlan = {
  planId: string;
  name: string;
  amount: number;
  formattedAmount: string;
  currency: string;
  interval: "monthly";
  totalCount: number;
};

export type RazorpaySubscription = {
  id: string;
  plan_id: string;
  status?: string | null;
  short_url?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  [key: string]: unknown;
};

export function premiumPlan(): PremiumPlan {
  return {
    planId: env.RAZORPAY_SUBSCRIPTION_PLAN_ID,
    name: env.RAZORPAY_SUBSCRIPTION_PLAN_NAME,
    amount: env.RAZORPAY_SUBSCRIPTION_AMOUNT,
    formattedAmount: formatCurrency(env.RAZORPAY_SUBSCRIPTION_AMOUNT, env.RAZORPAY_SUBSCRIPTION_CURRENCY),
    currency: env.RAZORPAY_SUBSCRIPTION_CURRENCY,
    interval: "monthly",
    totalCount: env.RAZORPAY_SUBSCRIPTION_TOTAL_COUNT
  };
}

export function isPremiumStatus(status: string): boolean {
  return status === "authenticated" || status === "active";
}

export function isReusableCheckoutStatus(status: string): boolean {
  return status === "created" || status === "pending" || status === "halted";
}

export function dateFromUnixSeconds(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value * 1000);
}

export async function createSubscription(userId: string, userEmail: string): Promise<RazorpaySubscription> {
  const plan = premiumPlan();
  return request<RazorpaySubscription>("POST", "/subscriptions", {
    plan_id: plan.planId,
    total_count: plan.totalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      app: "ai-companion",
      userId,
      userEmail
    }
  });
}

export async function fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
  return request<RazorpaySubscription>("GET", `/subscriptions/${subscriptionId}`);
}

function formatCurrency(amountInSubunits: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(amountInSubunits / 100);
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const data = text ? parseJson(text) : {};

  if (!response.ok) {
    throw AppError.serviceUnavailable("Razorpay request failed", {
      statusCode: response.status,
      response: data
    });
  }

  return data as T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

