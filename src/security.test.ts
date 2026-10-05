import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

const verify = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
process.env.SUBSCRIPTIONS_API_KEY = "test_subscriptions_secret";
process.env.MONGODB_URI = "mongodb://localhost/test";
const { env } = await import("./config/env.js");
const { requireGooglePlayPush, requireInternalKey } = await import("./security.js");
const request = (headers: Record<string, string> = {}, query = {}) => ({ headers, query }) as FastifyRequest;

beforeEach(() => {
  vi.clearAllMocks();
  env.GOOGLE_PLAY_RTDN_AUDIENCE = "https://billing.example/api/v1/webhooks/google-play/rtdn";
  env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "push@example.iam.gserviceaccount.com";
  env.GOOGLE_PLAY_RTDN_TOKEN = "legacy-secret";
});

describe("billing authentication", () => {
  it("checks signed push identity, audience and verified service account", async () => {
    verify.mockResolvedValue({ getPayload: () => ({ email: env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL, email_verified: true }) });
    await expect(requireGooglePlayPush(request({ authorization: "Bearer signed-token" }))).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith({ idToken: "signed-token", audience: env.GOOGLE_PLAY_RTDN_AUDIENCE });
  });
  it.each([{ email: "wrong@example.com", email_verified: true }, { email: "push@example.iam.gserviceaccount.com", email_verified: false }])("rejects an unexpected push account %s", async claims => {
    verify.mockResolvedValue({ getPayload: () => claims });
    await expect(requireGooglePlayPush(request({ authorization: "Bearer signed-token" }))).rejects.toThrow("Invalid Google Play push identity");
  });
  it("does not let the legacy query secret bypass configured OIDC", async () => {
    await expect(requireGooglePlayPush(request({}, { token: "legacy-secret" }))).rejects.toThrow("identity is required");
  });
  it("fails closed for incomplete OIDC settings", async () => {
    env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "";
    await expect(requireGooglePlayPush(request({}, { token: "legacy-secret" }))).rejects.toThrow("incomplete");
  });
  it("supports the configured legacy token while OIDC is not configured", async () => {
    env.GOOGLE_PLAY_RTDN_AUDIENCE = "";
    env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL = "";
    await expect(requireGooglePlayPush(request({}, { token: "legacy-secret" }))).resolves.toBeUndefined();
    await expect(requireGooglePlayPush(request({}, { token: "wrong" }))).rejects.toThrow();
  });
  it("rejects missing and incorrect internal keys", () => {
    expect(() => requireInternalKey(request())).toThrow();
    expect(() => requireInternalKey(request({ "x-subscriptions-key": "wrong" }))).toThrow();
    expect(() => requireInternalKey(request({ "x-subscriptions-key": env.SUBSCRIPTIONS_API_KEY }))).not.toThrow();
  });
});
