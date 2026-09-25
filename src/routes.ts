import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { badRequest } from "./errors.js";
import { requireInternalKey } from "./security.js";
import {
  confirmGooglePlayPurchase,
  confirmRazorpayPayment,
  createRazorpayCheckout,
  getEntitlement,
  listPlans,
  processGooglePlayRtdn,
  processRazorpayWebhook,
  syncSubscription
} from "./services/subscriptions.js";
import { processDueConfirmationJobs } from "./services/confirmation-queue.js";
import { QueueJobModel } from "./models/queue-job.model.js";
import { success } from "./utils/response.js";

const userSchema = z.object({
  userId: z.string().trim().min(1).max(160),
  email: z.string().trim().email().optional(),
  name: z.string().trim().max(160).optional(),
  externalTransactionToken: z.string().min(1).max(4096).optional()
});

const googlePlayConfirmSchema = userSchema.extend({
  productId: z.string().trim().min(1),
  purchaseToken: z.string().trim().min(10)
});

const razorpayConfirmSchema = z.object({
  userId: z.string().trim().min(1).max(160),
  razorpayPaymentId: z.string().trim().min(1),
  razorpaySubscriptionId: z.string().trim().min(1),
  razorpaySignature: z.string().trim().min(1)
});

const syncSchema = z.object({
  userId: z.string().trim().min(1).max(160),
  provider: z.enum(["google_play", "razorpay"]).optional(),
  providerSubscriptionId: z.string().trim().optional(),
  purchaseToken: z.string().trim().optional()
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/internal/queue/status", async request => {
    requireInternalKey(request);
    return success(await QueueJobModel.aggregate([{ $group: { _id: { type: "$jobType", status: "$status" }, count: { $sum: 1 } } }]));
  });
  app.post("/api/v1/internal/queue/:id/retry", async request => {
    requireInternalKey(request);
    const { id } = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }).parse(request.params);
    const result = await QueueJobModel.updateOne({ _id: id, status: "failed" }, {
      $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: "" }
    });
    return success({ retried: result.modifiedCount === 1 });
  });
  app.get("/health", async () => success({ service: "eva-subscriptions", status: "ok" }));

  app.get("/api/v1/plans", async () => success({ plans: await listPlans() }));

  app.post("/api/v1/internal/queue/process", async (request: FastifyRequest) => {
    requireInternalKey(request);
    return success({ processed: await processDueConfirmationJobs() });
  });

  app.get("/api/v1/subscriptions/:userId", async (request: FastifyRequest) => {
    requireInternalKey(request);
    const params = z.object({ userId: z.string().trim().min(1) }).parse(request.params);
    return success(await getEntitlement(params.userId));
  });

  app.post("/api/v1/subscriptions/checkout/razorpay", async (request: FastifyRequest) => {
    requireInternalKey(request);
    const body = userSchema.parse(request.body ?? {});
    return success(await createRazorpayCheckout(body));
  });

  app.post("/api/v1/subscriptions/confirm/razorpay", async (request: FastifyRequest) => {
    requireInternalKey(request);
    const body = razorpayConfirmSchema.parse(request.body ?? {});
    return success(await confirmRazorpayPayment(body));
  });

  app.post("/api/v1/subscriptions/confirm/google-play", async (request: FastifyRequest) => {
    requireInternalKey(request);
    const body = googlePlayConfirmSchema.parse(request.body ?? {});
    return success(await confirmGooglePlayPurchase(body));
  });

  app.post("/api/v1/subscriptions/sync", async (request: FastifyRequest) => {
    requireInternalKey(request);
    const body = syncSchema.parse(request.body ?? {});
    return success(await syncSubscription(body));
  });

  app.post("/api/v1/webhooks/razorpay", async (request: FastifyRequest) => {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody) throw badRequest("Raw body is required for webhook verification");
    const signature = String(request.headers["x-razorpay-signature"] ?? "");
    const eventId = String(request.headers["x-razorpay-event-id"] ?? "");
    const payload = z.record(z.unknown()).parse(request.body ?? {});
    return success(await processRazorpayWebhook({ rawBody, signature, eventId, payload }));
  });

  app.post("/api/v1/webhooks/google-play/rtdn", async (request: FastifyRequest) => {
    const query = z.object({ token: z.string().optional() }).parse(request.query ?? {});
    const payload = z.record(z.unknown()).parse(request.body ?? {});
    return success(await processGooglePlayRtdn({ token: query.token, payload }));
  });
}
