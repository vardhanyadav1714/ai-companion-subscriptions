import { Buffer } from "node:buffer";

import { GoogleAuth } from "google-auth-library";

import { env } from "../config/env.js";
import { serviceUnavailable } from "../errors.js";
import { SubscriptionModel } from "../models.js";

const androidPublisherScope = "https://www.googleapis.com/auth/androidpublisher";

export async function acknowledgeSubscription(purchaseToken: string): Promise<Record<string, unknown>> {
  const purchase = await fetchGooglePlaySubscriptionPurchase(purchaseToken);
  if (purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") return { status: "already_acknowledged" };
  if (purchase.subscriptionState !== "SUBSCRIPTION_STATE_ACTIVE") throw new Error("Purchase is not active for acknowledgement");
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/subscriptions/${encodeURIComponent(env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const response = await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${await getGoogleAccessToken()}`, "Content-Type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Purchase acknowledgement failed: ${response.status}`);
  return { status: "acknowledged" };
}

export async function reportExternalTransaction(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const subscription = await SubscriptionModel.findById(String(payload.subscriptionId));
  const payment = payload.payment as Record<string, unknown>;
  if (!subscription?.externalTransactionToken) throw new Error("Missing external transaction token");
  const id = `eva-${String(payment.id)}`;
  await SubscriptionModel.updateOne({ _id: subscription._id, initialExternalTransactionId: { $exists: false } }, {
    $set: { initialExternalTransactionId: id }
  });
  const current = await SubscriptionModel.findById(subscription._id);
  const initial = current?.initialExternalTransactionId;
  if (!initial) throw new Error("Missing initial transaction identity");
  const amount = Number(payment.amount);
  const timestamp = Number(payment.created_at);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Invalid provider payment amount or timestamp");
  const total = amount * 10000;
  const preTax = Math.round(total * 10000 / (10000 + env.GOOGLE_PLAY_TAX_RATE_BPS));
  const body = {
    originalPreTaxAmount: { priceMicros: String(preTax), currency: String(payment.currency) },
    originalTaxAmount: { priceMicros: String(total - preTax), currency: String(payment.currency) },
    transactionTime: new Date(timestamp * 1000).toISOString(),
    userTaxAddress: { regionCode: env.GOOGLE_PLAY_TAX_REGION },
    recurringTransaction: {
      externalSubscription: { subscriptionType: "RECURRING" },
      ...(initial === id ? { externalTransactionToken: subscription.externalTransactionToken } : { initialExternalTransactionId: initial })
    }
  };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/externalTransactions`;
  const headers = { Authorization: `Bearer ${await getGoogleAccessToken()}`, "Content-Type": "application/json" };
  const existing = await fetch(`${base}/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(15000) });
  if (existing.ok) return { status: "already_reported", id };
  if (existing.status !== 404) throw new Error(`External transaction lookup failed: ${existing.status}`);
  const response = await fetch(`${base}?externalTransactionId=${encodeURIComponent(id)}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`External transaction report failed: ${response.status}`);
  return { status: "reported", id };
}

export type GooglePlaySubscriptionPurchase = {
  subscriptionState?: string;
  latestOrderId?: string;
  startTime?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    offerDetails?: {
      basePlanId?: string;
      offerId?: string;
    };
    autoRenewingPlan?: {
      autoRenewEnabled?: boolean;
    };
  }>;
  canceledStateContext?: unknown;
  pausedStateContext?: unknown;
  inGracePeriodStateContext?: unknown;
  onHoldStateContext?: unknown;
  testPurchase?: unknown;
  externalAccountIdentifiers?: {
    externalAccountId?: string;
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
  [key: string]: unknown;
};

export function isGooglePlayConfigured(): boolean {
  return Boolean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.trim());
}

export async function fetchGooglePlaySubscriptionPurchase(
  purchaseToken: string
): Promise<GooglePlaySubscriptionPurchase> {
  if (!isGooglePlayConfigured()) {
    throw serviceUnavailable("Google Play service account is not configured");
  }

  const accessToken = await getGoogleAccessToken();
  const url = new URL(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      env.GOOGLE_PLAY_PACKAGE_NAME
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`
  );

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw serviceUnavailable("Google Play subscription lookup failed", {
      statusCode: response.status,
      data
    });
  }

  return data as GooglePlaySubscriptionPurchase;
}

async function getGoogleAccessToken(): Promise<string> {
  const credentials = parseServiceAccountCredentials();
  const auth = new GoogleAuth({
    credentials,
    scopes: [androidPublisherScope]
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw serviceUnavailable("Could not get Google Play access token");
  }
  return token.token;
}

function parseServiceAccountCredentials(): Record<string, unknown> {
  const raw = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.trim();
  if (!raw) {
    throw serviceUnavailable("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is required");
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
  }
}
