import mongoose, { type Model } from "mongoose";

const { Schema, model, models } = mongoose;

export type SubscriptionStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "cancelled"
  | "completed"
  | "expired"
  | "unknown";

const subscriptionSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    userEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    providerSubscriptionId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    planId: {
      type: String,
      required: true,
      trim: true
    },
    planName: {
      type: String,
      required: true,
      trim: true
    },
    amount: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      required: true,
      default: "INR"
    },
    status: {
      type: String,
      required: true,
      default: "created"
    },
    active: {
      type: Boolean,
      required: true,
      default: false
    },
    checkoutUrl: {
      type: String,
      trim: true,
      default: ""
    },
    currentStart: Date,
    currentEnd: Date,
    endedAt: Date,
    lastSyncedAt: Date,
    providerPayload: Schema.Types.Mixed
  },
  {
    timestamps: true
  }
);

subscriptionSchema.index({ userId: 1, updatedAt: -1 });

export type SubscriptionDocument = {
  _id: { toString(): string };
  userId: string;
  userEmail: string;
  providerSubscriptionId?: string | null;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  status: SubscriptionStatus;
  active: boolean;
  checkoutUrl?: string | null;
  currentStart?: Date | null;
  currentEnd?: Date | null;
  endedAt?: Date | null;
  lastSyncedAt?: Date | null;
  providerPayload?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export const SubscriptionModel =
  (models.Subscription as Model<SubscriptionDocument> | undefined) ??
  model<SubscriptionDocument>("Subscription", subscriptionSchema);

