/**
 * POST /api/agent/search — AI agent that finds concerts + ticket pages.
 *
 * Uses Claude API with web search tool to find real-time concert info.
 * No scraping needed — Claude searches the web directly.
 */

const { jsonResponse, corsHeaders, readBody } = require("../../lib");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const body = await readBody(req);
  const artist = (body.artist || "").trim();
  if (!artist) return jsonResponse(res, { error: "Nom d'artiste requis" }, 400);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return jsonResponse(res, { error: "API key not configured" }, 500);

  try {
    const prompt = `Recherche sur le web les concerts et la billetterie pour l'artiste "${artist}" en France.

Cherche specifiquement :
1. Les dates de concerts prevues en France (2025, 2026, 2027)
2. Les salles / lieux
3. Les URLs EXACTES des pages de billetterie (ticketmaster.fr, fnacspectacles.com, parisladefense-arena.com, accorarenaparis.com, seetickets.com, etc.)
4. Le statut de la vente (en vente, prevente, bientot, complet)
5. La fourchette de prix si disponible

Reponds UNIQUEMENT en JSON valide avec cette structure :
{
  "artist": "Nom exact de l'artiste",
  "found": true ou false,
  "concerts": [
    {
      "venue": "Nom de la salle",
      "city": "Ville",
      "dates": ["2026-09-12", "2026-09-16"],
      "ticket_urls": [
        { "url": "https://...", "label": "Ticketmaster" }
      ],
      "sale_date": "2026-04-10 10:00" ou null,
      "status": "en_vente" | "prevente" | "bientot" | "complet",
      "price_range": "45-120€" ou null
    }
  ],
  "message": "Resume court pour l'utilisateur"
}

IMPORTANT :
- Les URLs doivent etre de VRAIES URLs de pages de billetterie, pas des URLs inventees
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
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      return jsonResponse(res, { error: `Claude API error: ${claudeResponse.status}`, details: err }, 500);
    }

    const claudeData = await claudeResponse.json();

    // Extract text from the response (may have multiple content blocks)
    let responseText = "";
    for (const block of claudeData.content || []) {
      if (block.type === "text") {
        responseText += block.text;
      }
    }

    if (!responseText) {
      return jsonResponse(res, { ok: true, found: false, concerts: [], message: "Pas de reponse de l'agent" });
    }

    // Parse JSON from Claude's response
    let parsed;
    try {
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/(\{[\s\S]*\})/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);
    } catch (e) {
      return jsonResponse(res, { error: "Failed to parse response", raw: responseText.substring(0, 500) }, 500);
    }

    return jsonResponse(res, { ok: true, ...parsed });

  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
