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
  getUserId,
  getEvents,
  saveEvents,
} = require("../lib");

// ── Input validation ──
function validateEvent(body) {
  if (!body || typeof body !== 'object') return "Donnees invalides";
  if (!body.name || typeof body.name !== 'string' || body.name.length > 300) return "Nom requis (max 300 caracteres)";
  if (body.id && (typeof body.id !== 'string' || body.id.length > 300)) return "ID invalide";
  if (body.urls && (!Array.isArray(body.urls) || body.urls.length > 20)) return "Max 20 URLs";
  if (body.dates && (!Array.isArray(body.dates) || body.dates.length > 50)) return "Max 50 dates";
  return null; // valid
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  const userId = getUserId(req);

  try {
    if (req.method === "GET") {
      const events = await getEvents(userId);
      return jsonResponse(res, events);
    }

    // Auth required for POST, PUT, DELETE
    if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

    if (req.method === "POST") {
      const body = await readBody(req);
      if (body._error) return jsonResponse(res, { error: body._error }, 413);

      const validationError = validateEvent(body);
      if (validationError) return jsonResponse(res, { error: validationError }, 400);

      const events = await getEvents(userId);
      if (events.length >= 100) return jsonResponse(res, { error: "Maximum 100 evenements atteint" }, 400);

      events.push(body);
      await saveEvents(userId, events);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      if (body._error) return jsonResponse(res, { error: body._error }, 413);

      const validationError = validateEvent(body);
      if (validationError) return jsonResponse(res, { error: validationError }, 400);

      const events = await getEvents(userId);
      let updated = false;
      for (let i = 0; i < events.length; i++) {
        if (events[i].id === body.id) {
          events[i] = body;
          updated = true;
          break;
        }
      }
      if (!updated) {
        if (events.length >= 100) return jsonResponse(res, { error: "Maximum 100 evenements atteint" }, 400);
        events.push(body);
      }
      await saveEvents(userId, events);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "DELETE") {
      // Accept id from query param or body
      let eventId = null;
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      eventId = url.searchParams.get("id");

      if (!eventId) {
        const body = await readBody(req);
        if (body._error) return jsonResponse(res, { error: body._error }, 413);
        eventId = body.id;
      }

      if (!eventId) {
        return jsonResponse(res, { error: "Missing event id" }, 400);
      }

      const events = await getEvents(userId);
      const filtered = events.filter((ev) => ev.id !== eventId);
      await saveEvents(userId, filtered);
      return jsonResponse(res, { ok: true });
    }

    return jsonResponse(res, { error: "Method not allowed" }, 405);
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
