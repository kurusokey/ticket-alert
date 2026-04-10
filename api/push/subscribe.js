/**
 * POST /api/push/subscribe — Save a web push subscription to KV.
 */

const {
  jsonResponse,
  corsHeaders,
  readBody,
  getUserId,
  savePushSub,
} = require("../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "POST") {
    return jsonResponse(res, { error: "Method not allowed" }, 405);
  }

  const userId = getUserId(req);
  if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

  try {
    const body = await readBody(req);
    if (body._error) return jsonResponse(res, { error: body._error }, 413);

    if (!body.endpoint) {
      return jsonResponse(res, { error: "Missing endpoint in subscription" }, 400);
    }

    await savePushSub(userId, body);
    return jsonResponse(res, { ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
