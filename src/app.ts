import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";

import { env } from "./config/index.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: ["req.headers.x-service-api-key", "*.secret", "*.apiKey"],
        censor: "[redacted]"
      }
    }
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await registerRoutes(app);

  return app;
}

