/**
 * POST /api/auth — Login or auto-register with name + 6-digit PIN.
 *
 * Body: { name: "Yasuke", pin: "123456" }
 *
 * - PIN exists + name matches → login
 * - PIN doesn't exist → create account
 * - PIN exists + name doesn't match → error
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

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const body = await readBody(req);
  const store = getKV();
  if (!store) return jsonResponse(res, { ok: false, error: "Storage non disponible" }, 500);

  const pin = (body.pin || "").trim();
  const name = (body.name || "").trim();

  if (!name) return jsonResponse(res, { ok: false, error: "Prenom requis" }, 400);
  if (!/^\d{6}$/.test(pin)) return jsonResponse(res, { ok: false, error: "Le code PIN doit faire 6 chiffres" }, 400);

  const existing = await store.get(`user:${pin}`);

  if (existing) {
    // PIN exists — check name matches
    if (existing.name.toLowerCase() === name.toLowerCase()) {
      return jsonResponse(res, { ok: true, pin: existing.pin, name: existing.name, isNew: false });
    }
    return jsonResponse(res, { ok: false, error: "PIN et prenom ne correspondent pas" }, 403);
  }

  // PIN is free — create account
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
};
