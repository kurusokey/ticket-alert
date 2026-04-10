/**
 * /api/events — Events CRUD
 *
 * GET:    return all events (with computed `past` and `days_until` fields)
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

// ── Compute past/days_until for an event ──
function enrichEvent(ev) {
  var enriched = Object.assign({}, ev);
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!ev.dates || !Array.isArray(ev.dates) || ev.dates.length === 0) {
    enriched.past = false;
    enriched.days_until = null;
    return enriched;
  }

  var allPast = true;
  var earliestFutureDiff = null;
  var latestPastDiff = null;

  for (var i = 0; i < ev.dates.length; i++) {
    var d = ev.dates[i];
    var dateStr = typeof d === "string" ? d : (d && d.date ? d.date : null);
    if (!dateStr) continue;

    var parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) continue;
    parsed.setHours(0, 0, 0, 0);

    var diffDays = Math.ceil((parsed - today) / 86400000);

    if (parsed >= today) {
      allPast = false;
      if (earliestFutureDiff === null || diffDays < earliestFutureDiff) {
        earliestFutureDiff = diffDays;
      }
    } else {
      if (latestPastDiff === null || diffDays > latestPastDiff) {
        latestPastDiff = diffDays;
      }
    }
  }

  enriched.past = allPast;

  if (earliestFutureDiff !== null) {
    enriched.days_until = earliestFutureDiff;
  } else if (latestPastDiff !== null) {
    enriched.days_until = latestPastDiff; // negative number
  } else {
    enriched.days_until = null;
  }

  return enriched;
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  var userId = getUserId(req);

  try {
    if (req.method === "GET") {
      var events = await getEvents(userId);
      var enriched = events.map(enrichEvent);
      return jsonResponse(res, enriched);
    }

    // Auth required for POST, PUT, DELETE
    if (!userId) return jsonResponse(res, { ok: false, error: "Authentification requise" }, 401);

    if (req.method === "POST") {
      var body = await readBody(req);
      if (body._error) return jsonResponse(res, { error: body._error }, 413);

      var validationError = validateEvent(body);
      if (validationError) return jsonResponse(res, { error: validationError }, 400);

      var events2 = await getEvents(userId);
      if (events2.length >= 100) return jsonResponse(res, { error: "Maximum 100 evenements atteint" }, 400);

      events2.push(body);
      await saveEvents(userId, events2);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "PUT") {
      var body2 = await readBody(req);
      if (body2._error) return jsonResponse(res, { error: body2._error }, 413);

      var validationError2 = validateEvent(body2);
      if (validationError2) return jsonResponse(res, { error: validationError2 }, 400);

      var events3 = await getEvents(userId);
      var updated = false;
      for (var i = 0; i < events3.length; i++) {
        if (events3[i].id === body2.id) {
          events3[i] = body2;
          updated = true;
          break;
        }
      }
      if (!updated) {
        if (events3.length >= 100) return jsonResponse(res, { error: "Maximum 100 evenements atteint" }, 400);
        events3.push(body2);
      }
      await saveEvents(userId, events3);
      return jsonResponse(res, { ok: true });
    }

    if (req.method === "DELETE") {
      // Accept id from query param or body
      var eventId = null;
      var url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
      eventId = url.searchParams.get("id");

      if (!eventId) {
        var body3 = await readBody(req);
        if (body3._error) return jsonResponse(res, { error: body3._error }, 413);
        eventId = body3.id;
      }

      if (!eventId) {
        return jsonResponse(res, { error: "Missing event id" }, 400);
      }

      var events4 = await getEvents(userId);
      var filtered = events4.filter(function (ev) { return ev.id !== eventId; });
      await saveEvents(userId, filtered);
      return jsonResponse(res, { ok: true });
    }

    return jsonResponse(res, { error: "Method not allowed" }, 405);
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
