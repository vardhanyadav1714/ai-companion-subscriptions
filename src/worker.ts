import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./database/mongodb.js";
import { processDueConfirmationJobs } from "./services/confirmation-queue.js";

async function start(): Promise<void> {
  await connectMongo();
  console.info("Eva subscription confirmation worker started");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await disconnectMongo();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  while (!stopping) {
    try {
      await processDueConfirmationJobs();
    } catch (error) {
      console.error("Confirmation queue sweep failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.QUEUE_POLL_INTERVAL_MS));
  }
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
