/**
 * POST /api/agent/search — AI agent that finds events (concerts, sports, etc.) + ticket pages.
 *
 * Uses Claude API with web search tool to find real-time event info.
 * Results are cached in KV for 1 hour to save API tokens.
 */

const { jsonResponse, corsHeaders, readBody } = require("../../lib");

// ── Lazy KV import ──
let kv = null;
function getKV() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try { kv = require("@vercel/kv").kv; return kv; } catch { return null; }
  }
  return null;
}

// ── Normalize query for cache key: lowercase, trim, remove accents ──
function normalizeQuery(q) {
  return q
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const body = await readBody(req);
  const query = (body.artist || body.query || "").trim();
  if (!query) return jsonResponse(res, { error: "Recherche requise" }, 400);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return jsonResponse(res, { error: "API key not configured" }, 500);

  // ── Check search cache in KV ──
  const store = getKV();
  const cacheKey = `search_cache:${normalizeQuery(query)}`;

  if (store) {
    try {
      const cached = await store.get(cacheKey);
      if (cached && cached.timestamp && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return jsonResponse(res, { ok: true, cached: true, ...cached.data });
      }
    } catch { /* cache miss, proceed normally */ }
  }

  try {
    const prompt = `Tu es un agent specialise dans la recherche de billetterie en France.

L'utilisateur cherche : "${query}"

Determine d'abord s'il s'agit :
- D'un ARTISTE / GROUPE (concert, spectacle, festival)
- D'une EQUIPE SPORTIVE (football, rugby, basket, etc.)
- D'un EVENEMENT specifique

Puis recherche sur le web :

**Si c'est une equipe sportive (ex: PSG, Paris FC, Red Star, OM, OL...) :**
- Les PROCHAINS matchs a domicile (les plus proches dans le temps)
- Le stade / lieu
- L'adversaire pour chaque match
- Les URLs des pages de billetterie OFFICIELLES du club (ex: billetterie.psg.fr, parisfootballclub.com/billetterie, redstarsfc.fr, etc.) ou des revendeurs autorises (ticketmaster.fr, fnacspectacles.com)
- Le championnat / competition (Ligue 1, Ligue 2, Coupe de France, Champions League, etc.)

**Si c'est un artiste / concert :**
- Les dates de concerts en France
- Les salles / lieux
- Les URLs EXACTES des pages de billetterie
- Le statut de la vente

Reponds UNIQUEMENT en JSON valide avec cette structure :
{
  "query": "${query}",
  "type": "concert" | "sport" | "event",
  "found": true ou false,
  "events": [
    {
      "name": "Nom de l'evenement (ex: 'PSG vs Marseille' ou 'Celine Dion')",
      "venue": "Nom du stade ou de la salle",
      "city": "Ville",
      "competition": "Ligue 1" ou null (pour les sports),
      "dates": ["2026-04-12"],
      "ticket_urls": [
        { "url": "https://...", "label": "Billetterie officielle" }
      ],
      "sale_date": null,
      "status": "en_vente" | "prevente" | "bientot" | "complet",
      "price_range": "15-50€" ou null
    }
  ],
  "message": "Resume court pour l'utilisateur"
}

IMPORTANT :
- Les URLs doivent etre de VRAIES URLs de pages de billetterie, pas des URLs inventees
- Pour le sport, cherche les 3 a 5 prochains matchs A DOMICILE
- Les dates au format YYYY-MM-DD
- Ne retourne QUE le JSON, rien d'autre`;

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      return jsonResponse(res, { error: `Claude API error: ${claudeResponse.status}`, details: err }, 500);
    }

    const claudeData = await claudeResponse.json();

    let responseText = "";
    for (const block of claudeData.content || []) {
      if (block.type === "text") {
        responseText += block.text;
      }
    }

    if (!responseText) {
      return jsonResponse(res, { ok: true, found: false, events: [], message: "Pas de reponse de l'agent" });
    }

    let parsed;
    try {
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/(\{[\s\S]*\})/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);
    } catch (e) {
      return jsonResponse(res, { error: "Failed to parse response", raw: responseText.substring(0, 500) }, 500);
    }

    // Normalize: support both "concerts" and "events" keys
    if (parsed.concerts && !parsed.events) {
      parsed.events = parsed.concerts;
      delete parsed.concerts;
    }

    // ── Save to KV cache ──
    if (store) {
      try {
        await store.set(cacheKey, { timestamp: Date.now(), data: parsed });
      } catch { /* cache write failure is non-critical */ }
    }

    return jsonResponse(res, { ok: true, ...parsed });

  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
