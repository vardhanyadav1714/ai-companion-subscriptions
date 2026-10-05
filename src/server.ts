import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./database/mongodb.js";
import { ensureDefaultPlan } from "./services/subscriptions.js";
import { processDueConfirmationJobs, closeConfirmationQueue } from "./services/confirmation-queue.js";

async function start() {
  await connectMongo();
  await ensureDefaultPlan();

  const app = await buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
  let running: Promise<unknown> | undefined;
  const sweep = () => {
    if (running) return;
    running = processDueConfirmationJobs().catch(() => app.log.error("Billing queue sweep failed"))
      .finally(() => { running = undefined; });
  };
  const timer = env.QUEUE_WORKER_ENABLED ? setInterval(sweep, env.QUEUE_POLL_INTERVAL_MS) : undefined;
  if (timer) sweep();
  const stop = async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await running;
    await closeConfirmationQueue();
    await disconnectMongo();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
