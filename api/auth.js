/**
 * POST /api/auth — Register or login with a 6-digit PIN code.
 *
 * Body: { action: "register", name: "Yasuke", pin: "123456" }
 *   → Creates account with chosen PIN
 *
 * Body: { action: "login", pin: "123456" }
 *   → Verifies PIN exists, returns { pin, name }
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

  if (body.action === "register") {
    const pin = (body.pin || "").trim();
    const name = (body.name || "").trim() || "Mon compte";

    if (!/^\d{6}$/.test(pin)) {
      return jsonResponse(res, { ok: false, error: "Le code PIN doit faire 6 chiffres" }, 400);
    }

    if (store) {
      // Check if PIN already taken
      const existing = await store.get(`user:${pin}`);
      if (existing) {
        return jsonResponse(res, { ok: false, error: "Ce code PIN est deja utilise" }, 409);
      }

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
        const existing = JSON.parse(fs.readFileSync(evFile, "utf-8"));
        if (Array.isArray(existing) && existing.length > 0) {
          await store.set(`u:${pin}:events`, existing);
        }
      } catch {}

      return jsonResponse(res, { ok: true, pin, name });
    }

    return jsonResponse(res, { ok: false, error: "Storage non disponible" }, 500);
  }

  if (body.action === "login") {
    const pin = (body.pin || "").trim();
    if (!/^\d{6}$/.test(pin)) {
      return jsonResponse(res, { ok: false, error: "Le code PIN doit faire 6 chiffres" }, 400);
    }

    if (store) {
      const user = await store.get(`user:${pin}`);
      if (user) return jsonResponse(res, { ok: true, pin: user.pin, name: user.name });
    }

    return jsonResponse(res, { ok: false, error: "Code PIN introuvable" }, 404);
  }

  return jsonResponse(res, { error: "Action invalide" }, 400);
};
