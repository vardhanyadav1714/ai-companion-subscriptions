import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { forbidden, serviceUnavailable } from "../errors.js";
import { SubscriptionModel, PaymentModel } from "../models.js";
import type { GooglePlaySubscriptionPurchase } from "../providers/google-play.js";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  packageName: { type: String, required: true },
  provider: { type: String, required: true }
}, { timestamps: true });
const PurchaseOwnerModel = mongoose.models.PurchaseOwner ?? mongoose.model("PurchaseOwner", schema);

export function googlePlayAccountId(userId: string): string {
  return createHash("sha256").update(`eva-google-play:v1:${userId}`).digest("hex");
}

export async function claimGooglePlayOwnership(userId: string, token: string, purchase: GooglePlaySubscriptionPurchase): Promise<void> {
  const accountId = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  if (accountId && accountId !== googlePlayAccountId(userId)) throw ownershipConflict();
  if (purchase.latestOrderId) {
    const receipt = await PaymentModel.findOne({ provider: "google_play", providerPaymentId: purchase.latestOrderId });
    if (receipt && receipt.userId !== userId) throw ownershipConflict();
  }
  const tokens = [...new Set([purchase.linkedPurchaseToken, token].filter((value): value is string => Boolean(value)))];
  if (purchase.latestOrderId) tokens.push(`order:${purchase.latestOrderId}`);
  // Check every linked identity before claiming any new token. A rejected
  // transfer must not reserve the replacement against its rightful owner.
  for (const purchaseToken of tokens) {
    const existing = await SubscriptionModel.findOne({ provider: "google_play", purchaseToken });
    if (existing && existing.userId !== userId) throw ownershipConflict();
    const previousOwner = await findGooglePlayOwner(purchaseToken);
    if (previousOwner && previousOwner !== userId) throw ownershipConflict();
  }
  for (const purchaseToken of tokens) {
    // Insert-only claims survive expiry, token replacement, and subscription cleanup.
    const id = createHash("sha256").update(`${env.GOOGLE_PLAY_PACKAGE_NAME}:${purchaseToken}`).digest("hex");
    try {
      await PurchaseOwnerModel.updateOne({ _id: id }, { $setOnInsert: {
        userId, packageName: env.GOOGLE_PLAY_PACKAGE_NAME, provider: "google_play"
      } }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const owner = await PurchaseOwnerModel.findById(id).lean<{ userId: string } | null>();
    if (!owner) throw serviceUnavailable("Purchase ownership could not be saved");
    if (owner.userId !== userId) throw ownershipConflict();
  }
}

export async function findGooglePlayOwner(token: string): Promise<string | null> {
  const id = createHash("sha256").update(`${env.GOOGLE_PLAY_PACKAGE_NAME}:${token}`).digest("hex");
  const owner = await PurchaseOwnerModel.findById(id).lean<{ userId: string } | null>();
  return owner?.userId ?? null;
}

function ownershipConflict() {
  return forbidden("This purchase belongs to another Eva account. Sign in with the account used to purchase.");
}
