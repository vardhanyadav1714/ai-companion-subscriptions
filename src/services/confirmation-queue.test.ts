import { describe, expect, it } from "vitest";

import { confirmationQueueJobType, retryDelaySeconds } from "./confirmation-queue.js";

describe("confirmation queue", () => {
  it("uses a stable job type for idempotent confirmation delivery", () => {
    expect(confirmationQueueJobType).toBe("payment_confirmation");
  });

  it("backs off retries and caps the delay", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(8)).toBe(1800);
  });
});
