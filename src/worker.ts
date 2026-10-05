import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./database/mongodb.js";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { enqueueDueSubscriptionSyncs } from "./services/subscriptions.js";
import {
  dispatchDueConfirmationJobs,
  processConfirmationJobById,
  processDueConfirmationJobs,
  closeConfirmationQueue
} from "./services/confirmation-queue.js";

async function start(): Promise<void> {
  await connectMongo();
  console.info("Eva subscription confirmation worker started");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const redisConnection = env.REDIS_URL
    ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
    : null;
  const redisWorker = redisConnection
    ? new Worker(
        env.QUEUE_NAME,
        async (job) => processConfirmationJobById(String((job.data as { jobId: string }).jobId)),
        { connection: redisConnection, concurrency: env.QUEUE_WORKER_CONCURRENCY }
      )
    : null;
  redisWorker?.on("failed", (job, error) => console.error("Confirmation queue job failed", job?.id, error));
  redisWorker?.on("error", () => console.error("Redis worker unavailable; MongoDB polling continues"));

  while (!stopping) {
    try {
      await enqueueDueSubscriptionSyncs();
      await dispatchDueConfirmationJobs();
      await processDueConfirmationJobs();
    } catch (error) {
      console.error("Confirmation queue sweep failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.QUEUE_POLL_INTERVAL_MS));
  }
  await redisWorker?.close();
  redisConnection?.disconnect();
  await closeConfirmationQueue();
  await disconnectMongo();
  process.exit(0);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
