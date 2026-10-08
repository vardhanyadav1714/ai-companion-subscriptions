import Fastify from "fastify";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), lean: vi.fn(), update: vi.fn() }));
vi.mock("./models/queue-job.model.js", () => ({ QueueJobModel: { find: mocks.find, updateOne: mocks.update } }));
let register: typeof import("./routes.js").registerRoutes;
beforeAll(async () => {
  process.env.MONGODB_URI = "mongodb://localhost/test";
  process.env.SUBSCRIPTIONS_API_KEY = "test-only-queue-admin";
  ({ registerRoutes: register } = await import("./routes.js"));
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockReturnValue({ sort: () => ({ limit: () => ({ select: () => ({ lean: mocks.lean }) }) }) });
  mocks.lean.mockResolvedValue([{ _id: "507f1f77bcf86cd799439011", jobType: "payment_confirmation", attempts: 8, maxAttempts: 8, lastError: "Confirmation endpoint returned 404", payload: { purchaseToken: "private" } }]);
  mocks.update.mockResolvedValue({ modifiedCount: 1 });
});
afterEach(() => vi.restoreAllMocks());
async function request(url: string, method: "GET" | "POST" = "GET", authenticated = true) {
  const app = Fastify(); await app.register(register);
  try { return await app.inject({ url, method, headers: authenticated ? { "x-subscriptions-key": "test-only-queue-admin" } : {} }); }
  finally { await app.close(); }
}
it("does not expose failed jobs without the internal key", async () => {
  expect((await request("/api/v1/internal/queue/failed", "GET", false)).statusCode).toBeGreaterThanOrEqual(400);
  expect(mocks.find).not.toHaveBeenCalled();
});
it("lists bounded failed jobs without exposing payment payloads", async () => {
  const r = await request("/api/v1/internal/queue/failed?jobType=payment_confirmation&limit=10");
  expect(r.statusCode).toBe(200);
  expect(mocks.find).toHaveBeenCalledWith({ status: "failed", jobType: "payment_confirmation" });
  expect(r.json().data[0].failure).toBe("Confirmation endpoint returned 404");
  expect(r.body).not.toContain("private"); expect(r.body).not.toContain("purchaseToken");
});
it("redacts unstructured provider errors", async () => {
  mocks.lean.mockResolvedValue([{ _id: "job", jobType: "external_transaction", lastError: "private-token" }]);
  expect((await request("/api/v1/internal/queue/failed")).body).not.toContain("private-token");
});
it("retries only failed jobs without resetting the fencing counter", async () => {
  const id = "507f1f77bcf86cd799439011";
  expect((await request(`/api/v1/internal/queue/${id}/retry`, "POST")).statusCode).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith({ _id: id, status: "failed" }, [expect.objectContaining({ $set: expect.objectContaining({
    status: "pending", maxAttempts: { $add: ["$attempts", 8] }, lockedUntil: null
  }) })]);
  expect(mocks.update.mock.calls[0][1][0].$set).not.toHaveProperty("attempts");
});
