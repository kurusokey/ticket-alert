/**
 * GET /api/events/health — URL health check for all events.
 *
 * Tests all URLs for all events and returns health status.
 * Read-only: does NOT modify any data.
 *
 * Returns: { events: [ { id, name, urls: [ { url, label, ok, status } ] } ] }
 */

const {
  getUserId,
  getEvents,
  jsonResponse,
  corsHeaders,
} = require("../../lib");

var FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function testUrl(url) {
  // Try HEAD first with 5s timeout
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 5000);
    var resp = await fetch(url, {
      method: "HEAD",
      headers: FETCH_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    return { ok: resp.status < 400, status: resp.status };
  } catch (headErr) {
    // Fallback to GET if HEAD fails
    try {
      var controller2 = new AbortController();
      var timeout2 = setTimeout(function () { controller2.abort(); }, 5000);
      var resp2 = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: controller2.signal,
        redirect: "follow",
      });
      clearTimeout(timeout2);
      return { ok: resp2.status < 400, status: resp2.status };
    } catch (getErr) {
      var reason = getErr.name === "AbortError" ? "timeout" : "error";
      return { ok: false, status: reason };
    }
  }
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "GET") {
    return jsonResponse(res, { error: "Method not allowed" }, 405);
  }

  var userId = getUserId(req);

  try {
    var events = await getEvents(userId);
    var eventResults = [];

    // Build all URL test promises in parallel
    var allPromises = [];
    var promiseMap = []; // track which promise belongs to which event/url

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var rawUrls = ev.urls || (ev.url ? [{ url: ev.url, label: "" }] : []);

      for (var j = 0; j < rawUrls.length; j++) {
        var u = rawUrls[j];
        var urlStr = typeof u === "string" ? u : (u && u.url ? u.url : null);
        var label = typeof u === "string" ? "" : (u && u.label ? u.label : "");
        if (!urlStr) continue;

        allPromises.push(testUrl(urlStr));
        promiseMap.push({ eventIdx: i, url: urlStr, label: label });
      }
    }

    // Run all URL tests in parallel
    var results = await Promise.allSettled(allPromises);

    // Build response grouped by event
    var eventMap = {};
    for (var k = 0; k < results.length; k++) {
      var info = promiseMap[k];
      var ev2 = events[info.eventIdx];
      var evKey = ev2.id || ev2.name;

      if (!eventMap[evKey]) {
        eventMap[evKey] = {
          id: ev2.id || null,
          name: ev2.name || "?",
          urls: [],
        };
      }

      var testResult = results[k].status === "fulfilled"
        ? results[k].value
        : { ok: false, status: "error" };

      eventMap[evKey].urls.push({
        url: info.url,
        label: info.label,
        ok: testResult.ok,
        status: testResult.status,
      });
    }

    // Convert map to array
    var keys = Object.keys(eventMap);
    for (var m = 0; m < keys.length; m++) {
      eventResults.push(eventMap[keys[m]]);
    }

    return jsonResponse(res, { events: eventResults });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, { error: "Erreur interne" }, 500);
  }
};
