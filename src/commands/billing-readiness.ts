import { env } from "../config/env.js";
import { checkExternalReportingAccess } from "../providers/google-play.js";
import { validateRazorpayPlan } from "../providers/razorpay.js";

async function main(): Promise<void> {
  const checks: Record<string, boolean | number | string> = {
    alternativeBillingEnabled: env.GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED,
    indiaOnly: env.GOOGLE_PLAY_TAX_REGION === "IN" && env.PLAN_CURRENCY === "INR",
    configuredTaxRateBps: env.GOOGLE_PLAY_TAX_RATE_BPS,
    explicitTaxRateConfigured: Boolean(process.env.GOOGLE_PLAY_TAX_RATE_BPS?.trim()),
    authenticatedPushConfigured: Boolean(env.GOOGLE_PLAY_RTDN_AUDIENCE && env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL),
    razorpayConfigured: Boolean(env.RAZORPAY_ENABLED && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)
  };
  try { await validateRazorpayPlan(); checks.planMatches = true; } catch { checks.planMatches = false; }
  try {
    const access = await checkExternalReportingAccess();
    checks.externalReportingAccessible = access.accessible;
    checks.externalReportingHttpStatus = access.statusCode;
  } catch { checks.externalReportingAccessible = false; }
  console.log(JSON.stringify({ readOnly: true, checks }, null, 2));
  if (!checks.alternativeBillingEnabled || !checks.explicitTaxRateConfigured || !checks.indiaOnly || !checks.razorpayConfigured || !checks.planMatches || !checks.externalReportingAccessible) process.exitCode = 1;
}

void main().catch(() => { console.error("Billing readiness check could not complete"); process.exitCode = 1; });
