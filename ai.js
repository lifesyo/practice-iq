// api/ai.js — Google Gemini API proxy for Practice IQ (指導ノート要約・相談チャット)
// Requires Vercel environment variable: GEMINI_API_KEY  (無料枠キー: aistudio.google.com)
//
// アプリ側の callAI は { system, messages:[{role,content}], max_tokens } を送り、
// { text } を受け取る前提。ここで Anthropic 形式 → Gemini 形式に変換して中継する。

const MODEL = 'gemini-2.5-flash';   // 無料枠で使える高速モデル

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が設定されていません' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'messages がありません' });
  }

  // ペイロード上限（画像・PDFのbase64を含むため大きめに）
  const approxLen = JSON.stringify(messages).length + String(body.system || '').length;
  if (approxLen > 8000000) {
    return res.status(400).json({ error: 'データが大きすぎます（ファイルサイズを小さくしてください）' });
  }

  const contents = messages.map(function (m) {
    const role = (m.role === 'assistant') ? 'model' : 'user';
    var parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = [];
      m.content.forEach(function (b) {
        if (!b) return;
        if (b.type === 'text' && b.text != null) {
          parts.push({ text: String(b.text) });
        } else if ((b.type === 'image' || b.type === 'document') && b.source && b.source.data) {
          // base64 の画像・PDF を Gemini の inlineData として渡す
          parts.push({ inlineData: {
            mimeType: b.source.media_type || (b.type === 'document' ? 'application/pdf' : 'image/jpeg'),
            data: b.source.data
          }});
        } else if (b.text != null) {
          parts.push({ text: String(b.text) });
        }
      });
      if (!parts.length) parts = [{ text: '' }];
    } else {
      parts = [{ text: String(m.content || '') }];
    }
    return { role: role, parts: parts };
  });

  const payload = {
    contents: contents,
    generationConfig: {
      maxOutputTokens: Math.min(4000, Math.max(256, parseInt(body.max_tokens, 10) || 1200)),
      temperature: 0.6
    }
  };
  if (body.system) {
    payload.systemInstruction = { parts: [{ text: String(body.system) }] };
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const RETRYABLE = { 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };
  const MAX_TRIES = 4;

  try {
    let response = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        // ネットワーク例外も一時的とみなして再試行
        lastStatus = 0;
        if (attempt < MAX_TRIES - 1) { await sleep(600 * Math.pow(2, attempt)); continue; }
        throw netErr;
      }

      if (response.ok) break;

      lastStatus = response.status;
      if (RETRYABLE[response.status] && attempt < MAX_TRIES - 1) {
        // 0.6s, 1.2s, 2.4s … と待って再試行（混雑・過負荷向け）
        await sleep(600 * Math.pow(2, attempt));
        continue;
      }
      // 再試行対象外、または最終試行
      const errBody = await response.text();
      console.error('Gemini API error:', response.status, errBody);
      const msg = (response.status === 503 || response.status === 429)
        ? 'AIが混み合っています。少し待ってもう一度お試しください。'
        : 'AI APIエラー (' + response.status + ')';
      return res.status(502).json({ error: msg });
    }

    if (!response || !response.ok) {
      return res.status(502).json({ error: 'AIが混み合っています。少し待ってもう一度お試しください。（' + (lastStatus || 'network') + '）' });
    }

    const data = await response.json();
    let text = '';
    const cand = data && data.candidates && data.candidates[0];
    if (cand && cand.content && Array.isArray(cand.content.parts)) {
      text = cand.content.parts.map(function (p) { return p && p.text ? p.text : ''; }).join('');
    }
    if (!text) {
      const reason = (cand && cand.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || '';
      return res.status(200).json({ text: '', note: reason });
    }

    return res.status(200).json({ text: text });
  } catch (e) {
    console.error('ai proxy error:', e);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
};
