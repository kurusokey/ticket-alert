/**
 * POST /api/monitor/reset — Hard reset: write clean status to KV.
 */
const { getUserId, jsonResponse, corsHeaders, getKV } = require("../../lib");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

  const userId = getUserId(req);
  if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

  const cleanStatus = {
    running: false,
    check_count: 0,
    started_at: null,
    logs: [],
    alerts: [],
    last_results: [],
  };

  try {
    const store = getKV();
    if (store) {
      const key = userId ? `u:${userId}:status` : "status";
      await store.set(key, cleanStatus);
    }

    return jsonResponse(res, { ok: true, message: "Reset complet" });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
