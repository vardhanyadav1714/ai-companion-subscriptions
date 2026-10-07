import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { env } from "../config/env.js";
import { badRequest, serviceUnavailable, unauthorized, forbidden } from "../errors.js";
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
  fetchRazorpayPayment,
  fetchRazorpayInvoice,
  fetchRazorpayRefund,
  fetchPaidSubscriptionInvoices,
  cancelRazorpaySubscription,
  isRazorpayConfigured,
  validateRazorpayPlan,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type RazorpaySubscription
} from "../providers/razorpay.js";
import {
  fetchGooglePlaySubscriptionPurchase,
  isGooglePlayConfigured,
  type GooglePlaySubscriptionPurchase
} from "../providers/google-play.js";
import { enqueuePaymentConfirmation, enqueueJob } from "./confirmation-queue.js";
import { claimGooglePlayOwnership, findGooglePlayOwner } from "./purchase-ownership.js";
import { decodePlayNotification } from "./play-notifications.js";
import { withBillingLock } from "./billing-lock.js";
import { validateAlternativeBilling } from "./alternative-billing.js";
import { QueueJobModel } from "../models/queue-job.model.js";

export type Entitlement = {
  active: boolean;
  status: SubscriptionStatus | "none";
  provider: Provider | "none";
  planId: string;
  freeMessageLimit: number;
  paidDailyMessageLimit: number;
  currentEnd: string | null;
  providerSubscriptionId: string;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
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
  const active = await SubscriptionModel.findOne({
    userId, active: true, status: { $in: ["active", "grace_period", "cancelled", "completed"] },
    currentEnd: { $gt: new Date() }
  }).sort({ currentEnd: -1 }).lean();
  const subscription = active ?? await SubscriptionModel.findOne({ userId }).sort({ updatedAt: -1 }).lean();
  if (!subscription) return emptyEntitlement();
  return serializeEntitlement(subscription as SubscriptionDocument);
}

export async function createRazorpayCheckout(input: {
  externalTransactionToken?: string;
  billingCountryCode?: string;
  billingAdministrativeArea?: string;
  userId: string;
  email?: string;
  name?: string;
}): Promise<{ checkoutUrl: string; subscription: Entitlement }> {
  return withBillingLock(`checkout:${input.userId}`, async () => {
  if (!isRazorpayConfigured()) {
    throw serviceUnavailable("Razorpay checkout is disabled");
  }
  validateAlternativeBilling(input);
  await upsertUser(input);
  await ensureDefaultPlan();

  const entitlement = await getEntitlement(input.userId);
  if (entitlement.active) return { checkoutUrl: "", subscription: entitlement };
  await validateRazorpayPlan();
  const existing = await SubscriptionModel.findOne({
    userId: input.userId,
    provider: "razorpay",
    ...(input.externalTransactionToken ? { externalTransactionToken: input.externalTransactionToken } : { externalTransactionToken: { $exists: false } }),
    status: { $in: ["created", "pending", "authenticated", "active"] }
  }).sort({ updatedAt: -1 });

  const existingPlan = (existing?.providerPayload as RazorpaySubscription | undefined)?.plan_id;
  if (existing?.checkoutUrl && !isExpired(existing.currentEnd) && existingPlan === env.RAZORPAY_SUBSCRIPTION_PLAN_ID) {
    return { checkoutUrl: existing.checkoutUrl, subscription: serializeEntitlement(existing) };
  }

  const created = await createRazorpaySubscription(input);
  const subscription = await upsertRazorpaySubscription(input.userId, created);
  if (input.externalTransactionToken) await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: {
    externalTransactionToken: input.externalTransactionToken, billingAdministrativeArea: input.billingAdministrativeArea
  } });
  return {
    checkoutUrl: created.short_url ?? "",
    subscription: serializeEntitlement(subscription)
  };
  });
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
  const payment = await fetchRazorpayPayment(input.razorpayPaymentId);
  if (payment.status !== "captured" || payment.amount !== env.PLAN_AMOUNT || payment.currency !== env.PLAN_CURRENCY) {
    throw badRequest("Payment has not been captured for the configured plan amount");
  }
  if (payment.invoice_id) {
    const invoice = await fetchRazorpayInvoice(payment.invoice_id);
    if (invoice.subscription_id !== remote.id || invoice.payment_id !== payment.id) throw unauthorized("Payment does not belong to this subscription");
  }
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
        amount: payment.amount,
        currency: payment.currency,
        status: "completed",
        providerPayload: payment
      }
    },
    { upsert: true }
  );
  if (subscription.externalTransactionToken) await enqueueJob("external_transaction", `external-${payment.id}`, {
    subscriptionId: subscription._id.toString(), payment
  });
  await enqueueSubscriptionConfirmation(`razorpay:payment:${input.razorpayPaymentId}`, "payment.captured", subscription);
  return serializeEntitlement(subscription);
}

export async function cancelSubscription(userId: string): Promise<Entitlement> {
  return withBillingLock(`checkout:${userId}`, async () => {
    const entitlement = await getEntitlement(userId);
    if (entitlement.provider === "google_play") throw badRequest("Manage this subscription in Google Play");
    const subscription = await SubscriptionModel.findOne({ userId, provider: "razorpay", providerSubscriptionId: entitlement.providerSubscriptionId });
    if (!subscription?.providerSubscriptionId) throw badRequest("No Razorpay subscription is available to cancel");
    if (subscription.cancelAtPeriodEnd || subscription.status === "cancelled") return entitlement;
    const remote = await cancelRazorpaySubscription(subscription.providerSubscriptionId);
    await upsertRazorpaySubscription(userId, remote);
    await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: { cancelAtPeriodEnd: true, autoRenew: false } });
    const updated = await SubscriptionModel.findById(subscription._id);
    if (updated) await enqueueSubscriptionConfirmation(`cancel:${subscription._id}`, "subscription.cancelled", updated);
    return getEntitlement(userId);
  });
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
  return getEntitlement(input.userId);
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
    const updated = await upsertGooglePlaySubscription(subscription.userId, subscription.purchaseToken, remote);
    await enqueueSubscriptionConfirmation(`sync:${updated._id}`, "subscription.synced", updated);
    return getEntitlement(input.userId);
  }

  if (subscription.provider === "razorpay" && subscription.providerSubscriptionId) {
    const remote = await fetchRazorpaySubscription(subscription.providerSubscriptionId);
    const updated = await upsertRazorpaySubscription(subscription.userId, remote);
    if (updated.externalTransactionToken) {
      const invoices = await fetchPaidSubscriptionInvoices(subscription.providerSubscriptionId);
      for (const invoice of invoices) {
        const key = `external-${invoice.payment_id}`;
        if (await QueueJobModel.exists({ jobType: "external_transaction", idempotencyKey: key })) continue;
        const payment = await fetchRazorpayPayment(invoice.payment_id);
        if (payment.status === "captured" && payment.amount === env.PLAN_AMOUNT && payment.currency === env.PLAN_CURRENCY) {
          await enqueueJob("external_transaction", key, { subscriptionId: updated._id.toString(), payment });
        }
      }
    }
    await enqueueSubscriptionConfirmation(`sync:${updated._id}`, "subscription.synced", updated);
    return getEntitlement(input.userId);
  }

  return serializeEntitlement(subscription);
}

export async function enqueueDueSubscriptionSyncs(): Promise<number> {
  const providers: Provider[] = [];
  if (isGooglePlayConfigured()) providers.push("google_play");
  if (isRazorpayConfigured()) providers.push("razorpay");
  if (!providers.length) return 0;
  const interval = env.RECONCILIATION_INTERVAL_SECONDS * 1000;
  const stale = new Date(Date.now() - interval);
  const subscriptions = await SubscriptionModel.find({
    provider: { $in: providers },
    status: { $in: ["created", "pending", "authenticated", "active", "grace_period", "on_hold", "paused", "halted", "cancelled", "completed"] },
    $and: [
      { $or: [{ lastSyncedAt: { $lte: stale } }, { lastSyncedAt: { $exists: false } }] },
      { $or: [{ lastSyncQueuedAt: { $lte: stale } }, { lastSyncQueuedAt: { $exists: false } }] },
      { $or: [{ status: { $nin: ["cancelled", "completed"] } }, { active: true }, { currentEnd: { $gt: new Date() } }] }
    ]
  }).sort({ lastSyncedAt: 1 }).limit(env.QUEUE_BATCH_SIZE);
  const bucket = Math.floor(Date.now() / interval);
  for (const subscription of subscriptions) {
    await enqueueJob("subscription_sync", `sync-${subscription._id}-${bucket}`, {
      userId: subscription.userId, provider: subscription.provider,
      ...(subscription.providerSubscriptionId ? { providerSubscriptionId: subscription.providerSubscriptionId } : {}),
      ...(subscription.purchaseToken ? { purchaseToken: subscription.purchaseToken } : {})
    });
    await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: { lastSyncQueuedAt: new Date() } });
  }
  return subscriptions.length;
}

export async function processRazorpayWebhook(input: {
  rawBody: Buffer;
  signature: string;
  eventId?: string;
  payload: Record<string, unknown>;
}, queued = false): Promise<{ status: string; reason?: string }> {
  if (!queued && !verifyRazorpayWebhookSignature(input.rawBody, input.signature)) {
    throw unauthorized("Invalid Razorpay webhook signature");
  }

  const eventType = String(input.payload.event ?? "unknown");
  const eventId = input.eventId || stableEventId("razorpay", eventType, input.payload);
  if (!queued) {
    await enqueueJob("razorpay_webhook", eventId, input.payload);
    return { status: "queued" };
  }
  const marker = await WebhookEventModel.findOneAndUpdate(
    { eventId },
    { $setOnInsert: { eventId, provider: "razorpay", eventType, status: "failed", payload: input.payload } },
    { upsert: true, new: true }
  );
  if (marker.status === "processed") {
    return { status: "already_processed" };
  }

  if (eventType === "refund.processed") {
    await processRazorpayRefund(input.payload, eventId);
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "processed" } });
    return { status: "processed" };
  }

  const subscriptionEntity = getPayloadEntity(input.payload, "subscription") as RazorpaySubscription | null;
  let paymentEntity = getPayloadEntity(input.payload, "payment") as Record<string, unknown> | null;
  let subscriptionId = String(subscriptionEntity?.id ?? paymentEntity?.subscription_id ?? "");
  if (!subscriptionId && paymentEntity?.invoice_id) {
    subscriptionId = String((await fetchRazorpayInvoice(String(paymentEntity.invoice_id))).subscription_id ?? "");
  }
  if (!subscriptionId) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "missing_subscription" } });
    return { status: "skipped", reason: "missing_subscription" };
  }
  const remote = await fetchRazorpaySubscription(subscriptionId);
  const notes = normalizeNotes(remote.notes);
  const stored = await SubscriptionModel.findOne({ provider: "razorpay", providerSubscriptionId: subscriptionId });
  const userId = stored?.userId || String(notes.userId ?? "");

  if (!subscriptionId || !userId) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "missing_user_or_subscription" } });
    return { status: "skipped", reason: "missing_user_or_subscription" };
  }

  const subscription = await upsertRazorpaySubscription(userId, remote);

  if (paymentEntity?.id) {
    paymentEntity = await fetchRazorpayPayment(String(paymentEntity.id));
    await PaymentModel.updateOne(
      { provider: "razorpay", providerPaymentId: String(paymentEntity.id) },
      {
        $set: {
          userId,
          subscriptionId: subscription._id,
          provider: "razorpay",
          providerPaymentId: String(paymentEntity.id),
          providerOrderId: String(paymentEntity.order_id ?? ""),
          amount: Number(paymentEntity.amount ?? env.PLAN_AMOUNT),
          currency: String(paymentEntity.currency ?? env.PLAN_CURRENCY),
          status: paymentEntity.status === "refunded" ? "refunded" : paymentEntity.status === "captured" ? "completed" : paymentEntity.status === "failed" ? "failed" : "pending",
          providerPayload: paymentEntity
        }
      },
      { upsert: true }
    );
  }

  if (eventType.includes("failed") && paymentEntity?.status === "failed" && paymentEntity.id) {
    // Failed payment: nudge the user to retry (best-effort, idempotent per payment).
    await enqueuePaymentConfirmation({
      eventId: `failed-${String(paymentEntity.id)}`,
      userId,
      provider: "razorpay",
      eventType,
      planId: env.PLAN_ID,
      active: false,
      status: "failed",
      amount: Number(paymentEntity.amount ?? env.PLAN_AMOUNT),
      currency: String(paymentEntity.currency ?? env.PLAN_CURRENCY),
      providerSubscriptionId: subscriptionId,
      currentEnd: null,
      notification: {
        title: "Payment didn't go through",
        body: "Your last payment didn't complete, so Premium couldn't start. You can retry anytime from the app."
      }
    });
  }

  if (subscription.externalTransactionToken && paymentEntity?.status === "captured" && paymentEntity.amount === env.PLAN_AMOUNT && paymentEntity.id) {
    await enqueueJob("external_transaction", `external-${paymentEntity.id}`, {
      subscriptionId: subscription._id.toString(), payment: paymentEntity
    });
  }
  await enqueueSubscriptionConfirmation(eventId, eventType, subscription);

  if (subscription.status === "halted") {
    // Halted (payment pending): nudge the user to fix the payment method.
    await enqueuePaymentConfirmation({
      eventId: `halted-${subscription._id.toString()}:${subscription.currentEnd?.toISOString() ?? ""}`,
      userId,
      provider: "razorpay",
      eventType,
      planId: subscription.planId,
      active: false,
      status: "halted",
      amount: env.PLAN_AMOUNT,
      currency: env.PLAN_CURRENCY,
      providerSubscriptionId: subscription.providerSubscriptionId ?? "",
      currentEnd: subscription.currentEnd?.toISOString() ?? null,
      notification: {
        title: "Action needed for Eva Premium",
        body: "Your subscription payment is pending. Please complete it to keep Premium active."
      }
    });
  }
  await WebhookEventModel.updateOne({ eventId }, { $set: { status: "processed" } });

  return { status: "processed" };
}

async function processRazorpayRefund(payload: Record<string, unknown>, eventId: string): Promise<void> {
  const entity = getPayloadEntity(payload, "refund") as { id?: string } | null;
  if (!entity?.id) throw badRequest("Refund notification is missing its refund id");
  const refund = await fetchRazorpayRefund(entity.id);
  if (refund.status !== "processed") throw serviceUnavailable("Refund is not processed yet");
  const payment = await fetchRazorpayPayment(refund.payment_id);
  const receipt = await PaymentModel.findOne({ provider: "razorpay", providerPaymentId: payment.id });
  if (!receipt?.subscriptionId) throw serviceUnavailable("Refund payment has not been linked to a subscription yet");
  const stored = await SubscriptionModel.findById(receipt.subscriptionId);
  if (!stored?.providerSubscriptionId) throw serviceUnavailable("Refund subscription could not be found");
  const remote = await fetchRazorpaySubscription(stored.providerSubscriptionId);
  const currentStart = dateFromUnix(remote.current_start);
  const currentEnd = dateFromUnix(remote.current_end);
  if (payment.amount === env.PLAN_AMOUNT && payment.amount_refunded === payment.amount && currentStart && currentEnd && payment.created_at * 1000 >= currentStart.getTime() && payment.created_at * 1000 < currentEnd.getTime()) {
    await SubscriptionModel.updateOne({ _id: stored._id }, { $max: { refundedThrough: currentEnd } });
  }
  const subscription = await upsertRazorpaySubscription(stored.userId, remote);
  await PaymentModel.updateOne({ _id: receipt._id }, { $set: {
    status: payment.amount_refunded === payment.amount ? "refunded" : "completed", providerPayload: payment
  } });
  if (stored.externalTransactionToken && payment.amount === env.PLAN_AMOUNT) {
    await enqueueJob("external_transaction", `external-${payment.id}`, { subscriptionId: stored._id.toString(), payment });
    await enqueueJob("external_refund", `refund-${refund.id}`, { subscriptionId: stored._id.toString(), payment, refund });
  }
  await enqueueSubscriptionConfirmation(eventId, "refund.processed", subscription);
  await enqueuePaymentConfirmation({
    eventId: `refund-${refund.id}`, userId: stored.userId, provider: "razorpay", eventType: "refund.processed",
    planId: stored.planId, active: subscription.active, status: subscription.status,
    amount: refund.amount, currency: payment.currency, providerSubscriptionId: stored.providerSubscriptionId,
    currentEnd: subscription.currentEnd?.toISOString() ?? null,
    notification: { title: "Eva payment refunded", body: "Your payment provider processed a refund. Check your membership status in the app." }
  });
}

export async function processGooglePlayRtdn(input: {
  token?: string;
  payload: Record<string, unknown>;
}, queued = false, authenticated = false): Promise<{ status: string; reason?: string }> {
  if (!queued && !authenticated && (!env.GOOGLE_PLAY_RTDN_TOKEN || input.token !== env.GOOGLE_PLAY_RTDN_TOKEN)) {
    throw unauthorized("Invalid Google Play RTDN token");
  }

  const { notification: decoded, purchaseToken, eventType, eventId } = decodePlayNotification(input.payload);
  if (!queued) {
    await enqueueJob("google_play_rtdn", eventId, input.payload);
    return { status: "queued" };
  }

  const marker = await WebhookEventModel.findOneAndUpdate(
    { eventId },
    { $setOnInsert: { eventId, provider: "google_play", eventType, status: "failed", payload: decoded } },
    { upsert: true, new: true }
  );
  if (marker.status === "processed") {
    return { status: "already_processed" };
  }

  if (!purchaseToken) {
    await WebhookEventModel.updateOne({ eventId }, { $set: { status: "skipped", reason: "missing_purchase_token" } });
    return { status: "skipped", reason: "missing_purchase_token" };
  }

  const remote = await fetchGooglePlaySubscriptionPurchase(purchaseToken);
  const existing = await SubscriptionModel.findOne({ provider: "google_play", purchaseToken });
  const linked = !existing && remote.linkedPurchaseToken
    ? await SubscriptionModel.findOne({ provider: "google_play", purchaseToken: remote.linkedPurchaseToken }) : null;
  const ownerId = existing?.userId ?? linked?.userId ?? await findGooglePlayOwner(purchaseToken);
  if (!ownerId) {
    throw serviceUnavailable("Purchase is not linked to a user yet");
  }

  const subscription = await upsertGooglePlaySubscription(ownerId, purchaseToken, remote);
  if (decoded.voidedPurchaseNotification) {
    await PaymentModel.updateOne({ provider: "google_play", providerPaymentId: decoded.voidedPurchaseNotification.orderId }, {
      $set: { status: "refunded" }
    });
  }
  await enqueueSubscriptionConfirmation(eventId, eventType, subscription);
  await WebhookEventModel.updateOne({ eventId }, { $set: { status: "processed" } });
  return { status: "processed" };
}

async function enqueueSubscriptionConfirmation(
  eventId: string,
  eventType: string,
  subscription: SubscriptionDocument
): Promise<void> {
  const receipt = subscription.provider === "razorpay" && /captured|charged/.test(eventType);
  await enqueuePaymentConfirmation({
    eventId: createHash("sha256").update(`${receipt ? "receipt" : "state"}:${subscription._id}:${subscription.status}:${subscription.active}:${Boolean(subscription.cancelAtPeriodEnd)}:${subscription.currentEnd?.toISOString() ?? ""}:${subscription.latestOrderId ?? ""}`).digest("hex"),
    userId: subscription.userId,
    provider: subscription.provider,
    eventType,
    planId: subscription.planId,
    active: subscription.active && isEntitlementActive(subscription.status, subscription.currentEnd),
    status: subscription.status,
    amount: receipt ? env.PLAN_AMOUNT : 0,
    currency: env.PLAN_CURRENCY,
    providerSubscriptionId: subscription.providerSubscriptionId ?? "",
    currentEnd: subscription.currentEnd?.toISOString() ?? null,
    ...(subscription.status !== "active" || subscription.cancelAtPeriodEnd ? { notification: lifecycleNotification(subscription) } : {})
  });
}

function lifecycleNotification(subscription: SubscriptionDocument) {
  if (subscription.cancelAtPeriodEnd) return { title: "Eva Premium renewal cancelled", body: "Your current paid period remains available until its end date. Future renewals are cancelled." };
  const messages: Partial<Record<SubscriptionStatus, { title: string; body: string }>> = {
    cancelled: { title: "Eva Premium renewal cancelled", body: subscription.active
      ? "Your current Premium period remains available until its end date. Future renewals are cancelled."
      : "Your subscription is cancelled. You can check your membership in the app." },
    grace_period: { title: "Update your payment method", body: "Premium continues during your payment grace period. Update your payment method with your provider." },
    on_hold: { title: "Eva Premium is on hold", body: "Your renewal payment needs attention. Update your payment method with Google Play." },
    halted: { title: "Eva Premium payment needs attention", body: "Your subscription payment is pending. Check your payment method with Razorpay." },
    paused: { title: "Eva Premium paused", body: "Your subscription is paused. Manage it with your payment provider." },
    expired: { title: "Eva Premium period ended", body: "Your Premium period has ended. Check your membership in the app." },
    revoked: { title: "Eva Premium access updated", body: "Your payment provider revoked this purchase. Check your membership in the app." }
  };
  return messages[subscription.status] ?? { title: "Eva membership updated", body: "Your payment provider updated your subscription. Check its status in the app." };
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
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return "expired";
    default:
      return "unknown";
  }
}

export function isEntitlementActive(status: SubscriptionStatus, currentEnd?: Date | null): boolean {
  if (!(status === "active" || status === "grace_period" || ((status === "cancelled" || status === "completed") && currentEnd))) return false;
  return Boolean(currentEnd && !isExpired(currentEnd));
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
  const lineItem = remote.lineItems?.find(item => item.productId === env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID && item.offerDetails?.basePlanId === env.GOOGLE_PLAY_BASE_PLAN_ID);
  if (!lineItem) throw badRequest("Purchase does not match the configured product and base plan");
  await claimGooglePlayOwnership(userId, purchaseToken, remote);
  const status = mapGooglePlayStatus(remote.subscriptionState);
  const currentEnd = parseDate(lineItem.expiryTime);
  const update = {
    userId,
    provider: "google_play" as const,
    providerSubscriptionId: purchaseToken,
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
    { provider: "google_play", purchaseToken, userId },
    { $set: update },
    { upsert: true, new: true }
  );
  if (!subscription) throw serviceUnavailable("Could not persist Google Play subscription");
  if (subscription.active && remote.linkedPurchaseToken && remote.linkedPurchaseToken !== purchaseToken) {
    await SubscriptionModel.updateOne({ provider: "google_play", purchaseToken: remote.linkedPurchaseToken, userId }, {
      $set: { active: false, status: "expired", lastSyncedAt: new Date() }
    });
  }
  if (subscription.active && remote.latestOrderId) {
    await PaymentModel.updateOne({ provider: "google_play", providerPaymentId: remote.latestOrderId }, {
      $setOnInsert: { userId, subscriptionId: subscription._id, provider: "google_play", providerPaymentId: remote.latestOrderId,
        providerOrderId: remote.latestOrderId, amount: 0, currency: env.PLAN_CURRENCY, status: "completed", providerPayload: { subscriptionState: remote.subscriptionState } }
    }, { upsert: true });
  }
  if (subscription.active && remote.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
    await enqueueJob("google_play_acknowledge", createHash("sha256").update(purchaseToken).digest("hex"), { purchaseToken });
  }
  return subscription;
}

async function upsertRazorpaySubscription(
  userId: string,
  remote: RazorpaySubscription
): Promise<SubscriptionDocument> {
  if (remote.plan_id !== env.RAZORPAY_SUBSCRIPTION_PLAN_ID) throw badRequest("Razorpay subscription does not match the configured plan");
  const existing = await SubscriptionModel.findOne({ provider: "razorpay", providerSubscriptionId: remote.id });
  const remoteUserId = String(remote.notes?.userId ?? "");
  if ((existing && existing.userId !== userId) || (remoteUserId && remoteUserId !== userId) || (!existing && !remoteUserId)) {
    throw forbidden("This Razorpay subscription belongs to another account");
  }
  let status = mapRazorpayStatus(remote.status);
  const currentEnd = dateFromUnix(remote.current_end) ?? ((status === "cancelled" || status === "completed") ? existing?.currentEnd : undefined);
  if (currentEnd && existing?.refundedThrough && currentEnd.getTime() <= existing.refundedThrough.getTime()) status = "revoked";
  const subscription = await SubscriptionModel.findOneAndUpdate(
    { provider: "razorpay", providerSubscriptionId: remote.id, userId },
    {
      $set: {
        userId,
        provider: "razorpay",
        providerSubscriptionId: remote.id,
        productId: env.RAZORPAY_SUBSCRIPTION_PLAN_ID,
        planId: env.PLAN_ID,
        status,
        active: isEntitlementActive(status, currentEnd),
        autoRenew: !existing?.cancelAtPeriodEnd && status !== "cancelled" && status !== "expired" && status !== "completed",
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
    active: subscription.active && isEntitlementActive(subscription.status, subscription.currentEnd),
    status: subscription.status,
    provider: subscription.provider,
    planId: subscription.planId,
    freeMessageLimit: env.FREE_MESSAGE_LIMIT,
    paidDailyMessageLimit: env.PAID_DAILY_MESSAGE_LIMIT,
    currentEnd: subscription.currentEnd?.toISOString() ?? null,
    providerSubscriptionId: subscription.providerSubscriptionId ?? "",
    autoRenew: subscription.autoRenew,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd)
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
    providerSubscriptionId: "",
    autoRenew: false,
    cancelAtPeriodEnd: false
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
