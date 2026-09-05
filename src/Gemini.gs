/**
 * Gemini REST client. Uses an API key from Script Properties (single-user MVP).
 *
 * Generation: gemini-2.5-flash with multimodal parts (text + inline_data).
 * Embedding:  gemini-embedding-001 with output_dimensionality=EMBED_DIM.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function geminiGenerate_(parts, opts) {
  opts = opts || {};
  const key = getProp_(PROP.GEMINI_API_KEY);
  const url = `${GEMINI_BASE}/models/${MODELS.GENERATION}:generateContent?key=${encodeURIComponent(key)}`;
  // Thinking control changed between generations: 2.5 uses thinkingBudget
  // (0 = off), 3.x+ uses thinkingLevel (LOW/MEDIUM/HIGH, no off). Sending
  // both is a 400, so pick by the configured model's generation. Our tasks
  // (OCR / transcription / summary / short labels) don't need deep
  // reasoning, so we minimize: budget 0 on 2.5, level 'low' on 3.x.
  const isGen3Plus = /^gemini-(?:[3-9]|\d{2,})/.test(MODELS.GENERATION);
  const thinkingConfig = isGen3Plus
    ? { thinkingLevel: opts.thinkingLevel || 'low' }
    : { thinkingBudget: opts.thinkingBudget != null ? opts.thinkingBudget : 0 };
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: opts.temperature != null ? opts.temperature : 0.4,
      maxOutputTokens: opts.maxOutputTokens || 2048,
      thinkingConfig
    }
  };
  if (opts.systemInstruction) {
    payload.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 300) {
    const body = res.getContentText();
    const friendly = geminiErrorMessage_(code, body);
    if (friendly) throw new Error(friendly);
    throw new Error(`Gemini generate failed: ${code} ${body.slice(0, 500)}`);
  }
  const body = JSON.parse(res.getContentText());
  if (body.usageMetadata) {
    try { recordGenerateUsage_(body.usageMetadata); } catch (e) { console.warn('usage record failed:', e && e.message); }
    try {
      const gen = GEMINI_PRICING[MODELS.GENERATION] || { inputPerM: 0, outputPerM: 0 };
      const usd = ((body.usageMetadata.promptTokenCount || 0) * gen.inputPerM
                 + (body.usageMetadata.candidatesTokenCount || 0) * gen.outputPerM) / 1e6;
      chargeCurrentBillingUser_(usd);
    } catch (e) { console.warn('per-user charge (gen) failed:', e && e.message); }
  }
  const cand = (body.candidates && body.candidates[0]) || null;
  if (!cand) throw new Error(`Gemini returned no candidate: ${res.getContentText().slice(0, 500)}`);
  const textPart = (cand.content && cand.content.parts || []).map(p => p.text || '').join('').trim();
  return textPart;
}

function geminiEmbed_(text) {
  const key = getProp_(PROP.GEMINI_API_KEY);
  const url = `${GEMINI_BASE}/models/${MODELS.EMBEDDING}:embedContent?key=${encodeURIComponent(key)}`;
  const input = (text || '').slice(0, 8000);
  const payload = {
    model: `models/${MODELS.EMBEDDING}`,
    content: { parts: [{ text: input }] },
    outputDimensionality: EMBED_DIM
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 300) {
    const body = res.getContentText();
    const friendly = geminiErrorMessage_(code, body);
    if (friendly) throw new Error(friendly);
    throw new Error(`Gemini embed failed: ${code} ${body.slice(0, 500)}`);
  }
  try { recordEmbedUsage_(input.length); } catch (e) { console.warn('usage record failed:', e && e.message); }
  try {
    const emb = GEMINI_PRICING[MODELS.EMBEDDING] || { inputPerM: 0 };
    const usd = (input.length * emb.inputPerM) / 1e6;
    chargeCurrentBillingUser_(usd);
  } catch (e) { console.warn('per-user charge (embed) failed:', e && e.message); }
  const body = JSON.parse(res.getContentText());
  const values = body.embedding && body.embedding.values;
  if (!values) throw new Error('Gemini embed: no embedding.values');
  return values;
}

/** Helper: build an inline_data part from a Blob. */
function inlineDataPart_(blob, mimeType) {
  return {
    inline_data: {
      mime_type: mimeType || blob.getContentType() || 'application/octet-stream',
      data: Utilities.base64Encode(blob.getBytes())
    }
  };
}

/**
 * Condense LINE's English sticker keywords into one short traditional
 * Chinese phrase describing the emotion / action. Returns null on failure
 * so the caller can fall back to the raw keyword list instead of dropping
 * the sticker.
 *
 * Sticker keywords from LINE (e.g. ["treasure", "pucker", "adore", "Love",
 * "kiss", ...]) are repetitive English tags. Stickers are emotional
 * signals in a learning journal, so we want a clean Chinese phrase that
 * `/recall 興奮` or `/recall 沮喪` can match against.
 */
function geminiStickerSummary_(keywords) {
  const list = (keywords || []).slice(0, 30).join(', ');
  if (!list) return null;
  const prompt =
    '以下是 LINE 貼圖的英文情緒/動作標籤，請濃縮成一句 12 字以內的繁體中文情緒描述，'
    + '不要解釋、不要前綴、不要句號，直接給結果：\n' + list;
  try {
    const out = geminiGenerate_([{ text: prompt }], { temperature: 0.2, maxOutputTokens: 60 });
    return (out || '').trim() || null;
  } catch (e) {
    console.warn('geminiStickerSummary_ failed:', (e && e.message) || e);
    return null;
  }
}

/** 〔省額度〕貼圖情緒片語：**每個 stickerId 只算一次**（持久快取在 ScriptProperties），之後完全
 *  零 LLM。emoji 一律走啟發式（stickerEmoji_，本就零 LLM）；這裡只快取「給 /recall 搜尋用」的中文
 *  片語。回 phrase 或 null。 */
function stickerPhraseCached_(stickerId, keywords) {
  if (!keywords || !keywords.length) return null;
  const props = PropertiesService.getScriptProperties();
  const key = stickerId ? `stkphr_${stickerId}` : '';
  if (key) {
    const cached = props.getProperty(key);
    if (cached != null) return cached || null;   // '' ＝算過但無結果，仍不再呼叫
  }
  let phrase = null;
  try { phrase = geminiStickerSummary_(keywords); } catch (_) {}
  if (key) { try { props.setProperty(key, phrase || ''); } catch (_) {} }
  return phrase;
}
