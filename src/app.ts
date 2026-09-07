import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify from "fastify";

import { env } from "./config/env.js";
import { HttpError } from "./errors.js";
import { registerRoutes } from "./routes.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as typeof request & { rawBody?: Buffer }).rawBody = rawBody;
    if (rawBody.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch (error) {
      done(error as Error);
    }
  });

  await app.register(sensible);
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
    credentials: true
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  await registerRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        success: false,
        error: {
          message: error.message,
          details: error.details
        }
      });
      return;
    }

    const appError = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof appError.statusCode === "number" ? appError.statusCode : 500;
    const message = typeof appError.message === "string" ? appError.message : "Request failed";
    reply.status(statusCode).send({
      success: false,
      error: {
        message: statusCode >= 500 ? "Internal server error" : message
      }
    });
  });

  return app;
}
