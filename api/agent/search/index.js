const { jsonResponse, corsHeaders, readBody, getUserId } = require("../../lib");

// Search sources: DuckDuckGo HTML (no API key) + direct ticket sites
function buildSearchSources(artist) {
  const q = encodeURIComponent(artist);
  const qConc = encodeURIComponent(artist + " concert 2025 2026 billets France");
  return [
    // DuckDuckGo HTML (most reliable, no blocking)
    { name: "DuckDuckGo Concerts", url: `https://html.duckduckgo.com/html/?q=${qConc}` },
    { name: "DuckDuckGo Billets", url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(artist + " billets ticketmaster fnac")}` },
    // Direct ticket sites
    { name: "Ticketmaster", url: `https://www.ticketmaster.fr/search?q=${q}` },
    { name: "Paris La Defense Arena", url: `https://www.parisladefense-arena.com/?s=${q}` },
    { name: "Accor Arena", url: `https://www.accorarenaparis.com/rechercher?s=${q}` },
    { name: "Fnac Spectacles", url: `https://www.fnacspectacles.com/search/?term=${q}` },
  ];
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { corsHeaders(res); return res.end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const body = await readBody(req);
  const artist = (body.artist || "").trim();
  if (!artist) return jsonResponse(res, { error: "Nom d'artiste requis" }, 400);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return jsonResponse(res, { error: "API key not configured" }, 500);

  try {
    // Step 1: Fetch multiple sources in parallel
    const SEARCH_SITES = buildSearchSources(artist);
    const fetchResults = await Promise.allSettled(
      SEARCH_SITES.map(async (site) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const response = await fetch(site.url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              "Accept-Language": "fr-FR,fr;q=0.9",
              "Accept": "text/html",
            },
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timeout);
          if (!response.ok) return { site: site.name, error: `HTTP ${response.status}`, content: "" };
          const html = await response.text();
          // Extract text content (strip HTML but keep links)
          const { load } = require("cheerio");
          const $ = load(html);
          $("script, style, nav, footer, header, noscript").remove();
          // Get links with their text and href
          const links = [];
          $("a[href]").each(function() {
            let href = $(this).attr("href") || "";
            const text = $(this).text().trim();
            // Decode DuckDuckGo redirect URLs
            if (href.includes("duckduckgo.com/l/?uddg=")) {
              try {
                const url = new URL(href, "https://duckduckgo.com");
                href = decodeURIComponent(url.searchParams.get("uddg") || href);
              } catch {}
            }
            if (text && text.length > 3 && text.length < 200 && (href.startsWith("http://") || href.startsWith("https://"))) {
              links.push(`[${text}](${href})`);
            }
          });
          // Get main text content (trimmed)
          const textContent = $.text().replace(/\s+/g, " ").trim().substring(0, 3000);
          return { site: site.name, url: site.url, content: textContent.substring(0, 2000), links: links.slice(0, 30) };
        } catch (e) {
          return { site: site.name, error: e.message, content: "" };
        }
      })
    );

    const siteResults = fetchResults
      .filter(r => r.status === "fulfilled" && r.value.content)
      .map(r => r.value);

    // Step 2: Send to Claude API to extract structured concert info
    const prompt = `Tu es un assistant specialise dans la recherche de concerts et de billetterie en France.

L'utilisateur cherche des concerts de : **${artist}**

Voici les resultats de recherche sur plusieurs sites de billetterie francais :

${siteResults.map(r => `--- ${r.site} (${r.url || ''}) ---
Contenu: ${r.content}
Liens: ${(r.links || []).join("\n")}
`).join("\n\n")}

${siteResults.length === 0 ? "Aucun resultat trouve sur les sites de billetterie." : ""}

A partir de ces resultats, extrais TOUTES les informations de concert pour **${artist}** :

Reponds UNIQUEMENT en JSON valide avec cette structure :
{
  "artist": "Nom exact de l'artiste",
  "found": true/false,
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

Si tu ne trouves pas de concerts, mets found=false et un message explicatif.
Les dates doivent etre au format YYYY-MM-DD.
Ne retourne QUE le JSON, rien d'autre.`;

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
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      return jsonResponse(res, { error: `Claude API error: ${claudeResponse.status}`, details: err }, 500);
    }

    const claudeData = await claudeResponse.json();
    const responseText = claudeData.content?.[0]?.text || "";

    // Parse JSON from Claude's response
    let parsed;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/(\{[\s\S]*\})/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);
    } catch (e) {
      return jsonResponse(res, { error: "Failed to parse Claude response", raw: responseText }, 500);
    }

    return jsonResponse(res, { ok: true, ...parsed });

  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
};
