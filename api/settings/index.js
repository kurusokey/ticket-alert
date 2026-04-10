/**
 * GET/POST /api/settings — User notification preferences.
 *
 * GET  -> returns current settings (with defaults)
 * POST -> merges body into existing settings and saves
 */

const { getUserId, jsonResponse, corsHeaders, readBody, getKV } = require("../lib");

const ALLOWED_SETTINGS = ['scan_interval', 'telegram_enabled', 'push_enabled', 'quiet_hours'];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

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
      try {
        const saved = await store.get(key);
        if (saved) settings = { ...defaults, ...saved };
      } catch { /* use defaults */ }
    }
    return jsonResponse(res, settings);
  }

  if (req.method === "POST") {
    if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

    const body = await readBody(req);
    if (body._error) return jsonResponse(res, { error: body._error }, 413);

    // Whitelist allowed keys
    const filtered = {};
    for (const k of ALLOWED_SETTINGS) {
      if (k in body) filtered[k] = body[k];
    }

    if (store) {
      try {
        const current = await store.get(key) || defaults;
        const updated = { ...current, ...filtered };
        await store.set(key, updated);
        return jsonResponse(res, { ok: true, settings: updated });
      } catch (err) {
        console.error(err);
        return jsonResponse(res, { error: "Erreur interne" }, 500);
      }
    }
    return jsonResponse(res, { ok: false, error: "Storage non disponible" }, 500);
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
