/**
 * GET /api/share?token={shareToken} — Public share page for an event.
 * Returns styled HTML error pages for all error cases.
 */

const { corsHeaders, getKV, getEvents } = require("../lib");

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function safeHref(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return encodeURI(s);
  return '';
}

function htmlPage(res, status, content) {
  corsHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = status;
  res.end(`<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0f"><title>goFindMyTickets</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{max-width:500px;width:100%;background:#111118;border:1px solid #1e1e2e;border-radius:20px;padding:2rem;text-align:center}
h1{font-size:1.5rem;color:#fff;margin-bottom:0.3rem}h1 span{color:#f97316}
.name{font-size:1.2rem;font-weight:700;color:#f97316;margin:1rem 0 0.3rem}
.venue{color:#888;font-size:0.9rem}
.dates{color:#666;font-size:0.85rem;margin:0.5rem 0}
.links{display:flex;flex-direction:column;gap:0.5rem;margin-top:1rem}
.links a{display:block;background:#22c55e;color:#000;font-weight:700;padding:0.8rem;border-radius:12px;text-decoration:none;font-size:0.95rem}
.links a:active{transform:scale(0.97)}
.error-icon{font-size:3rem;margin-bottom:0.5rem}
.error-title{color:#fff;font-size:1.1rem;font-weight:600;margin-bottom:0.4rem}
.error-msg{color:#888;font-size:0.9rem;margin-bottom:1.5rem}
.btn-home{display:inline-block;background:#f97316;color:#000;font-weight:700;padding:0.7rem 1.5rem;border-radius:12px;text-decoration:none}
.footer{margin-top:1.5rem;font-size:0.75rem;color:#444}</style>
</head><body><div class="card">
<h1>go<span>Find</span>My<span>Tickets</span></h1>
${content}
<div class="footer">goFindMyTickets</div>
</div></body></html>`);
}

function errorPage(res, status, icon, title, message) {
  htmlPage(res, status, `
    <div class="error-icon">${icon}</div>
    <div class="error-title">${escHtml(title)}</div>
    <div class="error-msg">${escHtml(message)}</div>
    <a class="btn-home" href="/">Ouvrir l'app</a>
  `);
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      return errorPage(res, 400, '🔗', 'Lien invalide', 'Ce lien de partage est incomplet.');
    }

    const store = getKV();
    if (!store) {
      return errorPage(res, 500, '⚠️', 'Service indisponible', 'Le service est temporairement indisponible. Reessaie plus tard.');
    }

    const shareData = await store.get(`share:${token}`);
    if (!shareData || !shareData.userId || !shareData.eventId) {
      return errorPage(res, 404, '🔍', 'Lien expire ou invalide', 'Ce lien de partage n\'existe pas ou a expire. Demande un nouveau lien a la personne qui te l\'a envoye.');
    }

    const events = await store.get(`u:${shareData.userId}:events`) || [];
    const ev = events.find(e => e.id === shareData.eventId);

    if (!ev) {
      return errorPage(res, 404, '🗑️', 'Evenement supprime', 'Cet evenement a ete supprime par son proprietaire.');
    }

    const dates = (ev.dates || []).map(d => typeof d === 'string' ? d : d.date).filter(Boolean);
    const urls = ev.urls || (ev.url ? [{url: ev.url, label: ''}] : []);

    const linksHtml = urls.map(u => {
      const href = safeHref(u.url || u);
      if (!href) return '';
      const label = escHtml(u.label || 'Acheter des billets');
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">🎫 ${label}</a>`;
    }).filter(Boolean).join('\n');

    htmlPage(res, 200, `
      <div class="name">${escHtml(ev.name || '')}</div>
      <div class="venue">${escHtml(ev.venue || '')}</div>
      ${dates.length ? `<div class="dates">${dates.map(d => escHtml(d)).join(' · ')}</div>` : ''}
      ${linksHtml ? `<div class="links">${linksHtml}</div>` : '<div class="error-msg">Aucun lien de billetterie disponible</div>'}
    `);

  } catch (err) {
    console.error(err);
    errorPage(res, 500, '⚠️', 'Erreur inattendue', 'Un probleme est survenu. Reessaie plus tard.');
  }
};
