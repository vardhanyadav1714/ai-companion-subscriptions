import { env } from "../config/env.js";
import { QueueJobModel, type QueueJobDocument } from "../models/queue-job.model.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const JOB_TYPE = "payment_confirmation";
let queue: Queue | null = null;

function getQueue(): Queue | null {
  if (!env.REDIS_URL) return null;
  queue ??= new Queue(env.QUEUE_NAME, {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, commandTimeout: 3000 })
  });
  return queue;
}

export type PaymentConfirmation = {
  eventId: string;
  userId: string;
  provider: "google_play" | "razorpay";
  eventType: string;
  planId: string;
  active: boolean;
  status: string;
  amount: number;
  currency: string;
  providerSubscriptionId: string;
  currentEnd: string | null;
};

export async function enqueuePaymentConfirmation(payload: PaymentConfirmation): Promise<void> {
  await enqueueJob(JOB_TYPE, payload.eventId, payload);
}

export async function enqueueJob(jobType: string, eventId: string, payload: Record<string, unknown>): Promise<void> {
  const job = await QueueJobModel.findOneAndUpdate(
    { jobType, idempotencyKey: eventId },
    {
      $setOnInsert: {
        jobType,
        idempotencyKey: eventId,
        status: "pending",
        attempts: 0,
        maxAttempts: env.QUEUE_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
        payload
      }
    },
    { upsert: true, new: true }
  ).lean<QueueJobDocument>();
  if (job && job.status !== "completed") await dispatchConfirmationJob(job);
}

export async function dispatchDueConfirmationJobs(limit = env.QUEUE_BATCH_SIZE): Promise<number> {
  const jobs = await QueueJobModel.find({
    status: { $in: ["pending", "retrying"] },
    nextAttemptAt: { $lte: new Date() }
  }).sort({ nextAttemptAt: 1, createdAt: 1 }).limit(limit).lean<QueueJobDocument[]>();
  for (const job of jobs) await dispatchConfirmationJob(job);
  return jobs.length;
}

export async function processConfirmationJobById(jobId: string): Promise<boolean> {
  const job = await claimNextJob({ _id: jobId });
  if (!job) return false;
  await processClaimedJob(job);
  return true;
}

export async function processDueConfirmationJobs(limit = env.QUEUE_BATCH_SIZE): Promise<number> {
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = await claimNextJob();
    if (!job) break;
    await processClaimedJob(job);
    processed += 1;
  }
  return processed;
}

export function retryDelaySeconds(attempt: number): number {
  return Math.min(env.QUEUE_RETRY_MAX_SECONDS, env.QUEUE_RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
}

export const confirmationQueueJobType = JOB_TYPE;

async function claimNextJob(filter: Record<string, unknown> = {}): Promise<QueueJobDocument | null> {
  const now = new Date();
  return QueueJobModel.findOneAndUpdate(
    {
      ...filter,
      nextAttemptAt: { $lte: now },
      $or: [
        { status: { $in: ["pending", "retrying"] } },
        { status: "processing", lockedUntil: { $lt: now } }
      ]
    },
    {
      $set: {
        status: "processing",
        lockedUntil: new Date(now.getTime() + env.QUEUE_LEASE_SECONDS * 1000)
      },
      $inc: { attempts: 1 }
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true }
  ).lean<QueueJobDocument>();
}

async function dispatchConfirmationJob(job: QueueJobDocument): Promise<void> {
  const currentQueue = getQueue();
  if (!currentQueue) return;
  try {
    await currentQueue.add("payment-confirmation", { jobId: job._id.toString() }, {
      jobId: `${JOB_TYPE}-${job._id.toString()}-${job.attempts}`,
      removeOnComplete: true,
      removeOnFail: true
    });
  } catch (error) {
    console.error("Could not dispatch confirmation job to Redis", error);
  }
}

async function processClaimedJob(job: QueueJobDocument): Promise<void> {
  try {
    const result = job.jobType === JOB_TYPE ? await deliverConfirmation(job.payload) : await processProviderEvent(job);
    await QueueJobModel.updateOne(
      { _id: job._id, status: "processing", attempts: job.attempts },
      { $set: { status: "completed", completedAt: new Date(), lockedUntil: null, result } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Confirmation delivery failed";
    const shouldRetry = job.attempts < job.maxAttempts;
    await QueueJobModel.updateOne(
      { _id: job._id, status: "processing", attempts: job.attempts },
      {
        $set: {
          status: shouldRetry ? "retrying" : "failed",
          nextAttemptAt: shouldRetry ? new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000) : new Date(8640000000000000),
          lockedUntil: null,
          lastError: message
        }
      }
    );
  }
}

async function processProviderEvent(job: QueueJobDocument): Promise<Record<string, unknown>> {
  if (job.jobType === "google_play_acknowledge") {
    const { acknowledgeSubscription } = await import("../providers/google-play.js");
    return acknowledgeSubscription(String(job.payload.purchaseToken));
  }
  if (job.jobType === "external_transaction") {
    const { reportExternalTransaction } = await import("../providers/google-play.js");
    return reportExternalTransaction(job.payload);
  }
  const service = await import("./subscriptions.js");
  if (job.jobType === "razorpay_webhook") {
    return service.processRazorpayWebhook({ rawBody: Buffer.alloc(0), signature: "", eventId: job.idempotencyKey, payload: job.payload }, true);
  }
  if (job.jobType === "google_play_rtdn") {
    return service.processGooglePlayRtdn({ payload: job.payload }, true);
  }
  throw new Error("Unknown subscription job type");
}

async function deliverConfirmation(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.PAYMENT_CONFIRMATION_URL) {
    throw new Error("PAYMENT_CONFIRMATION_URL is not configured");
  }

  const response = await fetch(env.PAYMENT_CONFIRMATION_URL, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      ...(env.PAYMENT_CONFIRMATION_TOKEN ? { Authorization: `Bearer ${env.PAYMENT_CONFIRMATION_TOKEN}` } : {})
    },
    body: JSON.stringify({ type: JOB_TYPE, data: payload })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Confirmation endpoint returned ${response.status}: ${body.slice(0, 240)}`);
  return { status: "sent", statusCode: response.status, body: body.slice(0, 500) };
}
