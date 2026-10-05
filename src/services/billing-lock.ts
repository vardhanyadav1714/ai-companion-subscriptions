import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { serviceUnavailable } from "../errors.js";

const schema = new mongoose.Schema({
  _id: String, owner: String, lockedUntil: Date
}, { timestamps: true });
const BillingLockModel = mongoose.models.BillingLock ?? mongoose.model("BillingLock", schema);

export async function withBillingLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const id = createHash("sha256").update(key).digest("hex");
  const owner = randomUUID();
  let lock;
  try {
    lock = await BillingLockModel.findOneAndUpdate({ _id: id, lockedUntil: { $lte: new Date() } }, {
      $set: { owner, lockedUntil: new Date(Date.now() + 300_000) }
    }, { upsert: true, new: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    throw serviceUnavailable("Another billing operation is in progress. Please try again shortly.");
  }
  if (!lock) throw serviceUnavailable("Billing operation could not be claimed");
  try {
    return await operation();
  } finally {
    await BillingLockModel.updateOne({ _id: id, owner }, { $set: { lockedUntil: new Date(0) } });
  }
}
