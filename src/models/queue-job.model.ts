import mongoose, { type Model } from "mongoose";

const { Schema, model, models } = mongoose;

export type QueueJobStatus = "pending" | "processing" | "retrying" | "completed" | "failed";

const queueJobSchema = new Schema(
  {
    jobType: { type: String, required: true, trim: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: ["pending", "processing", "retrying", "completed", "failed"], default: "pending", index: true },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 8 },
    nextAttemptAt: { type: Date, required: true, default: Date.now, index: true },
    lockedUntil: { type: Date },
    lastError: { type: String, default: "" },
    completedAt: { type: Date },
    payload: { type: Schema.Types.Mixed, required: true },
    result: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

queueJobSchema.index({ jobType: 1, idempotencyKey: 1 }, { unique: true });
queueJobSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });

export type QueueJobDocument = {
  _id: { toString(): string };
  jobType: string;
  idempotencyKey: string;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  lastError?: string;
  payload: Record<string, unknown>;
};

export const QueueJobModel: Model<QueueJobDocument> =
  (models.QueueJob as Model<QueueJobDocument> | undefined) ??
  model<QueueJobDocument>("QueueJob", queueJobSchema);
