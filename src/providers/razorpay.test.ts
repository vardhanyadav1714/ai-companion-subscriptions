import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../config/env.js", () => ({ env: {
  RAZORPAY_ENABLED: true, RAZORPAY_KEY_ID: "test", RAZORPAY_KEY_SECRET: "test",
  RAZORPAY_WEBHOOK_SECRET: "test", RAZORPAY_SUBSCRIPTION_PLAN_ID: "plan_test",
  PLAN_AMOUNT: 49900, PLAN_CURRENCY: "INR", PLAN_INTERVAL: "monthly"
} }));
const { validateRazorpayPlan, fetchInitialRazorpayPayment, verifyRazorpayWebhookSignature, verifyRazorpayCheckoutSignature } = await import("./razorpay.js");
afterEach(() => vi.unstubAllGlobals());
describe("checkout plan validation", () => {
  const plan = { id: "plan_test", interval: 1, period: "monthly", item: { amount: 49900, currency: "INR", active: true } };
  it("accepts the configured monthly price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(plan))));
    await expect(validateRazorpayPlan()).resolves.toBeUndefined();
  });
  it.each([
    { ...plan, item: { ...plan.item, amount: 29900 } },
    { ...plan, interval: 2 },
    { ...plan, period: "yearly" },
    { ...plan, item: { ...plan.item, currency: "USD" } },
    { ...plan, item: { ...plan.item, active: false } },
    { ...plan, id: "plan_wrong" },
    {}
  ])("rejects mismatched or malformed plans", async remote => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(remote))));
    await expect(validateRazorpayPlan()).rejects.toThrow("does not match");
  });
  it("fails closed when Razorpay is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
    await expect(validateRazorpayPlan()).rejects.toThrow();
  });
  it("uses the earliest paid full-price invoice and ignores authorization-only amounts", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [
      { status: "paid", amount: 49900, payment_id: "pay_renewal", created_at: 200 },
      { status: "paid", amount: 100, payment_id: "pay_authorization", created_at: 50 },
      { status: "paid", amount: 49900, payment_id: "pay_initial", created_at: 100 }
    ] }))).mockResolvedValueOnce(new Response(JSON.stringify({ id: "pay_initial", amount: 49900, status: "captured" })));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchInitialRazorpayPayment("sub_test")).resolves.toMatchObject({ id: "pay_initial" });
    expect(fetch.mock.calls[1]![0]).toContain("/payments/pay_initial");
  });
  it("verifies the exact raw webhook bytes and rejects a modified body", () => {
    const body = Buffer.from('{"event":"subscription.charged"}');
    const signature = createHmac("sha256", "test").update(body).digest("hex");
    expect(verifyRazorpayWebhookSignature(body, signature)).toBe(true);
    expect(verifyRazorpayWebhookSignature(Buffer.from('{ "event":"subscription.charged"}'), signature)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, "invalid")).toBe(false);
  });
  it("binds checkout signatures to both payment and subscription", () => {
    const signature = createHmac("sha256", "test").update("pay_1|sub_1").digest("hex");
    expect(verifyRazorpayCheckoutSignature({ paymentId: "pay_1", subscriptionId: "sub_1", signature })).toBe(true);
    expect(verifyRazorpayCheckoutSignature({ paymentId: "pay_1", subscriptionId: "sub_other", signature })).toBe(false);
  });
});
