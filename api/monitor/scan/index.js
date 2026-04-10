/**
 * GET /api/monitor/scan — On-demand scan of all active events.
 *
 * Same detection logic as cron, but triggered manually.
 * No auth check. Returns full results.
 */

const {
  getUserId,
  getEvents,
  getStatus,
  saveStatus,
  getBaseline,
  saveBaseline,
  appendHistory,
  checkUrl,
  sendTelegram,
  sendWebPush,
  jsonResponse,
  corsHeaders,
} = require("../../lib");

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  const userId = getUserId(req);

  try {
    const events = await getEvents(userId);
    const active = events.filter((ev) => ev.active !== false);

    if (!active.length) {
      return jsonResponse(res, { ok: false, reason: "no_events", results: [] });
    }

    const now = new Date().toISOString();
    const timeStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const results = [];
    const newAlerts = [];

    for (const ev of active) {
      const eventId = ev.id || ev.name;
      const name = ev.name || "?";
      const venue = ev.venue || "";
      const closedMarker = ev.closed_marker || "";

      // Support both legacy `url` (string) and new `urls` (array of string or {url,label})
      const rawUrls = ev.urls || (ev.url ? [ev.url] : []);
      const urls = rawUrls.map(u => typeof u === 'string' ? u : u.url).filter(Boolean);

      for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
        const url = urls[urlIdx];

        // Load baseline for this url
        const baseline = await getBaseline(userId, eventId, urlIdx);

        // Run 3-layer detection
        const result = await checkUrl(url, closedMarker, baseline);

        // First run: save baseline, no alert
        if (!baseline) {
          await saveBaseline(userId, eventId, urlIdx, {
            md5: result.md5,
            links: result.links,
            savedAt: now,
          });

          results.push({
            event: name,
            url,
            status: result.status,
            detail: "Baseline enregistree — " + result.detail,
            ticketUrl: result.ticketUrl,
            time: timeStr,
            firstRun: true,
          });
          continue;
        }

        // Check for alerts — only if status CHANGED since last baseline
        const prevStatus = baseline.status || "CLOSED";
        const isNewOpen = result.status === "OPEN" && prevStatus !== "OPEN";
        const isNewChange = result.status === "CHANGED" && (result.newLinks.length > 0 || result.contentChanged);
        const shouldAlert = isNewOpen || isNewChange;

        if (shouldAlert && result.status !== "ERROR") {
          // Telegram alert
          const tgMsg =
            `🚨🚨🚨 BILLETTERIE ${result.status === "OPEN" ? "OUVERTE" : "CHANGEMENT DETECTE"} !!!\n\n` +
            `🎤 ${name}${venue ? " — " + venue : ""}\n\n` +
            `📋 ${result.detail}\n\n` +
            `👉 ${result.ticketUrl || url}\n\n` +
            (result.newLinks.length > 0 ? `🔗 ${result.newLinks.length} nouveau(x) lien(s)\n\n` : "") +
            `FONCE PRENDRE TES PLACES !`;
          await sendTelegram(tgMsg);

          // Web Push
          await sendWebPush(userId,
            result.status === "OPEN" ? "BILLETTERIE OUVERTE !" : "Changement detecte !",
            `${name} — ${result.detail}`,
            result.ticketUrl || url
          );

          newAlerts.push({
            time: timeStr,
            event: name,
            status: result.status,
            detail: result.detail,
            url: result.ticketUrl || url,
          });
        }

        // Update baseline (include status to avoid re-alerting)
        if (result.md5) {
          await saveBaseline(userId, eventId, urlIdx, {
            md5: result.md5,
            links: result.links,
            status: result.status,
            savedAt: now,
          });
        }

        // Append to history
        await appendHistory(userId, eventId, {
          time: now,
          timeStr,
          url,
          urlIdx,
          status: result.status,
          detail: result.detail,
          ticketUrl: result.ticketUrl,
          contentChanged: result.contentChanged,
          newLinksCount: result.newLinks.length,
          manual: true,
        });

        results.push({
          event: name,
          url,
          status: result.status,
          detail: result.detail,
          ticketUrl: result.ticketUrl,
          time: timeStr,
          contentChanged: result.contentChanged,
          newLinksCount: result.newLinks.length,
        });
      }
    }

    // Update status with scan results
    const status = await getStatus(userId);
    status.check_count = (status.check_count || 0) + 1;
    status.last_check = now;
    status.last_results = results;
    if (newAlerts.length > 0) {
      if (!status.alerts) status.alerts = [];
      status.alerts = [...status.alerts, ...newAlerts].slice(-50);
    }
    if (!status.logs) status.logs = [];
    for (const r of results) {
      status.logs.push({
        time: timeStr,
        message: `[SCAN] [${r.event}] ${r.status} — ${r.detail}`,
        level: r.status === "ERROR" ? "error" : r.status === "OPEN" ? "alert" : r.status === "CHANGED" ? "warning" : "info",
      });
    }
    status.logs = status.logs.slice(-200);
    await saveStatus(userId, status);

    return jsonResponse(res, {
      ok: true,
      checked: active.length,
      results,
      alerts: newAlerts,
      time: timeStr,
      v: 2,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
