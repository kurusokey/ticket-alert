/**
 * GET /api/calendar?id={eventId} — Generate .ics calendar file for an event.
 */

const { getUserId, getEvents, corsHeaders } = require("../lib");

// ── Sanitize ICS field values (strip special chars and newlines) ──
const icsEscape = (s) => String(s || '').replace(/[,;\\]/g, ' ').replace(/[\r\n]+/g, ' ');

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); res.statusCode = 200; return res.end(); }

  const userId = getUserId(req);
  const eventId = new URL(req.url, "http://localhost").searchParams.get("id");
  const events = await getEvents(userId);
  const ev = events.find(e => e.id === eventId);

  if (!ev) {
    res.statusCode = 404;
    return res.end("Event not found");
  }

  // Build .ics content
  const dates = ev.dates || [];
  let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//goFindMyTickets//FR\n`;

  for (const d of dates) {
    const dateStr = typeof d === 'string' ? d : d.date;
    if (!dateStr) continue;
    const dt = dateStr.replace(/-/g, '');
    const uid = `${icsEscape(ev.id)}-${dt}@gofindmytickets`;
    ics += `BEGIN:VEVENT\n`;
    ics += `UID:${uid}\n`;
    ics += `DTSTART;VALUE=DATE:${dt}\n`;
    ics += `SUMMARY:${icsEscape(ev.name)}\n`;
    ics += `LOCATION:${icsEscape(ev.venue)}\n`;
    if (ev.url || ev.urls?.[0]?.url) ics += `URL:${ev.url || ev.urls[0].url}\n`;
    ics += `END:VEVENT\n`;
  }

  // Also add sale date if present
  if (ev.sale_date) {
    const saleDt = ev.sale_date.replace(/[-: ]/g, '').substring(0, 8);
    ics += `BEGIN:VEVENT\n`;
    ics += `UID:${icsEscape(ev.id)}-sale@gofindmytickets\n`;
    ics += `DTSTART;VALUE=DATE:${saleDt}\n`;
    ics += `SUMMARY:Ouverture vente - ${icsEscape(ev.name)}\n`;
    ics += `END:VEVENT\n`;
  }

  ics += `END:VCALENDAR`;

  // Sanitize filename
  const safeId = (ev.id || 'event').replace(/[^a-z0-9_-]/gi, '_');

  corsHeaders(res);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeId}.ics"`);
  res.statusCode = 200;
  res.end(ics);
};
