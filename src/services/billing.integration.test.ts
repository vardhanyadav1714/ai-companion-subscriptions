import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const providers = vi.hoisted(() => ({ play: vi.fn(), subscription: vi.fn(), payment: vi.fn(), refund: vi.fn(), invoice: vi.fn(), create: vi.fn(), cancel: vi.fn(), paidInvoices: vi.fn() }));
vi.mock("../providers/google-play.js", () => ({
  isGooglePlayConfigured: () => true, fetchGooglePlaySubscriptionPurchase: providers.play
}));
vi.mock("../providers/razorpay.js", () => ({
  isRazorpayConfigured: () => true, fetchRazorpaySubscription: providers.subscription,
  fetchRazorpayPayment: providers.payment, fetchRazorpayInvoice: providers.invoice, fetchRazorpayRefund: providers.refund,
  createRazorpaySubscription: providers.create, validateRazorpayPlan: async () => {},
  cancelRazorpaySubscription: providers.cancel,
  fetchPaidSubscriptionInvoices: providers.paidInvoices,
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
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "{}";
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
  providers.paidInvoices.mockResolvedValue([]);
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
  it("grants only the configured review identity without payment records and preserves paid entitlements", async () => {
    const { env } = await import("../config/env.js");
    const previous = env.PLAY_REVIEW_USER_ID;
    const reviewer = "000000000000000000000043";
    env.PLAY_REVIEW_USER_ID = reviewer;
    try {
      const demo = await service.getEntitlement(reviewer);
      expect(demo).toMatchObject({ active: true, status: "active", provider: "none", providerSubscriptionId: "", autoRenew: false });
      expect(await service.getEntitlement("000000000000000000000044")).toMatchObject({ active: false });
      expect(await models.PaymentModel.countDocuments()).toBe(0);
      expect(await models.SubscriptionModel.countDocuments()).toBe(0);
      expect(await queue.QueueJobModel.countDocuments()).toBe(0);
      expect(providers.play).not.toHaveBeenCalled();

      expect(await confirm(reviewer)).toMatchObject({ active: true, provider: "google_play", providerSubscriptionId: token });
      expect(await service.getEntitlement(reviewer)).toMatchObject({ active: true, provider: "google_play", providerSubscriptionId: token });

      await models.SubscriptionModel.deleteMany({ userId: reviewer });
      env.PLAY_REVIEW_USER_ID = "";
      expect(await service.getEntitlement(reviewer)).toMatchObject({ active: false });
    } finally { env.PLAY_REVIEW_USER_ID = previous; }
  });

  it.each([undefined, { autoRenewEnabled: false }])("preserves cancelled Play access and exposes stopped renewal when plan metadata is %j", async autoRenewingPlan => {
    await confirm();
    const expiryTime = future();
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
      lineItems: [{ productId: "eva_premium_monthly", offerDetails: { basePlanId: "monthly" }, expiryTime, autoRenewingPlan }] });
    expect(await confirm()).toMatchObject({ active: true, status: "cancelled", autoRenew: false, cancelAtPeriodEnd: true, currentEnd: expiryTime });
    expect(await models.SubscriptionModel.findOne({ purchaseToken: token }).lean()).toMatchObject({ cancelAtPeriodEnd: true });

    providers.play.mockResolvedValue(activePurchase());
    expect(await confirm()).toMatchObject({ active: true, status: "active", autoRenew: true, cancelAtPeriodEnd: false });

    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
      lineItems: [{ productId: "eva_premium_monthly", offerDetails: { basePlanId: "monthly" }, expiryTime: new Date(Date.now() - 1000).toISOString() }] });
    expect(await confirm()).toMatchObject({ active: false, status: "expired", autoRenew: false, cancelAtPeriodEnd: false });
  });

  it("refreshes a lapsed cached paid period before returning a free entitlement", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { currentEnd: new Date(Date.now() - 1000) } });
    providers.play.mockClear();
    const expected = future();
    providers.play.mockResolvedValue({ ...activePurchase(), lineItems: [{ productId: "eva_premium_monthly", offerDetails: { basePlanId: "monthly" }, expiryTime: expected, autoRenewingPlan: { autoRenewEnabled: true } }] });
    expect(await service.getEntitlement("account-a")).toMatchObject({ active: true, currentEnd: expected });
    expect(providers.play).toHaveBeenCalledTimes(1);
  });

  it("queues a near-expiry subscription without waiting fifteen minutes", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: {
      currentEnd: new Date(Date.now() + 20_000), lastSyncedAt: new Date(Date.now() - 45_000)
    } });
    expect(await service.enqueueDueSubscriptionSyncs()).toBe(1);
    expect(await service.enqueueDueSubscriptionSyncs()).toBe(0);
    expect(await queue.QueueJobModel.countDocuments({ jobType: "subscription_sync" })).toBe(1);
  });

  it("does not consume the renewal safeguard for another account or a revoked purchase", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { status: "revoked", active: false, currentEnd: new Date(Date.now() - 1000) } });
    providers.play.mockClear();
    expect(await service.getEntitlement("account-a")).toMatchObject({ active: false, status: "revoked" });
    expect(await service.getEntitlement("account-b")).toMatchObject({ active: false, provider: "none" });
    expect(providers.play).not.toHaveBeenCalled();
  });

  it("does not poll a long-expired cached period every thirty seconds", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: {
      currentEnd: new Date(Date.now() - 10 * 60_000), lastSyncedAt: new Date(Date.now() - 45_000)
    } });
    expect(await service.enqueueDueSubscriptionSyncs()).toBe(0);
  });

  it("revalidates Razorpay renewals at the paid-period boundary", async () => {
    await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_boundary",
      productId: "plan_test", planId: "premium", status: "active", active: true, currentEnd: new Date(Date.now() - 1000) });
    providers.subscription.mockResolvedValue({ id: "sub_boundary", plan_id: "plan_test", status: "active",
      current_end: Math.floor(Date.now() / 1000) + 86400, notes: { userId: "account-a" } });
    expect(await service.getEntitlement("account-a")).toMatchObject({ active: true, provider: "razorpay" });
    expect(providers.subscription).toHaveBeenCalledWith("sub_boundary");
  });

  it("fails temporarily rather than downgrading a paid account during a provider outage", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { currentEnd: new Date(Date.now() - 1000) } });
    providers.play.mockClear().mockRejectedValue(new Error("provider unavailable"));
    await expect(service.getEntitlement("account-a")).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.getEntitlement("account-a")).rejects.toMatchObject({ statusCode: 503 });
    expect(providers.play).toHaveBeenCalledTimes(1);
  });

  it("keeps an unexpired verified paid period usable if its boundary check fails", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { currentEnd: new Date(Date.now() + 45_000) } });
    providers.play.mockRejectedValue(new Error("provider unavailable"));
    expect(await service.getEntitlement("account-a")).toMatchObject({ active: true });
  });

  it("shares concurrent boundary checks and accepts an authoritative expiry", async () => {
    await confirm();
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { currentEnd: new Date(Date.now() - 1000) } });
    providers.play.mockClear().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: "eva_premium_monthly", offerDetails: { basePlanId: "monthly" }, expiryTime: new Date(Date.now() - 1000).toISOString() }] };
    });
    const results = await Promise.all([service.getEntitlement("account-a"), service.getEntitlement("account-a")]);
    expect(results.every(result => !result.active && result.status === "expired")).toBe(true);
    expect(providers.play).toHaveBeenCalledTimes(1);
  });

  async function migratedMerchant(action: () => Promise<void>) {
    const { env } = await import("../config/env.js");
    const saved = { ...env };
    Object.assign(env, { RAZORPAY_KEY_ID: "rzp_live_new", RAZORPAY_KEY_SECRET: "new-private", RAZORPAY_WEBHOOK_SECRET: "new-hook",
      RAZORPAY_SUBSCRIPTION_PLAN_ID: "plan_new", RAZORPAY_LEGACY_KEY_ID: "rzp_live_old", RAZORPAY_LEGACY_KEY_SECRET: "old-private",
      RAZORPAY_LEGACY_WEBHOOK_SECRET: "old-hook", RAZORPAY_LEGACY_PLAN_ID: "plan_old", RAZORPAY_LEGACY_PLAN_AMOUNT: 34900,
      RAZORPAY_LIVE_TEST_PLAN_ID: "plan_verify", RAZORPAY_LIVE_TEST_USER_ID: "account-a" });
    try { await action(); } finally { Object.assign(env, saved); }
  }

  it("persists restricted live checkout merchant and price without changing the public plan", async () => {
    await migratedMerchant(async () => {
      const { razorpayProfile } = await import("../providers/razorpay-context.js");
      providers.create.mockImplementation(async (input: { userId: string }) => {
        expect(razorpayProfile()).toMatchObject({ keyId: "rzp_live_new", amount: 100, planId: "plan_verify", totalCount: 1 });
        return { id: "sub_verify", plan_id: "plan_verify", status: "created", short_url: "https://rzp.io/verify", notes: { userId: input.userId } };
      });
      await service.createRazorpayCheckout({ userId: "account-a" });
      expect(await models.SubscriptionModel.findOne({ providerSubscriptionId: "sub_verify" })).toMatchObject({
        userId: "account-a", razorpayMerchantKeyId: "rzp_live_new", productId: "plan_verify", billingAmount: 100, billingCurrency: "INR" });
      expect(await models.PlanModel.findOne({ planId: "eva_premium_monthly" })).toMatchObject({ amount: 49900, razorpayPlanId: "plan_new" });
      await service.createRazorpayCheckout({ userId: "account-a" });
      expect(providers.create).toHaveBeenCalledTimes(1);
    });
  });

  it("never reuses an old-merchant pending checkout for a new merchant purchase", async () => {
    await migratedMerchant(async () => {
      await models.SubscriptionModel.create({ userId: "account-b", provider: "razorpay", providerSubscriptionId: "sub_old",
        planId: "premium", productId: "plan_old", status: "created", checkoutUrl: "https://rzp.io/old", providerPayload: { plan_id: "plan_old" } });
      providers.create.mockResolvedValue({ id: "sub_new", plan_id: "plan_new", status: "created", short_url: "https://rzp.io/new", notes: { userId: "account-b" } });
      expect(await service.createRazorpayCheckout({ userId: "account-b" })).toMatchObject({ checkoutUrl: "https://rzp.io/new" });
      expect(await models.SubscriptionModel.countDocuments()).toBe(2);
    });
  });

  it("syncs an untagged legacy subscription with the original merchant and historical price", async () => {
    await migratedMerchant(async () => {
      const { razorpayProfile } = await import("../providers/razorpay-context.js");
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_old",
        planId: "premium", productId: "plan_old", status: "active", active: true, currentEnd: future() });
      providers.subscription.mockImplementation(async () => {
        expect(razorpayProfile()).toMatchObject({ keyId: "rzp_live_old", planId: "plan_old", amount: 34900 });
        return { id: "sub_old", plan_id: "plan_old", status: "active", current_end: Math.floor(Date.now() / 1000) + 86400, notes: { userId: "account-a" } };
      });
      expect(await service.syncSubscription({ userId: "account-a" })).toMatchObject({ active: true });
      expect(await models.SubscriptionModel.findOne({ providerSubscriptionId: "sub_old" })).toMatchObject({ razorpayMerchantKeyId: "rzp_live_old", billingAmount: 34900 });
    });
  });

  it("enqueues a signed webhook before provider lookups and replaces client merchant hints", async () => {
    await migratedMerchant(async () => {
      const result = await service.processRazorpayWebhook({ rawBody: Buffer.from("{}"), signature: "verified", eventId: "queued-migration",
        payload: { event: "payment.captured", __evaWebhookMerchantKeys: ["untrusted"], payload: { payment: { entity: { invoice_id: "inv_old" } } } } });
      expect(result.status).toBe("queued");
      expect(providers.invoice).not.toHaveBeenCalled();
      expect(providers.subscription).not.toHaveBeenCalled();
      expect((await queue.QueueJobModel.findOne({ idempotencyKey: "queued-migration" }))?.payload.__evaWebhookMerchantKeys)
        .toEqual(["rzp_live_new", "rzp_live_old"]);
    });
  });

  it("does not process a stored legacy subscription as a new-merchant webhook", async () => {
    await migratedMerchant(async () => {
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_old", productId: "plan_old", planId: "premium" });
      await expect(service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "", eventId: "wrong-merchant",
        payload: { event: "subscription.charged", __evaWebhookMerchantKeys: ["rzp_live_new"], payload: { subscription: { entity: { id: "sub_old" } } } } }, true))
        .rejects.toThrow("stored payment merchant");
      expect(providers.subscription).not.toHaveBeenCalled();
    });
  });

  it("routes invoice-only legacy events to the original credentials and receipts the historical price", async () => {
    await migratedMerchant(async () => {
      const { razorpayProfile } = await import("../providers/razorpay-context.js");
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_old", productId: "plan_old", planId: "premium" });
      providers.invoice.mockImplementation(async () => {
        expect(razorpayProfile().keyId).toBe("rzp_live_old");
        return { subscription_id: "sub_old", payment_id: "pay_old" };
      });
      providers.subscription.mockResolvedValue({ id: "sub_old", plan_id: "plan_old", status: "active",
        current_end: Math.floor(Date.now() / 1000) + 86400, notes: { userId: "account-a" } });
      providers.payment.mockResolvedValue({ id: "pay_old", amount: 34900, currency: "INR", status: "captured" });
      await service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "", eventId: "invoice-only",
        payload: { event: "payment.captured", __evaWebhookMerchantKeys: ["rzp_live_old"], payload: { payment: { entity: { id: "pay_old", invoice_id: "inv_old" } } } } }, true);
      expect((await queue.QueueJobModel.findOne({ jobType: "payment_confirmation" }))?.payload.amount).toBe(34900);
      expect((await models.SubscriptionModel.findOne({ providerSubscriptionId: "sub_old" }))?.razorpayMerchantKeyId).toBe("rzp_live_old");
    });
  });

  it("verifies a stored one-rupee purchase after disabling its allowlist and receipts its actual amount once", async () => {
    await migratedMerchant(async () => {
      const { env } = await import("../config/env.js");
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_verify",
        planId: "premium", productId: "plan_verify", status: "created", razorpayMerchantKeyId: "rzp_live_new", billingAmount: 100, billingCurrency: "INR" });
      env.RAZORPAY_LIVE_TEST_USER_ID = "";
      providers.subscription.mockResolvedValue({ id: "sub_verify", plan_id: "plan_verify", status: "completed",
        current_end: Math.floor(Date.now() / 1000) + 86400, notes: { userId: "account-a" } });
      providers.payment.mockResolvedValue({ id: "pay_verify", amount: 100, currency: "INR", status: "captured" });
      const input = { userId: "account-a", razorpayPaymentId: "pay_verify", razorpaySubscriptionId: "sub_verify", razorpaySignature: "verified" };
      expect(await service.confirmRazorpayPayment(input)).toMatchObject({ active: true, autoRenew: false });
      await service.confirmRazorpayPayment(input);
      expect(await models.PaymentModel.countDocuments()).toBe(1);
      expect(await queue.QueueJobModel.countDocuments({ jobType: "payment_confirmation" })).toBe(1);
      expect((await queue.QueueJobModel.findOne({ jobType: "payment_confirmation" }))?.payload.amount).toBe(100);
      expect((await queue.QueueJobModel.findOne({ jobType: "payment_confirmation" }))?.payload.notification).toBeUndefined();
    });
  });

  it("does not let another user confirm a stored verification purchase", async () => {
    await migratedMerchant(async () => {
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_verify",
        planId: "premium", productId: "plan_verify", status: "created", razorpayMerchantKeyId: "rzp_live_new", billingAmount: 100 });
      await expect(service.confirmRazorpayPayment({ userId: "account-b", razorpayPaymentId: "pay_verify", razorpaySubscriptionId: "sub_verify", razorpaySignature: "verified" }))
        .rejects.toThrow("another account");
      expect(providers.payment).not.toHaveBeenCalled();
    });
  });

  it("sends one failed-payment nudge without a second created-membership notification", async () => {
    providers.subscription.mockResolvedValue({ id: "sub_failed", plan_id: "plan_test", status: "created", notes: { userId: "account-a" } });
    providers.payment.mockResolvedValue({ id: "pay_failed", amount: 49900, currency: "INR", status: "failed" });
    await service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "", eventId: "first-failed",
      payload: { event: "payment.failed", payload: { subscription: { entity: { id: "sub_failed" } }, payment: { entity: { id: "pay_failed" } } } } }, true);
    expect(await queue.QueueJobModel.countDocuments({ jobType: "payment_confirmation" })).toBe(1);
    expect((await queue.QueueJobModel.findOne({ jobType: "payment_confirmation" }))?.payload.notification).toMatchObject({ title: "Payment didn't go through" });
    expect(await service.getEntitlement("account-a")).toMatchObject({ active: false });
  });

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

  it("queues SDK-confirmed alternative payment reporting once without waiting for a webhook", async () => {
    const { payment } = await razorpayReceipt();
    await models.SubscriptionModel.updateOne({ providerSubscriptionId: "sub_test" }, { $set: {
      externalTransactionToken: "choice-token", billingAdministrativeArea: "UTTAR PRADESH"
    } });
    const input = { userId: "account-a", razorpayPaymentId: payment.id, razorpaySubscriptionId: "sub_test", razorpaySignature: "verified" };
    await service.confirmRazorpayPayment(input);
    await service.confirmRazorpayPayment(input);
    expect(await queue.QueueJobModel.countDocuments({ jobType: "external_transaction", idempotencyKey: "external-pay_test" })).toBe(1);
  });

  it("recovers missed Razorpay payment reports from verified subscription invoices", async () => {
    const { payment } = await razorpayReceipt();
    await models.SubscriptionModel.updateOne({ providerSubscriptionId: "sub_test" }, { $set: {
      externalTransactionToken: "choice-token", billingAdministrativeArea: "UTTAR PRADESH"
    } });
    providers.paidInvoices.mockResolvedValue([{ payment_id: payment.id, created_at: payment.created_at }]);
    await service.syncSubscription({ userId: "account-a" });
    await service.syncSubscription({ userId: "account-a" });
    expect(await queue.QueueJobModel.countDocuments({ jobType: "external_transaction" })).toBe(1);
    expect(providers.paidInvoices).toHaveBeenCalledWith("sub_test");
  });

  it("never reuses a website checkout for a Google Play billing-choice token", async () => {
    const { env } = await import("../config/env.js");
    const saved = { ...env };
    env.GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED = true;
    env.RAZORPAY_ENABLED = true;
    env.RAZORPAY_KEY_ID = "rzp_test_key";
    env.RAZORPAY_KEY_SECRET = "test-secret";
    env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
    env.GOOGLE_PLAY_RTDN_AUDIENCE = "https://billing.example/rtdn";
    env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "push@example.iam.gserviceaccount.com";
    process.env.GOOGLE_PLAY_TAX_RATE_BPS = "0";
    try {
      const created = { id: "sub_choice", plan_id: "plan_test", status: "created", short_url: "https://rzp.io/choice", notes: { userId: "account-a" } };
      providers.create.mockResolvedValue(created);
      await models.SubscriptionModel.create({ userId: "account-a", provider: "razorpay", providerSubscriptionId: "sub_web", planId: "premium", status: "created", checkoutUrl: "https://rzp.io/web", providerPayload: { plan_id: "plan_test" } });
      const result = await service.createRazorpayCheckout({ userId: "account-a", externalTransactionToken: "choice-token", billingCountryCode: "IN", billingAdministrativeArea: "DELHI" });
      expect(result.checkoutUrl).toBe("https://rzp.io/choice");
      expect(providers.create).toHaveBeenCalledTimes(1);
      expect((await models.SubscriptionModel.findOne({ providerSubscriptionId: "sub_choice" }))?.billingAdministrativeArea).toBe("DELHI");
      await service.createRazorpayCheckout({ userId: "account-a", externalTransactionToken: "choice-token", billingCountryCode: "IN", billingAdministrativeArea: "DELHI" });
      expect(providers.create).toHaveBeenCalledTimes(1);
    } finally { Object.assign(env, saved); delete process.env.GOOGLE_PLAY_TAX_RATE_BPS; }
  });

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

  it("exposes reporting deadline failures only to internal monitoring", async () => {
    await queue.QueueJobModel.create({ jobType: "external_transaction", idempotencyKey: "old-report", status: "failed", payload: {
      payment: { created_at: Math.floor(Date.now() / 1000) - 90000 }
    } });
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    try {
      const url = "/api/v1/internal/queue/reporting-status";
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url, headers: { "x-subscriptions-key": "test-only-internal-key" } });
      expect(response.json().data).toEqual({ outstanding: 1, failed: 1, overdue: 1, healthy: false });
    } finally { await app.close(); }
  });

  it("reconciles a stale subscription through the durable queue after a missed notification", async () => {
    await confirm();
    await queue.QueueJobModel.deleteMany({});
    await models.SubscriptionModel.updateOne({ purchaseToken: token }, { $set: { lastSyncedAt: new Date(Date.now() - 1800_000) } });
    expect(await service.enqueueDueSubscriptionSyncs()).toBe(1);
    expect(await service.enqueueDueSubscriptionSyncs()).toBe(0);
    const job = await queue.QueueJobModel.findOne({ jobType: "subscription_sync" });
    providers.play.mockResolvedValue({ ...activePurchase(), subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    expect(await jobs.processConfirmationJobById(job!._id.toString())).toBe(true);
    await expect(service.getEntitlement("account-a")).resolves.toMatchObject({ active: false, status: "expired" });
    expect((await queue.QueueJobModel.findById(job!._id))?.status).toBe("completed");
  });
});
