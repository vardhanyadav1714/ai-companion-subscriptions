import { beforeEach, describe, expect, it } from "vitest";
process.env.MONGODB_URI = "mongodb://localhost/test";
process.env.SUBSCRIPTIONS_API_KEY = "test-only-internal-key";
const { env } = await import("../config/env.js");
const { validateAlternativeBilling, indiaAdministrativeAreas } = await import("./alternative-billing.js");
const choice = { externalTransactionToken: "choice-token", billingCountryCode: "IN", billingAdministrativeArea: "UTTAR PRADESH" };
beforeEach(() => {
  env.GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED = true;
  env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "{}";
  env.GOOGLE_PLAY_TAX_REGION = "IN";
  env.PLAN_CURRENCY = "INR";
  env.RAZORPAY_ENABLED = true;
  env.RAZORPAY_KEY_ID = "rzp_test_key";
  env.RAZORPAY_KEY_SECRET = "test-secret";
  env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
  env.GOOGLE_PLAY_RTDN_AUDIENCE = "https://billing.example/rtdn";
  env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "push@example.iam.gserviceaccount.com";
  process.env.GOOGLE_PLAY_TAX_RATE_BPS = "0";
});
describe("India user-choice billing guard", () => {
  it("allows website checkout without Play choice metadata", () => expect(() => validateAlternativeBilling({})).not.toThrow());
  it("allows a complete India choice", () => expect(() => validateAlternativeBilling(choice)).not.toThrow());
  it("rejects non-India and missing Play country", () => {
    for (const billingCountryCode of ["US", "GB", "AU", undefined]) {
      expect(() => validateAlternativeBilling({ ...choice, billingCountryCode })).toThrow("only in India");
    }
  });
  it("requires a real Indian billing state", () => {
    expect(() => validateAlternativeBilling({ ...choice, billingAdministrativeArea: undefined })).toThrow("billing state");
    expect(() => validateAlternativeBilling({ ...choice, billingAdministrativeArea: "INVALID" })).toThrow("billing state");
    expect(new Set(indiaAdministrativeAreas).size).toBe(36);
  });
  it("fails closed when reporting or the rollout switch is missing", () => {
    env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "";
    expect(() => validateAlternativeBilling(choice)).toThrow("not configured");
    env.GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED = false;
    expect(() => validateAlternativeBilling(choice)).toThrow("not enabled");
  });
  it("does not accept choice metadata without a Google token", () => {
    expect(() => validateAlternativeBilling({ billingCountryCode: "IN" })).toThrow("token is required");
  });
  it("blocks checkout until the explicit tax rate is configured", () => {
    delete process.env.GOOGLE_PLAY_TAX_RATE_BPS;
    expect(() => validateAlternativeBilling(choice)).toThrow("not configured");
    process.env.GOOGLE_PLAY_TAX_RATE_BPS = "0";
    expect(() => validateAlternativeBilling(choice)).not.toThrow();
  });
  it("does not gate Razorpay reporting on unrelated Play purchase push settings", () => {
    env.GOOGLE_PLAY_RTDN_AUDIENCE = "";
    env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "";
    expect(() => validateAlternativeBilling(choice)).not.toThrow();
  });
});
