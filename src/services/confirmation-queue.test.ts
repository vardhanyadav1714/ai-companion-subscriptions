import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SUBSCRIPTIONS_API_KEY ??= "test_subscriptions_secret";
process.env.MONGODB_URI ??= "mongodb://localhost:27017/eva_subscriptions_test";
process.env.PAYMENT_CONFIRMATION_URL = "https://example.test/confirmation";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), update: vi.fn() }));
vi.mock("../models/queue-job.model.js", () => ({ QueueJobModel: {
  findOneAndUpdate: () => ({ lean: mocks.claim }), updateOne: mocks.update
} }));
const { confirmationQueueJobType, retryDelaySeconds, processConfirmationJobById } = await import("./confirmation-queue.js");
beforeEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("confirmation queue", () => {
  it("uses a stable job type for idempotent confirmation delivery", () => {
    expect(confirmationQueueJobType).toBe("payment_confirmation");
  });

  it("backs off retries and caps the delay", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(8)).toBe(1800);
  });

  it("does not deliver a job already claimed by another worker", async () => {
    mocks.claim.mockResolvedValue(null);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await processConfirmationJobById("job1")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries failed delivery with a fenced write", async () => {
    mocks.claim.mockResolvedValue({ _id: "job1", jobType: "payment_confirmation", attempts: 2, maxAttempts: 8, payload: {} });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    await processConfirmationJobById("job1");
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: "job1", status: "processing", attempts: 2 },
      expect.objectContaining({ $set: expect.objectContaining({ status: "retrying", lastError: "network unavailable" }) })
    );
  });

  it("retains exhausted jobs for operator recovery", async () => {
    mocks.claim.mockResolvedValue({ _id: "job1", jobType: "payment_confirmation", attempts: 8, maxAttempts: 8, payload: {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" }));
    await processConfirmationJobById("job1");
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(),
      { $set: expect.objectContaining({ status: "failed", lockedUntil: null }) });
  });
});
