import Fastify from "fastify";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
const lookup = vi.hoisted(() => ({ find: vi.fn(), lean: vi.fn() }));
vi.mock("./models.js", async original => ({ ...await original<typeof import("./models.js")>(),
  UserModel: { find: lookup.find } }));
let register: typeof import("./routes.js").registerRoutes;
beforeAll(async () => {
  process.env.MONGODB_URI = "mongodb://localhost/test";
  process.env.SUBSCRIPTIONS_API_KEY = "test-only-account-lookup";
  ({ registerRoutes: register } = await import("./routes.js"));
});
beforeEach(() => {
  vi.clearAllMocks();
  lookup.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: lookup.lean }) }) });
  lookup.lean.mockResolvedValue([{ userId: "507f1f77bcf86cd799439011" }]);
});
async function request(authenticated = true) {
  const app = Fastify();
  await register(app);
  try { return await app.inject({ method: "POST", url: "/api/v1/internal/billing/resolve-user",
    headers: authenticated ? { "X-Subscriptions-Key": "test-only-account-lookup" } : {}, payload: { email: "Tester@Example.com" } }); }
  finally { await app.close(); }
}
it("requires the private internal key before looking up a billing user", async () => {
  expect((await request(false)).statusCode).toBeGreaterThanOrEqual(400);
  expect(lookup.find).not.toHaveBeenCalled();
});
it("resolves an existing billing account to its immutable ID without returning profile details", async () => {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(lookup.find).toHaveBeenCalledWith({ email: "tester@example.com" });
  expect(response.json().data).toEqual({ userId: "507f1f77bcf86cd799439011" });
  expect(response.body).not.toContain("example.com");
});
it.each([{ users: [] }, { users: [{ userId: "a" }, { userId: "b" }] }])("refuses missing or ambiguous billing identities", async ({ users }) => {
  lookup.lean.mockResolvedValue(users);
  expect((await request()).statusCode).toBeGreaterThanOrEqual(400);
});
