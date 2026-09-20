import "dotenv/config";

import { z } from "zod";

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalUrl = z.string().url().or(z.literal("")).default("");

const booleanString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .default(String(defaultValue))
    .transform((value) => value.trim().toLowerCase() === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  SUBSCRIPTIONS_API_KEY: z.preprocess(blankAsUndefined, z.string().min(16)),

  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("eva_subscriptions"),

  PLAN_ID: z.string().trim().min(1).default("eva_premium_monthly"),
  PLAN_NAME: z.string().trim().min(1).default("Eva Premium Monthly"),
  PLAN_AMOUNT: z.coerce.number().int().positive().default(49900),
  PLAN_CURRENCY: z.string().trim().min(3).max(3).default("INR"),
  PLAN_INTERVAL: z.enum(["monthly", "yearly"]).default("monthly"),
  FREE_MESSAGE_LIMIT: z.coerce.number().int().nonnegative().default(10),
  PAID_DAILY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(100),

  GOOGLE_PLAY_PACKAGE_NAME: z.string().trim().min(1).default("com.eva.ai"),
  GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID: z.string().trim().min(1).default("eva_premium_monthly"),
  GOOGLE_PLAY_BASE_PLAN_ID: z.string().trim().min(1).default("monthly"),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional().default(""),
  GOOGLE_PLAY_RTDN_TOKEN: z.string().optional().default(""),

  RAZORPAY_ENABLED: booleanString(false),
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(""),
  RAZORPAY_SUBSCRIPTION_PLAN_ID: z.string().optional().default("plan_TRv3HKpujDyFoS"),
  RAZORPAY_SUBSCRIPTION_TOTAL_COUNT: z.coerce.number().int().positive().default(120),

  PAYMENT_CONFIRMATION_URL: optionalUrl,
  PAYMENT_CONFIRMATION_TOKEN: z.string().optional().default(""),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  QUEUE_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(8),
  QUEUE_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  QUEUE_RETRY_MAX_SECONDS: z.coerce.number().int().positive().default(1800),
  QUEUE_LEASE_SECONDS: z.coerce.number().int().positive().default(300)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${formatted}`);
}

export const env = parsed.data;
