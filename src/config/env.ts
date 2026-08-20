import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4010),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DATABASE: z.string().min(1, "MONGODB_DATABASE is required"),
  SERVICE_API_KEY: z.string().min(24, "SERVICE_API_KEY must be at least 24 characters"),

  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  RAZORPAY_SUBSCRIPTION_PLAN_ID: z.string().default("plan_TRv3HKpujDyFoS"),
  RAZORPAY_SUBSCRIPTION_PLAN_NAME: z.string().default("Eva Premium Monthly"),
  RAZORPAY_SUBSCRIPTION_AMOUNT: z.coerce.number().int().positive().default(29900),
  RAZORPAY_SUBSCRIPTION_CURRENCY: z.string().default("INR"),
  RAZORPAY_SUBSCRIPTION_TOTAL_COUNT: z.coerce.number().int().positive().default(120)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${errors}`);
}

export const env = parsed.data;

