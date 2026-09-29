const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { DOMParser } = require('@xmldom/xmldom');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════
// FLUX RSS — sources culturelles
// ═══════════════════════════════════════
const FEEDS = [
  { id:'opdesk',   name:'Opportunity Desk',   url:'https://opportunitydesk.org/feed/',           cat:'opportunity', tag:'Global/Afrique' },
  { id:'ungrants', name:'UN Funding & Dev',    url:'https://news.un.org/feed/subscribe/en/news/topic/economic-development/feed/rss.xml', cat:'funding', tag:'Mondial' },
  { id:'youthop',  name:'Youth Opportunities', url:'https://www.youthop.com/feed',                cat:'opportunity', tag:'Mondial' },
  { id:'devex',    name:'Devex Global Dev',    url:'https://www.devex.com/news/rss.xml',          cat:'funding',     tag:'Mondial' },
  { id:'res',      name:'ResArtis',            url:'https://resartis.org/feed/',                  cat:'residency',   tag:'Mondial' },
  { id:'afrikan',  name:'Africans Rising',     url:'https://africansrising.net/feed/',            cat:'opportunity', tag:'Afrique' },
  { id:'arts2',    name:'ArtRabbit',           url:'https://www.artrabbit.com/feed',              cat:'event',       tag:'International' },
  { id:'callart',  name:'Calls for Artists',   url:'https://www.callsforartists.net/feed',        cat:'call',        tag:'International' },
];

// Cache en mémoire — évite de re-fetcher à chaque requête
let cache = { items: [], lastUpdate: null, feedStatus: {} };

// ── Nettoyage HTML ──
function cleanHtml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ').trim();
}

function fmtDate(s, locale) {
  if (!s) return locale === 'fr' ? 'Récent' : 'Recent';
  try {
    return new Date(s).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB',
      { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return locale === 'fr' ? 'Récent' : 'Recent'; }
}

function isRecent(s) {
  if (!s) return false;
  try { return (Date.now() - new Date(s).getTime()) < 7 * 24 * 60 * 60 * 1000; }
  catch { return false; }
}

// ── Fetch d'un flux RSS ──
async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      timeout: 12000,
      headers: { 'User-Agent': 'FESAL-CultureBot/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    if (!txt || txt.length < 100) throw new Error('Réponse vide');

    const parser = new DOMParser();
    const xml = parser.parseFromString(txt, 'text/xml');
    const items = Array.from(xml.getElementsByTagName('item'))
      .concat(Array.from(xml.getElementsByTagName('entry')));

    if (!items.length) throw new Error('Aucun item');

    const parsed = items.slice(0, 8).map((el, i) => {
      const g = tag => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
      const linkEl = el.getElementsByTagName('link')[0];
      let link = linkEl?.textContent?.trim() || linkEl?.getAttribute('href') || '';
      if (!link) link = el.getElementsByTagName('guid')[0]?.textContent?.trim() || '#';

      const rawTitle = g('title') || 'Sans titre';
      const rawDesc = g('description') || g('summary') || g('content') || '';
      const pubDate = g('pubDate') || g('published') || g('updated') || '';

      return {
        id: `${feed.id}_${i}_${Date.now()}`,
        cat: 'live',
        displayCat: feed.cat,
        title: rawTitle.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').substring(0, 120),
        org: `${feed.name} · ${feed.tag}`,
        desc_fr: cleanHtml(rawDesc).substring(0, 280),
        desc_en: cleanHtml(rawDesc).substring(0, 280),
        date_fr: fmtDate(pubDate, 'fr'),
        date_en: fmtDate(pubDate, 'en'),
        src: feed.name,
        link: link,
        isNew: isRecent(pubDate),
        isLive: true,
        fetchedAt: new Date().toISOString(),
      };
    });

    return { ok: true, items: parsed, count: parsed.length };
  } catch (e) {
    return { ok: false, items: [], count: 0, error: e.message };
  }
}

// ── Refresh de tous les flux ──
async function refreshAllFeeds() {
  console.log(`[${new Date().toISOString()}] Actualisation des flux RSS...`);
  const results = await Promise.allSettled(FEEDS.map(f => fetchFeed(f)));

  let allItems = [];
  let feedStatus = {};

  results.forEach((r, i) => {
    const feed = FEEDS[i];
    const result = r.status === 'fulfilled' ? r.value : { ok: false, items: [], count: 0, error: 'Échec' };
    feedStatus[feed.id] = { name: feed.name, tag: feed.tag, ok: result.ok, count: result.count, error: result.error || null };
    if (result.ok) allItems.push(...result.items);
  });

  cache.items = allItems;
  cache.lastUpdate = new Date().toISOString();
  cache.feedStatus = feedStatus;

  const active = Object.values(feedStatus).filter(f => f.ok).length;
  console.log(`[${new Date().toISOString()}] ${active}/${FEEDS.length} flux actifs — ${allItems.length} articles récupérés`);
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

// Santé du serveur
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: 'FËSAL Backend',
    lastUpdate: cache.lastUpdate,
    itemCount: cache.items.length,
    feedCount: Object.keys(cache.feedStatus).length,
  });
});

// Flux RSS agrégés
app.get('/api/feeds', (req, res) => {
  res.json({
    items: cache.items,
    lastUpdate: cache.lastUpdate,
    feedStatus: cache.feedStatus,
    total: cache.items.length,
  });
});

// Statut des sources
app.get('/api/status', (req, res) => {
  res.json({
    lastUpdate: cache.lastUpdate,
    feeds: cache.feedStatus,
    totalItems: cache.items.length,
  });
});

// Curateur IA — proxy sécurisé vers Anthropic
app.post('/api/ask', async (req, res) => {
  const { question, system, maxTokens = 800, lang = 'fr' } = req.body;
  if (!question) return res.status(400).json({ error: 'Question manquante' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Clé API non configurée sur le serveur' });

  const defaultSystem = lang === 'fr'
    ? `Tu es un curateur d'opportunités culturelles spécialisé dans le secteur créatif africain, notamment au Sénégal et en Afrique de l'Ouest. Aide les gestionnaires de projets et les artistes à trouver des résidences, bourses, appels à projets, événements et fellowships. Donne 2 à 4 exemples réels avec noms, organisations, délais et conseils pratiques. Utilise HTML simple : <strong> pour les titres, <br> pour les sauts de ligne. Sois chaleureux et professionnel. Réponds en français sauf si la question est en anglais.`
    : `You are a cultural opportunities curator specializing in the African creative sector, especially Senegal and West Africa. Help project managers and artists find residencies, grants, open calls, events and fellowships. Give 2–4 specific real examples. Use simple HTML: <strong> for titles, <br> for line breaks. Be warm and professional.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: system || defaultSystem,
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.map(c => c.type === 'text' ? c.text : '').join('') || '';
    res.json({ text, model: data.model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`✅ FËSAL Backend démarré sur le port ${PORT}`);
  // Premier chargement immédiat
  await refreshAllFeeds();
  // Puis toutes les 6 heures
  setInterval(refreshAllFeeds, 6 * 60 * 60 * 1000);
});
