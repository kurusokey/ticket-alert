/**
 * POST /api/events/cleanup — Remove broken URLs and empty events.
 *
 * Tests each URL, removes those returning errors (403, 404, timeout).
 * Removes events with no working URLs left.
 * Returns a summary of what was cleaned.
 */

const { getUserId, getEvents, saveEvents, jsonResponse, corsHeaders } = require("../../lib");

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function testUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: "HEAD",
      headers: FETCH_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    // Accept 2xx and 3xx as valid
    return res.status < 400;
  } catch {
    // Try GET as fallback (some sites block HEAD)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      return res.status < 400;
    } catch {
      return false;
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

  const userId = getUserId(req);
  if (!userId) return jsonResponse(res, { error: "Authentification requise" }, 401);

  try {
    const events = await getEvents(userId);
    const report = { tested: 0, urlsRemoved: 0, eventsRemoved: 0, details: [] };

    const cleanedEvents = [];

    for (const ev of events) {
      const rawUrls = ev.urls || (ev.url ? [{ url: ev.url, label: "" }] : []);
      const workingUrls = [];

      for (const u of rawUrls) {
        const url = typeof u === "string" ? u : u.url;
        if (!url) continue;
        report.tested++;

        const ok = await testUrl(url);
        if (ok) {
          workingUrls.push(u);
        } else {
          report.urlsRemoved++;
          report.details.push({ event: ev.name, url, status: "supprimee" });
        }
      }

      if (workingUrls.length > 0) {
        ev.urls = workingUrls;
        ev.url = workingUrls[0].url || workingUrls[0];
        cleanedEvents.push(ev);
      } else {
        report.eventsRemoved++;
        report.details.push({ event: ev.name, url: null, status: "event supprime (aucune URL)" });
      }
    }

    await saveEvents(userId, cleanedEvents);

    return jsonResponse(res, {
      ok: true,
      message: `${report.urlsRemoved} URL(s) supprimee(s), ${report.eventsRemoved} event(s) supprime(s) sur ${events.length}`,
      before: events.length,
      after: cleanedEvents.length,
      ...report,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
