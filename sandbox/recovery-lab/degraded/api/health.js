const SERVICE = "toolbraid-recovery-lab";

module.exports = function healthHandler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store, max-age=0");

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    return response.status(405).json({
      error: "method_not_allowed",
      allowed: ["GET", "OPTIONS"],
    });
  }

  return response.status(503).json({
    status: "degraded",
    service: SERVICE,
    environment: "production",
    version: "2026.08.28-bad",
    checkout: {
      state: "failing",
      successRatePercent: 62.4,
      failureRatePercent: 37.6,
      p95LatencyMs: 2840,
    },
    incident: {
      id: "INC-DEMO-503",
      severity: "SEV-1",
      symptom: "Payment authorization failures after release",
      rollbackRecommended: true,
    },
    deployment: {
      track: "degraded",
      rollbackSafe: true,
    },
    observedAt: new Date().toISOString(),
  });
};
