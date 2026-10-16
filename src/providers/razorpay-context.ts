import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";
import { serviceUnavailable } from "../errors.js";
import { SubscriptionModel, PaymentModel, type SubscriptionDocument } from "../models.js";

export type RazorpayProfile = {
  keyId: string; keySecret: string; webhookSecret: string; planId: string;
  amount: number; currency: string; totalCount: number;
};

const context = new AsyncLocalStorage<RazorpayProfile>();

export function primaryRazorpayProfile(): RazorpayProfile {
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    planId: env.RAZORPAY_SUBSCRIPTION_PLAN_ID, amount: env.PLAN_AMOUNT, currency: env.PLAN_CURRENCY,
    totalCount: env.RAZORPAY_SUBSCRIPTION_TOTAL_COUNT };
}

function legacyRazorpayProfile(): RazorpayProfile | null {
  if (!env.RAZORPAY_LEGACY_KEY_ID) return null;
  if (!env.RAZORPAY_LEGACY_KEY_SECRET || !env.RAZORPAY_LEGACY_WEBHOOK_SECRET || !env.RAZORPAY_LEGACY_PLAN_ID ||
      env.RAZORPAY_LEGACY_KEY_ID === env.RAZORPAY_KEY_ID) throw serviceUnavailable("Legacy merchant configuration is incomplete or ambiguous");
  return { ...primaryRazorpayProfile(), keyId: env.RAZORPAY_LEGACY_KEY_ID, keySecret: env.RAZORPAY_LEGACY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_LEGACY_WEBHOOK_SECRET, planId: env.RAZORPAY_LEGACY_PLAN_ID,
    amount: env.RAZORPAY_LEGACY_PLAN_AMOUNT, currency: env.RAZORPAY_LEGACY_PLAN_CURRENCY };
}

export function razorpayWebhookProfiles(): RazorpayProfile[] {
  const legacy = legacyRazorpayProfile();
  return [primaryRazorpayProfile(), ...(legacy ? [legacy] : [])];
}

export function checkoutRazorpayProfile(userId: string): RazorpayProfile {
  const profile = primaryRazorpayProfile();
  if (!env.RAZORPAY_LIVE_TEST_USER_ID || userId !== env.RAZORPAY_LIVE_TEST_USER_ID) return profile;
  if (!profile.keyId.startsWith("rzp_live_") || !env.RAZORPAY_LIVE_TEST_PLAN_ID ||
      env.RAZORPAY_LIVE_TEST_PLAN_ID === profile.planId) throw serviceUnavailable("Restricted live verification plan is not configured");
  return { ...profile, planId: env.RAZORPAY_LIVE_TEST_PLAN_ID, amount: 100, currency: "INR", totalCount: 1 };
}

export function storedRazorpayProfile(subscription: Pick<SubscriptionDocument, "razorpayMerchantKeyId" | "productId" | "billingAmount" | "billingCurrency">): RazorpayProfile {
  const primary = primaryRazorpayProfile();
  const legacy = legacyRazorpayProfile();
  const keyId = subscription.razorpayMerchantKeyId;
  const profile = !keyId ? legacy ?? primary : keyId === primary.keyId ? primary : keyId === legacy?.keyId ? legacy : null;
  if (!profile) throw serviceUnavailable("Original payment merchant credentials are unavailable");
  return { ...profile, planId: subscription.productId || profile.planId,
    amount: subscription.billingAmount ?? profile.amount, currency: subscription.billingCurrency || profile.currency };
}

export async function webhookRazorpayProfile(payload: Record<string, unknown>, candidates = razorpayWebhookProfiles()): Promise<RazorpayProfile> {
  const body = payload.payload as Record<string, { entity?: Record<string, unknown> }> | undefined;
  const subscriptionId = body?.subscription?.entity?.id ?? body?.payment?.entity?.subscription_id;
  if (typeof subscriptionId === "string") {
    const subscription = await SubscriptionModel.findOne({ provider: "razorpay", providerSubscriptionId: subscriptionId });
    if (subscription) return storedRazorpayProfile(subscription);
  }
  const paymentId = body?.payment?.entity?.id ?? body?.refund?.entity?.payment_id;
  if (typeof paymentId === "string") {
    const receipt = await PaymentModel.findOne({ provider: "razorpay", providerPaymentId: paymentId });
    if (receipt?.subscriptionId) {
      const subscription = await SubscriptionModel.findById(receipt.subscriptionId);
      if (subscription) return storedRazorpayProfile(subscription);
    }
  }
  // Some payment/refund events omit the subscription ID. Only re-fetch from
  // merchants whose webhook signatures have already been accepted by the caller.
  const invoiceId = body?.payment?.entity?.invoice_id;
  const refundId = body?.refund?.entity?.id;
  if (typeof invoiceId === "string" || typeof refundId === "string") {
    const provider = await import("./razorpay.js");
    for (const candidate of candidates) {
      let linkedId: string | undefined;
      let linkedPaymentId: string | undefined;
      try {
        await withRazorpayProfile(candidate, async () => {
          if (typeof invoiceId === "string") linkedId = (await provider.fetchRazorpayInvoice(invoiceId))?.subscription_id;
          else linkedPaymentId = (await provider.fetchRazorpayRefund(String(refundId)))?.payment_id;
        });
      } catch { continue; }
      const receipt = linkedPaymentId ? await PaymentModel.findOne({ provider: "razorpay", providerPaymentId: linkedPaymentId }) : null;
      const subscription = linkedId ? await SubscriptionModel.findOne({ provider: "razorpay", providerSubscriptionId: linkedId })
        : receipt?.subscriptionId ? await SubscriptionModel.findById(receipt.subscriptionId) : null;
      if (subscription) {
        const profile = storedRazorpayProfile(subscription);
        if (profile.keyId === candidate.keyId) return profile;
      }
    }
  }
  const remote = body?.subscription?.entity;
  const notes = remote?.notes as Record<string, unknown> | undefined;
  if (remote?.plan_id === env.RAZORPAY_LIVE_TEST_PLAN_ID && notes?.userId === env.RAZORPAY_LIVE_TEST_USER_ID &&
      env.RAZORPAY_LIVE_TEST_USER_ID) return checkoutRazorpayProfile(env.RAZORPAY_LIVE_TEST_USER_ID);
  return candidates[0] ?? primaryRazorpayProfile();
}

export function razorpayProfile(): RazorpayProfile { return context.getStore() ?? primaryRazorpayProfile(); }
export function withRazorpayProfile<T>(profile: RazorpayProfile, action: () => Promise<T>): Promise<T> {
  return context.run(profile, action);
}
