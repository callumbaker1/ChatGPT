require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Allow all origins for now (easy while testing). You can lock this down later.
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'stickershop-ai-api' });
});

// Chat endpoint your widget will POST to
// Expects: { messages:[{role,content}...], context:string }
app.post('/api/chat', async (req, res) => {
  try {
    const { messages = [], context = '' } = req.body || {};
    const last = messages.length ? messages[messages.length - 1].content : '';

    // For now: echo a friendly reply so you can wire everything up.
    // Later you’ll swap this for a real model call.
    const reply =
      'Thanks! I received your message:\n\n' +
      (last || '(empty)') +
      (context ? '\n\n(P.S. I can also see some page context.)' : '');

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API listening on :' + PORT));
