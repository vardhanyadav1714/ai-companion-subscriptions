import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({ subscription: vi.fn(), update: vi.fn(), earliest: vi.fn(), initialPayment: vi.fn() }));
vi.mock("./razorpay.js", () => ({ fetchInitialRazorpayPayment: models.initialPayment }));
vi.mock("../models.js", () => ({
  SubscriptionModel: { findById: models.subscription, updateOne: models.update },
  PaymentModel: { findOne: () => ({ sort: models.earliest }) }
}));
vi.mock("../services/billing-lock.js", () => ({ withBillingLock: async (_key: string, operation: () => Promise<unknown>) => operation() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getClient = async () => ({ getAccessToken: async () => ({ token: "test-only-token" }) }); } }));
process.env.SUBSCRIPTIONS_API_KEY = "test_subscriptions_secret";
process.env.MONGODB_URI = "mongodb://localhost/test";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "{}";
const { reportExternalTransaction, reportExternalRefund } = await import("./google-play.js");
const { env } = await import("../config/env.js");
const fetchMock = vi.fn();
const payment = { id: "pay_1", amount: 49900, currency: "INR", created_at: Math.floor(Date.now() / 1000) - 60 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  env.GOOGLE_PLAY_TAX_RATE_BPS = 0;
  models.subscription.mockResolvedValue({ _id: "sub_1", providerSubscriptionId: "sub_provider", externalTransactionToken: "test-only-choice-token", billingAdministrativeArea: "UTTAR PRADESH", initialExternalTransactionId: "eva-pay_1" });
  models.earliest.mockResolvedValue({ providerPaymentId: "pay_1" });
  models.initialPayment.mockResolvedValue(payment);
});
afterEach(() => vi.unstubAllGlobals());

describe("external billing reporting", () => {
  it("reports paise as micros with the provider timestamp and first-purchase token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response("{}"));
    await reportExternalTransaction({ subscriptionId: "sub_1", payment });
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body.originalPreTaxAmount).toEqual({ priceMicros: "499000000", currency: "INR" });
    expect(body.recurringTransaction.externalTransactionToken).toBe("test-only-choice-token");
    expect(body.transactionTime).toBe(new Date(payment.created_at * 1000).toISOString());
    expect(body.userTaxAddress).toEqual({ regionCode: "IN", administrativeArea: "UTTAR PRADESH" });
  });
  it("does not report a renewal until the first transaction exists", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(reportExternalTransaction({ subscriptionId: "sub_1", payment: { ...payment, id: "pay_2" } })).rejects.toThrow("before renewals");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("recovers the provider's first payment when a renewal webhook arrives first", async () => {
    models.subscription.mockResolvedValueOnce({ _id: "sub_1", providerSubscriptionId: "sub_provider", externalTransactionToken: "test-only-choice-token", billingAdministrativeArea: "UTTAR PRADESH" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}"));
    await reportExternalTransaction({ subscriptionId: "sub_1", payment: { ...payment, id: "pay_2" } });
    expect(models.initialPayment).toHaveBeenCalledWith("sub_provider");
    const posted = fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
    expect(posted).toHaveLength(2);
    expect(posted[0]![0]).toContain("externalTransactionId=eva-pay_1");
    expect(JSON.parse(posted[1]![1].body).recurringTransaction.initialExternalTransactionId).toBe("eva-pay_1");
  });
  it("rejects invented or future payment timestamps", async () => {
    await expect(reportExternalTransaction({ subscriptionId: "sub_1", payment: { ...payment, created_at: Date.now() / 1000 + 10000 } })).rejects.toThrow("timestamp");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not invent a billing state for an incomplete transaction", async () => {
    models.subscription.mockResolvedValueOnce({ externalTransactionToken: "test-only-choice-token" });
    await expect(reportExternalTransaction({ subscriptionId: "sub_1", payment })).rejects.toThrow("billing state");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("splits tax-inclusive payments without losing micros", async () => {
    env.GOOGLE_PLAY_TAX_RATE_BPS = 1800;
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response("{}"));
    await reportExternalTransaction({ subscriptionId: "sub_1", payment });
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(Number(body.originalPreTaxAmount.priceMicros) + Number(body.originalTaxAmount.priceMicros)).toBe(499000000);
    expect(Number(body.originalTaxAmount.priceMicros)).toBeGreaterThan(0);
  });
  it("validates an existing report before treating it as a successful replay", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ originalPreTaxAmount: { priceMicros: "1", currency: "INR" }, originalTaxAmount: { priceMicros: "0" } })));
    await expect(reportExternalTransaction({ subscriptionId: "sub_1", payment })).rejects.toThrow("does not match");
  });
  it("reports a full refund after the original transaction", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ originalPreTaxAmount: { priceMicros: "499000000" }, currentPreTaxAmount: { priceMicros: "499000000" } })))
      .mockResolvedValueOnce(new Response("{}"));
    await reportExternalRefund({ subscriptionId: "sub_1", payment: { ...payment, amount_refunded: 49900 }, refund: { created_at: payment.created_at + 30 } });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ fullRefund: {} });
    expect(fetchMock.mock.calls[1]![0]).toContain("eva-pay_1:refund");
  });
  it("does not repeat a refund when the response was lost but Google's balance was updated", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ originalPreTaxAmount: { priceMicros: "499000000" }, currentPreTaxAmount: { priceMicros: "399000000" } })));
    await expect(reportExternalRefund({ subscriptionId: "sub_1", payment: { ...payment, amount_refunded: 10000 }, refund: { created_at: payment.created_at + 30 } }))
      .resolves.toMatchObject({ status: "already_reported" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reports only the remaining partial-refund difference", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ originalPreTaxAmount: { priceMicros: "499000000" }, currentPreTaxAmount: { priceMicros: "449000000" } })))
      .mockResolvedValueOnce(new Response("{}"));
    await reportExternalRefund({ subscriptionId: "sub_1", payment: { ...payment, amount_refunded: 10000 }, refund: { created_at: payment.created_at + 30 } });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).partialRefund).toEqual({ refundId: "eva-pay_1-10000", refundPreTaxAmount: { currency: "INR", priceMicros: "50000000" } });
  });
});
