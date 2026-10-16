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
  TRUST_PROXY_CIDRS: z.string().default(""),
  GOOGLE_PLAY_RTDN_TOKEN: z.string().optional().default(""),
  GOOGLE_PLAY_RTDN_AUDIENCE: optionalUrl,
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: z.string().email().or(z.literal("")).default(""),
  GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED: booleanString(false),
  GOOGLE_PLAY_TAX_RATE_BPS: z.coerce.number().int().min(0).default(0),
  GOOGLE_PLAY_TAX_REGION: z.string().default("IN"),

  RAZORPAY_ENABLED: booleanString(false),
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(""),
  RAZORPAY_SUBSCRIPTION_PLAN_ID: z.string().optional().default("plan_TgMvWQzlmT0eVZ"),
  RAZORPAY_SUBSCRIPTION_TOTAL_COUNT: z.coerce.number().int().positive().default(120),
  RAZORPAY_LEGACY_KEY_ID: z.string().default(""),
  RAZORPAY_LEGACY_KEY_SECRET: z.string().default(""),
  RAZORPAY_LEGACY_WEBHOOK_SECRET: z.string().default(""),
  RAZORPAY_LEGACY_PLAN_ID: z.string().default(""),
  RAZORPAY_LEGACY_PLAN_AMOUNT: z.coerce.number().int().positive().default(49900),
  RAZORPAY_LEGACY_PLAN_CURRENCY: z.string().length(3).default("INR"),
  RAZORPAY_LIVE_TEST_PLAN_ID: z.string().default(""),
  RAZORPAY_LIVE_TEST_USER_ID: z.string().default(""),

  PAYMENT_CONFIRMATION_URL: optionalUrl,
  PAYMENT_CONFIRMATION_TOKEN: z.string().optional().default(""),
  REDIS_URL: optionalUrl,
  QUEUE_NAME: z.string().trim().min(1).default("subscriptions_payments"),
  QUEUE_WORKER_CONCURRENCY: z.coerce.number().int().positive().max(20).default(2),
  QUEUE_WORKER_ENABLED: booleanString(true),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  QUEUE_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(8),
  QUEUE_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  QUEUE_RETRY_MAX_SECONDS: z.coerce.number().int().positive().default(1800),
  QUEUE_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900)
}).superRefine((values, context) => {
  const legacy = [values.RAZORPAY_LEGACY_KEY_ID, values.RAZORPAY_LEGACY_KEY_SECRET,
    values.RAZORPAY_LEGACY_WEBHOOK_SECRET, values.RAZORPAY_LEGACY_PLAN_ID];
  if (legacy.some(Boolean) && (!legacy.every(Boolean) || values.RAZORPAY_LEGACY_KEY_ID === values.RAZORPAY_KEY_ID)) {
    context.addIssue({ code: "custom", path: ["RAZORPAY_LEGACY_KEY_ID"], message: "Configure a complete, distinct legacy merchant" });
  }
  if (Boolean(values.RAZORPAY_LIVE_TEST_PLAN_ID) !== Boolean(values.RAZORPAY_LIVE_TEST_USER_ID) ||
      (values.RAZORPAY_LIVE_TEST_USER_ID && (!values.RAZORPAY_KEY_ID.startsWith("rzp_live_") ||
        values.RAZORPAY_LIVE_TEST_PLAN_ID === values.RAZORPAY_SUBSCRIPTION_PLAN_ID ||
        !/^[a-f\d]{24}$/i.test(values.RAZORPAY_LIVE_TEST_USER_ID)))) {
    context.addIssue({ code: "custom", path: ["RAZORPAY_LIVE_TEST_USER_ID"], message: "Live verification requires a distinct plan and exact Eva user ID" });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${formatted}`);
}

export const env = parsed.data;
