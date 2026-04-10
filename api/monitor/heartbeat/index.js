/**
 * GET /api/monitor/heartbeat — Cron health monitoring.
 *
 * Returns the last cron heartbeat timestamp.
 * If more than 5 minutes old (or missing), returns { healthy: false }.
 */

const { jsonResponse, corsHeaders, getKV } = require("../../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "GET") {
    return jsonResponse(res, { error: "Method not allowed" }, 405);
  }

  try {
    var store = getKV();
    if (!store) {
      return jsonResponse(res, {
        healthy: false,
        reason: "KV store non disponible",
        timestamp: null,
        age_seconds: null,
      });
    }

    var data = await store.get("cron:heartbeat");

    if (!data || !data.timestamp) {
      return jsonResponse(res, {
        healthy: false,
        reason: "Aucun heartbeat enregistre",
        timestamp: null,
        age_seconds: null,
      });
    }

    var heartbeatTime = new Date(data.timestamp);
    var now = new Date();
    var ageMs = now.getTime() - heartbeatTime.getTime();
    var ageSeconds = Math.floor(ageMs / 1000);
    var maxAgeSeconds = 5 * 60; // 5 minutes

    var healthy = ageSeconds <= maxAgeSeconds;

    return jsonResponse(res, {
      healthy: healthy,
      timestamp: data.timestamp,
      age_seconds: ageSeconds,
      max_age_seconds: maxAgeSeconds,
      reason: healthy ? null : "Heartbeat trop ancien (" + ageSeconds + "s > " + maxAgeSeconds + "s)",
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, {
      healthy: false,
      reason: "Erreur interne",
      timestamp: null,
      age_seconds: null,
    }, 500);
  }
};
