/**
 * In-memory cosine similarity over the scope's embeddings.jsonl.
 * MVP scale: fine up to a few thousand records per chat.
 */

function cosineSim_(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Hybrid scoring: cosine similarity + keyword boost.
 *
 * Pure cosine similarity on Gemini embeddings is unreliable for short
 * Chinese queries — thematically related but vocabulary-different records
 * often score 0.55-0.65 (below the noise floor). Add a flat +0.3 boost
 * when the lowercased query string appears literally in the record's text,
 * so any record that contains the exact phrase will surface even when its
 * semantic score alone wouldn't pass SEARCH_MIN_SCORE.
 */
function topKByQuery_(scope, queryText, k) {
  k = k || 5;
  const qVec = geminiEmbed_(queryText);
  const records = loadEmbeddingRecords_(scope);
  const q = (queryText || '').toLowerCase().trim();
  const scored = [];
  for (const r of records) {
    // Prefer aggregatedEmbedding when a record has been supplemented via
    // quote-reply — that vector reflects the latest understanding
    // (original + corrections). Falls back to the original embedding for
    // un-supplemented records.
    const vec = r.aggregatedEmbedding || r.embedding;
    if (!vec) continue;
    const sem = cosineSim_(qVec, vec);
    // Keyword match still checks original text + aggregatedText so a query
    // that hits the literal supplement also boosts the original.
    const haystack = ((r.text || '') + ' ' + (r.aggregatedText || '')).toLowerCase();
    const keywordHit = q && haystack.indexOf(q) >= 0;
    const score = sem + (keywordHit ? 0.3 : 0);
    scored.push({ score, semScore: sem, keywordHit, record: r });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Records with ts in [startMs, endMs). */
function recordsInRange_(scope, startMs, endMs) {
  const records = loadEmbeddingRecords_(scope);
  return records.filter(r => {
    const t = Date.parse(r.ts);
    return !isNaN(t) && t >= startMs && t < endMs;
  });
}
