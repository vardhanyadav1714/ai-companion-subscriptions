import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";

import { env } from "./config/env.js";
import { unauthorized } from "./errors.js";

export function requireInternalKey(request: FastifyRequest): void {
  const expected = env.SUBSCRIPTIONS_API_KEY.trim();
  const headerKey = String(request.headers["x-subscriptions-key"] ?? "").trim();
  const authorization = String(request.headers.authorization ?? "").trim();
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";

  if (matchesSecret(headerKey, expected) || matchesSecret(bearer, expected)) return;
  throw unauthorized("Invalid subscriptions API key");
}

function matchesSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return Boolean(expected && left.length === right.length && timingSafeEqual(left, right));
}

const pushAuth = new OAuth2Client();

export async function requireGooglePlayPush(request: FastifyRequest): Promise<void> {
  if (env.GOOGLE_PLAY_RTDN_AUDIENCE || env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL) {
    if (!env.GOOGLE_PLAY_RTDN_AUDIENCE || !env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL) {
      throw unauthorized("Google Play push authentication is incomplete");
    }
    const authorization = String(request.headers.authorization ?? "");
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    if (!token) throw unauthorized("Google Play push identity is required");
    try {
      const ticket = await pushAuth.verifyIdToken({ idToken: token, audience: env.GOOGLE_PLAY_RTDN_AUDIENCE });
      const claims = ticket.getPayload();
      if (claims?.email !== env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL || claims.email_verified !== true) {
        throw new Error("Unexpected push identity");
      }
      return;
    } catch {
      throw unauthorized("Invalid Google Play push identity");
    }
  }
  const token = (request.query as { token?: unknown })?.token;
  if (typeof token === "string" && matchesSecret(token, env.GOOGLE_PLAY_RTDN_TOKEN)) return;
  throw unauthorized("Invalid Google Play RTDN token");
}
