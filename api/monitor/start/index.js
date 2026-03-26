/**
 * POST /api/monitor/start — Start monitoring.
 *
 * Sets status.running = true in KV and sends Telegram notification.
 */

const {
  jsonResponse,
  corsHeaders,
  getEvents,
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

    if (status.running) {
      return jsonResponse(res, { ok: false, message: "Deja en cours" });
    }

    const now = new Date().toISOString();
    const timeStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    status.running = true;
    status.check_count = 0;
    status.started_at = now;
    status.logs = [{ time: timeStr, message: "Surveillance demarree", level: "success" }];
    status.alerts = [];
    status.last_results = [];

    await saveStatus(status);

    // Telegram notification
    const events = await getEvents();
    const activeNames = events
      .filter((ev) => ev.active !== false)
      .map((ev) => ev.name)
      .join(", ");

    await sendTelegram(`🔍 Ticket Alert demarre\n${activeNames || "Aucun evenement actif"}`);

    return jsonResponse(res, { ok: true, message: "Demarree" });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
