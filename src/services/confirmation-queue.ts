import { env } from "../config/env.js";
import { QueueJobModel, type QueueJobDocument } from "../models/queue-job.model.js";

const JOB_TYPE = "payment_confirmation";

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
  await QueueJobModel.updateOne(
    { jobType: JOB_TYPE, idempotencyKey: payload.eventId },
    {
      $setOnInsert: {
        jobType: JOB_TYPE,
        idempotencyKey: payload.eventId,
        status: "pending",
        attempts: 0,
        maxAttempts: env.QUEUE_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
        payload
      }
    },
    { upsert: true }
  );
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

async function claimNextJob(): Promise<QueueJobDocument | null> {
  const now = new Date();
  return QueueJobModel.findOneAndUpdate(
    {
      jobType: JOB_TYPE,
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

async function processClaimedJob(job: QueueJobDocument): Promise<void> {
  try {
    const result = await deliverConfirmation(job.payload);
    await QueueJobModel.updateOne(
      { _id: job._id, status: "processing" },
      { $set: { status: "completed", completedAt: new Date(), lockedUntil: null, result } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Confirmation delivery failed";
    const shouldRetry = job.attempts < job.maxAttempts;
    await QueueJobModel.updateOne(
      { _id: job._id, status: "processing" },
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

async function deliverConfirmation(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.PAYMENT_CONFIRMATION_URL) {
    return { status: "skipped", reason: "PAYMENT_CONFIRMATION_URL is not configured" };
  }

  const response = await fetch(env.PAYMENT_CONFIRMATION_URL, {
    method: "POST",
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
