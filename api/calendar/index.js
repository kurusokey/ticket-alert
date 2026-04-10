/**
 * GET /api/calendar?id={eventId} — Generate .ics calendar file for an event.
 */

const { getUserId, getEvents, corsHeaders } = require("../lib");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.end(); }

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
    const uid = `${ev.id}-${dt}@gofindmytickets`;
    ics += `BEGIN:VEVENT\n`;
    ics += `UID:${uid}\n`;
    ics += `DTSTART;VALUE=DATE:${dt}\n`;
    ics += `SUMMARY:${(ev.name || '').replace(/[,;\\]/g, ' ')}\n`;
    ics += `LOCATION:${(ev.venue || '').replace(/[,;\\]/g, ' ')}\n`;
    if (ev.url || ev.urls?.[0]?.url) ics += `URL:${ev.url || ev.urls[0].url}\n`;
    ics += `END:VEVENT\n`;
  }

  // Also add sale date if present
  if (ev.sale_date) {
    const saleDt = ev.sale_date.replace(/[-: ]/g, '').substring(0, 8);
    ics += `BEGIN:VEVENT\n`;
    ics += `UID:${ev.id}-sale@gofindmytickets\n`;
    ics += `DTSTART;VALUE=DATE:${saleDt}\n`;
    ics += `SUMMARY:🎫 Ouverture vente — ${(ev.name || '').replace(/[,;\\]/g, ' ')}\n`;
    ics += `END:VEVENT\n`;
  }

  ics += `END:VCALENDAR`;

  corsHeaders(res);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${ev.id}.ics"`);
  res.statusCode = 200;
  res.end(ics);
};
