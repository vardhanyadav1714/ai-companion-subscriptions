import { beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const config = vi.hoisted(() => ({ RAZORPAY_ENABLED: true, RAZORPAY_KEY_ID: "rzp_live_new", RAZORPAY_KEY_SECRET: "new-private",
  RAZORPAY_WEBHOOK_SECRET: "new-hook", RAZORPAY_SUBSCRIPTION_PLAN_ID: "plan_new", RAZORPAY_SUBSCRIPTION_TOTAL_COUNT: 120,
  RAZORPAY_LEGACY_KEY_ID: "rzp_live_old", RAZORPAY_LEGACY_KEY_SECRET: "old-private", RAZORPAY_LEGACY_WEBHOOK_SECRET: "old-hook",
  RAZORPAY_LEGACY_PLAN_ID: "plan_old", RAZORPAY_LEGACY_PLAN_AMOUNT: 34900, RAZORPAY_LEGACY_PLAN_CURRENCY: "INR",
  RAZORPAY_LIVE_TEST_PLAN_ID: "plan_verify", RAZORPAY_LIVE_TEST_USER_ID: "test-owner", PLAN_AMOUNT: 49900,
  PLAN_CURRENCY: "INR", PLAN_INTERVAL: "monthly" }));
vi.mock("../config/env.js", () => ({ env: config }));
const { checkoutRazorpayProfile, storedRazorpayProfile, razorpayProfile, withRazorpayProfile } = await import("./razorpay-context.js");
const { createRazorpaySubscription, verifyRazorpayCheckoutSignature, verifyRazorpayWebhookSignature, validateRazorpayPlan } = await import("./razorpay.js");
const defaults = { ...config };
beforeEach(() => { Object.assign(config, defaults); vi.unstubAllGlobals(); });

it("uses the new normal merchant and advertised amount for other users", () => {
  expect(checkoutRazorpayProfile("regular-user")).toMatchObject({ keyId: "rzp_live_new", amount: 49900, planId: "plan_new", totalCount: 120 });
});
it("limits the one-rupee single-cycle plan to the exact configured user ID", () => {
  expect(checkoutRazorpayProfile("test-owner")).toMatchObject({ amount: 100, planId: "plan_verify", totalCount: 1 });
  expect(checkoutRazorpayProfile("TEST-OWNER").amount).toBe(49900);
});
it("does not enable verification pricing without an immutable user allowlist", () => {
  config.RAZORPAY_LIVE_TEST_USER_ID = "";
  expect(checkoutRazorpayProfile("test-owner").amount).toBe(49900);
});
it("fails closed when the verification plan is missing or equals the public plan", () => {
  config.RAZORPAY_LIVE_TEST_PLAN_ID = "";
  expect(() => checkoutRazorpayProfile("test-owner")).toThrow("not configured");
  config.RAZORPAY_LIVE_TEST_PLAN_ID = config.RAZORPAY_SUBSCRIPTION_PLAN_ID;
  expect(() => checkoutRazorpayProfile("test-owner")).toThrow("not configured");
});
it("does not accept a test-mode key for live verification", () => {
  config.RAZORPAY_KEY_ID = "rzp_test_wrong";
  expect(() => checkoutRazorpayProfile("test-owner")).toThrow("not configured");
});
it("routes untagged historical rows to the retained original merchant and price", () => {
  expect(storedRazorpayProfile({})).toMatchObject({ keyId: "rzp_live_old", planId: "plan_old", amount: 34900 });
});
it("preserves historical snapshot amounts even after the public price changes", () => {
  config.PLAN_AMOUNT = 59900;
  expect(storedRazorpayProfile({ razorpayMerchantKeyId: "rzp_live_new", productId: "plan_verify", billingAmount: 100, billingCurrency: "INR" }))
    .toMatchObject({ keyId: "rzp_live_new", planId: "plan_verify", amount: 100 });
});
it("keeps a stored verification purchase verifiable after the allowlist is disabled", () => {
  config.RAZORPAY_LIVE_TEST_USER_ID = "";
  config.RAZORPAY_LIVE_TEST_PLAN_ID = "";
  expect(storedRazorpayProfile({ razorpayMerchantKeyId: "rzp_live_new", productId: "plan_verify", billingAmount: 100 }).amount).toBe(100);
});
it("never falls back to another merchant when a stored key is unknown", () => {
  expect(() => storedRazorpayProfile({ razorpayMerchantKeyId: "rzp_live_unavailable" })).toThrow("unavailable");
});
it("fails closed with incomplete or ambiguous legacy credentials", () => {
  config.RAZORPAY_LEGACY_KEY_SECRET = "";
  expect(() => storedRazorpayProfile({})).toThrow("incomplete");
  config.RAZORPAY_LEGACY_KEY_SECRET = "old-private";
  config.RAZORPAY_LEGACY_KEY_ID = config.RAZORPAY_KEY_ID;
  expect(() => storedRazorpayProfile({})).toThrow("ambiguous");
});
it("does not leak merchant context between concurrent operations", async () => {
  const profiles = [checkoutRazorpayProfile("test-owner"), storedRazorpayProfile({})];
  const values = await Promise.all(profiles.map(profile => withRazorpayProfile(profile, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return { key: razorpayProfile().keyId, amount: razorpayProfile().amount };
  })));
  expect(values).toEqual([{ key: "rzp_live_new", amount: 100 }, { key: "rzp_live_old", amount: 34900 }]);
  expect(razorpayProfile().amount).toBe(49900);
});
it("sends the scoped credentials and a single-cycle verification plan to Razorpay", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"id":"sub_verify"}'));
  vi.stubGlobal("fetch", fetch);
  await withRazorpayProfile(checkoutRazorpayProfile("test-owner"), () => createRazorpaySubscription({ userId: "test-owner" }));
  const request = fetch.mock.calls[0]![1];
  expect(request.headers.Authorization).toBe("Basic " + Buffer.from("rzp_live_new:new-private").toString("base64"));
  expect(JSON.parse(request.body)).toMatchObject({ plan_id: "plan_verify", total_count: 1, notes: { userId: "test-owner" } });
});
it("validates the one-rupee plan against its own price, not the standard price", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "plan_verify", interval: 1,
    period: "monthly", item: { amount: 100, currency: "INR" } }))));
  await withRazorpayProfile(checkoutRazorpayProfile("test-owner"), () => expect(validateRazorpayPlan()).resolves.toBeUndefined());
  await expect(validateRazorpayPlan()).rejects.toThrow("does not match");
});
it("verifies checkout and webhook signatures using the original merchant only", async () => {
  const signature = createHmac("sha256", "old-private").update("pay_old|sub_old").digest("hex");
  const body = Buffer.from('{"event":"subscription.charged"}');
  const hook = createHmac("sha256", "old-hook").update(body).digest("hex");
  expect(verifyRazorpayCheckoutSignature({ paymentId: "pay_old", subscriptionId: "sub_old", signature })).toBe(false);
  expect(verifyRazorpayWebhookSignature(body, hook)).toBe(false);
  await withRazorpayProfile(storedRazorpayProfile({}), async () => {
    expect(verifyRazorpayCheckoutSignature({ paymentId: "pay_old", subscriptionId: "sub_old", signature })).toBe(true);
    expect(verifyRazorpayWebhookSignature(body, hook)).toBe(true);
  });
});
