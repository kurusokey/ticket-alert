/**
 * GET /api/monitor/history — Return check history from KV.
 *
 * Query param: eventId (optional — all events if omitted)
 */

const {
  jsonResponse,
  corsHeaders,
  getEvents,
  getHistory,
} = require("../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const eventId = url.searchParams.get("eventId");

    if (eventId) {
      const history = await getHistory(eventId);
      return jsonResponse(res, { eventId, history });
    }

    // All events
    const events = await getEvents();
    const allHistory = {};

    for (const ev of events) {
      const eid = ev.id || ev.name;
      allHistory[eid] = await getHistory(eid);
    }

    return jsonResponse(res, { history: allHistory });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
