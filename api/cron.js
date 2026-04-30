/**
 * GET /api/cron — Vercel Cron handler (runs every minute).
 *
 * The HEART of goFindMyTickets: checks all active events for ALL users,
 * compares against baselines, sends alerts on changes.
 *
 * Smart features:
 * - Skips events where baseline status is already "OPEN"
 * - Skips events where ALL dates are in the past
 * - Respects quiet hours (still scans, skips Telegram notifications)
 * - Sends daily summary at first run after 08:00
 * - Saves cron heartbeat for health monitoring
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

// ── Helper: check if ALL dates of an event are in the past ──
function isEventPast(ev) {
  if (!ev.dates || !Array.isArray(ev.dates) || ev.dates.length === 0) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return ev.dates.every(function (d) {
    var dateStr = typeof d === "string" ? d : (d && d.date ? d.date : null);
    if (!dateStr) return false;
    var parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) return false;
    parsed.setHours(0, 0, 0, 0);
    return parsed < today;
  });
}

// ── Helper: check if baseline status is already OPEN for ALL urls of an event ──
async function isEventAlreadyOpen(userId, ev) {
  var eventId = ev.id || ev.name;
  var rawUrls = ev.urls || (ev.url ? [ev.url] : []);
  var urls = rawUrls.map(function (u) { return typeof u === "string" ? u : u.url; }).filter(Boolean);
  if (urls.length === 0) return false;

  for (var i = 0; i < urls.length; i++) {
    try {
      var baseline = await getBaseline(userId, eventId, i);
      if (!baseline || baseline.status !== "OPEN") return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── Helper: check if current time is in quiet hours ──
function isInQuietHours(settings) {
  if (!settings || !settings.quiet_hours || !settings.quiet_hours.enabled) return false;
  var start = settings.quiet_hours.start || "23:00";
  var end = settings.quiet_hours.end || "07:00";

  var now = new Date();
  var hh = now.getHours();
  var mm = now.getMinutes();
  var currentMinutes = hh * 60 + mm;

  var startParts = start.split(":");
  var startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1] || "0", 10);

  var endParts = end.split(":");
  var endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1] || "0", 10);

  // Handle overnight range (e.g., 23:00 -> 07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ── Helper: get user settings from KV ──
async function getUserSettings(userId) {
  var store = getKV();
  if (!store) return null;
  try {
    var key = userId ? "u:" + userId + ":settings" : "settings";
    var data = await store.get(key);
    return data || null;
  } catch {
    return null;
  }
}

// ── Helper: check if daily summary should be sent ──
async function shouldSendDailySummary(userId) {
  var store = getKV();
  if (!store) return false;

  var now = new Date();
  var hh = now.getHours();
  // Only send after 08:00
  if (hh < 8) return false;

  var todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  var key = userId ? "u:" + userId + ":last_summary" : "last_summary";

  try {
    var lastDate = await store.get(key);
    if (lastDate === todayStr) return false;
    // Mark as sent for today
    await store.set(key, todayStr);
    return true;
  } catch {
    return false;
  }
}

// ── Helper: save cron heartbeat ──
async function saveHeartbeat() {
  var store = getKV();
  if (!store) return;
  try {
    await store.set("cron:heartbeat", { timestamp: new Date().toISOString() });
  } catch {}
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  // Verify CRON_SECRET (Vercel sends this header for cron jobs)
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var authHeader = req.headers["authorization"];
    if (authHeader !== "Bearer " + cronSecret) {
      return jsonResponse(res, { error: "Unauthorized" }, 401);
    }
  }

  try {
    var userIds = await getAllUserIds();
    var allUserResults = [];

    for (var u = 0; u < userIds.length; u++) {
      var userId = userIds[u];
      var status = await getStatus(userId);

      // Only run if monitoring is active for this user
      if (!status.running) {
        allUserResults.push({ userId: userId, ok: false, reason: "not_running" });
        continue;
      }

      var events = await getEvents(userId);
      var active = events.filter(function (ev) { return ev.active !== false; });

      if (!active.length) {
        allUserResults.push({ userId: userId, ok: false, reason: "no_events" });
        continue;
      }

      // Load user settings for quiet hours
      var settings = await getUserSettings(userId);
      var quietMode = isInQuietHours(settings);

      var now = new Date().toISOString();
      var timeStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      var results = [];
      var newAlerts = [];
      var skippedPast = 0;
      var skippedOpen = 0;

      for (var e = 0; e < active.length; e++) {
        var ev = active[e];
        var eventId = ev.id || ev.name;
        var name = ev.name || "?";
        var venue = ev.venue || "";
        var closedMarker = ev.closed_marker || "";

        // ── Smart skip: past events ──
        if (isEventPast(ev)) {
          skippedPast++;
          continue;
        }

        // ── Smart skip: already OPEN in baseline ──
        var alreadyOpen = await isEventAlreadyOpen(userId, ev);
        if (alreadyOpen) {
          skippedOpen++;
          continue;
        }

        // Support both legacy `url` (string) and new `urls` (array of string or {url,label})
        var rawUrls = ev.urls || (ev.url ? [ev.url] : []);
        var urls = rawUrls.map(function (u2) { return typeof u2 === "string" ? u2 : u2.url; }).filter(Boolean);

        for (var urlIdx = 0; urlIdx < urls.length; urlIdx++) {
          var url = urls[urlIdx];

          // Load baseline for this url
          var baseline = await getBaseline(userId, eventId, urlIdx);

          // Run 3-layer detection
          var result = await checkUrl(url, closedMarker, baseline);

          // First run: save baseline, no alert
          if (!baseline) {
            await saveBaseline(userId, eventId, urlIdx, {
              md5: result.md5,
              links: result.links,
              status: result.status,
              savedAt: now,
            });

            var entry = {
              time: now,
              timeStr: timeStr,
              url: url,
              urlIdx: urlIdx,
              status: result.status,
              detail: "Baseline enregistree — " + result.detail,
              firstRun: true,
            };
            await appendHistory(userId, eventId, entry);
            results.push({ event: name, url: url, time: now, timeStr: timeStr, urlIdx: urlIdx, status: result.status, detail: entry.detail, firstRun: true });
            continue;
          }

          // Check for alerts — only if status changed since last baseline
          var prevStatus = baseline.status || "CLOSED";
          var isNewOpen = result.status === "OPEN" && prevStatus !== "OPEN";
          var isNewChange = result.status === "CHANGED" && (result.newLinks.length > 0 || result.contentChanged);
          var shouldAlert = isNewOpen || isNewChange;

          if (shouldAlert && result.status !== "ERROR") {
            // Build alert message
            var alertMsg = "BILLETTERIE - " + name;
            if (venue) alertMsg += " - " + venue;
            alertMsg += "\n" + result.detail;
            if (result.ticketUrl) alertMsg += "\n" + result.ticketUrl;
            if (result.newLinks.length > 0) {
              alertMsg += "\n" + result.newLinks.length + " nouveau(x) lien(s)";
            }

            // Telegram — skip if in quiet hours
            if (!quietMode) {
              var tgMsg =
                "\u{1F6A8}\u{1F6A8}\u{1F6A8} BILLETTERIE " + (result.status === "OPEN" ? "OUVERTE" : "CHANGEMENT DETECTE") + " !!!\n\n" +
                "\u{1F3A4} " + name + (venue ? " \u2014 " + venue : "") + "\n\n" +
                "\u{1F4CB} " + result.detail + "\n\n" +
                "\u{1F449} " + (result.ticketUrl || url) + "\n\n" +
                (result.newLinks.length > 0 ? "\u{1F517} " + result.newLinks.length + " nouveau(x) lien(s)\n\n" : "") +
                "FONCE PRENDRE TES PLACES !";
              await sendTelegram(tgMsg);
            }

            // Web Push — also skip during quiet hours
            if (!quietMode) {
              await sendWebPush(userId,
                result.status === "OPEN" ? "BILLETTERIE OUVERTE !" : "Changement detecte !",
                name + " \u2014 " + result.detail,
                result.ticketUrl || url
              );
            }

            newAlerts.push({
              time: timeStr,
              event: name,
              status: result.status,
              detail: result.detail,
              url: result.ticketUrl || url,
              quietSuppressed: quietMode,
            });
          }

          // Update baseline with latest data + status (even if no alert)
          if (result.md5) {
            await saveBaseline(userId, eventId, urlIdx, {
              md5: result.md5,
              links: result.links,
              status: result.status,
              savedAt: now,
            });
          }

          // Append to history
          var histEntry = {
            time: now,
            timeStr: timeStr,
            url: url,
            urlIdx: urlIdx,
            status: result.status,
            detail: result.detail,
            ticketUrl: result.ticketUrl,
            contentChanged: result.contentChanged,
            newLinksCount: result.newLinks.length,
          };
          await appendHistory(userId, eventId, histEntry);
          results.push({ event: name, url: url, time: now, timeStr: timeStr, urlIdx: urlIdx, status: result.status, detail: result.detail, ticketUrl: result.ticketUrl, contentChanged: result.contentChanged, newLinksCount: result.newLinks.length });
        }
      }

      // ── Daily summary ──
      var sendSummary = await shouldSendDailySummary(userId);
      if (sendSummary && !quietMode) {
        try {
          var totalEvents = active.length;
          var openCount = 0;
          var soonCount = 0;
          var todayDate = new Date();
          todayDate.setHours(0, 0, 0, 0);

          for (var s = 0; s < active.length; s++) {
            var sev = active[s];
            // Check if any baseline is OPEN
            var sevId = sev.id || sev.name;
            var sevRawUrls = sev.urls || (sev.url ? [sev.url] : []);
            var sevUrls = sevRawUrls.map(function (su) { return typeof su === "string" ? su : su.url; }).filter(Boolean);
            for (var si = 0; si < sevUrls.length; si++) {
              try {
                var sevBaseline = await getBaseline(userId, sevId, si);
                if (sevBaseline && sevBaseline.status === "OPEN") { openCount++; break; }
              } catch {}
            }

            // Check if event is within 7 days
            if (sev.dates && Array.isArray(sev.dates)) {
              for (var di = 0; di < sev.dates.length; di++) {
                var dateStr = typeof sev.dates[di] === "string" ? sev.dates[di] : (sev.dates[di] && sev.dates[di].date ? sev.dates[di].date : null);
                if (dateStr) {
                  var parsed = new Date(dateStr);
                  if (!isNaN(parsed.getTime())) {
                    parsed.setHours(0, 0, 0, 0);
                    var diffDays = Math.ceil((parsed - todayDate) / 86400000);
                    if (diffDays >= 0 && diffDays <= 7) { soonCount++; break; }
                  }
                }
              }
            }
          }

          var summaryMsg =
            "\u{1F4CA} goFindMyTickets \u2014 Resume quotidien\n\n" +
            "\u{1F50D} " + totalEvents + " evenement(s) surveille(s)\n" +
            "\u{1F7E2} " + openCount + " en vente\n" +
            "\u{23F0} " + soonCount + " bientot (< 7 jours)\n\n" +
            "Bonne journee !";
          await sendTelegram(summaryMsg);
        } catch {}
      }

      // Update status
      status.check_count = (status.check_count || 0) + 1;
      status.last_check = now;
      status.last_results = results;
      if (newAlerts.length > 0) {
        if (!status.alerts) status.alerts = [];
        status.alerts = [].concat(status.alerts, newAlerts).slice(-50);
      }
      // Keep last 200 log lines
      if (!status.logs) status.logs = [];
      for (var r = 0; r < results.length; r++) {
        var res2 = results[r];
        status.logs.push({
          time: timeStr,
          message: "[" + res2.event + "] " + res2.status + " \u2014 " + res2.detail,
          level: res2.status === "ERROR" ? "error" : res2.status === "OPEN" ? "alert" : res2.status === "CHANGED" ? "warning" : "info",
        });
      }
      status.logs = status.logs.slice(-200);

      await saveStatus(userId, status);

      allUserResults.push({
        userId: userId,
        ok: true,
        checked: results.length,
        alerts: newAlerts.length,
        check_count: status.check_count,
        skippedPast: skippedPast,
        skippedOpen: skippedOpen,
        quietMode: quietMode,
      });
    }

    // ── Save heartbeat after processing all users ──
    await saveHeartbeat();

    return jsonResponse(res, {
      ok: true,
      users: allUserResults,
    });
  } catch (err) {
    console.error("Cron error:", err);
    const msg = String(err.message || err);
    if (msg.includes("max requests limit exceeded") || msg.includes("limit exceeded")) {
      return jsonResponse(res, { error: "KV limit reached — cron paused", kvLimitReached: true }, 503);
    }
    return jsonResponse(res, { error: "Erreur interne cron" }, 500);
  }
};
