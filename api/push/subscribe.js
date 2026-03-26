/**
 * POST /api/push/subscribe — Save a web push subscription to KV.
 */

const {
  jsonResponse,
  corsHeaders,
  readBody,
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

  try {
    const body = await readBody(req);

    if (!body.endpoint) {
      return jsonResponse(res, { error: "Missing endpoint in subscription" }, 400);
    }

    await savePushSub(body);
    return jsonResponse(res, { ok: true });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
