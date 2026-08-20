import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireInternalUser } from "../middleware/internal-auth.js";
import { SubscriptionModel, type SubscriptionDocument } from "../models/subscription.model.js";
import {
  createSubscription,
  dateFromUnixSeconds,
  fetchSubscription,
  isPremiumStatus,
  isReusableCheckoutStatus,
  premiumPlan
} from "../services/razorpay.js";
import { success } from "../utils/api-response.js";

export async function registerSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/plans/premium", async () => success(premiumPlan()));

  app.get("/subscriptions/me", async (request: FastifyRequest) => {
    const user = requireInternalUser(request);
    const subscription = await latestSyncedSubscription(user.userId);
    return success(serializeState(subscription));
  });

  app.post("/subscriptions/sync", async (request: FastifyRequest) => {
    const user = requireInternalUser(request);
    const subscription = await latestSyncedSubscription(user.userId, true);
    return success(serializeState(subscription));
  });

  app.post("/subscriptions/checkout", async (request: FastifyRequest) => {
    const user = requireInternalUser(request);
    const plan = premiumPlan();
    const latest = await latestSyncedSubscription(user.userId, true);

    if (latest?.active) {
      return success({
        subscription: serializeState(latest),
        checkout: null
      });
    }

    if (
      latest &&
      isReusableCheckoutStatus(latest.status) &&
      latest.checkoutUrl &&
      latest.planId === plan.planId
    ) {
      return success({
        subscription: serializeState(latest),
        checkout: {
          provider: "razorpay",
          subscriptionId: latest.providerSubscriptionId ?? "",
          checkoutUrl: latest.checkoutUrl
        }
      });
    }

    const created = await createSubscription(user.userId, user.userEmail);
    const status = normalizeStatus(created.status);
    const subscription = await SubscriptionModel.create({
      userId: user.userId,
      userEmail: user.userEmail,
      providerSubscriptionId: created.id,
      planId: created.plan_id || plan.planId,
      planName: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      status,
      active: isPremiumStatus(status),
      checkoutUrl: created.short_url ?? "",
      currentStart: dateFromUnixSeconds(created.current_start),
      currentEnd: dateFromUnixSeconds(created.current_end),
      endedAt: dateFromUnixSeconds(created.ended_at),
      lastSyncedAt: new Date(),
      providerPayload: created
    });

    return success({
      subscription: serializeState(subscription.toObject() as SubscriptionDocument),
      checkout: {
        provider: "razorpay",
        subscriptionId: created.id,
        checkoutUrl: created.short_url ?? ""
      }
    });
  });
}

async function latestSyncedSubscription(
  userId: string,
  forceSync = false
): Promise<SubscriptionDocument | null> {
  const latest = await SubscriptionModel.findOne({ userId }).sort({ updatedAt: -1 });
  if (!latest) {
    return null;
  }

  const subscription = latest.toObject() as SubscriptionDocument;
  if (!subscription.providerSubscriptionId || (!forceSync && recentlySynced(subscription.lastSyncedAt))) {
    return subscription;
  }

  const remote = await fetchSubscription(subscription.providerSubscriptionId);
  const status = normalizeStatus(remote.status);
  const updated = await SubscriptionModel.findByIdAndUpdate(
    subscription._id.toString(),
    {
      $set: {
        planId: remote.plan_id || subscription.planId,
        status,
        active: isPremiumStatus(status),
        checkoutUrl: remote.short_url ?? subscription.checkoutUrl ?? "",
        currentStart: dateFromUnixSeconds(remote.current_start),
        currentEnd: dateFromUnixSeconds(remote.current_end),
        endedAt: dateFromUnixSeconds(remote.ended_at),
        lastSyncedAt: new Date(),
        providerPayload: remote
      }
    },
    { new: true }
  );

  return (updated?.toObject() as SubscriptionDocument | undefined) ?? subscription;
}

function serializeState(subscription: SubscriptionDocument | null) {
  const plan = premiumPlan();
  if (!subscription) {
    return {
      active: false,
      status: "none",
      provider: "razorpay",
      plan
    };
  }

  return {
    active: subscription.active,
    status: subscription.status,
    provider: "razorpay",
    providerSubscriptionId: subscription.providerSubscriptionId ?? "",
    checkoutUrl: subscription.checkoutUrl ?? "",
    plan: {
      ...plan,
      planId: subscription.planId || plan.planId,
      name: subscription.planName || plan.name,
      amount: subscription.amount || plan.amount,
      currency: subscription.currency || plan.currency
    },
    currentStart: subscription.currentStart?.toISOString() ?? null,
    currentEnd: subscription.currentEnd?.toISOString() ?? null,
    endedAt: subscription.endedAt?.toISOString() ?? null,
    lastSyncedAt: subscription.lastSyncedAt?.toISOString() ?? null
  };
}

function normalizeStatus(status: unknown): SubscriptionDocument["status"] {
  if (typeof status !== "string") {
    return "unknown";
  }
  const normalized = status.toLowerCase();
  if (
    normalized === "created" ||
    normalized === "authenticated" ||
    normalized === "active" ||
    normalized === "pending" ||
    normalized === "halted" ||
    normalized === "cancelled" ||
    normalized === "completed" ||
    normalized === "expired"
  ) {
    return normalized;
  }
  return "unknown";
}

function recentlySynced(value: Date | null | undefined): boolean {
  return value ? Date.now() - value.getTime() < 60_000 : false;
}

