/**
 * GET /api/share?token={shareToken} — Public share page for an event.
 *
 * Returns an HTML page with event details + ticket purchase links.
 * No auth required (public share via token).
 */

const { corsHeaders, getKV, getEvents } = require("../lib");

// ── HTML escape to prevent XSS ──
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Validate and encode URL for href attributes ──
function safeHref(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return encodeURI(s);
  return '';
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    res.statusCode = 400;
    return res.end("Missing parameters");
  }

  const store = getKV();
  if (!store) { res.statusCode = 500; return res.end("Storage unavailable"); }

  // Look up share token
  const shareData = await store.get(`share:${token}`);
  if (!shareData || !shareData.userId || !shareData.eventId) {
    res.statusCode = 404;
    return res.end("Share link not found or expired");
  }

  const events = await store.get(`u:${shareData.userId}:events`) || [];
  const ev = events.find(e => e.id === shareData.eventId);

  if (!ev) { res.statusCode = 404; return res.end("Event not found"); }

  const dates = (ev.dates || []).map(d => typeof d === 'string' ? d : d.date).filter(Boolean);
  const urls = ev.urls || (ev.url ? [{url: ev.url, label: ''}] : []);

  const linksHtml = urls.map(u => {
    const href = safeHref(u.url || u);
    if (!href) return '';
    const label = escHtml(u.label || 'Acheter des billets');
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }).filter(Boolean).join('\n');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0f">
<title>${escHtml(ev.name || 'Event')} — goFindMyTickets</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{max-width:500px;width:100%;background:#111118;border:1px solid #1e1e2e;border-radius:20px;padding:2rem;text-align:center}
h1{font-size:1.5rem;color:#fff;margin-bottom:0.3rem}
h1 span{color:#f97316}
.name{font-size:1.2rem;font-weight:700;color:#f97316;margin:1rem 0 0.3rem}
.venue{color:#888;font-size:0.9rem}
.dates{color:#666;font-size:0.85rem;margin:0.5rem 0}
.links{display:flex;flex-direction:column;gap:0.5rem;margin-top:1rem}
.links a{display:block;background:#22c55e;color:#000;font-weight:700;padding:0.8rem;border-radius:12px;text-decoration:none;font-size:0.95rem}
.links a:active{transform:scale(0.97)}
.footer{margin-top:1.5rem;font-size:0.75rem;color:#444}
</style>
</head>
<body>
<div class="card">
<h1>go<span>Find</span>My<span>Tickets</span></h1>
<div class="name">${escHtml(ev.name || '')}</div>
<div class="venue">${escHtml(ev.venue || '')}</div>
<div class="dates">${dates.map(d => escHtml(d)).join(' · ')}</div>
<div class="links">
${linksHtml}
</div>
<div class="footer">Partage via goFindMyTickets</div>
</div>
</body>
</html>`;

  corsHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = 200;
  res.end(html);
};
