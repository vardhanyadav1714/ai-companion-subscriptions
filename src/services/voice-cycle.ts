import { createHash } from "node:crypto";

type CycleSubscription = {
  provider: string; providerSubscriptionId?: string; status: string;
  currentStart?: Date; currentEnd?: Date; latestOrderId?: string; providerPayload?: unknown; productId?: string;
};

export function voiceBillingCycleId(subscription: CycleSubscription): string | null {
  let cycle: string | undefined;
  if (subscription.provider === "google_play") {
    const payload = subscription.providerPayload as { lineItems?: Array<{ productId?: string; latestSuccessfulOrderId?: string }> } | undefined;
    cycle = payload?.lineItems?.find(item => item.latestSuccessfulOrderId && (!subscription.productId || item.productId === subscription.productId))?.latestSuccessfulOrderId;
    // A pending/failed latestOrderId or an extended grace expiry is not a paid renewal.
    // Older cached responses must be refreshed before granting a new voice budget.
  } else if (subscription.provider === "razorpay" && subscription.currentStart && Number.isFinite(subscription.currentStart.getTime())) {
    cycle = subscription.currentStart.toISOString();
  }
  if (!cycle || !subscription.providerSubscriptionId) return null;
  return createHash("sha256").update(JSON.stringify([subscription.provider, subscription.providerSubscriptionId, cycle])).digest("hex");
}
