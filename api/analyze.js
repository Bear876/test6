export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { model, base64, mediaType, prompt } = req.body;

  if (!model || !base64 || !mediaType || !prompt) {
    return res.status(400).json({ error: 'Missing required fields' });
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
          generationConfig: { temperature: 0.05, maxOutputTokens: 4000 }
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
