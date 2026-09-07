import { describe, expect, it } from "vitest";

process.env.SUBSCRIPTIONS_API_KEY ??= "test_subscriptions_secret";
process.env.MONGODB_URI ??= "mongodb://localhost:27017/eva_subscriptions_test";

const { isEntitlementActive, mapGooglePlayStatus } = await import("./subscriptions.js");

describe("subscription status mapping", () => {
  it("maps active Google Play states to internal states", () => {
    expect(mapGooglePlayStatus("SUBSCRIPTION_STATE_ACTIVE")).toBe("active");
    expect(mapGooglePlayStatus("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).toBe("grace_period");
  });

  it("does not grant entitlement for expired subscriptions", () => {
    expect(isEntitlementActive("active", new Date(Date.now() - 1000))).toBe(false);
    expect(isEntitlementActive("expired", new Date(Date.now() + 1000))).toBe(false);
  });

  it("grants entitlement for active subscriptions before expiry", () => {
    expect(isEntitlementActive("active", new Date(Date.now() + 60_000))).toBe(true);
  });
});
