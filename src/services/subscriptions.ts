import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { env } from "../config/env.js";
import { badRequest, serviceUnavailable, unauthorized } from "../errors.js";
import {
  PaymentModel,
  PlanModel,
  SubscriptionModel,
  UserModel,
  WebhookEventModel,
  type Provider,
  type SubscriptionDocument,
  type SubscriptionStatus
} from "../models.js";
import {
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  isRazorpayConfigured,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type RazorpaySubscription
} from "../providers/razorpay.js";
import {
  fetchGooglePlaySubscriptionPurchase,
  isGooglePlayConfigured,
  type GooglePlaySubscriptionPurchase
} from "../providers/google-play.js";
import { enqueuePaymentConfirmation } from "./confirmation-queue.js";

export type Entitlement = {
  active: boolean;
  status: SubscriptionStatus | "none";
  provider: Provider | "none";
  planId: string;
  freeMessageLimit: number;
  paidDailyMessageLimit: number;
  currentEnd: string | null;
  providerSubscriptionId: string;
};

export async function ensureDefaultPlan(): Promise<void> {
  await PlanModel.updateOne(
    { planId: env.PLAN_ID },
    {
      $set: {
        name: env.PLAN_NAME,
        amount: env.PLAN_AMOUNT,
        currency: env.PLAN_CURRENCY,
        interval: env.PLAN_INTERVAL,
        freeMessageLimit: env.FREE_MESSAGE_LIMIT,
        paidDailyMessageLimit: env.PAID_DAILY_MESSAGE_LIMIT,
        googlePlayProductId: env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,
        googlePlayBasePlanId: env.GOOGLE_PLAY_BASE_PLAN_ID,
        razorpayPlanId: env.RAZORPAY_SUBSCRIPTION_PLAN_ID,
        active: true
      }
    },
    { upsert: true }
  );
}

export async function listPlans(): Promise<unknown[]> {
  await ensureDefaultPlan();
  return PlanModel.find({ active: true }).sort({ amount: 1 }).lean();
}

export async function getEntitlement(userId: string): Promise<Entitlement> {
  const subscription = await SubscriptionModel.findOne({ userId }).sort({ updatedAt: -1 }).lean();
  if (!subscription) return emptyEntitlement();
  return serializeEntitlement(subscription as SubscriptionDocument);
}

export async function createRazorpayCheckout(input: {
  userId: string;
  email?: string;
  name?: string;
}): Promise<{ checkoutUrl: string; subscription: Entitlement }> {
  if (!isRazorpayConfigured()) {
    throw serviceUnavailable("Razorpay checkout is disabled");
  }
  await upsertUser(input);
  await ensureDefaultPlan();

  const existing = await SubscriptionModel.findOne({
    userId: input.userId,
    provider: "razorpay",
    status: { $in: ["created", "pending", "authenticated", "active"] }
  }).sort({ updatedAt: -1 });

  if (existing?.checkoutUrl && !isExpired(existing.currentEnd)) {
    return { checkoutUrl: existing.checkoutUrl, subscription: serializeEntitlement(existing) };
  }

  const created = await createRazorpaySubscription(input);
  const subscription = await upsertRazorpaySubscription(input.userId, created);
  return {
    checkoutUrl: created.short_url ?? "",
    subscription: serializeEntitlement(subscription)
  };
}

export async function confirmRazorpayPayment(input: {
  userId: string;
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): Promise<Entitlement> {
  if (
    !verifyRazorpayCheckoutSignature({
      paymentId: input.razorpayPaymentId,
      subscriptionId: input.razorpaySubscriptionId,
      signature: input.razorpaySignature
    })
  ) {
    throw unauthorized("Invalid Razorpay payment signature");
  }

  const remote = await fetchRazorpaySubscription(input.razorpaySubscriptionId);
  const subscription = await upsertRazorpaySubscription(input.userId, remote);
  await PaymentModel.updateOne(
    { provider: "razorpay", providerPaymentId: input.razorpayPaymentId },
    {
      $setOnInsert: {
        userId: input.userId,
        subscriptionId: subscription._id,
        provider: "razorpay",
        providerPaymentId: input.razorpayPaymentId,
        providerOrderId: remote.id,
        amount: env.PLAN_AMOUNT,
        currency: env.PLAN_CURRENCY,
        status: "completed",
        providerPayload: remote
      }
    },
    { upsert: true }
  );
  await enqueueSubscriptionConfirmation(`razorpay:payment:${input.razorpayPaymentId}`, "payment.captured", subscription);
  return serializeEntitlement(subscription);
}

export async function confirmGooglePlayPurchase(input: {
  userId: string;
  email?: string;
  name?: string;
  productId: string;
  purchaseToken: string;
}): Promise<Entitlement> {
  if (!isGooglePlayConfigured()) {
    throw serviceUnavailable("Google Play verification is not configured");
  }
  if (input.productId !== env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID) {
    throw badRequest("Google Play product id does not match the configured Eva plan");
  }

  await upsertUser(input);
  await ensureDefaultPlan();
  const remote = await fetchGooglePlaySubscriptionPurchase(input.purchaseToken);
  const subscription = await upsertGooglePlaySubscription(input.userId, input.purchaseToken, remote);
  await enqueueSubscriptionConfirmation(`google_play:purchase:${input.purchaseToken}`, "subscription.confirmed", subscription);
  return serializeEntitlement(subscription);
}

export async function syncSubscription(input: {
  userId: string;
  provider?: Provider;
  providerSubscriptionId?: string;
  purchaseToken?: string;
}): Promise<Entitlement> {
  const subscription = await SubscriptionModel.findOne({
    userId: input.userId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.providerSubscriptionId ? { providerSubscriptionId: input.providerSubscriptionId } : {}),
    ...(input.purchaseToken ? { purchaseToken: input.purchaseToken } : {})
  }).sort({ updatedAt: -1 });

  if (!subscription) return emptyEntitlement();

  if (subscription.provider === "google_play" && subscription.purchaseToken) {
    const remote = await fetchGooglePlaySubscriptionPurchase(subscription.purchaseToken);
    return serializeEntitlement(
      await upsertGooglePlaySubscription(subscription.userId, subscription.purchaseToken, remote)
    );
  }

  if (subscription.provider === "razorpay" && subscription.providerSubscriptionId) {
    const remote = await fetchRazorpaySubscription(subscription.providerSubscriptionId);
    return serializeEntitlement(await upsertRazorpaySubscription(subscription.userId, remote));
  }

  return serializeEntitlement(subscription);
}

export async function processRazorpayWebhook(input: {
  rawBody: Buffer;
  signature: string;
  eventId?: string;
  payload: Record<string, unknown>;
}): Promise<{ status: string; reason?: string }> {
  if (!verifyRazorpayWebhookSignature(input.rawBody, input.signature)) {
    throw unauthorized("Invalid Razorpay webhook signature");
  }

  const eventType = String(input.payload.event ?? "unknown");
  const eventId = input.eventId || stableEventId("razorpay", eventType, input.payload);
  const marker = await WebhookEventModel.updateOne(
    { eventId },
    { $setOnInsert: { eventId, provider: "razorpay", eventType, status: "processed", payload: input.payload } },
    { upsert: true }
  );
  if (marker.upsertedCount === 0) return { status: "skipped", reason: "duplicate_event" };

  const subscriptionEntity = getPayloadEntity(input.payload, "subscription") as RazorpaySubscription | null;
  const paymentEntity = getPayloadEntity(input.payload, "payment") as Record<string, unknown> | null;
  const subscriptionId = String(subscriptionEntity?.id ?? paymentEntity?.subscription_id ?? "");
  const notes = normalizeNotes(subscriptionEntity?.notes ?? paymentEntity?.notes);
  const userId = String(notes.userId ?? "");

  if (!subscriptionId || !userId) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "missing_user_or_subscription" } });
    return { status: "skipped", reason: "missing_user_or_subscription" };
  }

  const remote = subscriptionEntity?.id ? subscriptionEntity : await fetchRazorpaySubscription(subscriptionId);
  const subscription = await upsertRazorpaySubscription(userId, remote);

  if (paymentEntity?.id) {
    await PaymentModel.updateOne(
      { provider: "razorpay", providerPaymentId: String(paymentEntity.id) },
      {
        $setOnInsert: {
          userId,
          subscriptionId: subscription._id,
          provider: "razorpay",
          providerPaymentId: String(paymentEntity.id),
          providerOrderId: String(paymentEntity.order_id ?? ""),
          amount: Number(paymentEntity.amount ?? env.PLAN_AMOUNT),
          currency: String(paymentEntity.currency ?? env.PLAN_CURRENCY),
          status: eventType.includes("failed") ? "failed" : "completed",
          providerPayload: paymentEntity
        }
      },
      { upsert: true }
    );
  }

  await enqueueSubscriptionConfirmation(eventId, eventType, subscription);

  return { status: "processed" };
}

export async function processGooglePlayRtdn(input: {
  token?: string;
  payload: Record<string, unknown>;
}): Promise<{ status: string; reason?: string }> {
  if (!env.GOOGLE_PLAY_RTDN_TOKEN || input.token !== env.GOOGLE_PLAY_RTDN_TOKEN) {
    throw unauthorized("Invalid Google Play RTDN token");
  }

  const message = input.payload.message as { data?: string; messageId?: string } | undefined;
  const decoded = message?.data ? JSON.parse(Buffer.from(message.data, "base64").toString("utf8")) : input.payload;
  const notification = decoded.subscriptionNotification as
    | { notificationType?: number; purchaseToken?: string; subscriptionId?: string }
    | undefined;
  const purchaseToken = notification?.purchaseToken ?? "";
  const eventType = `SUBSCRIPTION_${notification?.notificationType ?? "UNKNOWN"}`;
  const eventId = message?.messageId || stableEventId("google_play", eventType, decoded);

  const marker = await WebhookEventModel.updateOne(
    { eventId },
    { $setOnInsert: { eventId, provider: "google_play", eventType, status: "processed", payload: decoded } },
    { upsert: true }
  );
  if (marker.upsertedCount === 0) return { status: "skipped", reason: "duplicate_event" };

  if (!purchaseToken) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "missing_purchase_token" } });
    return { status: "skipped", reason: "missing_purchase_token" };
  }

  const existing = await SubscriptionModel.findOne({ provider: "google_play", purchaseToken });
  if (!existing) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "unknown_purchase_token" } });
    return { status: "skipped", reason: "unknown_purchase_token" };
  }

  const remote = await fetchGooglePlaySubscriptionPurchase(purchaseToken);
  const subscription = await upsertGooglePlaySubscription(existing.userId, purchaseToken, remote);
  await enqueueSubscriptionConfirmation(eventId, eventType, subscription);
  return { status: "processed" };
}

async function enqueueSubscriptionConfirmation(
  eventId: string,
  eventType: string,
  subscription: SubscriptionDocument
): Promise<void> {
  await enqueuePaymentConfirmation({
    eventId,
    userId: subscription.userId,
    provider: subscription.provider,
    eventType,
    planId: subscription.planId,
    active: subscription.active,
    status: subscription.status,
    amount: env.PLAN_AMOUNT,
    currency: env.PLAN_CURRENCY,
    providerSubscriptionId: subscription.providerSubscriptionId ?? "",
    currentEnd: subscription.currentEnd?.toISOString() ?? null
  });
}

export function mapGooglePlayStatus(state: string | undefined): SubscriptionStatus {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "active";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return "grace_period";
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "on_hold";
    case "SUBSCRIPTION_STATE_PAUSED":
      return "paused";
    case "SUBSCRIPTION_STATE_CANCELED":
      return "cancelled";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "expired";
    case "SUBSCRIPTION_STATE_PENDING":
      return "pending";
    default:
      return "unknown";
  }
}

export function isEntitlementActive(status: SubscriptionStatus, currentEnd?: Date | null): boolean {
  if (!(status === "active" || status === "authenticated" || status === "grace_period")) return false;
  return !isExpired(currentEnd);
}

async function upsertUser(input: { userId: string; email?: string; name?: string }) {
  await UserModel.updateOne(
    { userId: input.userId },
    {
      $set: {
        email: input.email ?? "",
        name: input.name ?? "",
        source: "ai-companion"
      }
    },
    { upsert: true }
  );
}

async function upsertGooglePlaySubscription(
  userId: string,
  purchaseToken: string,
  remote: GooglePlaySubscriptionPurchase
): Promise<SubscriptionDocument> {
  const lineItem = remote.lineItems?.[0] ?? {};
  const status = mapGooglePlayStatus(remote.subscriptionState);
  const currentEnd = parseDate(lineItem.expiryTime);
  const update = {
    userId,
    provider: "google_play" as const,
    providerSubscriptionId: remote.latestOrderId ?? purchaseToken,
    purchaseToken,
    productId: lineItem.productId ?? env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,
    basePlanId: lineItem.offerDetails?.basePlanId ?? env.GOOGLE_PLAY_BASE_PLAN_ID,
    planId: env.PLAN_ID,
    status,
    active: isEntitlementActive(status, currentEnd),
    autoRenew: Boolean(lineItem.autoRenewingPlan?.autoRenewEnabled),
    latestOrderId: remote.latestOrderId ?? "",
    currentStart: parseDate(remote.startTime),
    currentEnd,
    cancelledAt: remote.canceledStateContext ? new Date() : undefined,
    lastSyncedAt: new Date(),
    providerPayload: remote
  };

  const subscription = await SubscriptionModel.findOneAndUpdate(
    { provider: "google_play", purchaseToken },
    { $set: update },
    { upsert: true, new: true }
  );
  if (!subscription) throw serviceUnavailable("Could not persist Google Play subscription");
  return subscription;
}

async function upsertRazorpaySubscription(
  userId: string,
  remote: RazorpaySubscription
): Promise<SubscriptionDocument> {
  const status = mapRazorpayStatus(remote.status);
  const currentEnd = dateFromUnix(remote.current_end);
  const subscription = await SubscriptionModel.findOneAndUpdate(
    { provider: "razorpay", providerSubscriptionId: remote.id },
    {
      $set: {
        userId,
        provider: "razorpay",
        providerSubscriptionId: remote.id,
        productId: env.RAZORPAY_SUBSCRIPTION_PLAN_ID,
        planId: env.PLAN_ID,
        status,
        active: isEntitlementActive(status, currentEnd),
        autoRenew: status !== "cancelled" && status !== "expired",
        checkoutUrl: remote.short_url ?? "",
        currentStart: dateFromUnix(remote.current_start),
        currentEnd,
        endedAt: dateFromUnix(remote.ended_at),
        lastSyncedAt: new Date(),
        providerPayload: remote
      }
    },
    { upsert: true, new: true }
  );
  if (!subscription) throw serviceUnavailable("Could not persist Razorpay subscription");
  return subscription;
}

function mapRazorpayStatus(status: unknown): SubscriptionStatus {
  const value = typeof status === "string" ? status.toLowerCase() : "unknown";
  if (
    value === "created" ||
    value === "pending" ||
    value === "authenticated" ||
    value === "active" ||
    value === "halted" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "expired"
  ) {
    return value;
  }
  return "unknown";
}

function serializeEntitlement(subscription: SubscriptionDocument): Entitlement {
  return {
    active: subscription.active,
    status: subscription.status,
    provider: subscription.provider,
    planId: subscription.planId,
    freeMessageLimit: env.FREE_MESSAGE_LIMIT,
    paidDailyMessageLimit: env.PAID_DAILY_MESSAGE_LIMIT,
    currentEnd: subscription.currentEnd?.toISOString() ?? null,
    providerSubscriptionId: subscription.providerSubscriptionId ?? ""
  };
}

function emptyEntitlement(): Entitlement {
  return {
    active: false,
    status: "none",
    provider: "none",
    planId: env.PLAN_ID,
    freeMessageLimit: env.FREE_MESSAGE_LIMIT,
    paidDailyMessageLimit: env.PAID_DAILY_MESSAGE_LIMIT,
    currentEnd: null,
    providerSubscriptionId: ""
  };
}

function isExpired(value?: Date | null): boolean {
  return Boolean(value && value.getTime() <= Date.now());
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateFromUnix(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : undefined;
}

function getPayloadEntity(payload: Record<string, unknown>, key: string): unknown {
  const raw = payload.payload as Record<string, unknown> | undefined;
  const wrapped = raw?.[key] as Record<string, unknown> | undefined;
  return wrapped?.entity ?? null;
}

function normalizeNotes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function stableEventId(provider: string, eventType: string, payload: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
  return `${provider}:${eventType}:${hash}`;
}
