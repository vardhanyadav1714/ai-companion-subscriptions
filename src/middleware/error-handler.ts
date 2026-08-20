import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { env } from "../config/index.js";
import { AppError } from "../errors/app-error.js";
import { failure } from "../utils/api-response.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ method: request.method, url: request.url }, "Route not found");
    return reply.status(404).send(failure("NOT_FOUND", "Route not found"));
  });

  app.setErrorHandler((error, request, reply) => handleError(error, request, reply));
}

function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof AppError) {
    request.log.warn({ code: error.code, statusCode: error.statusCode }, error.message);
    return reply.status(error.statusCode).send(failure(error.code, error.message, error.details));
  }

  if (error instanceof ZodError) {
    return reply.status(400).send(failure("BAD_REQUEST", "Request validation failed", error.flatten()));
  }

  request.log.error({ err: error }, "Unhandled server error");
  return reply.status(500).send(
    failure(
      "INTERNAL_SERVER_ERROR",
      "Internal server error",
      env.NODE_ENV === "production" ? undefined : { message: getErrorMessage(error) }
    )
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

