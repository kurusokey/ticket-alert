/**
 * POST /api/monitor/reset — Hard reset: clear all alerts, logs, baselines.
 */
const { getUserId, saveStatus, jsonResponse, corsHeaders } = require("../../lib");

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
  const cleanStatus = {
    running: false,
    check_count: 0,
    started_at: null,
    logs: [],
    alerts: [],
    last_results: [],
  };

  await saveStatus(userId, cleanStatus);

  // Also clean baselines and history via KV scan
  const store = getKV();
  if (store && userId) {
    try {
      // Delete all baseline and history keys for this user
      const prefix = `u:${userId}:`;
      const keys = await store.keys(`${prefix}baseline:*`);
      const histKeys = await store.keys(`${prefix}history:*`);
      for (const k of [...keys, ...histKeys]) {
        await store.del(k);
      }
    } catch {}
  }

  return jsonResponse(res, { ok: true, message: "Reset complet" });
};
