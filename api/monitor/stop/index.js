/**
 * POST /api/monitor/stop — Stop monitoring.
 *
 * Sets status.running = false in KV and sends Telegram notification.
 */

const {
  jsonResponse,
  corsHeaders,
  getStatus,
  saveStatus,
  sendTelegram,
} = require("../../lib");

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
    const status = await getStatus();
    status.running = false;

    const timeStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (!status.logs) status.logs = [];
    status.logs.push({ time: timeStr, message: "Surveillance arretee", level: "info" });
    status.logs = status.logs.slice(-200);

    await saveStatus(status);

    await sendTelegram("⏹ Ticket Alert arrete");

    return jsonResponse(res, { ok: true, message: "Arretee" });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
