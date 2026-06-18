// api/ai.js — Anthropic API proxy for Practice IQ (指導ノート要約・相談チャット)
// Requires Vercel environment variable: ANTHROPIC_API_KEY
// Accepts: { model?, max_tokens?, system?, messages: [{role, content}] }
// Returns: { text }  (also passes through content[] for compatibility)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  // Body may arrive as string on some runtimes
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'messages がありません' });
  }

  // Safety cap on total payload size (~150KB)
  const approxLen = JSON.stringify(messages).length + String(body.system || '').length;
  if (approxLen > 150000) {
    return res.status(400).json({ error: 'データが大きすぎます' });
  }

  const payload = {
    model: typeof body.model === 'string' ? body.model : 'claude-sonnet-4-6',
    max_tokens: Math.min(4000, Math.max(256, parseInt(body.max_tokens, 10) || 1200)),
    messages: messages
  };
  if (body.system) payload.system = String(body.system);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'AI APIエラー (' + response.status + ')' });
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n');

    return res.status(200).json({ text: text, content: data.content || [] });
  } catch (e) {
    console.error('ai proxy error:', e);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
};
