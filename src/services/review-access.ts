import { createHash } from "node:crypto";
import { env } from "../config/env.js";

// A server-configured demo identity, separate from customers and temporary QA grants.
export function getPlayReviewAccess(userId: string, now = new Date()) {
  if (!env.PLAY_REVIEW_USER_ID || userId !== env.PLAY_REVIEW_USER_ID) return null;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    currentEnd: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
    voiceCycleId: createHash("sha256").update(`play-review:${userId}:${year}-${month + 1}`).digest("hex")
  };
}
