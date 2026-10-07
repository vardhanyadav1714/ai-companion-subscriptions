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
});
