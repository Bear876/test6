export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { model, base64, mediaType, prompt } = req.body;

  if (!base64 || !mediaType || !prompt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (model === 'groq-llava') {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) {
      return res.status(503).json({ error: 'Groq not configured' });
    }
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
              { type: 'text', text: prompt }
            ]
          }],
          max_tokens: 4096,
          temperature: 0.05
        })
      });
      if (!groqRes.ok) {
        const err = await groqRes.json().catch(() => ({}));
        return res.status(groqRes.status).json({ error: err?.error?.message || 'Groq error' });
      }
      const data = await groqRes.json();
      const raw = data.choices?.[0]?.message?.content || '';
      return res.status(200).json({ result: raw });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const GEMINI_KEY = process.env.GEMINI_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: base64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
        })
      }
    );
    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      const msg = errBody?.error?.message || `HTTP ${geminiRes.status}`;
      return res.status(geminiRes.status).json({ error: msg });
    }
    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ result: raw });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
