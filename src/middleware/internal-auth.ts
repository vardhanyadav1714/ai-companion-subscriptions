import type { FastifyRequest } from "fastify";

import { env } from "../config/index.js";
import { AppError } from "../errors/app-error.js";

export type InternalUser = {
  userId: string;
  userEmail: string;
};

export function requireInternalUser(request: FastifyRequest): InternalUser {
  const apiKey = String(request.headers["x-service-api-key"] ?? "");
  if (!apiKey || apiKey !== env.SERVICE_API_KEY) {
    throw AppError.authenticationRequired("Valid service API key is required");
  }

  const userId = String(request.headers["x-user-id"] ?? "").trim();
  const userEmail = String(request.headers["x-user-email"] ?? "").trim().toLowerCase();
  if (!userId || !userEmail) {
    throw AppError.badRequest("x-user-id and x-user-email headers are required");
  }

  return { userId, userEmail };
}

