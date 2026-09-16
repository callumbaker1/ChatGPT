// server.js (ESM) — StickerShop AI
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------- Paths & config ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT   = process.env.PORT || 3000;
const APIKEY = process.env.OPENAI_API_KEY;

// ---------------- Load catalogue (optional) ----------------
const CATALOG_PATH = path.join(__dirname, 'products.json');
let CATALOG = [];
try {
  if (fs.existsSync(CATALOG_PATH)) {
    CATALOG = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('products.json failed to load:', err.message);
}

// ---------------- Load help-center articles (optional) ----------------
// Generated from StickerShop-Theme-New/scripts/help-center/content.json -
// see that repo for the source of truth; this is a plain-text export.
const ARTICLES_PATH = path.join(__dirname, 'articles.json');
let ARTICLES = [];
try {
  if (fs.existsSync(ARTICLES_PATH)) {
    ARTICLES = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('articles.json failed to load:', err.message);
}

// ---------------- Normalisers for product objects ----------------
// Make an absolute/valid-ish URL from a variety of shapes.
function normalizeUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (!s) return '';

  // Protocol-relative (//cdn...) -> https
  if (s.startsWith('//')) s = 'https:' + s;

  // If it's already http(s): or data: or /relative, keep it
  if (/^(?:https?:|data:|\/)/i.test(s)) return s;

  // Otherwise treat as site-relative path
  return '/' + s.replace(/^\/+/, '');
}

// Try multiple image fields and return one best guess.
function firstImage(p = {}) {
  const cand = [
    p.thumb,
    p.image,
    p.image_url,
    p.img,
    p.images?.card,
    p.images?.thumb,
    Array.isArray(p.images) ? p.images[0] : null,
  ].find(Boolean);
  return normalizeUrl(cand || '');
}

// Map any raw product to the compact shape the frontend expects.
function pickForClient(p = {}) {
  const id =
    p.id || p.handle || p.sku || p.slug || p.title || Math.random().toString(36).slice(2);

  return {
    id,
    title: String(p.title || p.name || '').trim(),
    url: normalizeUrl(p.url || p.link || p.href || '#'),
    price: (p.price !== undefined && p.price !== null)
      ? Number(p.price)
      : null,
    unit: p.unit || '',
    pitch: p.pitch || p.subtitle || p.tagline || '',
    thumb: firstImage(p),  // <- unified key the UI uses for images
    // keep a few extras in case you want them later:
    currency: p.currency || 'GBP',
    tags: Array.isArray(p.tags) ? p.tags : [],
  };
}

// Trim catalogue for the model (fewer tokens)
const catalogForLLM = CATALOG.map(p => ({
  id: pickForClient(p).id,
  title: String(p.title || p.name || '').trim(),
  price: (p.price !== undefined && p.price !== null) ? Number(p.price) : null,
  currency: p.currency || 'GBP',
  tags: p.tags || [],
  pitch: p.pitch || ''
}));

// ---------------- Your policy (kept) ----------------
const policy = `
You are StickerShop’s website assistant. Speak as "we"/"our" (first person plural).
SOURCE PRIORITY:
1) If PAGE_CONTEXT contains an "AI_KNOWLEDGE_JSON" block, treat that JSON as authoritative.
2) Otherwise, if the question is about help/support topics (artwork setup, materials, ordering,
   proofing, delivery, accounts, etc.), use the ARTICLES corpus provided below - it is your
   primary source of truth for support questions and is authoritative over general knowledge.
3) Otherwise use the rest of PAGE_CONTEXT text.
4) If neither covers it, you MAY give general UK-relevant guidance, but keep it generic.
   Do NOT invent precise prices, lead times, SKUs, policies, or certifications not in the
   articles or page context.
When you rely on general guidance, briefly prefix a line like "General guidance:".

Be concise, friendly and helpful. Use short paragraphs or bullets where it aids clarity.

FORMAT:
- Reply in **Markdown**.
- Use \`###\` subheadings for sections.
- Use **bold** labels and bullet lists where helpful.
- Avoid code fences unless showing code.
- Keep it concise and friendly.
`;

// Small, additive guidance so the model knows how to use the help-centre
// article corpus and cite its sources - mirrors the product guidance below.
const articleGuidance = `
You have access to the full StickerShop Help & Support article library below (ARTICLES_JSON).
Use it as your primary source for any support/help question - artwork setup, materials,
ordering, proofing, delivery, accounts, etc. Do not invent facts (numbers, timeframes,
policies) that aren't in these articles.

ARTICLES_JSON:
${JSON.stringify(ARTICLES.map(a => ({ handle: a.handle, title: a.title, category: a.category, text: a.text })))}

MANDATORY LAST LINE - this is not optional:
Whenever your answer draws on ANY article(s) above (which will be true for almost every
support question), the VERY LAST LINE of your reply - after everything else, on its own
line - MUST be exactly this format, with no other text after it:
SOURCES_JSON=[{"handle":"<handle1>"},{"handle":"<handle2>"}]
List the 1-3 most relevant article handles, most relevant first, using the exact "handle"
value from ARTICLES_JSON. Only omit this line if the question was completely unrelated to
anything in the article library. Never mention or explain this line to the user - it is
parsed out before they see your reply.

Example of a correctly formatted reply (structure only, not real content):
### Heading
Some helpful answer text.
SOURCES_JSON=[{"handle":"what-is-bleed-and-why-do-i-need-it"}]
`;

// Small, additive guidance so the model knows how to surface products
const productGuidance = `
You have access to a small product catalogue (IDs and basics) for recommendations when the user asks for suggestions or comparisons.
Only use it when relevant. Never invent products or prices.

Catalogue (IDs and basics):
${JSON.stringify(catalogForLLM)}

If you decide to recommend, list up to 3 items in your Markdown answer (titles only),
and then END your message with a single line exactly like:
PRODUCTS_JSON=[{"id":"<id1>","note":"why"}, {"id":"<id2>","note":"why"}]
Do not mention this JSON line in the visible text.
`;

// ---------------- Utilities ----------------
/**
 * Extract a trailing PRODUCTS_JSON=[...] line.
 * Returns: { clean: string, items: fullProductObjects[] }
 */
function extractProductsFromReply(text) {
  const m = String(text).match(/PRODUCTS_JSON=(\[.*?\])\s*$/);
  if (!m) return { clean: String(text).trim(), items: [] };

  let ids = [];
  try { ids = JSON.parse(m[1]); } catch { ids = []; }

  const items = ids
    .map(x => {
      // find matching product in raw catalog (by id), then map for client
      const raw = CATALOG.find(p => {
        const candidateId = pickForClient(p).id; // ensure same id logic
        return candidateId === x.id;
      });
      return raw ? pickForClient(raw) : null;
    })
    .filter(Boolean);

  const clean = String(text).replace(/PRODUCTS_JSON=\[.*?\]\s*$/, '').trim();
  return { clean, items };
}

/**
 * Extract a trailing SOURCES_JSON=[...] line (help-article citations).
 * Returns: { clean: string, sources: {handle,title,url,category}[] }
 */
function extractSourcesFromReply(text) {
  const m = String(text).match(/SOURCES_JSON=(\[.*?\])\s*$/);
  if (!m) return { clean: String(text).trim(), sources: [] };

  let refs = [];
  try { refs = JSON.parse(m[1]); } catch { refs = []; }

  const sources = refs
    .map((r) => ARTICLES.find((a) => a.handle === r.handle))
    .filter(Boolean)
    .map((a) => ({ handle: a.handle, title: a.title, url: a.url, category: a.category }));

  const clean = String(text).replace(/SOURCES_JSON=\[.*?\]\s*$/, '').trim();
  return { clean, sources };
}

// ---------------- Product finder (homepage "which sticker do I need" box) ----------------
// Separate from the help-centre chat above: this endpoint returns structured
// data (not a chat reply) so the homepage can act on it directly - navigate
// to the right product and, where relevant, pre-select how it's supplied.
// Deliberately narrow in scope for now (product family + supplied format
// only) - deeper autoconfiguration of the builder's other options is left
// for later once StickerConfig's own setup is finalised.
const FAMILY_INFO = `
- stickers: Individual custom-shaped die-cut stickers for general use - branding, packaging, laptops, giveaways, product decoration. Our most popular, all-purpose option.
- labels: Product/packaging labels, usually applied by hand from a sheet.
- sheets: Multiple different designs printed together on one sheet (e.g. sticker packs, planner stickers, kids' sticker sheets).
- rolls: Labels supplied on a roll, for high-volume or machine/automatic application.
- wall: Large wall decals/graphics for interiors, murals, decor.
- floor: Floor decals/graphics, e.g. signage, social distancing markers, retail floor branding.
- window: Window clings/decals for shopfronts, vehicles, glass surfaces.
`;

const recommendPrompt = `
You are StickerShop's product finder assistant. Your ONLY job is to work out which product
FAMILY the customer needs, and (if relevant) how it should be SUPPLIED, then respond with
structured data - never invent prices, materials, or other details, and never discuss
anything outside picking a family/supplied format.

FAMILIES (pick exactly one):
${FAMILY_INFO}

SUPPLIED FORMAT (only meaningful when family is stickers, labels, sheets or rolls):
- Singles: Individual stickers, each die cut to its own shape ("Die Cut Singles").
- Sheets: Multiple stickers printed together and supplied on one sheet ("On Sheets").
- Rolls: Supplied on a roll, one sticker after another ("On Rolls").
- StickerSheets: A dedicated sticker sheet product - use this when family is "sheets".
- not_applicable: Use this for wall, floor and window families, or whenever supply format
  genuinely hasn't come up / doesn't matter for the recommendation.

RULES:
- Ask AT MOST one short clarifying question if you genuinely can't tell which family fits -
  e.g. if the customer just says "stickers" with no context. Otherwise make your best call.
- Never ask a second clarifying question - after one round of clarification, commit to a
  recommendation even if you're not fully certain.
- Keep "reason" to one short, friendly sentence explaining the pick in plain English.
- Do not discuss price, delivery times, or materials - that's handled later in the builder.
- If the request is nonsensical or totally unrelated to stickers/labels, set family to
  "unclear" and explain briefly in "reason".
`;

const recommendSchema = {
  name: 'sticker_recommendation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      needsClarification: { type: 'boolean' },
      clarifyingQuestion: { type: 'string' },
      family: { type: 'string', enum: ['stickers', 'labels', 'sheets', 'rolls', 'wall', 'floor', 'window', 'unclear'] },
      suppliedFormat: { type: 'string', enum: ['Singles', 'Sheets', 'Rolls', 'StickerSheets', 'not_applicable'] },
      reason: { type: 'string' }
    },
    required: ['needsClarification', 'clarifyingQuestion', 'family', 'suppliedFormat', 'reason'],
    additionalProperties: false
  }
};

// ---------------- App ----------------
const app = express();
app.use(cors());
app.use(express.json());

// Health/debug
app.get('/', (_req, res) => res.send('Stickershop AI API is running'));
app.get('/health', (_req, res) => res.json({ ok: true, products: CATALOG.length, articles: ARTICLES.length }));
app.get('/api/products', (_req, res) => {
  // Always return normalised products for the UI
  const out = CATALOG.map(pickForClient);
  res.json({ count: out.length, products: out });
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    if (!APIKEY) return res.status(500).send('Missing OPENAI_API_KEY');

    const { messages = [], context = '' } = req.body || {};

    const messagesForOpenAI = [
      // Your policy first
      { role: 'system', content: policy.trim() },
      // Page context (authoritative JSON beats text per your policy)
      ...(context
        ? [{ role: 'system', content: `PAGE_CONTEXT:\n${String(context).slice(0, 3000)}` }]
        : []),
      // Non-invasive product guidance (only used when relevant)
      ...(catalogForLLM.length ? [{ role: 'system', content: productGuidance.trim() }] : []),
      // Help-centre article corpus (only used when relevant)
      ...(ARTICLES.length ? [{ role: 'system', content: articleGuidance.trim() }] : []),
      // User/assistant history (keep short)
      ...messages.slice(-12)
    ];

    const body = {
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 700,
      messages: messagesForOpenAI
    };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APIKEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('OpenAI error:', data);
      return res.status(500).send(data?.error?.message || 'OpenAI request failed');
    }

    const raw = data?.choices?.[0]?.message?.content || '';
    const { clean: cleanOfSources, sources } = extractSourcesFromReply(raw);
    const { clean, items } = extractProductsFromReply(cleanOfSources);

    // items/sources are already client-shaped via their respective extractors
    res.json({ reply: clean, products: items, sources });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).send('Server error');
  }
});

// Product finder endpoint - returns structured JSON, not a chat reply
app.post('/api/recommend', async (req, res) => {
  try {
    if (!APIKEY) return res.status(500).send('Missing OPENAI_API_KEY');

    const { messages = [] } = req.body || {};

    const body = {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: 'system', content: recommendPrompt.trim() },
        ...messages.slice(-10)
      ],
      response_format: { type: 'json_schema', json_schema: recommendSchema }
    };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APIKEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('OpenAI error:', data);
      return res.status(500).send(data?.error?.message || 'OpenAI request failed');
    }

    let parsed;
    try {
      parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    } catch {
      parsed = null;
    }
    if (!parsed) return res.status(500).send('Bad model response');

    res.json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).send('Server error');
  }
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});