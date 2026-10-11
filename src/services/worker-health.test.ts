import { expect, it } from "vitest";
import { workerReadiness, createWorkerHealthServer } from "./worker-health.js";

it("reports unhealthy on startup, stale sweeps, and database disconnects", () => {
  expect(workerReadiness(true, 0, 5000, 200000)).toBe(false);
  expect(workerReadiness(true, 1000, 5000, 200000)).toBe(false);
  expect(workerReadiness(false, 200000, 5000, 200001)).toBe(false);
  expect(workerReadiness(true, 200000, 5000, 200001)).toBe(true);
});
it("serves readiness without disclosing payment or configuration details", async () => {
  const health = createWorkerHealthServer(() => true, 5000);
  await new Promise<void>(resolve => health.server.listen(0, "127.0.0.1", resolve));
  const address = health.server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const url = `http://127.0.0.1:${address.port}/health`;
  try {
    expect((await fetch(url)).status).toBe(503);
    health.markSuccessfulSweep();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  } finally { await new Promise<void>((resolve, reject) => health.server.close(error => error ? reject(error) : resolve())); }
});
