/**
 * /api/events — Events CRUD
 *
 * GET:    return all events
 * POST:   add event
 * PUT:    update event (match by id)
 * DELETE: remove event (id in query or body)
 * OPTIONS: CORS preflight
 */

const {
  jsonResponse,
  corsHeaders,
  readBody,
  getEvents,
  saveEvents,
} = require("../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  try {
    if (req.method === "GET") {
      const events = await getEvents();
      return jsonResponse(res, events);
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const events = await getEvents();
      events.push(body);
      await saveEvents(events);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      const events = await getEvents();
      let updated = false;
      for (let i = 0; i < events.length; i++) {
        if (events[i].id === body.id) {
          events[i] = body;
          updated = true;
          break;
        }
      }
      if (!updated) {
        events.push(body);
      }
      await saveEvents(events);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "DELETE") {
      // Accept id from query param or body
      let eventId = null;
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      eventId = url.searchParams.get("id");

      if (!eventId) {
        const body = await readBody(req);
        eventId = body.id;
      }

      if (!eventId) {
        return jsonResponse(res, { error: "Missing event id" }, 400);
      }

      const events = await getEvents();
      const filtered = events.filter((ev) => ev.id !== eventId);
      await saveEvents(filtered);
      return jsonResponse(res, { ok: true });
    }

    return jsonResponse(res, { error: "Method not allowed" }, 405);
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
