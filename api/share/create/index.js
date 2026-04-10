/**
 * POST /api/share/create — Generate a share token for an event.
 *
 * Body: { id: "eventId" }
 * Returns: { ok: true, token, url }
 */

const { getUserId, getEvents, jsonResponse, corsHeaders, readBody, createShareToken } = require("../../lib");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const userId = getUserId(req);
  if (!userId) return jsonResponse(res, { error: "Authentification requise" }, 401);

  try {
    const body = await readBody(req);
    if (body._error) return jsonResponse(res, { error: body._error }, 413);

    const eventId = body.id;
    if (!eventId) return jsonResponse(res, { error: "Event ID requis" }, 400);

    // Verify event exists for this user
    const events = await getEvents(userId);
    const ev = events.find(e => e.id === eventId);
    if (!ev) return jsonResponse(res, { error: "Evenement introuvable" }, 404);

    const token = await createShareToken(userId, eventId);
    if (!token) return jsonResponse(res, { error: "Storage non disponible" }, 500);

    return jsonResponse(res, { ok: true, token, url: `/api/share?token=${token}` });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
