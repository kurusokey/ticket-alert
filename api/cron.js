/**
 * GET /api/cron — Vercel Cron handler (runs every minute).
 *
 * The HEART of goFindMyTickets: checks all active events for ALL users,
 * compares against baselines, sends alerts on changes.
 */

const {
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
} = require("./lib");

// ── Helper: get KV store directly for all_users list ──
let _kv = null;
function getKV() {
  if (_kv) return _kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { _kv = require("@vercel/kv").kv; return _kv; } catch { return null; }
  }
  return null;
}

async function getAllUserIds() {
  const store = getKV();
  if (!store) return [null];
  try {
    const list = await store.get("all_users");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {}
  // Fallback: no user list yet, run once with null (legacy/single-user mode)
  return [null];
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  // Verify CRON_SECRET (Vercel sends this header for cron jobs)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return jsonResponse(res, { error: "Unauthorized" }, 401);
    }
  }

  const userIds = await getAllUserIds();
  const allUserResults = [];

  for (const userId of userIds) {
    const status = await getStatus(userId);

    // Only run if monitoring is active for this user
    if (!status.running) {
      allUserResults.push({ userId, ok: false, reason: "not_running" });
      continue;
    }

    const events = await getEvents(userId);
    const active = events.filter((ev) => ev.active !== false);

    if (!active.length) {
      allUserResults.push({ userId, ok: false, reason: "no_events" });
      continue;
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

      // Support both legacy `url` (string) and new `urls` (array)
      const urls = ev.urls || (ev.url ? [ev.url] : []);

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

          const entry = {
            time: now,
            timeStr,
            url,
            urlIdx,
            status: result.status,
            detail: "Baseline enregistree — " + result.detail,
            firstRun: true,
          };
          await appendHistory(userId, eventId, entry);
          results.push({ event: name, url, ...entry });
          continue;
        }

        // Check for alerts
        const shouldAlert =
          result.status === "OPEN" ||
          (result.status === "CHANGED") ||
          result.newLinks.length > 0 ||
          result.contentChanged;

        if (shouldAlert && result.status !== "ERROR") {
          // Build alert message
          let alertMsg = `BILLETTERIE - ${name}`;
          if (venue) alertMsg += ` - ${venue}`;
          alertMsg += `\n${result.detail}`;
          if (result.ticketUrl) alertMsg += `\n${result.ticketUrl}`;
          if (result.newLinks.length > 0) {
            alertMsg += `\n${result.newLinks.length} nouveau(x) lien(s)`;
          }

          // Telegram
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

        // Update baseline with latest data (even if no alert)
        if (result.md5) {
          await saveBaseline(userId, eventId, urlIdx, {
            md5: result.md5,
            links: result.links,
            savedAt: now,
          });
        }

        // Append to history
        const entry = {
          time: now,
          timeStr,
          url,
          urlIdx,
          status: result.status,
          detail: result.detail,
          ticketUrl: result.ticketUrl,
          contentChanged: result.contentChanged,
          newLinksCount: result.newLinks.length,
        };
        await appendHistory(userId, eventId, entry);
        results.push({ event: name, url, ...entry });
      }
    }

    // Update status
    status.check_count = (status.check_count || 0) + 1;
    status.last_check = now;
    status.last_results = results;
    if (newAlerts.length > 0) {
      if (!status.alerts) status.alerts = [];
      status.alerts = [...status.alerts, ...newAlerts].slice(-50);
    }
    // Keep last 200 log lines
    if (!status.logs) status.logs = [];
    for (const r of results) {
      status.logs.push({
        time: timeStr,
        message: `[${r.event}] ${r.status} — ${r.detail}`,
        level: r.status === "ERROR" ? "error" : r.status === "OPEN" ? "alert" : r.status === "CHANGED" ? "warning" : "info",
      });
    }
    status.logs = status.logs.slice(-200);

    await saveStatus(userId, status);

    allUserResults.push({
      userId,
      ok: true,
      checked: results.length,
      alerts: newAlerts.length,
      check_count: status.check_count,
    });
  }

  return jsonResponse(res, {
    ok: true,
    users: allUserResults,
  });
};
