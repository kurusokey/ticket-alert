/**
 * POST /api/auth — Register or login with a sync code.
 *
 * Body: { action: "register", name: "Yasuke" }
 *   → Creates a new sync code, returns { code, name }
 *
 * Body: { action: "login", code: "ABC123" }
 *   → Verifies the code exists, returns { code, name }
 */

const crypto = require("crypto");
const { jsonResponse, corsHeaders, readBody } = require("./lib");

let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { kv = require("@vercel/kv").kv; return kv; } catch { return null; }
  }
  return null;
}

function generateCode() {
  // 6-char alphanumeric uppercase code
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const body = await readBody(req);
  const store = getKV();

  if (body.action === "register") {
    const code = generateCode();
    const name = (body.name || "").trim() || "Mon compte";
    const user = { code, name, created: new Date().toISOString() };

    if (store) {
      await store.set(`user:${code}`, user);
      // Add to all_users list (for cron)
      try {
        let allUsers = await store.get("all_users");
        if (!Array.isArray(allUsers)) allUsers = [];
        if (!allUsers.includes(code)) {
          allUsers.push(code);
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
          await store.set(`u:${code}:events`, existing);
        }
      } catch {}
    }

    return jsonResponse(res, { ok: true, code, name });
  }

  if (body.action === "login") {
    const code = (body.code || "").trim().toUpperCase();
    if (!code || code.length < 4) return jsonResponse(res, { ok: false, error: "Code invalide" }, 400);

    if (store) {
      const user = await store.get(`user:${code}`);
      if (user) return jsonResponse(res, { ok: true, code: user.code, name: user.name });
    }

    return jsonResponse(res, { ok: false, error: "Code introuvable" }, 404);
  }

  return jsonResponse(res, { error: "Action invalide" }, 400);
};
