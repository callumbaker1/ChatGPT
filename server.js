// server.js (ESM)
import express from 'express';
import cors from 'cors';
import 'dotenv/config'; // loads .env

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Stickershop AI API is running');
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  const { messages = [], context = '' } = req.body || {};

  try {
    // Minimal example using OpenAI Chat Completions via fetch
    const system = context
      ? `Use this page context to answer succinctly:\n${String(context).slice(0, 3000)}`
      : 'You are a helpful assistant.';

    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages].slice(-12),
      temperature: 0.4,
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