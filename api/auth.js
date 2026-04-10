/**
 * POST /api/auth — Login or auto-register with name + 6-digit PIN.
 *
 * Body: { name: "Yasuke", pin: "123456" }
 *
 * - PIN exists + name matches -> login
 * - PIN doesn't exist -> create account
 * - PIN exists + name doesn't match -> error
 *
 * Rate limited: max 5 attempts per minute per IP.
 */

const { jsonResponse, corsHeaders, readBody } = require("./lib");

let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { kv = require("@vercel/kv").kv; return kv; } catch { return null; }
  }
  return null;
}

// ── Rate limiting helpers ──
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function checkRateLimit(store, ip) {
  if (!store) return true; // no store = skip rate limiting
  const key = `rate:${ip}`;
  try {
    const data = await store.get(key);
    const now = Date.now();
    if (data && data.ts && (now - data.ts) < 60000) {
      if (data.count >= 5) return false; // rate limited
      await store.set(key, { count: data.count + 1, ts: data.ts });
    } else {
      await store.set(key, { count: 1, ts: now });
    }
  } catch { /* allow on error */ }
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  try {
    const body = await readBody(req);
    if (body._error) return jsonResponse(res, { error: body._error }, 413);

    const store = getKV();
    if (!store) return jsonResponse(res, { ok: false, error: "Storage non disponible" }, 500);

    // Rate limiting
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(store, ip);
    if (!allowed) return jsonResponse(res, { ok: false, error: "Trop de tentatives. Reessayez dans une minute." }, 429);

    const pin = (body.pin || "").trim();
    const name = (body.name || "").trim();

    if (!name) return jsonResponse(res, { ok: false, error: "Prenom requis" }, 400);
    if (!/^\d{6}$/.test(pin)) return jsonResponse(res, { ok: false, error: "Le code PIN doit faire 6 chiffres" }, 400);

    const existing = await store.get(`user:${pin}`);

    if (existing) {
      // PIN exists -- check name matches
      if (existing.name.toLowerCase() === name.toLowerCase()) {
        return jsonResponse(res, { ok: true, pin: existing.pin, name: existing.name, isNew: false });
      }
      return jsonResponse(res, { ok: false, error: "PIN et prenom ne correspondent pas" }, 403);
    }

    // PIN is free -- create account
    const user = { pin, name, created: new Date().toISOString() };
    await store.set(`user:${pin}`, user);

    // Add to all_users list (for cron)
    try {
      let allUsers = await store.get("all_users");
      if (!Array.isArray(allUsers)) allUsers = [];
      if (!allUsers.includes(pin)) {
        allUsers.push(pin);
        await store.set("all_users", allUsers);
      }
    } catch {}

    // Migrate data.json events for first user
    try {
      const fs = require("fs");
      const path = require("path");
      const evFile = path.join(__dirname, "..", "data.json");
      const data = JSON.parse(fs.readFileSync(evFile, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        await store.set(`u:${pin}:events`, data);
      }
    } catch {}

    return jsonResponse(res, { ok: true, pin, name, isNew: true });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { ok: false, error: "Erreur interne" }, 500);
  }
};
