import { Buffer } from "node:buffer";

import { GoogleAuth } from "google-auth-library";

import { env } from "../config/env.js";
import { serviceUnavailable } from "../errors.js";

const androidPublisherScope = "https://www.googleapis.com/auth/androidpublisher";

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
