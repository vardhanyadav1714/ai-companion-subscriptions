import type { FastifyRequest } from "fastify";

import { env } from "./config/env.js";
import { unauthorized } from "./errors.js";

export function requireInternalKey(request: FastifyRequest): void {
  const expected = env.SUBSCRIPTIONS_API_KEY.trim();
  const headerKey = String(request.headers["x-subscriptions-key"] ?? "").trim();
  const authorization = String(request.headers.authorization ?? "").trim();
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";

  if (headerKey === expected || bearer === expected) return;
  throw unauthorized("Invalid subscriptions API key");
}
