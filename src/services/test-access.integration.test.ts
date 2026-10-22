import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const userId = "507f1f77bcf86cd799439011";
let mongo: MongoMemoryServer;
let service: typeof import("./test-access.js");
let billing: typeof import("./subscriptions.js");
let models: typeof import("../models.js");
let env: typeof import("../config/env.js")["env"];
let buildApp: typeof import("../app.js")["buildApp"];
beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  process.env.MONGODB_URI = mongo.getUri();
  process.env.SUBSCRIPTIONS_API_KEY = "isolated-test-access-secret";
  process.env.TEST_ACCESS_USER_ID = userId;
  process.env.LOG_LEVEL = "silent";
  await mongoose.connect(mongo.getUri());
  service = await import("./test-access.js");
  billing = await import("./subscriptions.js");
  models = await import("../models.js");
  ({ env } = await import("../config/env.js"));
  ({ buildApp } = await import("../app.js"));
}, 120_000);
beforeEach(async () => {
  env.TEST_ACCESS_USER_ID = userId;
  await service.TestAccessModel.deleteMany({});
  await models.SubscriptionModel.deleteMany({});
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

it("grants bounded access without financial records and retries do not extend it", async () => {
  const grant = await service.grantTestAccess(userId);
  const again = await service.grantTestAccess(userId);
  expect(again.expiresAt).toEqual(grant.expiresAt);
  expect(grant.expiresAt.getTime() - grant.grantedAt.getTime()).toBe(86400000);
  const entitlement = await billing.getEntitlement(userId);
  expect(entitlement).toMatchObject({ active: true, provider: "none", autoRenew: false, providerSubscriptionId: "" });
  expect(entitlement.voiceCycleId).toMatch(/^[a-f0-9]{64}$/);
  expect((await billing.getEntitlement(userId)).voiceCycleId).toBe(entitlement.voiceCycleId);
  expect(await models.PaymentModel.countDocuments()).toBe(0);
  expect(await models.SubscriptionModel.countDocuments()).toBe(0);
  expect(await mongoose.connection.db!.collection("queuejobs").countDocuments()).toBe(0);
});
it("enforces expiry before TTL deletion and prevents revoked-grant reactivation", async () => {
  await service.grantTestAccess(userId);
  await service.revokeTestAccess(userId);
  expect(await service.getTestAccess(userId)).toBeNull();
  await expect(service.grantTestAccess(userId)).rejects.toThrow();
  await service.TestAccessModel.updateOne({userId}, {$unset:{revokedAt:1}, $set:{expiresAt:new Date(Date.now()-1000)}});
  expect(await service.getTestAccess(userId)).toBeNull();
  expect((await billing.getEntitlement(userId)).active).toBe(false);
});
it("fails closed when disabled or targeting another account", async () => {
  await expect(service.grantTestAccess("507f1f77bcf86cd799439012")).rejects.toThrow();
  await service.grantTestAccess(userId);
  env.TEST_ACCESS_USER_ID = "";
  expect(await service.getTestAccess(userId)).toBeNull();
  await expect(service.grantTestAccess(userId)).rejects.toThrow();
});
it("does not replace a real paid entitlement", async () => {
  await service.grantTestAccess(userId);
  await models.SubscriptionModel.create({userId,provider:"razorpay",planId:"real-plan",status:"active",active:true,currentEnd:new Date(Date.now()+86400000),providerSubscriptionId:"sub_fixture"});
  expect(await billing.getEntitlement(userId)).toMatchObject({provider:"razorpay",providerSubscriptionId:"sub_fixture"});
});
it("requires internal authentication and rejects client-supplied expiry", async () => {
  const app = await buildApp();
  try {
    expect((await app.inject({method:"POST",url:"/api/v1/internal/test-access",payload:{userId}})).statusCode).toBe(401);
    const headers={"x-subscriptions-key":env.SUBSCRIPTIONS_API_KEY};
    expect((await app.inject({method:"POST",url:"/api/v1/internal/test-access",headers,payload:{userId,expiresAt:"2099-01-01"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/v1/internal/test-access",headers,payload:{userId}})).statusCode).toBe(200);
    expect((await app.inject({method:"DELETE",url:`/api/v1/internal/test-access/${userId}`})).statusCode).toBe(401);
    expect((await app.inject({method:"DELETE",url:`/api/v1/internal/test-access/${userId}`,headers})).statusCode).toBe(200);
    expect(await service.getTestAccess(userId)).toBeNull();
  } finally { await app.close(); }
});
