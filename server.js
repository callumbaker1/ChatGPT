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

// ---------------- Load sticker material knowledge (optional) ----------------
// Generated from StickerShop-Theme-New/scripts/sticker-finder/generate-material-knowledge.mjs,
// which itself is built from that repo's product-content/*.json - the real,
// maintained source of each material's product page copy and tech specs.
// Never hand-type material facts here; regenerate instead.
const MATERIALS_PATH = path.join(__dirname, 'materials.json');
let MATERIALS = [];
try {
  if (fs.existsSync(MATERIALS_PATH)) {
    MATERIALS = JSON.parse(fs.readFileSync(MATERIALS_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('materials.json failed to load:', err.message);
}

// ---------------- Load wall/floor/window family knowledge (optional) ----------------
// Generated from StickerShop-Theme-New's scripts/sticker-finder/generate-family-knowledge.mjs.
// These three families don't have a material rail (each is a single product,
// not a menu of separate material pages) so they had no real knowledge at
// all before this - the AI could only ask generic, ungrounded clarifying
// questions instead of the real choice each product actually offers
// (e.g. window: white or transparent cling; wall/floor: indoor or outdoor).
const FAMILIES_PATH = path.join(__dirname, 'families.json');
let FAMILIES = [];
try {
  if (fs.existsSync(FAMILIES_PATH)) {
    FAMILIES = JSON.parse(fs.readFileSync(FAMILIES_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('families.json failed to load:', err.message);
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
- sheets (Sticker Sheets - a distinct PRODUCT, not just "labels supplied on a sheet"): ONE SHEET
  containing SEVERAL DIFFERENT DESIGNS together, usually with a printed background connecting
  them (e.g. a kids' sticker pack, a planner sticker sheet, a sheet of mixed designs sold as one
  item). Only pick this family when the customer wants multiple different designs as one product
  - an everyday request for labels/stickers that happen to be delivered together on a backing
  sheet is family "labels" or "stickers" with suppliedFormat "Sheets" instead, not this.
- rolls: Labels supplied on a roll, for high-volume or machine/automatic application.
- wall: Wall decals/graphics for interiors, murals, decor, signage. Real indoor vs outdoor
  choice - see WALL/FLOOR/WINDOW DETAIL below, this matters as much as material does elsewhere.
- floor: Floor decals/graphics, e.g. safety markings, wayfinding, retail floor branding. Real
  indoor vs outdoor choice - see WALL/FLOOR/WINDOW DETAIL below.
- window: Window clings/decals for shopfronts, vehicles, glass surfaces. Real white (opaque) vs
  transparent choice - see WALL/FLOOR/WINDOW DETAIL below.
- refer_to_support: We don't sell this at all, or it's not available yet - see REFER TO SUPPORT below.
`;

// Real materials - generated by StickerShop-Theme-New's
// scripts/sticker-finder/generate-material-knowledge.mjs from that repo's own
// product-content/*.json (the maintained source of each material's product
// page copy and tech specs). Never hand-type material facts here - if this
// looks stale, regenerate materials.json instead of editing it by hand.
// The builder doesn't auto-select a material yet (that's a later step), but
// the assistant should still name the right one in "reason" when it clearly
// matters, same as a good member of staff would.
const MATERIAL_AVAILABILITY_NOTES = `
Sticker Sheets only offers Waterproof Vinyl or Premium Paper - NOT Biodegradable Paper, even
though that exists for the Stickers/Labels families.
Roll Labels only offers Waterproof Vinyl, Clear Waterproof Vinyl, Holographic Mosaic Vinyl or
Biodegradable Paper.
Wall, Floor and Window don't have a separate "material" (no "material" value applies - always
"none" for these families), but each is still a real choice between two variants of that one
product - see WALL/FLOOR/WINDOW DETAIL below, and don't skip it just because "material" isn't
involved.
`;
const MATERIAL_INFO = MATERIALS.length
  ? `Stickers and Labels can use any of these materials (JSON, one entry per material - "specs" and "highlights" are real product facts, use them):\n${JSON.stringify(MATERIALS)}\n\n${MATERIAL_AVAILABILITY_NOTES.trim()}`
  : MATERIAL_AVAILABILITY_NOTES.trim();

// Real facts for the three "single product, real variant choice" families -
// generated by generate-family-knowledge.mjs from the same product-content
// source as materials. No routable "material" field involved (these aren't
// separate product pages), but the choice is just as real and just as much
// a customer's actual decision, so the clarifying question when it's
// unclear should be THIS, not an invented generic one.
const WALL_FLOOR_WINDOW_INFO = FAMILIES.length
  ? `WALL/FLOOR/WINDOW DETAIL (JSON, one entry per family - "options" is the real choice each one offers):\n${JSON.stringify(FAMILIES)}`
  : '';

const recommendPrompt = `
You are StickerShop's product finder assistant. Your job is to work out which product FAMILY
the customer needs, how it should be SUPPLIED, and - where it genuinely matters - which
MATERIAL fits, then respond with structured data.

FAMILIES (pick exactly one):
${FAMILY_INFO}

STEP 1 - CHECK THIS FIRST, before anything else: does the customer's request describe
something we do not sell, or something listed as "Coming soon" in the builder? If so, this is
"refer_to_support" - full stop, do not pick "unclear" or force it into a family that doesn't
fit. This applies whenever the request clearly names a product/material/process outside our
range, for example (not exhaustive - use judgement for anything equivalent): fabric patches,
embroidered patches/badges, iron-on/heat transfer vinyl for t-shirts, keyrings, magnets,
mugs, business cards, vehicle wraps, large format PVC banners, engraving, 3D/embossed or
textured printing. It also applies when a safety- or compliance-relevant requirement is asked
about and NONE of the materials below actually confirm it - e.g. we cannot guarantee any
material is dishwasher-safe, so refer rather than guess on that. But check the material data
FIRST: some materials do carry real, specific certifications (e.g. a material's "specs" may
state food-contact/compostability compliance) - if one matches what's being asked, recommend
that material and name the certification in "reason" instead of referring to support. Only
refer when the requirement genuinely isn't covered by anything in the data. Explain briefly in
"reason" why it's being referred, so the customer isn't left guessing.

STEP 2 - only if step 1 doesn't apply: is the request itself too vague to route confidently,
even though it IS something we sell (e.g. just "I need some stickers" with no context, or "can
you help me with labels")? That's "unclear" - ask ONE short clarifying question about what
they're for. Don't use "unclear" for something we simply don't sell - that's always
"refer_to_support" instead, never "unclear".

STEP 3 - otherwise, pick the real family normally.

SUPPLIED FORMAT (only meaningful when family is stickers, labels, sheets or rolls) - this is
about physical packaging, and it is EASY to confuse "Sheets" here with family "sheets"
(Sticker Sheets) below because they share a word - they are NOT the same thing, read both
carefully:
- Singles: Individually die-cut stickers, not grouped with others - each one stands alone
  ("Die Cut Singles"). Our default for family "stickers" - use it whenever nothing suggests
  otherwise.
- Sheets: Our STANDARD default way of supplying stickers/labels - individually die-cut pieces
  (all the SAME design, unless told otherwise) grouped together on one shared peel-off backing
  sheet for convenience, e.g. a sheet of identical product labels ("On Sheets"). This is the
  default for family "labels" unless told otherwise. Despite the name, this is completely
  different from family "sheets" (Sticker Sheets) below - most everyday "labels on a sheet"
  requests are this, NOT that.
- Rolls: Supplied on a roll, one sticker after another ("On Rolls").
- StickerSheets: use this ONLY when family is "sheets" (see below) - never for an ordinary
  "labels on a sheet" request, which is suppliedFormat Sheets under family "labels" instead.
- not_applicable: ONLY for families that don't use a supplied format at all (wall, floor,
  window, unclear, refer_to_support). Never use it for stickers/labels/sheets/rolls just
  because you're unsure - pick the sensible default instead.

MATERIALS - IMPORTANT: most of these materials are their own separate product pages, not
options within one product, so the "material" field is what actually decides which page the
customer lands on - getting it right matters as much as "family" does, not just phrasing.
Set "material" to the exact matching value whenever the customer names, implies, or clearly
needs a specific one (a decorative/foil/metallic finish, eco/compostable, waterproof/outdoor,
see-through, extra-durable, strong adhesive for a tricky surface, a specific adhesive type -
see below). If the request is generic and a standard material is genuinely fine, set
"material" to "none" (this lands them on the default product for that family, which already
uses Waterproof Vinyl). Never guess a material value that isn't in the list below. Always name
it by its exact label in "reason" too (e.g. "Foiled stickers", never a vague phrase like "a
gold foil effect").
Each material's "options" array lists its REAL finish/adhesive choices (most are "Permanent
Only" - a few, like Waterproof Vinyl and Laminated Stickers, also offer Removable and/or
Extra-Permanent). If the customer asks for a removable, extra-strong, or specific-finish
sticker, check "options" and recommend a material that actually offers it - don't assume every
material does, and don't invent an adhesive type that isn't listed. Read the adhesive value
LITERALLY, word for word - "Permanent BioTak Biodegradable Adhesive" (Biodegradable Paper) is
PERMANENT, not removable, even though the words "biodegradable" and "adhesive" are right next
to each other; the material's other qualities (eco-friendly, paper, etc.) never imply anything
about its adhesive - only the word "Removable" actually appearing in "options" does.
Each material's "whiteInkAvailable" says whether we can print an opaque white ink layer under
the design on that material (needed on materials that aren't already solid, e.g. clear or
metallic/holographic materials, so colours don't pick up whatever's underneath - paper
materials are already opaque enough and never need it). Mention it in "reason" when relevant
(e.g. printing on a clear or metallic material) - it's an optional add-on, not a material
choice in itself, so don't let it change "material".
Each material's "categories" tags match the real filter tabs in the builder ("popular",
"metallics", "eco") - see BROWSING below for when this matters.
Each material's "suppliedFormats" lists which supplied formats ACTUALLY EXIST for it - this is
a hard constraint, not a preference. Most decorative/paper materials are Sheets-only; only
Waterproof Vinyl and Clear Waterproof Vinyl support Singles, and only a handful support Rolls.
Whenever "material" is not "none", "suppliedFormat" MUST be one of that material's
suppliedFormats - never combine a material with a format it doesn't actually offer (e.g. Paper
Foiled is Sheets-only, so it can never be "Singles", no matter what family/default logic above
would otherwise suggest). If the format the customer wants isn't in the chosen material's
suppliedFormats, either pick a different material that does offer it (if one clearly fits) or
say so honestly in "reason" instead of pairing them incorrectly.
${MATERIAL_INFO}

${WALL_FLOOR_WINDOW_INFO}
For wall/floor/window: check FIRST whether the customer's own words already answer the real
choice (window: the words "white"/"opaque" vs "transparent"/"clear"/"see-through"; wall/floor:
"indoor"/"inside" vs "outdoor"/"outside"/"exterior"/a specific outdoor surface like a shopfront,
pavement, brick wall). If they already said it, in this message or earlier in the
conversation, DO NOT ask again - set needsClarification to false and commit straight to a
confident answer that uses their stated choice in "reason". Only ask when it's genuinely not
stated anywhere yet, and when you do, that IS your one clarifying question - ask about that
specific real choice using the actual language from its "options"/description above, never a
vague generic question like "what design or effect are you looking for?".

BROWSING vs RECOMMENDING - these need different kinds of answer:
- RECOMMENDING (the default): the customer describes a NEED ("stickers for my wedding
  favours", "waterproof labels for my products") - commit to the single best family/material/
  suppliedFormat, as everywhere else in this prompt. Set isBrowse to false and leave
  browseOptions as an empty array.
- BROWSING: triggered by the PHRASING, not the topic - "what ... do you have", "what options",
  "show me", "which materials", "what's available in ...", "what do you offer in ..." are
  ALWAYS browsing, no matter which group they name (metallic, eco, paper, waterproof,
  popular, foiled, etc.) - treat this as an instant, unambiguous signal and go straight to
  browseOptions. Do NOT ask a clarifying question first just because the group has several
  members - that's exactly what browsing is for. (Contrast: "I want metallic stickers for my
  product" with no "what/which/show me" phrasing is a NEED, not browsing - that one should
  still get a single best pick, clarifying first only if truly ambiguous.) Forcing a single
  pick on a genuine browsing question would hide real choice, so instead set isBrowse to true,
  and fill browseOptions with EVERY material whose "categories" (or, for a grouping with no
  exact category tag like "waterproof" or "foiled", whose description) genuinely matches what
  was asked - typically 2-6 items, each with a one-sentence "note" on what makes it distinct
  from the others in the group. Still set "family" to your best-guess context (default
  "stickers" if unclear) and leave "material" as "none" - browseOptions carries the real
  answer. Keep "reason" to one short intro sentence (e.g. "Here's what we offer in
  metallics:").

RULES:
- Never ask a second clarifying question - after one round of clarification, commit to a
  recommendation even if you're not fully certain.
- "rolls" vs suppliedFormat "Rolls": these are different things. suppliedFormat "Rolls" means
  a sticker/label/sheet product simply packaged on a roll instead of loose. family "rolls" is
  our DEDICATED roll-fed label product built for automatic/machine dispensing at real volume
  (think barcode/warehouse/production-line labelling). If the customer specifically mentions
  automatic application, a dispensing machine, or labelling at meaningful volume/scale, prefer
  family "rolls" over giving another family a "Rolls" suppliedFormat.
- Keep "reason" to one or two short, friendly sentences explaining the pick in plain English.
- Do not discuss price or delivery times - that's handled later in the builder.
`;

// A handful of real, staff-reviewed answers - kept short and only for the
// trickier cases (material calls, refer-to-support calls), not the obvious
// ones, so the model sees what "good" looks like without bloating the prompt.
const RECOMMEND_EXAMPLES = `
WORKED EXAMPLES - these are not optional flavour text, they show the exact standard your real
answer must meet. Match this level of specificity every time (set "material" whenever a
specific one applies - it decides which product page the customer actually lands on, not just
what "reason" says - never leave suppliedFormat as not_applicable for stickers/labels/sheets/
rolls, use refer_to_support - never unclear - for anything we don't sell):
- "Can you make stickers with a gold foil effect for my wedding favours?" -> family: stickers,
  suppliedFormat: Singles, material: paper-foiled-stickers, reason: "We'd recommend our Paper
  Foiled stickers for that metallic foil finish, supplied as individual Die Cut Singles for
  your favours."
- "I would like some foiled labels please" (with nothing else to go on) -> needsClarification:
  true, clarifyingQuestion: "Foiled looks great on a few materials - would you like it on a
  waterproof material, a transparent one, or a paper finish?" (we offer 3 distinct foiled
  products - Transparent, Paper and Waterproof Foiled - so don't silently default to a
  non-foiled material like Waterproof Vinyl just because "labels" was also said; ask which foil
  base fits, then commit on the next message even if still not 100% sure)
- "I need stickers for my water bottle that will survive the dishwasher" -> family:
  refer_to_support, suppliedFormat: not_applicable, material: none, reason: "We can't guarantee
  our materials are fully dishwasher-safe, so it's best to check with our team before ordering
  for something that'll go through repeated washes." (no material's data confirms this, so
  refer)
- "I want eco-friendly labels for candle jars that are food safe" -> family: labels,
  suppliedFormat: Sheets, material: biodegradable-paper-stickers, reason: "Biodegradable Paper
  is a great fit - the facestock and adhesive are certified safe for direct food contact
  (EC1935/2004, FDA 175.105) and it's fully compostable." (this material's own data confirms
  it, so recommend it - don't refer just because the word "safe" appears)
- "Do you print fabric patches or embroidered badges?" -> family: refer_to_support,
  suppliedFormat: not_applicable, material: none, reason: "We don't currently offer fabric or
  embroidered patches - our team can let you know if that's something we can help with another
  way."
- "Looking for stickers to put on the outside of gift boxes as a seal" -> family: labels,
  suppliedFormat: Sheets, material: none, reason: "Labels supplied on a sheet are easiest to
  peel and stick as a seal on gift boxes - we can also supply on a roll if that suits your
  workflow better." (Waterproof Vinyl, the default, is genuinely fine here - no need to name
  a specific material)
- "I want stickers that are clear so the packaging colour shows through" -> family: labels,
  suppliedFormat: Sheets, material: clear-waterproof-vinyl, reason: "Clear Waterproof Vinyl
  labels let your packaging colour show through, supplied on a sheet for easy peeling."
- "I need labels for my product, and I'd like them supplied on a sheet" -> family: labels,
  suppliedFormat: Sheets, material: none, reason: "Labels supplied on a sheet is our standard
  option - they're individually die cut but grouped together on one backing sheet for easy
  peeling." (this is ordinary labels-on-a-sheet, NOT the Sticker Sheets product - family stays
  "labels")
- "I want a sheet with a few different fun designs on it, like a kids sticker pack" -> family:
  sheets, suppliedFormat: StickerSheets, material: none, reason: "Our Sticker Sheets are exactly
  this - multiple different designs together on one printed sheet." (this genuinely IS the
  Sticker Sheets product, because it's several different designs as one item, not just the
  everyday delivery format)
- "I need stickers with a removable adhesive so I can take them off later" -> family: stickers,
  suppliedFormat: Singles, material: waterproof-vinyl, isBrowse: false, browseOptions: [],
  reason: "Waterproof Vinyl offers a removable adhesive option alongside permanent, so you can
  take these off cleanly later." (checked "options" for waterproof-vinyl, which lists
  Removable - don't just default to the generic material without checking this)
- "I need window stickers" (nothing else said) -> needsClarification: true,
  clarifyingQuestion: "Would you like these on a solid white background, or transparent so
  people can still see through the glass?", family: window, suppliedFormat: not_applicable,
  material: none, isBrowse: false, browseOptions: [], reason: "" (window stickers have a real
  white-vs-transparent choice - ask THAT, not a vague "what design or effect" question, which
  gives the customer nothing concrete to answer)
- "I need transparent window stickers for my shop front" -> needsClarification: false,
  clarifyingQuestion: "", family: window, suppliedFormat: not_applicable, material: none,
  isBrowse: false, browseOptions: [], reason: "Window Stickers on our transparent static cling
  material will give you that 'invisible' see-through look on your shop front glass." (the word
  "transparent" already answers the one real question this family has - do NOT ask it again,
  commit immediately using what they said)
- "I want removable stickers, on a paper finish please" -> family: stickers, suppliedFormat:
  Sheets, material: paper-foiled-stickers, isBrowse: false, browseOptions: [], reason: "Paper
  Foiled is our paper-based material that offers a removable adhesive - Biodegradable, Kraft
  and Antique Paper are all Permanent Only, even though 'biodegradable' might sound flexible."
  (checked every paper-ish material's real "options" value word for word - only Paper Foiled
  actually says "Removable"; don't pick Biodegradable Paper just because it's the most obvious
  "paper" material, its adhesive is Permanent despite the name)
- "Can I get some foil stickers, individually cut please?" -> family: stickers, suppliedFormat:
  Sheets, material: paper-foiled-stickers, isBrowse: false, browseOptions: [], reason: "Paper
  Foiled stickers are supplied on sheets rather than individually die cut, so they'll come as a
  sheet you peel from rather than loose singles." (paper-foiled-stickers' suppliedFormats is
  ["Sheets"] only - Singles isn't real for this material even though the customer asked for it,
  so say so honestly in "reason" instead of promising something that doesn't exist)
- "I want holographic stickers, will the colours look solid or see-through?" -> family:
  stickers, suppliedFormat: Singles, material: holographic-vinyl-stickers, isBrowse: false,
  browseOptions: [], reason: "Holographic Mosaic Vinyl can take a white ink layer under your
  design, so your colours come out solid rather than picking up the holographic effect
  underneath - let us know when ordering if you'd like that." (whiteInkAvailable is true for
  this material, and it's directly relevant to what was asked, so mention it)
- "What metallic stickers do you have?" -> isBrowse: true, family: stickers, suppliedFormat:
  not_applicable, material: none, browseOptions: [
    { material: "metallic-vinyl-stickers", note: "Metallic Silver or Gold - a reflective satin
      metallic finish." },
    { material: "mirror-vinyl-stickers", note: "Mirror Silver, Gold or Rose Gold - a polished,
      high-shine mirror finish." },
    { material: "brushed-vinyl-stickers", note: "Brushed Silver, Gold or Rose Gold - a brushed
      metal texture, popular for weddings and luxury branding." },
    { material: "rainbow-vinyl-stickers", note: "Holographic Rainbow - a shifting rainbow
      metallic effect." },
    { material: "holographic-vinyl-stickers", note: "Holographic Mosaic - a mosaic-patterned
      holographic shimmer." },
    { material: "glitter-vinyl-stickers", note: "Glitter Vinyl - a sparkly glitter finish." }
  ], reason: "Here's what we offer in metallic finishes:" (all 6 are tagged "metallics" in the
  real data - list all of them, this is a browsing question, not one to narrow down)
`;

const MATERIAL_ENUM = ['none', ...MATERIALS.map((m) => m.value)];
const MATERIALS_BY_VALUE = new Map(MATERIALS.map((m) => [m.value, m]));

const SUPPLIED_FORMAT_PHRASES = {
  Singles: 'as individual Die Cut Singles',
  Sheets: 'on a sheet',
  Rolls: 'on a roll',
  StickerSheets: 'as a Sticker Sheet'
};

// Belt-and-braces on top of the prompt instruction: the model occasionally
// still pairs a material with a supplied format it doesn't really offer
// (found via a real bug - Paper Foiled recommended as "Die Cut Singles",
// which isn't a real product). Clamp deterministically to a format the
// material's own real data confirms, rather than trust wording alone.
// Also rewrites "reason" when correcting - leaving the old claim in place
// (e.g. still saying "individual Die Cut Singles" after silently changing
// suppliedFormat to Sheets) is its own bug: a visible contradiction between
// what the text says and what the page actually does.
function enforceSuppliedFormatAvailability(rec) {
  if (!rec || rec.isBrowse || !rec.material || rec.material === 'none') return rec;
  const material = MATERIALS_BY_VALUE.get(rec.material);
  if (!material || !Array.isArray(material.suppliedFormats) || !material.suppliedFormats.length) return rec;
  if (material.suppliedFormats.includes(rec.suppliedFormat)) return rec;

  const corrected = material.suppliedFormats[0];
  console.warn(`Corrected suppliedFormat for ${rec.material}: ${rec.suppliedFormat} -> ${corrected}`);
  const phrase = SUPPLIED_FORMAT_PHRASES[corrected] || corrected;
  return {
    ...rec,
    suppliedFormat: corrected,
    reason: `${material.label} is only supplied ${phrase} - that's how this one will come.`
  };
}

// Same idea for adhesive claims - testing found the model repeatedly (3/4
// runs) claiming Biodegradable Paper offers a removable adhesive, which is
// false (its real adhesive is "Permanent BioTak Biodegradable Adhesive").
// Doesn't change which material was picked (that may reflect other real
// reasons - eco, paper finish, etc.) - just stops it lying about a specific
// capability the material's own data contradicts.
function enforceAdhesiveClaims(rec) {
  if (!rec || rec.isBrowse || !rec.material || rec.material === 'none' || !rec.reason) return rec;
  const material = MATERIALS_BY_VALUE.get(rec.material);
  if (!material) return rec;

  const claimsRemovable = /removable/i.test(rec.reason);
  const actuallyRemovable = (material.options || []).some((o) => /removable/i.test(o));
  if (claimsRemovable && !actuallyRemovable) {
    console.warn(`False removable claim for ${rec.material}, correcting reason`);
    return { ...rec, reason: `${material.label} uses a permanent adhesive only - it doesn't offer a removable option. Let us know if that's a dealbreaker and we can point you to one that does.` };
  }
  return rec;
}

const recommendSchema = {
  name: 'sticker_recommendation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      needsClarification: { type: 'boolean' },
      clarifyingQuestion: { type: 'string' },
      family: { type: 'string', enum: ['stickers', 'labels', 'sheets', 'rolls', 'wall', 'floor', 'window', 'unclear', 'refer_to_support'] },
      suppliedFormat: { type: 'string', enum: ['Singles', 'Sheets', 'Rolls', 'StickerSheets', 'not_applicable'] },
      material: { type: 'string', enum: MATERIAL_ENUM },
      isBrowse: { type: 'boolean' },
      browseOptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            material: { type: 'string', enum: MATERIAL_ENUM },
            note: { type: 'string' }
          },
          required: ['material', 'note'],
          additionalProperties: false
        }
      },
      reason: { type: 'string' }
    },
    required: ['needsClarification', 'clarifyingQuestion', 'family', 'suppliedFormat', 'material', 'isBrowse', 'browseOptions', 'reason'],
    additionalProperties: false
  }
};

// ---------------- App ----------------
const app = express();
app.use(cors());
app.use(express.json());

// Health/debug
app.get('/', (_req, res) => res.send('Stickershop AI API is running'));
app.get('/health', (_req, res) => res.json({ ok: true, products: CATALOG.length, articles: ARTICLES.length, materials: MATERIALS.length, families: FAMILIES.length }));
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
      temperature: 0.15,
      max_tokens: 300,
      messages: [
        { role: 'system', content: recommendPrompt.trim() + '\n\n' + RECOMMEND_EXAMPLES.trim() },
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

    res.json(enforceAdhesiveClaims(enforceSuppliedFormatAvailability(parsed)));
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).send('Server error');
  }
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});