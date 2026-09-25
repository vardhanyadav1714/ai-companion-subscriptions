import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: {
  RAZORPAY_ENABLED: true, RAZORPAY_KEY_ID: "test", RAZORPAY_KEY_SECRET: "test",
  RAZORPAY_WEBHOOK_SECRET: "test", RAZORPAY_SUBSCRIPTION_PLAN_ID: "plan_test",
  PLAN_AMOUNT: 49900, PLAN_CURRENCY: "INR", PLAN_INTERVAL: "monthly"
} }));
const { validateRazorpayPlan } = await import("./razorpay.js");
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
});
