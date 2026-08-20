import type { FastifyInstance } from "fastify";

import { registerHealthRoutes } from "./health.route.js";
import { registerSubscriptionRoutes } from "./subscriptions.route.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerHealthRoutes, { prefix: "/api/v1" });
  await app.register(registerSubscriptionRoutes, { prefix: "/api/v1" });
}

