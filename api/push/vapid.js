/**
 * GET /api/push/vapid — Return VAPID public key for web push subscription.
 */

const {
  jsonResponse,
  corsHeaders,
} = require("../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY || "";

  return jsonResponse(res, { publicKey });
};
