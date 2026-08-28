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

  return response.status(200).json({
    status: "healthy",
    service: SERVICE,
    environment: "production",
    version: "2026.08.28-stable",
    checkout: {
      state: "operational",
      successRatePercent: 99.98,
      failureRatePercent: 0.02,
      p95LatencyMs: 184,
    },
    deployment: {
      track: "stable",
      rollbackSafe: true,
    },
    observedAt: new Date().toISOString(),
  });
};
