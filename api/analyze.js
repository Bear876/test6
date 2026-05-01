export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { model, base64, mediaType, prompt } = req.body;
  if (!base64 || !mediaType) return res.status(400).json({ error: 'Missing fields' });

  // ── HUGGING FACE — zero-shot image classification ────────────────────────
  if (model === 'hf-biomed') {
    const HF_KEY = process.env.HF_API_KEY;
    if (!HF_KEY) return res.status(503).json({ error: 'HF not configured' });
    try {
      const imgBuffer = Buffer.from(base64, 'base64');
      // Use BLIP image captioning — reliable and available on free tier
      const hfRes = await fetch(
        'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_KEY}`,
            'Content-Type': 'application/octet-stream'
          },
          body: imgBuffer
        }
      );
      if (!hfRes.ok) {
        const err = await hfRes.text();
        console.warn('HF error:', hfRes.status, err.slice(0, 100));
        return res.status(hfRes.status).json({ error: 'HF error: ' + hfRes.status });
      }
      const data = await hfRes.json();
      return res.status(200).json({ result: JSON.stringify(data) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ROBOFLOW EYE DETECTION ───────────────────────────────────────────────
  if (model === 'roboflow') {
    const RF_KEY = process.env.ROBOFLOW_API_KEY;
    if (!RF_KEY) return res.status(503).json({ error: 'Roboflow not configured' });
    try {
      // Use infer endpoint with base64 directly in URL
      const rfRes = await fetch(
        `https://detect.roboflow.com/eye-detection-4jkmm/1?api_key=${RF_KEY}&confidence=25`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: base64
        }
      );
      if (!rfRes.ok) {
        const err = await rfRes.text();
        console.warn('Roboflow error:', rfRes.status, err.slice(0, 100));
        return res.status(rfRes.status).json({ error: 'Roboflow error: ' + rfRes.status });
      }
      const data = await rfRes.json();
      return res.status(200).json({ result: JSON.stringify(data) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GROQ ─────────────────────────────────────────────────────────────────
  if (model === 'groq-llava') {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return res.status(503).json({ error: 'Groq not configured' });
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
        console.warn('Groq error:', groqRes.status, err?.error?.message);
        return res.status(groqRes.status).json({ error: err?.error?.message || 'Groq error' });
      }
      const data = await groqRes.json();
      return res.status(200).json({ result: data.choices?.[0]?.message?.content || '' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GEMINI ───────────────────────────────────────────────────────────────
  const GEMINI_KEY = process.env.GEMINI_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'Gemini key not configured' });
  try {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mediaType, data: base64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
        })
      }
    );
    if (!gemRes.ok) {
      const err = await gemRes.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${gemRes.status}`;
      console.warn('Gemini error:', gemRes.status, msg);
      return res.status(gemRes.status).json({ error: msg });
    }
    const data = await gemRes.json();
    return res.status(200).json({ result: data.candidates?.[0]?.content?.parts?.[0]?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
