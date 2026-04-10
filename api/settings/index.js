/**
 * GET/POST /api/settings — User notification preferences.
 *
 * GET  → returns current settings (with defaults)
 * POST → merges body into existing settings and saves
 */

const { getUserId, jsonResponse, corsHeaders, readBody } = require("../lib");

let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { kv = require("@vercel/kv").kv; return kv; } catch { return null; }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.end(); }

  const userId = getUserId(req);
  const store = getKV();
  const key = userId ? `u:${userId}:settings` : "settings";

  const defaults = {
    scan_interval: 60,
    telegram_enabled: true,
    push_enabled: false,
    quiet_hours: { start: "23:00", end: "07:00", enabled: false },
  };

  if (req.method === "GET") {
    let settings = defaults;
    if (store) {
      const saved = await store.get(key);
      if (saved) settings = { ...defaults, ...saved };
    }
    return jsonResponse(res, settings);
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    if (store) {
      const current = await store.get(key) || defaults;
      const updated = { ...current, ...body };
      await store.set(key, updated);
      return jsonResponse(res, { ok: true, settings: updated });
    }
    return jsonResponse(res, { ok: false, error: "Storage non disponible" }, 500);
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
