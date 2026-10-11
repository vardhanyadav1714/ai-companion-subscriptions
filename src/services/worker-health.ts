import { createServer } from "node:http";

export function workerReadiness(databaseConnected: boolean, lastSuccessfulSweep: number, pollIntervalMs: number, now = Date.now()): boolean {
  return databaseConnected && lastSuccessfulSweep > 0 && now - lastSuccessfulSweep < Math.max(120_000, pollIntervalMs * 6);
}

export function createWorkerHealthServer(databaseConnected: () => boolean, pollIntervalMs: number) {
  let lastSuccessfulSweep = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end(JSON.stringify({ status: "not_found" }));
      return;
    }
    const healthy = workerReadiness(databaseConnected(), lastSuccessfulSweep, pollIntervalMs);
    response.writeHead(healthy ? 200 : 503).end(JSON.stringify({ status: healthy ? "ok" : "not_ready" }));
  });
  return { server, markSuccessfulSweep: () => { lastSuccessfulSweep = Date.now(); } };
}
