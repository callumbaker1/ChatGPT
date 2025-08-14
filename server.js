// server.js (ESM)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Stickershop AI API is running');
});

/** Strict system prompt: ONLY answer from provided context */
function strictSystem(ctx = '', origin = '') {
  return `
You are a website-only assistant for ${origin}.
You may ONLY answer using the content provided in CONTEXT below.
Do NOT use outside knowledge, guesses, or unstated assumptions.

If the answer is not clearly supported by the context,
reply exactly with:
"I couldn't find that on this page. Try another page or ask a different question."

Write in concise UK English.

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

  const {
    messages = [],
    context = '',
    origin = '',
    strict = true
  } = req.body || {};

  try {
    const system = strict ? strictSystem(String(context).slice(0, 12000), origin)
                          : softSystem(String(context).slice(0, 3000));

    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages].slice(-12),
      temperature: 0,          // deterministic; no “creative” guesses
      top_p: 0.1,
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