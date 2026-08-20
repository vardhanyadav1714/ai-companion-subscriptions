import type { FastifyInstance } from "fastify";

import { mongoState } from "../database.js";
import { success } from "../utils/api-response.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () =>
    success({
      status: "ok",
      mongodb: mongoState(),
      uptimeSeconds: Math.round(process.uptime())
    })
  );
}

