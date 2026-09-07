import mongoose, { type Model } from "mongoose";

const { Schema, model, models } = mongoose;

export const subscriptionStatuses = [
  "created",
  "pending",
  "authenticated",
  "active",
  "grace_period",
  "on_hold",
  "paused",
  "halted",
  "cancelled",
  "completed",
  "expired",
  "revoked",
  "unknown"
] as const;

export type SubscriptionStatus = (typeof subscriptionStatuses)[number];
export type Provider = "google_play" | "razorpay";
type AnyDocument = Record<string, unknown>;

const userSchema = new Schema(
  {
    userId: { type: String, required: true, trim: true, unique: true },
    email: { type: String, trim: true, lowercase: true, index: true, sparse: true },
    name: { type: String, trim: true, default: "" },
    source: { type: String, trim: true, default: "ai-companion" }
  },
  { timestamps: true }
);

const planSchema = new Schema(
  {
    planId: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, trim: true, default: "INR" },
    interval: { type: String, required: true, enum: ["monthly", "yearly"], default: "monthly" },
    freeMessageLimit: { type: Number, required: true, default: 10 },
    paidDailyMessageLimit: { type: Number, required: true, default: 100 },
    googlePlayProductId: { type: String, trim: true, default: "" },
    googlePlayBasePlanId: { type: String, trim: true, default: "" },
    razorpayPlanId: { type: String, trim: true, default: "" },
    active: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

const subscriptionSchema = new Schema(
  {
    userId: { type: String, required: true, trim: true, index: true },
    provider: { type: String, required: true, enum: ["google_play", "razorpay"], index: true },
    providerSubscriptionId: { type: String, trim: true, index: true, sparse: true },
    purchaseToken: { type: String, trim: true, index: true, sparse: true },
    productId: { type: String, trim: true, default: "" },
    basePlanId: { type: String, trim: true, default: "" },
    planId: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: subscriptionStatuses, default: "pending" },
    active: { type: Boolean, required: true, default: false },
    autoRenew: { type: Boolean, required: true, default: false },
    checkoutUrl: { type: String, trim: true, default: "" },
    latestOrderId: { type: String, trim: true, default: "" },
    currentStart: { type: Date },
    currentEnd: { type: Date },
    cancelledAt: { type: Date },
    endedAt: { type: Date },
    lastSyncedAt: { type: Date },
    providerPayload: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

subscriptionSchema.index({ userId: 1, updatedAt: -1 });
subscriptionSchema.index({ provider: 1, providerSubscriptionId: 1 }, { unique: true, sparse: true });
subscriptionSchema.index({ provider: 1, purchaseToken: 1 }, { unique: true, sparse: true });

const paymentSchema = new Schema(
  {
    userId: { type: String, required: true, trim: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription", index: true },
    provider: { type: String, required: true, enum: ["google_play", "razorpay"], index: true },
    providerPaymentId: { type: String, trim: true, index: true, sparse: true },
    providerOrderId: { type: String, trim: true, index: true, sparse: true },
    amount: { type: Number, required: true, default: 0 },
    currency: { type: String, trim: true, default: "INR" },
    status: { type: String, required: true, enum: ["pending", "completed", "failed", "refunded"], default: "pending" },
    providerPayload: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

paymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true, sparse: true });

const webhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, trim: true, unique: true },
    provider: { type: String, required: true, enum: ["google_play", "razorpay"], index: true },
    eventType: { type: String, required: true, trim: true, index: true },
    status: { type: String, required: true, enum: ["processed", "skipped", "failed"], default: "processed" },
    reason: { type: String, trim: true, default: "" },
    payload: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

export type SubscriptionDocument = {
  _id: { toString(): string };
  userId: string;
  provider: Provider;
  providerSubscriptionId?: string;
  purchaseToken?: string;
  productId?: string;
  basePlanId?: string;
  planId: string;
  status: SubscriptionStatus;
  active: boolean;
  autoRenew: boolean;
  checkoutUrl?: string;
  latestOrderId?: string;
  currentStart?: Date;
  currentEnd?: Date;
  cancelledAt?: Date;
  endedAt?: Date;
  lastSyncedAt?: Date;
  providerPayload?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export const UserModel: Model<AnyDocument> =
  (models.User as Model<AnyDocument> | undefined) ?? model<AnyDocument>("User", userSchema);
export const PlanModel: Model<AnyDocument> =
  (models.Plan as Model<AnyDocument> | undefined) ?? model<AnyDocument>("Plan", planSchema);
export const SubscriptionModel: Model<SubscriptionDocument> =
  (models.Subscription as Model<SubscriptionDocument> | undefined) ??
  model<SubscriptionDocument>("Subscription", subscriptionSchema);
export const PaymentModel: Model<AnyDocument> =
  (models.Payment as Model<AnyDocument> | undefined) ?? model<AnyDocument>("Payment", paymentSchema);
export const WebhookEventModel: Model<AnyDocument> =
  (models.WebhookEvent as Model<AnyDocument> | undefined) ?? model<AnyDocument>("WebhookEvent", webhookEventSchema);
