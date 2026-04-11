/**
 * GET /api/calendar?id={eventId} — Generate .ics calendar file for an event.
 * Returns user-friendly HTML error pages instead of raw text.
 */

const { getUserId, getEvents, corsHeaders } = require("../lib");

const icsEscape = (s) => String(s || '').replace(/[,;\\]/g, ' ').replace(/[\r\n]+/g, ' ');

function errorPage(res, status, title, message) {
  corsHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = status;
  res.end(`<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0f"><title>${title} — goFindMyTickets</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{max-width:400px;width:100%;background:#111118;border:1px solid #1e1e2e;border-radius:20px;padding:2rem;text-align:center}
h1{font-size:3rem;margin-bottom:0.5rem}h2{color:#fff;font-size:1.2rem;margin-bottom:0.5rem}
p{color:#888;font-size:0.9rem;margin-bottom:1.5rem}
a{display:inline-block;background:#f97316;color:#000;font-weight:700;padding:0.7rem 1.5rem;border-radius:12px;text-decoration:none}</style>
</head><body><div class="card">
<h1>${status === 404 ? '🔍' : '⚠️'}</h1>
<h2>${title}</h2>
<p>${message}</p>
<a href="/">Retour a l'app</a>
</div></body></html>`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

  try {
    const url = new URL(req.url, "http://localhost");
    const eventId = url.searchParams.get("id");
    const userId = getUserId(req) || url.searchParams.get("pin") || null;

    if (!eventId) {
      return errorPage(res, 400, "Parametre manquant", "L'identifiant de l'evenement est requis.");
    }

    if (!userId) {
      return errorPage(res, 401, "Non connecte", "Connecte-toi a l'app pour exporter le calendrier.");
    }

    const events = await getEvents(userId);
    const ev = events.find(e => e.id === eventId);

    if (!ev) {
      return errorPage(res, 404, "Evenement introuvable", "Cet evenement n'existe pas ou a ete supprime.");
    }

    const dates = ev.dates || [];
    if (dates.length === 0 && !ev.sale_date) {
      return errorPage(res, 404, "Aucune date", "Cet evenement n'a pas de date a exporter.");
    }

    let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//goFindMyTickets//FR\n`;

    for (const d of dates) {
      const dateStr = typeof d === 'string' ? d : d.date;
      if (!dateStr) continue;
      const dt = dateStr.replace(/-/g, '');
      ics += `BEGIN:VEVENT\n`;
      ics += `UID:${icsEscape(ev.id)}-${dt}@gofindmytickets\n`;
      ics += `DTSTART;VALUE=DATE:${dt}\n`;
      ics += `SUMMARY:${icsEscape(ev.name)}\n`;
      ics += `LOCATION:${icsEscape(ev.venue)}\n`;
      if (ev.url || ev.urls?.[0]?.url) ics += `URL:${ev.url || ev.urls[0].url}\n`;
      ics += `END:VEVENT\n`;
    }

    if (ev.sale_date) {
      const saleDt = ev.sale_date.replace(/[-: ]/g, '').substring(0, 8);
      ics += `BEGIN:VEVENT\n`;
      ics += `UID:${icsEscape(ev.id)}-sale@gofindmytickets\n`;
      ics += `DTSTART;VALUE=DATE:${saleDt}\n`;
      ics += `SUMMARY:Ouverture vente - ${icsEscape(ev.name)}\n`;
      ics += `END:VEVENT\n`;
    }

    ics += `END:VCALENDAR`;

    const safeId = (ev.id || 'event').replace(/[^a-z0-9_-]/gi, '_');
    corsHeaders(res);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeId}.ics"`);
    res.statusCode = 200;
    res.end(ics);

  } catch (err) {
    console.error(err);
    errorPage(res, 500, "Erreur interne", "Un probleme est survenu. Reessaie plus tard.");
  }
};
