/**
 * POST /api/monitor/stop — Stop monitoring.
 *
 * Sets status.running = false in KV and sends Telegram notification.
 */

const {
  jsonResponse,
  corsHeaders,
  getUserId,
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

  const userId = getUserId(req);
  if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

  try {
    const status = await getStatus(userId);
    status.running = false;

    const timeStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (!status.logs) status.logs = [];
    status.logs.push({ time: timeStr, message: "Surveillance arretee", level: "info" });
    status.logs = status.logs.slice(-200);

    await saveStatus(userId, status);

    await sendTelegram("Ticket Alert arrete");

    return jsonResponse(res, { ok: true, message: "Arretee" });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
