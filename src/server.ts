import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo } from "./database/mongodb.js";
import { ensureDefaultPlan } from "./services/subscriptions.js";

async function start() {
  await connectMongo();
  await ensureDefaultPlan();

  const app = await buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
