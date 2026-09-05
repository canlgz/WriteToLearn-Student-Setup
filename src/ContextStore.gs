/**
 * Persistence for the upper layers of the 5-layer model (see
 * docs/design/context-to-journey.md):
 *   層4 脈絡 (context) — contexts.jsonl
 *   層5 學習歷程片段 (journey) — journeys.jsonl
 *
 * These are the durable objects that the background upgrade flow will create /
 * update; until that flow is built they stay empty (so 脈絡/歷程 counts read 0).
 * One JSON object per line, like embeddings.jsonl; upsert by `id`, lock-protected.
 *
 * 脈絡 (context) object:
 *   { id, createdAt, updatedAt, label,
 *     userTitle,                              // 使用者手動改名（顯示優先於 label / journey.title）
 *     recordIds: [...],                       // the主題群組's member records
 *     firstTs, lastTs,                        // first→last member-record timestamp (all records)
 *     status: 'candidate' | 'context',        // 候選 / 已升格
 *     criteria: {                             // snapshot of the 3-condition check
 *       semanticDensity, clusterSeparation, returnVisits, returnSpanHours,
 *       mediaKinds, passed } }
 *
 * 歷程 (journey) object:
 *   { id, createdAt, updatedAt, contextId, label,
 *     title,                          // 可讀主題標題（detectContextMarkers_ 同呼叫產出）；卡片優先用 title || label
 *     markers: [ { type, evidence, confidence, detectedAt } ],  // 四種轉折標記
 *     status: 'journey' | 'watch',  // 'journey' 已升格(≥1 標記)；'watch' 已偵測但無標記＝持續關注
 *     basedOnUpdatedAt }            // 偵測當下對應 context.updatedAt，內容沒變就不重判(省 LLM)
 */

function chatJsonlFile_(scope, name) {
  const parent = chatFolder_(scope);
  const it = parent.getFilesByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFile(name, '', MimeType.PLAIN_TEXT);
}

function loadJsonl_(file) {
  const text = file.getBlob().getDataAsString();
  if (!text) return [];
  const out = [];
  for (const ln of text.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

/** Insert-or-replace a record by `id` in a per-chat jsonl. Lock-protected. */
function upsertJsonl_(scope, name, obj) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatJsonlFile_(scope, name);
    const rows = loadJsonl_(file);
    const i = rows.findIndex(r => r.id === obj.id);
    if (i >= 0) rows[i] = obj; else rows.push(obj);
    file.setContent(rows.map(r => JSON.stringify(r)).join('\n'));
    return obj;
  } finally {
    lock.releaseLock();
  }
}

/** Overwrite an entire per-chat jsonl with `rows` in one write. Lock-protected. */
function saveJsonl_(scope, name, rows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    chatJsonlFile_(scope, name).setContent(rows.map(r => JSON.stringify(r)).join('\n'));
    return rows;
  } finally {
    lock.releaseLock();
  }
}

/* ---- 脈絡 (層4) ---- */
function loadContexts_(scope) { return loadJsonl_(chatJsonlFile_(scope, CONTEXTS_FILE)); }
function upsertContext_(scope, obj) { return upsertJsonl_(scope, CONTEXTS_FILE, obj); }
/** Replace the whole 脈絡 store (used by the background upgrade's single rewrite). */
function saveContexts_(scope, rows) { return saveJsonl_(scope, CONTEXTS_FILE, rows); }
/** Count of升格 contexts (status === 'context'); candidates excluded. */
function countContexts_(scope) { return loadContexts_(scope).filter(c => c.status === 'context').length; }
/** Count of候選 contexts awaiting升格 (status === 'candidate'). */
function countContextCandidates_(scope) { return loadContexts_(scope).filter(c => c.status === 'candidate').length; }

/* ---- 學習歷程 (層5) ---- */
function loadJourneys_(scope) { return loadJsonl_(chatJsonlFile_(scope, JOURNEYS_FILE)); }
function upsertJourney_(scope, obj) { return upsertJsonl_(scope, JOURNEYS_FILE, obj); }
/** Replace the whole 歷程 store (block 3 reconciles journeys vs contexts in one write). */
function saveJourneys_(scope, rows) { return saveJsonl_(scope, JOURNEYS_FILE, rows); }
/** Count of 升格 journeys only (status === 'journey'); 'watch' (持續關注、無轉折) excluded. */
function countJourneys_(scope) { return loadJourneys_(scope).filter(j => j.status === 'journey').length; }

/** 統一從 journeys 裡挑「contextId === cid」最該被當代表的那條 journey。
 *  多重 journey per cid 是 merge/absorb 殘留資料雜訊；caller 用 .find() 或 forEach
 *  取「第一筆/最後一筆」會得到不同結果（L0 ↔ L2 名字不一致就是這樣來的）。
 *  優先序：status='journey' > markers 多者 > updatedAt 新者 > createdAt 早者（id 穩定）。 */
function pickJourneyForContext_(journeys, cid) {
  if (!cid || !journeys) return null;
  const matches = journeys.filter(j => j && j.contextId === cid);
  if (matches.length <= 1) return matches[0] || null;
  matches.sort((a, b) => {
    const sa = a.status === 'journey' ? 0 : 1;
    const sb = b.status === 'journey' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ma = (a.markers || []).length, mb = (b.markers || []).length;
    if (ma !== mb) return mb - ma;
    const ua = Date.parse(a.updatedAt || 0), ub = Date.parse(b.updatedAt || 0);
    if (ua !== ub) return ub - ua;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  return matches[0];
}

/** 用 pickJourneyForContext_ 建立 {contextId → 代表 journey} 對照表（去重）。 */
function journeysByContext_(journeys) {
  const groups = {};
  for (const j of (journeys || [])) {
    if (!j || !j.contextId) continue;
    (groups[j.contextId] = groups[j.contextId] || []).push(j);
  }
  const out = {};
  for (const cid in groups) out[cid] = pickJourneyForContext_(groups[cid], cid);
  return out;
}
