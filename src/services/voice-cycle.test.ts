import { expect, it } from "vitest";
import { voiceBillingCycleId } from "./voice-cycle.js";

const period = { provider: "razorpay", providerSubscriptionId: "sub_example", status: "active",
  currentStart: new Date("2026-10-16T12:00:00Z"), currentEnd: new Date("2026-11-16T12:00:00Z") };
it("keeps one cycle across cancellation, expiry extension and repeat reads", () => {
  const cycle = voiceBillingCycleId(period);
  expect(cycle).toMatch(/^[a-f0-9]{64}$/);
  expect(voiceBillingCycleId({ ...period, status: "cancelled" })).toBe(cycle);
  expect(voiceBillingCycleId({ ...period, currentEnd: new Date("2026-11-20T12:00:00Z") })).toBe(cycle);
});
it("starts a fresh Razorpay cycle only when the verified current start changes", () => {
  expect(voiceBillingCycleId({ ...period, currentStart: new Date("2026-11-16T12:00:00Z") })).not.toBe(voiceBillingCycleId(period));
});
it("uses the successful Google order rather than a grace expiry or failed renewal", () => {
  const google = { ...period, provider: "google_play", latestOrderId: "pending-renewal",
    providerPayload: { lineItems: [{ latestSuccessfulOrderId: "GPA.example..0" }] } };
  const id = voiceBillingCycleId(google);
  expect(voiceBillingCycleId({ ...google, status: "grace_period", currentEnd: new Date("2026-11-25T12:00:00Z") })).toBe(id);
  expect(voiceBillingCycleId({ ...google, providerPayload: { lineItems: [{ latestSuccessfulOrderId: "GPA.example..1" }] } })).not.toBe(id);
});
it("does not guess a cycle for unverified Google grace periods or missing provider dates", () => {
  expect(voiceBillingCycleId({ ...period, provider: "google_play", status: "grace_period", latestOrderId: "unknown" })).toBeNull();
  expect(voiceBillingCycleId({ ...period, provider: "google_play", latestOrderId: "possibly-pending" })).toBeNull();
  expect(voiceBillingCycleId({ ...period, currentStart: undefined })).toBeNull();
});
