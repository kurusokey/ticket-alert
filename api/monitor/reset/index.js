/**
 * POST /api/monitor/reset — Hard reset: write clean status to KV.
 */
const { getUserId, jsonResponse, corsHeaders } = require("../../lib");

let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { kv = require("@vercel/kv").kv; return kv; } catch { return null; }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

  const userId = getUserId(req);
  const store = getKV();

  const cleanStatus = {
    running: false,
    check_count: 0,
    started_at: null,
    logs: [],
    alerts: [],
    last_results: [],
  };

  if (store) {
    const key = userId ? `u:${userId}:status` : "status";
    await store.set(key, cleanStatus);
  }

  return jsonResponse(res, { ok: true, message: "Reset complet" });
};
