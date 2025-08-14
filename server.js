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

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  // client sends: { messages: [...], context: "AI_KNOWLEDGE_JSON: {...}\nVISIBLE_TEXT: ..." }
  const { messages = [], context = '' } = req.body || {};

  // Softer policy: prioritise page data, but allow generic guidance when needed.
  const policy = `
You are StickerShop’s website assistant. Speak as "we"/"our" (first person plural).
SOURCE PRIORITY:
1) If PAGE_CONTEXT contains an "AI_KNOWLEDGE_JSON" block, treat that JSON as authoritative.
2) Otherwise use the rest of PAGE_CONTEXT text.
3) If the page doesn’t cover it, you MAY give general UK-relevant guidance, but keep it generic.
   Do NOT invent precise prices, lead times, SKUs, or certifications not in the page.
When you rely on general guidance, briefly prefix a line like "General guidance:".

Be concise, friendly and helpful. Use short paragraphs or bullets where it aids clarity.

FORMAT:
- Reply in **Markdown**.
- Use \`###\` subheadings for sections.
- Use **bold** labels and bullet lists where helpful.
- Avoid code fences unless showing code.
- Keep it concise and friendly.
`;

  // Put the whole context in the system message so the model always sees it
  const systemWithContext = `${policy}\n\nPAGE_CONTEXT START\n${String(context).slice(0, 12000)}\nPAGE_CONTEXT END`;

  try {
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemWithContext },
        // keep only the tail of the conversation to stay under token limits
        ...messages.slice(-12)
      ],
      temperature: 0.5,      // a bit more relaxed vs 0.3–0.4
      max_tokens: 800
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