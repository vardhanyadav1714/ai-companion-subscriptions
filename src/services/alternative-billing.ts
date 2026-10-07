import { env } from "../config/env.js";
import { badRequest, serviceUnavailable } from "../errors.js";

export const indiaAdministrativeAreas = [
  "ANDAMAN AND NICOBAR ISLANDS", "ANDHRA PRADESH", "ARUNACHAL PRADESH", "ASSAM", "BIHAR", "CHANDIGARH",
  "CHHATTISGARH", "DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "DELHI", "GOA", "GUJARAT", "HARYANA",
  "HIMACHAL PRADESH", "JAMMU AND KASHMIR", "JHARKHAND", "KARNATAKA", "KERALA", "LADAKH", "LAKSHADWEEP",
  "MADHYA PRADESH", "MAHARASHTRA", "MANIPUR", "MEGHALAYA", "MIZORAM", "NAGALAND", "ODISHA", "PUDUCHERRY",
  "PUNJAB", "RAJASTHAN", "SIKKIM", "TAMIL NADU", "TELANGANA", "TRIPURA", "UTTAR PRADESH", "UTTARAKHAND", "WEST BENGAL"
] as const;

export function validateAlternativeBilling(input: {
  externalTransactionToken?: string; billingCountryCode?: string; billingAdministrativeArea?: string;
}): void {
  if (!input.externalTransactionToken) {
    if (input.billingCountryCode || input.billingAdministrativeArea) throw badRequest("Google Play billing choice token is required");
    return;
  }
  if (!env.GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED) throw badRequest("Alternative billing is not enabled");
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || env.GOOGLE_PLAY_TAX_REGION !== "IN" || env.PLAN_CURRENCY !== "INR") {
    throw serviceUnavailable("India alternative billing reporting is not configured");
  }
  if (input.billingCountryCode !== "IN") throw badRequest("Razorpay billing choice is available only in India");
  if (!indiaAdministrativeAreas.includes(input.billingAdministrativeArea as typeof indiaAdministrativeAreas[number])) {
    throw badRequest("Select a valid Indian billing state or union territory");
  }
}
