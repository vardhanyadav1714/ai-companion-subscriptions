import { z } from "zod";
import { badRequest } from "../errors.js";
import { env } from "../config/env.js";

const notificationSchema = z.object({
  packageName: z.string(),
  subscriptionNotification: z.object({ purchaseToken: z.string().min(1), notificationType: z.number().int() }).optional(),
  voidedPurchaseNotification: z.object({ purchaseToken: z.string().min(1), orderId: z.string().min(1), productType: z.number().int(), refundType: z.number().int().optional() }).optional(),
  testNotification: z.record(z.unknown()).optional()
});

export function decodePlayNotification(payload: Record<string, unknown>) {
  const envelope = z.object({ message: z.object({ data: z.string().min(1), messageId: z.string().min(1) }) }).parse(payload);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope.message.data, "base64").toString("utf8"));
  } catch {
    throw badRequest("Malformed Google Play notification data");
  }
  const notification = notificationSchema.parse(decoded);
  if (notification.packageName !== env.GOOGLE_PLAY_PACKAGE_NAME) throw badRequest("RTDN package does not match Eva");
  const subscription = notification.subscriptionNotification;
  const voided = notification.voidedPurchaseNotification;
  return {
    notification,
    eventId: `google_play:${envelope.message.messageId}`,
    eventType: notification.testNotification ? "TEST_NOTIFICATION" : voided ? "VOIDED_PURCHASE" : `SUBSCRIPTION_${subscription?.notificationType ?? "UNKNOWN"}`,
    purchaseToken: subscription?.purchaseToken ?? (voided?.productType === 1 ? voided.purchaseToken : "")
  };
}
