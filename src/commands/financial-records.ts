import mongoose from "mongoose";
import { env } from "../config/env.js";
import { PaymentModel, SubscriptionModel, WebhookEventModel } from "../models.js";

// Read-only: financial evidence must not be subject to an ordinary log TTL.
// Expiry remains an operator review because legal holds and valid purchase
// ownership must be checked before any deletion or anonymization.
async function main(): Promise<void> {
  // Do not use the application startup helper: it initializes indexes. Auditing
  // must inspect the existing indexes, without creating or repairing any.
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DATABASE,
    serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false });
  try {
    const collections = [];
    for (const model of [PaymentModel, SubscriptionModel, WebhookEventModel]) {
      const collection = mongoose.connection.db!.collection(model.collection.name);
      const count = await collection.estimatedDocumentCount();
      const indexes = await collection.listIndexes().toArray();
      const earliest = await collection.findOne({ createdAt: { $type: "date" } }, { sort: { createdAt: 1 }, projection: { _id: 0, createdAt: 1 } });
      collections.push({ collection: model.collection.name, count,
        earliestRecordAt: earliest?.createdAt instanceof Date ? earliest.createdAt.toISOString() : null,
        ttlIndexes: indexes.filter(index => index.expireAfterSeconds !== undefined).map(index => index.name) });
    }
    const verified = collections.every(collection => collection.ttlIndexes.length === 0);
    console.log(JSON.stringify({ readOnly: true, checkedAt: new Date().toISOString(),
      accountingYearsAfterFinancialYearEnd: 8, razorpayYearsAfterOrder: 10,
      manualExpiryReview: true, financialTtlAbsent: verified, collections }, null, 2));
    if (!verified) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}

void main().catch(() => { console.error("Financial retention audit could not complete; records and credentials withheld."); process.exitCode = 1; });
