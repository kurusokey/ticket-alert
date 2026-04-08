/**
 * GET /api/monitor/status — Return current monitoring status.
 *
 * Returns: running, check_count, last results, alerts, logs.
 */

const {
  jsonResponse,
  corsHeaders,
  getUserId,
  getStatus,
} = require("../../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  const userId = getUserId(req);

  try {
    const status = await getStatus(userId);
    return jsonResponse(res, status);
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
