// server.js (ESM)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const BRAND_NAME = process.env.BRAND_NAME || 'StickerShop';
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Stickershop AI API is running');
});

/** Strict system prompt: ONLY answer from provided context */
function strictSystem(ctx = '', origin = '', brand = 'StickerShop') {
  return `
You are the on-site assistant for ${brand} (${origin}).
Speak as ${brand} in first-person plural — use “we”, “us”, and “our”.
Never refer to ${brand} in the third person (no “they/it/StickerShop says…”).

Style: concise, friendly UK English.

Source of truth:
• Use ONLY the provided CONTEXT from this page.
• If a JSON block named PRODUCT_MATRIX is present, treat it as canonical.
• If the answer is not supported by the context, reply exactly:
  "We couldn’t find that on this page. Try another page or ask a different question."

---- START CONTEXT ----
${ctx || '(no context provided)'}
---- END CONTEXT ----
`.trim();
}

/** Softer prompt (not used when strict=true) */
function softSystem(ctx = '') {
  if (!ctx) return 'You are a helpful assistant.';
  return `Use this page context to answer succinctly and accurately:\n${ctx}`;
}

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  const { messages = [], context = '' } = req.body || {};
  const origin = req.headers.origin || req.get('host') || 'this site';

  const system = strictSystem(context, origin, BRAND_NAME);

  try {
    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages].slice(-12),
      temperature: 0,        // keep it factual and less “creative”
      max_tokens: 600
    };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('OpenAI error:', data);
      return res.status(500).send(data?.error?.message || 'OpenAI request failed');
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));