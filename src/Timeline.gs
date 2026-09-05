/**
 * Episode (time-gap) grouping + last-ingest tracking.
 *
 * The per-day timeline files / `/timeline` command were removed (they duplicated
 * /episodes). `appendToTimeline_` is kept (name unchanged to avoid churn at its
 * many call sites) but now only maintains meta.lastIngestTs, which /me shows as
 * "last activity". `groupByEpisode_` is still used by /episodes and /themes.
 */

/** Record the last ingest time (for /me's last-activity). Lock-protected so
 *  concurrent captures don't clobber other meta fields. */
function appendToTimeline_(scope, record) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const metaFile = chatMetaFile_(scope);
    let meta = {};
    try { meta = JSON.parse(metaFile.getBlob().getDataAsString() || '{}'); } catch (_) {}
    // record.ts = 上傳當下時間（媒體轉錄延遲後才寫入，ts 仍是上傳時刻）。lastIngestTs 取較新者，
    // 別讓「延遲處理的媒體（較早 ts）寫在等待期間新打的文字之後」把 lastIngestTs 倒退（影響 freshness）。
    meta.lastIngestTs = (meta.lastIngestTs && Date.parse(meta.lastIngestTs) >= Date.parse(record.ts))
      ? meta.lastIngestTs : record.ts;
    metaFile.setContent(JSON.stringify(meta, null, 2));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Group a chronologically sorted array of records into sessions. A new
 * session starts whenever the gap to the previous record exceeds gapMs.
 * Returns array of { startTs, endTs, records[] }.
 */
function groupByEpisode_(records, gapMs) {
  if (!records || !records.length) return [];
  const out = [];
  let cur = null;
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (isNaN(t)) continue;
    if (!cur || (t - cur.endTs) > gapMs) {
      cur = { startTs: t, endTs: t, records: [r] };
      out.push(cur);
    } else {
      cur.records.push(r);
      cur.endTs = t;
    }
  }
  return out;
}

/* ── 記寫綁串（thread／串）───────────────────────────────────────────
 * 把一個敘事片段裡「連續記寫、通常是同一件事」的多則綁成一串。判「串/拆」：
 *   - 時間間隔（主）：≤TIGHT 連發＝預設串；隔得較久（仍在同片段，≤30 分）需有延續訊號才串。
 *   - 語言訊號：接續詞／前句沒寫完／無主詞指涉短句＝黏；切換詞＝拆（即使很近）。
 *   - 向量：很像→加分黏；**低相似一律不拿來拆**（短中文向量看字面、會誤殺碎句）。
 * 只做靜默綁串；「曖昧才輕提示」是下一階段，不在這裡。
 */
const THREAD_CONT_PREFIX_    = /^(而且|並且|然後|接著|再來|再者|所以|因此|於是|結果|還有|也|又|加上|此外|順著|但是?|不過|可是|因為)/;
const THREAD_SWITCH_PREFIX_  = /^(對了|另外|話說|順帶|順便|題外|換個|講到別的|欸對了|喔對了)/;
const THREAD_PRONOUN_PREFIX_ = /^(他|她|它|牠|他們|她們|它們|牠們|這|那|這些|那些|大家|其中|裡面|當時|那時|此事)/;

function threadText_(r) { return ((r && (r.aggregatedText || r.text)) || '').trim(); }

/** 邊界判定：cur 接在 prev 之後是「確定串 chain／確定拆 split／曖昧 ambiguous」。
 *  曖昧＝隔得比連發久、又沒明確延續或斷點訊號（兩邊都說得通），預設仍 lean-chain。 */
function boundaryConfidence_(prev, cur, gapMs) {
  if (cur && cur.threadBreak) return 'split';                              // 使用者按過「拆開」→ 永遠自成一串
  const text = threadText_(cur);
  if (THREAD_SWITCH_PREFIX_.test(text)) return 'split';                    // 切換詞開頭＝確定拆（即使連發）
  const prevText = threadText_(prev);
  const incompletePrev = !!(prevText && /[，、,：:；;…—\-]$/.test(prevText));         // 前句沒寫完
  const pronoun = THREAD_PRONOUN_PREFIX_.test(text) && text.length <= 16;           // 無主詞指涉短句
  const contWord = THREAD_CONT_PREFIX_.test(text);                                  // 接續詞
  const vecHigh = !!(prev && cur && prev.embedding && cur.embedding && prev.embedding.length
      && cosineSim_(prev.embedding, cur.embedding) >= THREAD_VEC_CHAIN_MIN);        // 向量很像（只加黏）
  if (gapMs <= THREAD_TIGHT_GAP_MS) return 'chain';                        // 連發＝確定串
  if (pronoun || incompletePrev || contWord || vecHigh) return 'chain';    // 有明確延續訊號＝串
  if (gapMs <= THREAD_AMBIG_GAP_MS) return 'ambiguous';                    // 中等間隔、無訊號＝曖昧（lean-chain）
  return 'split';                                                          // 隔很久又無訊號＝確定拆
}

/** cur 是否「接」在 prev 之後（同一串）。曖昧預設 lean-chain（仍歸同串、留待事後輕問）。 */
function recordChainsToPrev_(prev, cur, gapMs) {
  return boundaryConfidence_(prev, cur, gapMs) !== 'split';
}

/** 把（已同屬一個敘事片段的）records 依時間切成「串」。回傳 [[record,…],…]（各串時間排序）。 */
function segmentThreads_(records) {
  const sorted = (records || []).filter(r => r && r.ts).slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const threads = [];
  let cur = null, prev = null, prevTs = 0;
  for (const r of sorted) {
    const t = Date.parse(r.ts);
    if (isNaN(t)) continue;
    if (!cur) { cur = [r]; threads.push(cur); }
    else if (recordChainsToPrev_(prev, r, t - prevTs)) cur.push(r);
    else { cur = [r]; threads.push(cur); }
    prev = r; prevTs = t;
  }
  return threads;
}

/** 同串→同標籤：把每串內「已判（neighbor 的 r[field]）或本輪 LLM 給的標籤」收斂成一個
 *  （多數決、平手取最早），寫回 map 內**尚未判**的成員 → 達成「一串一個歸戶」。 */
function collapseLabelByThread_(threads, map, field) {
  (threads || []).forEach(th => {
    const eff = r => (r && r[field]) || map[r.id];     // 有效標籤：已判優先，否則本輪 LLM 給的
    let head = null;
    th.forEach(r => { const l = eff(r); if (l && head == null) head = l; });
    if (head == null) return;                          // 整串都還沒標 → 留給後備
    const votes = {};
    th.forEach(r => { const l = eff(r); if (l) votes[l] = (votes[l] || 0) + 1; });
    let best = head, bestN = -1;
    th.forEach(r => { const l = eff(r); if (l && votes[l] > bestN) { bestN = votes[l]; best = l; } });
    th.forEach(r => { if (!(r && r[field])) map[r.id] = best; });   // 只覆寫尚未判的
  });
  return map;
}
