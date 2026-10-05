import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const providers = vi.hoisted(() => ({ play: vi.fn(), subscription: vi.fn(), payment: vi.fn(), refund: vi.fn(), invoice: vi.fn(), create: vi.fn(), cancel: vi.fn() }));
vi.mock("../providers/google-play.js", () => ({
  isGooglePlayConfigured: () => true, fetchGooglePlaySubscriptionPurchase: providers.play
}));
vi.mock("../providers/razorpay.js", () => ({
  isRazorpayConfigured: () => true, fetchRazorpaySubscription: providers.subscription,
  fetchRazorpayPayment: providers.payment, fetchRazorpayInvoice: providers.invoice, fetchRazorpayRefund: providers.refund,
  createRazorpaySubscription: providers.create, validateRazorpayPlan: async () => {},
  cancelRazorpaySubscription: providers.cancel,
  verifyRazorpayCheckoutSignature: () => true, verifyRazorpayWebhookSignature: () => true
}));

let mongo: MongoMemoryServer;
let service: typeof import("./subscriptions.js");
let models: typeof import("../models.js");
let queue: typeof import("../models/queue-job.model.js");
let ownership: typeof import("./purchase-ownership.js");
let jobs: typeof import("./confirmation-queue.js");

const token = "verified-purchase-token";
const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
const activePurchase = () => ({
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", latestOrderId: "GPA.test.0",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  lineItems: [{ productId: "eva_premium_monthly", offerDetails: { basePlanId: "monthly" }, expiryTime: future(), autoRenewingPlan: { autoRenewEnabled: true } }]
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  process.env.MONGODB_URI = mongo.getUri();
  process.env.SUBSCRIPTIONS_API_KEY = "test-only-internal-key";
  process.env.GOOGLE_PLAY_RTDN_TOKEN = "test-only-push-key";
  process.env.GOOGLE_PLAY_RTDN_AUDIENCE = "";
  process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "";
  process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.eva.ai";
  process.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID = "eva_premium_monthly";
  process.env.GOOGLE_PLAY_BASE_PLAN_ID = "monthly";
  process.env.PLAN_AMOUNT = "49900";
  process.env.PLAN_CURRENCY = "INR";
  process.env.REDIS_URL = "";
  process.env.RAZORPAY_SUBSCRIPTION_PLAN_ID = "plan_test";
  process.env.PAYMENT_CONFIRMATION_URL = "https://confirmation.example/internal/payment-confirmation";
  await mongoose.connect(mongo.getUri());
  service = await import("./subscriptions.js");
  models = await import("../models.js");
  queue = await import("../models/queue-job.model.js");
  ownership = await import("./purchase-ownership.js");
  jobs = await import("./confirmation-queue.js");
  await Promise.all([models.SubscriptionModel.init(), models.PaymentModel.init(), models.WebhookEventModel.init(), queue.QueueJobModel.init()]);
  await service.ensureDefaultPlan();
}, 120_000);

beforeEach(async () => {
  vi.clearAllMocks();
  for (const name of ["subscriptions", "payments", "webhookevents", "queuejobs", "purchaseowners", "billinglocks", "users"]) {
    await mongoose.connection.db!.collection(name).deleteMany({});
  }
  providers.play.mockResolvedValue(activePurchase());
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo?.stop();
});

const confirm = (userId = "account-a", purchaseToken = token) => service.confirmGooglePlayPurchase({ userId, purchaseToken, productId: "eva_premium_monthly" });
const rtdn = (data: Record<string, unknown>, id = "message-1") => ({
  token: "test-only-push-key",
  payload: { message: { messageId: id, data: Buffer.from(JSON.stringify({ packageName: "com.eva.ai", ...data })).toString("base64") } }
});

describe("billing persistence and lifecycle", () => {
  it("binds a verified purchase and rejects a different Eva account", async () => {
    await expect(confirm()).resolves.toMatchObject({ active: true });
    await expect(confirm("account-b")).rejects.toThrow("another Eva account");
    expect(await models.SubscriptionModel.countDocuments()).toBe(1);
  });

  it("rejects a purchase whose Google account identifier belongs to another user", async () => {
    providers.play.mockResolvedValue({ ...activePurchase(), externalAccountIdentifiers: { obfuscatedExternalAccountId: ownership.googlePlayAccountId("account-b") } });
    await expect(confirm()).rejects.toThrow("another Eva account");
    expect(await models.SubscriptionModel.countDocuments()).toBe(0);
  });

  it("allows only one owner under concurrent first claims", async () => {
    const results = await Promise.allSettled([confirm("account-a"), confirm("account-b")]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await models.SubscriptionModel.countDocuments()).toBe(1);
  });

  it("keeps a pending purchase inactive and does not queue acknowledgement", async () => {
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_PENDING" });
    await expect(confirm()).resolves.toMatchObject({ active: false, status: "pending" });
    expect(await queue.QueueJobModel.countDocuments({ jobType: "google_play_acknowledge" })).toBe(0);
  });

  it("does not accept the wrong base plan", async () => {
    const purchase = activePurchase();
    purchase.lineItems[0]!.offerDetails.basePlanId = "annual";
    providers.play.mockResolvedValue(purchase);
    await expect(confirm()).rejects.toThrow("product and base plan");
  });

  it("queues acknowledgement once and keeps renewal order ids separate from purchase identity", async () => {
    const first = activePurchase();
    providers.play.mockResolvedValue(first);
    await confirm();
    providers.play.mockResolvedValue({ ...first, latestOrderId: "GPA.test.1" });
    await confirm();
    expect(await models.SubscriptionModel.countDocuments()).toBe(1);
    expect(await models.PaymentModel.countDocuments()).toBe(2);
    expect(await queue.QueueJobModel.countDocuments({ jobType: "google_play_acknowledge" })).toBe(1);
  });

  it("replaces a linked purchase without allowing ownership transfer", async () => {
    await confirm();
    providers.play.mockResolvedValue({ ...activePurchase(), linkedPurchaseToken: token, latestOrderId: "GPA.new.0" });
    await expect(confirm("account-b", "replacement-token")).rejects.toThrow("another Eva account");
    await expect(confirm("account-a", "replacement-token")).resolves.toMatchObject({ active: true });
    expect((await models.SubscriptionModel.findOne({ purchaseToken: token }))?.active).toBe(false);
  });

  it("keeps the existing paid period when a linked replacement is still pending", async () => {
    await confirm();
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_PENDING", linkedPurchaseToken: token, latestOrderId: "GPA.pending.0" });
    await expect(confirm("account-a", "pending-replacement")).resolves.toMatchObject({ active: true, providerSubscriptionId: token });
    expect((await models.SubscriptionModel.findOne({ purchaseToken: token }))?.active).toBe(true);
  });

  it("persists RTDN before processing and updates expiry exactly once", async () => {
    await confirm();
    const input = rtdn({ subscriptionNotification: { notificationType: 13, purchaseToken: token } });
    expect(await service.processGooglePlayRtdn(input)).toEqual({ status: "queued" });
    expect(await queue.QueueJobModel.countDocuments({ jobType: "google_play_rtdn" })).toBe(1);
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    expect(await service.processGooglePlayRtdn(input, true)).toEqual({ status: "processed" });
    expect(await service.processGooglePlayRtdn(input, true)).toEqual({ status: "already_processed" });
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: false, status: "expired" });
    const confirmation = await queue.QueueJobModel.findOne({ jobType: "payment_confirmation", "payload.status": "expired" });
    expect(confirmation?.payload.active).toBe(false);
    expect(confirmation?.payload.notification).toBeDefined();
  });

  it("accepts Play test notifications without provider calls or permanent retry", async () => {
    const input = rtdn({ testNotification: { version: "1.0" } });
    await service.processGooglePlayRtdn(input);
    await expect(service.processGooglePlayRtdn(input, true)).resolves.toMatchObject({ status: "skipped" });
    expect(providers.play).not.toHaveBeenCalled();
  });

  it("records a voided order while reading the current subscription from Google", async () => {
    await confirm();
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    await service.processGooglePlayRtdn(rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: "GPA.test.0", productType: 1, refundType: 1 } }), true);
    expect((await models.PaymentModel.findOne({ providerPaymentId: "GPA.test.0" }))?.status).toBe("refunded");
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: false });
  });

  it("rejects a Razorpay subscription claimed by the wrong account", async () => {
    providers.subscription.mockResolvedValue({ id: "sub_test", plan_id: "plan_test", status: "active", notes: { userId: "account-a" }, current_end: Math.floor(Date.now() / 1000) + 10000 });
    providers.payment.mockResolvedValue({ id: "pay_test", status: "captured", amount: 49900, currency: "INR" });
    await expect(service.confirmRazorpayPayment({ userId: "account-b", razorpayPaymentId: "pay_test", razorpaySubscriptionId: "sub_test", razorpaySignature: "verified" }))
      .rejects.toThrow("another account");
  });

  it("does not confirm an authorized but uncaptured Razorpay payment", async () => {
    providers.subscription.mockResolvedValue({ id: "sub_test", plan_id: "plan_test", notes: { userId: "account-a" } });
    providers.payment.mockResolvedValue({ id: "pay_test", status: "authorized", amount: 49900, currency: "INR" });
    await expect(service.confirmRazorpayPayment({ userId: "account-a", razorpayPaymentId: "pay_test", razorpaySubscriptionId: "sub_test", razorpaySignature: "verified" }))
      .rejects.toThrow("not been captured");
    expect(await models.PaymentModel.countDocuments()).toBe(0);
  });

  it("retains ownership after the subscription expires and its row is removed", async () => {
    await confirm();
    await models.SubscriptionModel.deleteMany({});
    await expect(confirm("account-b")).rejects.toThrow("another Eva account");
  });

  it("allows only one queue worker to deliver a confirmation at a time", async () => {
    await jobs.enqueuePaymentConfirmation({ eventId: "unique-receipt", userId: "account-a", provider: "razorpay", eventType: "subscription.charged", planId: "premium", active: true,
      status: "active", amount: 49900, currency: "INR", providerSubscriptionId: "sub_test", currentEnd: future() });
    const job = await queue.QueueJobModel.findOne({ idempotencyKey: "unique-receipt" });
    const send = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", send);
    const claims = await Promise.all([jobs.processConfirmationJobById(job!._id.toString()), jobs.processConfirmationJobById(job!._id.toString())]);
    expect(claims.sort()).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await queue.QueueJobModel.findById(job!._id))?.status).toBe("completed");
    vi.unstubAllGlobals();
  });

  it("deduplicates concurrent submissions of the same provider event", async () => {
    const input = rtdn({ testNotification: { version: "1.0" } });
    await Promise.all([service.processGooglePlayRtdn(input), service.processGooglePlayRtdn(input)]);
    expect(await queue.QueueJobModel.countDocuments({ jobType: "google_play_rtdn" })).toBe(1);
  });

  async function razorpayReceipt() {
    const now = Math.floor(Date.now() / 1000);
    const remote = { id: "sub_test", plan_id: "plan_test", status: "active", notes: { userId: "account-a" }, current_start: now - 1000, current_end: now + 30 * 86400 };
    const payment = { id: "pay_test", amount: 49900, currency: "INR", status: "captured", created_at: now - 10, amount_refunded: 0 };
    providers.subscription.mockResolvedValue(remote);
    providers.payment.mockResolvedValue(payment);
    await service.confirmRazorpayPayment({ userId: "account-a", razorpayPaymentId: payment.id, razorpaySubscriptionId: remote.id, razorpaySignature: "verified" });
    return { remote, payment };
  }

  it("cancels only the user's own Razorpay renewal and preserves paid time", async () => {
    const { remote } = await razorpayReceipt();
    providers.cancel.mockResolvedValue({ ...remote, status: "cancelled" });
    await expect(service.cancelSubscription("account-b")).rejects.toThrow("No Razorpay subscription");
    await expect(service.cancelSubscription("account-a")).resolves.toMatchObject({ active: true, autoRenew: false, cancelAtPeriodEnd: true });
    await service.cancelSubscription("account-a");
    expect(providers.cancel).toHaveBeenCalledTimes(1);
  });

  it("revokes a fully refunded current Razorpay cycle and does not restore it during sync", async () => {
    const { remote, payment } = await razorpayReceipt();
    providers.payment.mockResolvedValue({ ...payment, amount_refunded: payment.amount, status: "refunded" });
    providers.refund.mockResolvedValue({ id: "rfnd_test", payment_id: payment.id, amount: payment.amount, status: "processed", created_at: payment.created_at + 5 });
    await service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "verified", eventId: "refund-event", payload: { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_test" } } } } }, true);
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: false, status: "revoked" });
    await expect(service.syncSubscription({ userId: "account-a" })).resolves.toMatchObject({ active: false, status: "revoked" });
    providers.subscription.mockResolvedValue({ ...remote, current_start: remote.current_end, current_end: remote.current_end + 30 * 86400 });
    await expect(service.syncSubscription({ userId: "account-a" })).resolves.toMatchObject({ active: true, status: "active" });
  });

  it("keeps access for a partial refund and queues its external reporting", async () => {
    const { payment } = await razorpayReceipt();
    await models.SubscriptionModel.updateOne({ providerSubscriptionId: "sub_test" }, { $set: { externalTransactionToken: "test-token" } });
    providers.payment.mockResolvedValue({ ...payment, amount_refunded: 10000 });
    providers.refund.mockResolvedValue({ id: "rfnd_partial", payment_id: payment.id, amount: 10000, status: "processed", created_at: payment.created_at + 5 });
    await service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "verified", eventId: "partial-refund-event", payload: { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_partial" } } } } }, true);
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: true });
    expect(await queue.QueueJobModel.countDocuments({ jobType: "external_refund" })).toBe(1);
  });

  it("preserves the last paid period after a finite Razorpay subscription completes", async () => {
    await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_completed", planId: "premium", status: "completed", active: true, autoRenew: false, currentEnd: new Date(future()) });
    await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_pending", planId: "premium", status: "pending", active: false, autoRenew: false });
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: true, status: "completed", providerSubscriptionId: "sub_completed" });
  });

  it("returns 400 for invalid public notification payloads without adding a job", async () => {
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/webhooks/google-play/rtdn?token=test-only-push-key", payload: { message: { data: "not-json", messageId: "bad-message" } } });
      expect(response.statusCode).toBe(400);
      expect(await queue.QueueJobModel.countDocuments()).toBe(0);
    } finally { await app.close(); }
  }, 15_000);

  it("requires an internal key before accepting purchase verification", async () => {
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/subscriptions/confirm/google-play", payload: { userId: "account-a", productId: "eva_premium_monthly", purchaseToken: token } })).statusCode).toBe(401);
      expect(providers.play).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 15_000);
});
