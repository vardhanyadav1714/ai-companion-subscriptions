import "dotenv/config";
import mongoose from "mongoose";

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DATABASE || "eva_subscriptions" });
try {
  for (const [name, field] of [["subscriptions", "providerSubscriptionId"], ["subscriptions", "purchaseToken"], ["payments", "providerPaymentId"]]) {
    const collection = mongoose.connection.db.collection(name);
    const indexName = `provider_1_${field}_1`;
    const indexes = await collection.listIndexes().toArray();
    const existing = indexes.find(index => index.name === indexName);
    if (existing?.partialFilterExpression) continue;
    console.log(`${process.argv.includes("--apply") ? "Migrating" : "Would migrate"} ${name}.${indexName}`);
    if (!process.argv.includes("--apply")) continue;
    // Run only with API and worker stopped after backing up the database.
    if (existing) await collection.dropIndex(indexName);
    await collection.createIndex({ provider: 1, [field]: 1 }, {
      name: indexName, unique: true, partialFilterExpression: { [field]: { $type: "string" } }
    });
  }
} finally {
  await mongoose.disconnect();
}
