import mongoose from "mongoose";

import { env } from "../config/env.js";
import { PaymentModel, SubscriptionModel, WebhookEventModel } from "../models.js";
import { QueueJobModel } from "../models/queue-job.model.js";

export async function connectMongo(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DATABASE,
    serverSelectionTimeoutMS: 8000
  });
  await Promise.all([PaymentModel.init(), SubscriptionModel.init(), WebhookEventModel.init(), QueueJobModel.init()]);
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
