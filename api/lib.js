/**
 * Shared library for goFindMyTickets v2 — Node.js backend.
 *
 * KV storage (Vercel KV / Upstash Redis), detection engine, notifications.
 */

const crypto = require("crypto");
const { load: cheerioLoad } = require("cheerio");
const path = require("path");
const fs = require("fs");

// ── Lazy KV import (only when configured) ──
let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      kv = require("@vercel/kv").kv;
      return kv;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Lazy web-push import ──
let webpush = null;
function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require("web-push");
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:contact@gofindmytickets.com",
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    }
    return webpush;
  } catch {
    return null;
  }
}

// ── In-memory fallback cache ──
const _cache = { events: null, status: null };

// ── Config ──
const EVENTS_FILE = path.join(__dirname, "..", "data.json");

const TICKET_PLATFORMS = [
  "ticketmaster.fr", "ticketmaster.com", "fnacspectacles",
  "seetickets", "digitick", "eventbrite", "weezevent",
  "shotgun", "dice.fm", "festicket", "francebillet",
  "carrefourspectacles",
];

const PERMANENT_LINK_PATTERNS = [
  "/fr/panier", "/fr/identification", "/billetterie/",
  "/billets-securite/", "racing92.fr", "/groupes-et-ce/",
  "-offre-vip/",
];

const KEYWORD_HREF = [
  "panier", "cart", "checkout", "purchase", "manifestation",
  "booking", "order", "billet", "ticket", "reservation",
];

const KEYWORD_TEXT = [
  "acheter", "achetez vos billets", "achetez vos places",
  "prendre mes places", "reserver", "réserver",
  "accéder à la billetterie", "ajouter au panier",
  "places disponibles", "en vente", "billets disponibles",
];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
  "Accept-Encoding": "gzip, deflate",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

// ═══════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════

function md5(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function jsonResponse(res, data, code = 200) {
  corsHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = code;
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════
// AUTH — extract userId from request
// ═══════════════════════════════════════════════════════════

function getUserId(req) {
  // Read from Authorization header: "Bearer <code>"
  const auth = (req.headers?.authorization || "").replace("Bearer ", "").trim();
  return auth || null;
}

// ═══════════════════════════════════════════════════════════
// KV STORAGE — user-scoped with graceful fallback
// ═══════════════════════════════════════════════════════════

function _key(userId, key) {
  return userId ? `u:${userId}:${key}` : key;
}

async function getEvents(userId) {
  const store = getKV();
  if (store) {
    try {
      const data = await store.get(_key(userId, "events"));
      if (data !== null && data !== undefined) {
        _cache.events = data;
        return Array.isArray(data) ? data : [];
      }
    } catch { /* fallback */ }
  }
  if (_cache.events !== null) {
    return [..._cache.events];
  }
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    _cache.events = parsed;
    return [...parsed];
  } catch {
    return [];
  }
}

async function saveEvents(userId, events) {
  _cache.events = events;
  const store = getKV();
  if (store) {
    try {
      await store.set(_key(userId, "events"), events);
    } catch { /* silent */ }
  }
}

async function getStatus(userId) {
  const store = getKV();
  if (store) {
    try {
      const data = await store.get(_key(userId, "status"));
      if (data !== null && data !== undefined) {
        _cache.status = data;
        return data;
      }
    } catch { /* fallback */ }
  }
  if (_cache.status !== null) {
    return { ..._cache.status };
  }
  return {
    running: false,
    check_count: 0,
    started_at: null,
    logs: [],
    alerts: [],
    last_results: [],
  };
}

async function saveStatus(userId, status) {
  _cache.status = status;
  const store = getKV();
  if (store) {
    try {
      await store.set(_key(userId, "status"), status);
    } catch { /* silent */ }
  }
}

async function getBaseline(userId, eventId, urlIdx) {
  const key = _key(userId, `baseline:${eventId}:${urlIdx}`);
  const store = getKV();
  if (store) {
    try {
      const data = await store.get(key);
      if (data !== null && data !== undefined) return data;
    } catch { /* fallback */ }
  }
  return null;
}

async function saveBaseline(userId, eventId, urlIdx, data) {
  const key = _key(userId, `baseline:${eventId}:${urlIdx}`);
  const store = getKV();
  if (store) {
    try {
      await store.set(key, data);
    } catch { /* silent */ }
  }
}

async function getHistory(userId, eventId) {
  const key = _key(userId, `history:${eventId}`);
  const store = getKV();
  if (store) {
    try {
      const data = await store.get(key);
      if (data !== null && data !== undefined) return Array.isArray(data) ? data : [];
    } catch { /* fallback */ }
  }
  return [];
}

async function appendHistory(userId, eventId, entry) {
  const key = _key(userId, `history:${eventId}`);
  const store = getKV();
  if (store) {
    try {
      let history = await store.get(key);
      if (!Array.isArray(history)) history = [];
      history.push(entry);
      if (history.length > 100) history = history.slice(-100);
      await store.set(key, history);
    } catch { /* silent */ }
  }
}

async function getPushSubs(userId) {
  const store = getKV();
  if (store) {
    try {
      const data = await store.get(_key(userId, "push_subs"));
      if (data !== null && data !== undefined) return Array.isArray(data) ? data : [];
    } catch { /* fallback */ }
  }
  return [];
}

async function savePushSub(userId, sub) {
  const store = getKV();
  if (store) {
    try {
      let subs = await store.get(_key(userId, "push_subs"));
      if (!Array.isArray(subs)) subs = [];
      const exists = subs.find((s) => s.endpoint === sub.endpoint);
      if (!exists) {
        subs.push(sub);
        await store.set(_key(userId, "push_subs"), subs);
      }
    } catch { /* silent */ }
  }
}

async function removePushSub(userId, endpoint) {
  const store = getKV();
  if (store) {
    try {
      let subs = await store.get(_key(userId, "push_subs"));
      if (!Array.isArray(subs)) return;
      subs = subs.filter((s) => s.endpoint !== endpoint);
      await store.set(_key(userId, "push_subs"), subs);
    } catch { /* silent */ }
  }
}

// ═══════════════════════════════════════════════════════════
// DETECTION ENGINE — 3-layer analysis
// ═══════════════════════════════════════════════════════════

async function checkUrl(url, closedMarker, baseline) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        status: "ERROR",
        detail: `HTTP ${response.status}`,
        ticketUrl: null,
        md5: null,
        links: [],
        newLinks: [],
        contentChanged: false,
      };
    }

    const html = await response.text();
    const $ = cheerioLoad(html);

    // ── LAYER 1: Link scanning ──
    let ticketStatus = null;
    let ticketDetail = null;
    let ticketUrl = null;

    const allLinks = [];

    $("a[href]").each(function () {
      const href = ($(this).attr("href") || "").trim();
      const linkText = $(this).text().trim().toLowerCase();
      const hrefLower = href.toLowerCase();

      // Collect all links for Layer 3
      if (href && href.startsWith("http")) {
        allLinks.push(href);
      }

      // Skip permanent navigation links
      if (PERMANENT_LINK_PATTERNS.some((p) => hrefLower.includes(p))) {
        return; // continue
      }

      // Already found a ticket? Skip further checks
      if (ticketStatus) return;

      // Check ticketing platforms in href
      for (const platform of TICKET_PLATFORMS) {
        if (hrefLower.includes(platform)) {
          ticketStatus = "OPEN";
          ticketDetail = `Lien billetterie : ${platform}`;
          ticketUrl = href;
          return;
        }
      }

      // Check purchase keywords in href
      if (KEYWORD_HREF.some((kw) => hrefLower.includes(kw))) {
        // Skip generic navigation links
        if (!["groupes", "vip", "racing92"].some((skip) => hrefLower.includes(skip))) {
          ticketStatus = "OPEN";
          ticketDetail = `Lien d'achat detecte dans URL`;
          ticketUrl = href;
          return;
        }
      }

      // Check purchase keywords in link text
      if (KEYWORD_TEXT.some((kw) => linkText.includes(kw))) {
        if (!["groupes", "vip", "racing92"].some((skip) => hrefLower.includes(skip))) {
          ticketStatus = "OPEN";
          ticketDetail = `Bouton d'achat : '${linkText.substring(0, 60)}'`;
          ticketUrl = href;
          return;
        }
      }

      // Direct ticketing link patterns
      if (
        hrefLower.includes("tickets.") &&
        (/\/manifestation\//.test(hrefLower) ||
         /\/event\//.test(hrefLower) ||
         /\/show\//.test(hrefLower))
      ) {
        ticketStatus = "OPEN";
        ticketDetail = `Lien billetterie directe`;
        ticketUrl = href;
        return;
      }
    });

    // ── LAYER 2: MD5 content hash ──
    // Remove scripts, styles, nav, footer for meaningful content comparison
    const $clone = cheerioLoad(html);
    $clone("script, style, nav, footer, header, noscript, iframe").remove();
    let textContent = $clone.text();
    // Normalize whitespace
    textContent = textContent.replace(/\s+/g, " ").trim();
    const pageMd5 = md5(textContent);

    let contentChanged = false;
    if (baseline && baseline.md5 && baseline.md5 !== pageMd5) {
      contentChanged = true;
    }

    // ── LAYER 3: New links detection ──
    const linkSet = new Set(allLinks);
    const newLinks = [];
    if (baseline && baseline.links) {
      const baselineSet = new Set(baseline.links);
      for (const link of linkSet) {
        if (!baselineSet.has(link)) {
          newLinks.push(link);
        }
      }
    }

    // ── Determine final status ──
    if (ticketStatus) {
      return {
        status: ticketStatus,
        detail: ticketDetail,
        ticketUrl,
        md5: pageMd5,
        links: [...linkSet],
        newLinks,
        contentChanged,
      };
    }

    // Check closed marker
    const pageText = $.text().toLowerCase();
    if (closedMarker) {
      if (pageText.includes(closedMarker.toLowerCase())) {
        // If content changed or new links appeared, flag as CHANGED
        if (contentChanged || newLinks.length > 0) {
          return {
            status: "CHANGED",
            detail: `Page modifiee (${contentChanged ? "contenu" : ""}${contentChanged && newLinks.length > 0 ? " + " : ""}${newLinks.length > 0 ? newLinks.length + " nouveaux liens" : ""})`,
            ticketUrl: null,
            md5: pageMd5,
            links: [...linkSet],
            newLinks,
            contentChanged,
          };
        }
        return {
          status: "CLOSED",
          detail: `'${closedMarker}' toujours present`,
          ticketUrl: null,
          md5: pageMd5,
          links: [...linkSet],
          newLinks: [],
          contentChanged: false,
        };
      } else {
        return {
          status: "CHANGED",
          detail: `'${closedMarker}' a disparu !`,
          ticketUrl: null,
          md5: pageMd5,
          links: [...linkSet],
          newLinks,
          contentChanged: true,
        };
      }
    }

    // No closed marker configured — content/link changes still matter
    if (contentChanged || newLinks.length > 0) {
      return {
        status: "CHANGED",
        detail: `Page modifiee (${contentChanged ? "contenu" : ""}${contentChanged && newLinks.length > 0 ? " + " : ""}${newLinks.length > 0 ? newLinks.length + " nouveaux liens" : ""})`,
        ticketUrl: newLinks.length > 0 ? newLinks[0] : null,
        md5: pageMd5,
        links: [...linkSet],
        newLinks,
        contentChanged,
      };
    }

    return {
      status: "CLOSED",
      detail: "Aucun lien de billetterie detecte",
      ticketUrl: null,
      md5: pageMd5,
      links: [...linkSet],
      newLinks: [],
      contentChanged: false,
    };
  } catch (err) {
    const message = err.name === "AbortError"
      ? "Timeout (site surcharge ?)"
      : (err.message || String(err)).substring(0, 100);
    return {
      status: "ERROR",
      detail: message,
      ticketUrl: null,
      md5: null,
      links: [],
      newLinks: [],
      contentChanged: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* silent */ }
}

async function sendWebPush(userId, title, body, url) {
  const wp = getWebPush();
  if (!wp || !process.env.VAPID_PUBLIC_KEY) return;

  const subs = await getPushSubs(userId);
  if (!subs.length) return;

  const payload = JSON.stringify({
    title,
    body,
    url,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  });

  const expiredEndpoints = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await wp.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  for (const endpoint of expiredEndpoints) {
    await removePushSub(userId, endpoint);
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
  // Utility
  md5,
  corsHeaders,
  jsonResponse,
  readBody,
  getUserId,
  // KV Storage
  getEvents,
  saveEvents,
  getStatus,
  saveStatus,
  getBaseline,
  saveBaseline,
  getHistory,
  appendHistory,
  getPushSubs,
  savePushSub,
  removePushSub,
  // Detection
  checkUrl,
  TICKET_PLATFORMS,
  PERMANENT_LINK_PATTERNS,
  KEYWORD_HREF,
  KEYWORD_TEXT,
  // Notifications
  sendTelegram,
  sendWebPush,
};
