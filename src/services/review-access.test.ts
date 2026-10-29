import { afterEach, expect, it } from "vitest";

process.env.SUBSCRIPTIONS_API_KEY ??= "test_subscriptions_secret";
process.env.MONGODB_URI ??= "mongodb://localhost:27017/eva_subscriptions_test";

const { env } = await import("../config/env.js");
const { getPlayReviewAccess } = await import("./review-access.js");
const original = env.PLAY_REVIEW_USER_ID;
const reviewer = "000000000000000000000043";
afterEach(() => { env.PLAY_REVIEW_USER_ID = original; });

it("fails closed when review access is disabled or the account differs", () => {
  env.PLAY_REVIEW_USER_ID = "";
  expect(getPlayReviewAccess(reviewer)).toBeNull();
  env.PLAY_REVIEW_USER_ID = reviewer;
  expect(getPlayReviewAccess("000000000000000000000044")).toBeNull();
});

it("keeps one bounded UTC allowance cycle and renews it across the year boundary", () => {
  env.PLAY_REVIEW_USER_ID = reviewer;
  const first = getPlayReviewAccess(reviewer, new Date("2026-12-01T00:00:00Z"))!;
  const repeated = getPlayReviewAccess(reviewer, new Date("2026-12-31T23:59:59Z"))!;
  const next = getPlayReviewAccess(reviewer, new Date("2027-01-01T00:00:00Z"))!;
  expect(first).toEqual(repeated);
  expect(first.currentEnd).toBe("2027-01-01T00:00:00.000Z");
  expect(next.currentEnd).toBe("2027-02-01T00:00:00.000Z");
  expect(next.voiceCycleId).not.toBe(first.voiceCycleId);
});
