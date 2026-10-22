import mongoose from "mongoose";
import { env } from "../config/env.js";
import { forbidden } from "../errors.js";

const schema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  grantedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  reason: { type: String, required: true, enum: ["website-qa"] }
}, { collection: "testaccessgrants" });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TestAccessModel = mongoose.model("TestAccessGrant", schema);
let indexes: Promise<unknown> | undefined;
const allowed = (userId: string) => Boolean(env.TEST_ACCESS_USER_ID && userId === env.TEST_ACCESS_USER_ID);

export async function getTestAccess(userId: string) {
  if (!allowed(userId)) return null;
  const now = new Date();
  // Expiry is enforced on reads, independently of asynchronous Mongo TTL cleanup.
  return TestAccessModel.findOne({ userId, grantedAt: { $lte: now }, expiresAt: { $gt: now }, revokedAt: { $exists: false } }).lean();
}

export async function grantTestAccess(userId: string) {
  if (!allowed(userId)) throw forbidden("Test access is disabled for this account");
  indexes ??= TestAccessModel.createIndexes().catch(error => { indexes = undefined; throw error; });
  await indexes;
  const now = new Date();
  // Retrying the operation cannot extend its expiry or reactivate a revoked grant.
  try {
    await TestAccessModel.updateOne({ userId }, { $setOnInsert: {
      userId, grantedAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000), reason: "website-qa"
    } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const grant = await getTestAccess(userId);
  if (!grant) throw forbidden("Test access has expired or was revoked");
  return grant;
}

export async function revokeTestAccess(userId: string) {
  if (!allowed(userId)) throw forbidden("Test access is disabled for this account");
  await TestAccessModel.updateOne({ userId }, { $set: { revokedAt: new Date() } });
}
