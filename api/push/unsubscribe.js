/**
 * POST /api/push/unsubscribe — Remove a web push subscription from KV by endpoint.
 */

const {
  jsonResponse,
  corsHeaders,
  readBody,
  getUserId,
  removePushSub,
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
      return jsonResponse(res, { error: "Missing endpoint" }, 400);
    }

    await removePushSub(userId, body.endpoint);
    return jsonResponse(res, { ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
