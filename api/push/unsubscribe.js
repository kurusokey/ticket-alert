/**
 * POST /api/push/unsubscribe — Remove a web push subscription from KV by endpoint.
 */

const {
  jsonResponse,
  corsHeaders,
  readBody,
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

  try {
    const body = await readBody(req);

    if (!body.endpoint) {
      return jsonResponse(res, { error: "Missing endpoint" }, 400);
    }

    await removePushSub(body.endpoint);
    return jsonResponse(res, { ok: true });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
