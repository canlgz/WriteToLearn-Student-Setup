/**
 * Block 2 — 脈絡升格 (層3 主題群組 → 層4 脈絡).
 * See docs/design/context-to-journey.md §二 + §八.
 *
 * Flow (runs in the background, throttled — see maybeUpgradeContexts_):
 *   1. k-means over the whole corpus → 主題群組 clusters (the same kmeans /themes
 *      uses, so granularity matches the rest of the app).
 *   2. Match each cluster to existing 脈絡 objects by member-id Jaccard overlap.
 *      High overlap = the same 脈絡 (update in place); otherwise a new candidate.
 *      This keeps a 脈絡's identity — and its id, which block 5 journeys link to —
 *      stable across re-clusters even though k-means itself is non-deterministic.
 *   3. Evaluate the three 升格 conditions (語意密度 / 意向回返 / 跨媒介) against
 *      Config CONTEXT_CRITERIA.
 *   4. Persist every cluster as a 脈絡 object with status 'candidate' or 'context'.
 *
 * No Gemini call here: labels are a cheap representative snippet; transition
 * detection + rich labelling come later (block 3 / 5). Pure CPU, so it is safe
 * to run inside the 5-minute sweep under the throttle below.
 */

// 跨媒介計數的媒介集合（排除 sticker/location，語意訊號弱——見設計文件 §八）。
// link＝外部連結，算一種獨立媒介（使用者決策）：故「連結＋寫文字」可滿足跨媒介≥2。
const CONTEXT_MEDIA_TYPES = { text: 1, link: 1, audio: 1, image: 1, video: 1, file: 1 };

/**
 * k for the 脈絡 pipeline — finer than /themes' pickFocusK_ (≤8). Whole-corpus
 * clustering needs more clusters or it lumps distinct topics into one 脈絡
 * (e.g. 個人活動 + 小時候願望 fused). ~n/8, capped, so topics stay separate.
 */
function pickContextK_(n) {
  return Math.max(2, Math.min(24, Math.round(n / 8)));
}

// COLLECTION_MIN_NOTE_CHARS：仍由 isBareLinkPaste_（Handlers.gs）用來判「純 URL、沒寫字」→
// 設 record.linkBookmark。收藏概念取消後，linkBookmark 只剩「綁串時略過裸連結」一個用途。
const COLLECTION_MIN_NOTE_CHARS = 1;

// 〔2026-06-03 取消「收藏 vs 學習素材」區分〕所有網址一律當學習素材、併入語意、進主題/歷程。
// 函式保留（多處呼叫 !isCollectionRecord_(...)）但永遠回 false ＝沒有任何記錄被排除升格。
// 入庫選擇泡泡與原始記錄的「收藏/學習素材」切換鈕已移除；linkIntent/linkBookmark 不再影響歸戶。
function isCollectionRecord_(r, linkIntent) {
  return false;
}

/**
 * Throttle gate called once per scope from backgroundSweep(). Runs the upgrade
 * at most once per CONTEXT_UPGRADE_MIN_INTERVAL_MS, and skips entirely when no
 * new message has arrived since the last upgrade (idle chats cost nothing).
 */
function maybeUpgradeContexts_(scope, ignoreThrottle) {
  const meta = loadChatMeta_(scope);
  if (!meta.lastIngestTs) return null;                  // never ingested → nothing to cluster
  const now = Date.now();
  const lastUpgrade = meta.lastContextUpgradeAt ? Date.parse(meta.lastContextUpgradeAt) : 0;
  // 略過 3h 節流（ignoreThrottle）供使用者主動指令（/journey）即時對齊；但「無新資料」
  // 一律跳過——重分群純 CPU 也沒必要白跑。
  if (!ignoreThrottle && lastUpgrade && (now - lastUpgrade) < CONTEXT_UPGRADE_MIN_INTERVAL_MS) return null;
  // 「無新資料」跳過：必須同時「沒有新訊息」且「沒有新分類」。背景晚補的大類/議題標籤
  // （maybeClassifyCategories_ / maybeAssignTopics_）會更新 meta.lastClassifyAt——否則一筆
  // 先前未判、稍後才被背景貼好標籤的舊紀錄，會因為「沒有新訊息進來」永遠等不到重分群、
  // 折不進它該屬的主題（這是使用者回報「5/30 回返沒被編進」的主因之一）。
  const lastIngest = meta.lastIngestTs ? Date.parse(meta.lastIngestTs) : 0;
  const lastClassify = meta.lastClassifyAt ? Date.parse(meta.lastClassifyAt) : 0;
  if (lastUpgrade && Math.max(lastIngest, lastClassify) <= lastUpgrade) return null;  // 既無新訊息也無新分類
  const summary = upgradeContexts_(scope);
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = new Date(now).toISOString(); return m; });
  if (summary) console.log(`contextUpgrade ${scope.key}:`, JSON.stringify(summary));
  return summary;
}

/**
 * Core upgrade pass. Clusters the corpus, reconciles against existing 脈絡
 * objects, evaluates criteria, and rewrites contexts.jsonl in one lock-protected
 * write. Returns a summary object (or null when there isn't enough data to
 * cluster). Bypasses the throttle — call maybeUpgradeContexts_ for the scheduled
 * path, runContextUpgradeNow for a forced run from the editor.
 */
function upgradeContexts_(scope) {
  const all = loadEmbeddingRecords_(scope);
  const embedded = all.filter(r => r.embedding && r.embedding.length === EMBED_DIM);
  // 收藏（裸連結/書籤）排除在升格語料外——仍儲存、仍可檢索，只是不進脈絡/歷程。
  const linkIntent = loadChatMeta_(scope).linkIntent || {};
  const valid = embedded.filter(r => !isCollectionRecord_(r, linkIntent));
  const collected = embedded.length - valid.length;
  if (valid.length < FOCUS_MIN_COUNT) return null;

  // Manual split correction (must-not-link): records the user pinned into a
  // group cluster ON THEIR OWN, never re-merged by k-means. The rest cluster
  // normally. So "這是兩件事·分開" sticks across re-clusters. See handleContextSplit_.
  const pins = loadChatMeta_(scope).recordPins || {};
  const pinnedGroups = {};
  const unpinned = [];
  for (const r of valid) {
    const g = pins[r.id];
    if (g) (pinnedGroups[g] = pinnedGroups[g] || []).push(r);
    else unpinned.push(r);
  }
  // 〔block 3b〕主題群＝同 (大類, 議題標籤) 的 record，不再用 k-means。議題一致由 LLM 在
  // record.topicLabel 上判定（見 Topic.gs），這裡只做純 CPU 的 group-by——快、決定性、
  // 巨無霸免疫（桶內議題切分，不會把教學＋生活湊一條）。尚無 topicLabel 的（背景還沒判到）
  // 〔未議題化暫不成群〕否則整個大類塌成 catch-all blob（測試/連結/情緒全混進來、還可能
  // 升格成假歷程，即實測「AI工具應用 53 筆」假主題）。等背景判好 topicLabel、gate 重分群再納入。
  const groups = {};   // key → record[]
  for (const r of unpinned) {
    if (!r.topicLabel) continue;
    const key = (r.category || '未分類') + ' ' + r.topicLabel;
    (groups[key] = groups[key] || []).push(r);
  }
  let clusters = Object.keys(groups).map(k => groups[k]).filter(c => c.length > 0);
  for (const g in pinnedGroups) clusters.push(pinnedGroups[g]);   // 手動分開的各自成群
  if (!clusters.length) return null;

  const centroids = clusters.map(c => meanVector_(c.map(r => r.embedding)));

  // 非文字媒介池：供「跨媒介語意歸戶」用——一張關於本主題的圖片就算被 k-means
  // 分到隔壁群，只要夠靠近本群群心仍算進本群的跨媒介（見 evaluateContextCriteria_）。
  const corpusMedia = valid.filter(r =>
    r.embedding && CONTEXT_MEDIA_TYPES[r.type] && r.type !== 'text');

  // Describe each fresh cluster: members + criteria snapshot + label.
  // label 優先用議題標籤（同群成員 topicLabel 一致）；無則退回代表片段。category 也帶上，
  // 供卡片顯示「大類成分」與 /themes 分桶。
  const fresh = clusters.map((c, i) => {
    const recordIds = c.map(r => r.id);
    const tss = c.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
    const topicLabel = (c.find(r => r.topicLabel) || {}).topicLabel || '';
    const catVotes = {};
    c.forEach(r => { if (r.category) catVotes[r.category] = (catVotes[r.category] || 0) + 1; });
    let category = ''; let bestN = -1;
    for (const k in catVotes) if (catVotes[k] > bestN) { bestN = catVotes[k]; category = k; }
    return {
      recordIds,
      recordIdSet: new Set(recordIds),
      label: topicLabel || representativeLabel_(c, centroids[i]),
      category,
      criteria: evaluateContextCriteria_(c, centroids, i, corpusMedia),
      firstTs: tss.length ? new Date(tss[0]).toISOString() : null,
      lastTs: tss.length ? new Date(tss[tss.length - 1]).toISOString() : null,
      matched: false
    };
  });

  // Greedy one-to-one Jaccard match against existing 脈絡 objects: strongest
  // overlaps claimed first, each side used at most once.
  const existing = loadContexts_(scope);
  const pairs = [];
  for (let fi = 0; fi < fresh.length; fi++) {
    for (let ei = 0; ei < existing.length; ei++) {
      const jac = jaccard_(fresh[fi].recordIdSet, new Set(existing[ei].recordIds || []));
      if (jac >= CONTEXT_MATCH.jaccardMin) pairs.push({ fi, ei, jac });
    }
  }
  pairs.sort((a, b) => b.jac - a.jac);
  const existingMatched = new Array(existing.length).fill(false);
  const matchByExisting = {};  // ei -> fi
  for (const p of pairs) {
    if (fresh[p.fi].matched || existingMatched[p.ei]) continue;
    fresh[p.fi].matched = true;
    existingMatched[p.ei] = true;
    matchByExisting[p.ei] = p.fi;
  }

  const nowIso = new Date().toISOString();
  const out = [];
  let created = 0, updated = 0, stable = 0, dropped = 0;

  // Each upgrade = a CLEAN current partition. Matched fresh clusters reuse the
  // existing 脈絡's id (so 歷程 stay linked); UNMATCHED existing are DROPPED —
  // no carry-forward, no member-union. Carry-forward + union were what produced
  // stale blobs / duplicate records / same-topic fragmentation. 歷程 whose 脈絡
  // dropped are re-linked below to the best-overlap fresh 脈絡, so they persist.
  for (let ei = 0; ei < existing.length; ei++) {
    const ex = existing[ei];
    if (!existingMatched[ei]) { dropped++; continue; }
    const f = fresh[matchByExisting[ei]];
    const wasContext = ex.status === 'context';
    // Bump updatedAt only when membership actually changed (it's the re-judge
    // change-gate via basedOnUpdatedAt). 升格只進不退 = status only: a matched
    // 脈絡 that was 'context' stays 'context' even if fresh criteria dip.
    const sameMembers = sameIdSet_(ex.recordIds, f.recordIds);
    out.push({
      id: ex.id,
      createdAt: ex.createdAt || nowIso,
      updatedAt: sameMembers ? (ex.updatedAt || nowIso) : nowIso,
      label: f.label,
      category: f.category || undefined,           // 大類（block 3）：/themes 分桶、卡片成分
      userTitle: ex.userTitle || undefined,        // 保留使用者改名，不被重分群覆寫
      recordIds: f.recordIds,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      status: (wasContext || f.criteria.passed) ? 'context' : 'candidate',
      criteria: f.criteria
    });
    if (sameMembers) stable++; else updated++;
  }

  // Unmatched fresh clusters become brand-new objects.
  for (const f of fresh) {
    if (f.matched) continue;
    out.push({
      id: newId_(),
      createdAt: nowIso,
      updatedAt: nowIso,
      label: f.label,
      category: f.category || undefined,           // 大類（block 3）
      recordIds: f.recordIds,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      status: f.criteria.passed ? 'context' : 'candidate',
      criteria: f.criteria
    });
    created++;
  }

  // 〔block 3b〕向量邊緣淘汰**已停用**：新模型以「議題標籤（LLM 判的議題一致）」為分群權威，
  // 不該因為某筆向量幾何上離群心遠就把它踢掉——那正是我們花力氣用上下文歸對的「單句模糊但
  // 議題一致」record。向量在新模型只當參考（凝聚度顯示），不再當淘汰閘。保留迴圈骨架但不淘汰
  // （evictedIds 恆空），讓下游 journey re-link 等邏輯原封不動。
  const recByIdFit = {};
  valid.forEach(r => { recByIdFit[r.id] = r; });
  const evictedIds = [];
  const fitMin = -2;   // 不可能達到的門檻 → 等同永不淘汰（cos ∈ [-1,1]）
  const HOUR_MS = 3600000;
  const visitGapMs = CONTEXT_CRITERIA.returnGapMinutes * 60000;
  for (const c of out) {
    const memberRecs = (c.recordIds || []).map(id => recByIdFit[id]).filter(r => r && r.embedding);
    if (memberRecs.length < 2) continue;
    const centroid = meanVector_(memberRecs.map(r => r.embedding));
    const kept = [];
    for (const r of memberRecs) {
      const pin = pins[r.id];
      if (pin && pin.indexOf('m:') !== 0) { kept.push(r); continue; }   // manual pin → keep
      if (cosineSim_(r.embedding, centroid) >= fitMin) kept.push(r);
      else evictedIds.push(r.id);
    }
    if (kept.length === memberRecs.length) continue;                     // nothing evicted
    c.recordIds = kept.map(r => r.id);
    const tss = kept.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
    c.firstTs = tss.length ? new Date(tss[0]).toISOString() : null;
    c.lastTs  = tss.length ? new Date(tss[tss.length - 1]).toISOString() : null;
    c.updatedAt = nowIso;
    if (kept.length < 2) continue;                                       // skip criteria recompute on near-empty
    const newDensity = avgPairwiseCosine_(kept.map(r => r.embedding), 2000);
    const newCoreFrac = clusterCoreFrac_(kept.map(r => r.embedding));
    let returnVisits = 1, returnSpanHours = 0;
    const vts = tss;
    for (let i = 1; i < vts.length; i++) if (vts[i] - vts[i - 1] >= visitGapMs) returnVisits++;
    if (vts.length) returnSpanHours = (vts[vts.length - 1] - vts[0]) / HOUR_MS;
    const newKinds = {};
    kept.forEach(r => { if (CONTEXT_MEDIA_TYPES[r.type]) newKinds[r.type] = 1; });   // 〔嚴格〕只算本脈絡成員
    const newMediaKinds = Object.keys(newKinds).length;
    const newPassed = densityConditionMet_({ semanticDensity: newDensity, coreFrac: newCoreFrac })
      && returnVisits >= CONTEXT_CRITERIA.returnVisitsMin
      && returnSpanHours >= CONTEXT_CRITERIA.returnSpanHoursMin
      && newMediaKinds >= CONTEXT_CRITERIA.mediaKindsMin;
    c.criteria = Object.assign({}, c.criteria || {}, {
      semanticDensity: round_(newDensity, 4),
      coreFrac: round_(newCoreFrac, 4),
      densityViaFocus: newPassed && newDensity < CONTEXT_CRITERIA.semanticDensityMin,
      returnVisits,
      returnSpanHours: round_(returnSpanHours, 2),
      mediaKinds: newMediaKinds,
      passed: newPassed
    });
    // 升格只進不退: never demote a status='context' just because eviction tightened
    // criteria to fail. Promote candidate→context if eviction CLEANED the cluster
    // enough to pass (next sweep would do this anyway; saving a round-trip).
    if (newPassed && c.status === 'candidate') c.status = 'context';
  }
  // Drop contexts that fully emptied — journey re-link below picks them up.
  const cleanedOut = out.filter(c => (c.recordIds || []).length > 0);
  if (evictedIds.length) {
    console.log(`upgrade eviction: dropped ${evictedIds.length} periphery records (fit<${fitMin}); ${out.length - cleanedOut.length} contexts emptied.`);
    updateChatMeta_(scope, m => {
      const newPins = m.recordPins || {};
      for (const rid of evictedIds) {
        if (newPins[rid] && newPins[rid].indexOf('m:') === 0) delete newPins[rid];
      }
      m.recordPins = newPins;
      return m;
    });
  }

  saveContexts_(scope, cleanedOut);

  // Re-link 歷程 whose 脈絡 was dropped this run → point to the fresh 脈絡 that best
  // contains its old records, so a frozen 歷程 survives re-partitioning instead of
  // spawning a duplicate. Orphaned records with no overlap are pruned.
  // **One journey per contextId**: 多條 journey 若被 re-link 到同一個新 ctx，只
  // 保留「重疊最高（其次 status='journey'、再其次有 title）」的那條，其餘丟棄——
  // 避免 detectJourneys_ 後續看到一個 ctx 多條 journey 而原地保留（這正是先前
  // 出現 14筆/29天重複卡的成因）。
  const surviving = {}; cleanedOut.forEach(c => { surviving[c.id] = true; });
  const ctxOut = {}; cleanedOut.forEach(c => { ctxOut[c.id] = c; });
  const exById = {}; existing.forEach(c => { exById[c.id] = c; });
  const journeys = loadJourneys_(scope);
  let changed = false, relinked = 0;
  const candidates = [];  // {j, newCtxId, overlap}
  for (const j of journeys) {
    if (surviving[j.contextId]) {
      candidates.push({ j, newCtxId: j.contextId, overlap: Infinity });   // 沒改、優先級最高
      continue;
    }
    const oldIds = new Set(((exById[j.contextId] || {}).recordIds) || []);
    let best = null, bestN = 0;
    if (oldIds.size) for (const c of cleanedOut) {
      let n = 0; for (const id of (c.recordIds || [])) if (oldIds.has(id)) n++;
      if (n > bestN) { bestN = n; best = c; }
    }
    if (best && bestN > 0) candidates.push({ j, newCtxId: best.id, overlap: bestN });
    else changed = true;   // topic dissolved
  }
  // 每個 newCtxId 只留一條 journey：先比 overlap、再比 status='journey' 優先、
  // 再比 title 完整度，最後 createdAt 早的優先（穩定 id）。
  const bestByCtx = {};
  for (const cand of candidates) {
    const cur = bestByCtx[cand.newCtxId];
    if (!cur) { bestByCtx[cand.newCtxId] = cand; continue; }
    if (cand.overlap > cur.overlap) { bestByCtx[cand.newCtxId] = cand; continue; }
    if (cand.overlap < cur.overlap) continue;
    const candScore = (cand.j.status === 'journey' ? 2 : 0) + (cand.j.title ? 1 : 0);
    const curScore = (cur.j.status === 'journey' ? 2 : 0) + (cur.j.title ? 1 : 0);
    if (candScore > curScore) bestByCtx[cand.newCtxId] = cand;
    else if (candScore === curScore && (cand.j.createdAt || '') < (cur.j.createdAt || '')) bestByCtx[cand.newCtxId] = cand;
  }
  const keptJourneys = [];
  for (const cand of Object.values(bestByCtx)) {
    if (cand.j.contextId !== cand.newCtxId) {
      cand.j.contextId = cand.newCtxId; changed = true;
      if (cand.j.status === 'journey') relinked++;
      // Re-linked onto a DIFFERENT cluster → its old 標題/摘要/關鍵字/轉折 describe the
      // former (often larger / now-dissolved) 脈絡, not the new records. Reset the judging
      // state so detectJourneys_ regenerates them from the new cluster — same trick absorb
      // uses. Without this, a journey re-pointed by re-partition (e.g. a 巨無霸 split) keeps
      // a stale blob summary + markers harvested from topics that are now separate cards.
      // 升格只進不退 is preserved: status stays 'journey' (wasJourney path in detect).
      // Guard: only reset when the new 脈絡 is a 'context' (detect只重判 status==='context')；
      // re-linking onto a 'candidate' wouldn't be re-judged, so a reset would leave the card
      // blank — keep the old fields in that (rare) case.
      if ((ctxOut[cand.newCtxId] || {}).status === 'context') {
        cand.j.title = '';
        cand.j.summary = '';
        cand.j.keywords = null;
        cand.j.markers = [];
        cand.j.basedOnUpdatedAt = null;
      }
    }
    keptJourneys.push(cand.j);
  }
  // Detect dropped-because-collision: any candidate whose `j` is not in keptJourneys
  // (some others stole its newCtxId slot). They're silently dropped above; mark changed.
  if (candidates.length !== keptJourneys.length) changed = true;
  if (changed) saveJourneys_(scope, keptJourneys);

  return {
    records: valid.length,
    clusters: clusters.length,
    contexts: cleanedOut.filter(c => c.status === 'context').length,
    candidates: cleanedOut.filter(c => c.status === 'candidate').length,
    created, updated, stable, dropped, relinked,
    evicted: evictedIds.length,
    collected   // 因「收藏（裸連結）」被排除在升格之外的記錄數
  };
}

/**
 * Evaluate the three 升格 conditions for one cluster. The returned snapshot's
 * shape matches the `criteria` block documented in ContextStore.gs's header.
 *
 *   1. 語意密度 — mean pairwise cosine inside the cluster ≥ semanticDensityMin
 *      AND distance to the nearest other cluster ≥ clusterSeparationMin.
 *   2. 意向回返 — proactive members (quote-reply supplements excluded) form
 *      ≥ returnVisitsMin temporally-separated visits (a new visit begins after
 *      a ≥ returnSpanHoursMin gap) AND the first→last span ≥ returnSpanHoursMin.
 *      Continuous bursts inside one sitting count as a single visit, not a return.
 *   3. 跨媒介 — ≥ mediaKindsMin distinct媒介 among {text,audio,image,video,file}.
 *      貼圖 / 地點 are excluded (weak semantic signal — see §八). 〔嚴格・2026-06-07〕
 *      只算**本脈絡自己成員**的媒介類型；不再用短中文 cosine 把鄰群的圖/音 attach 進來
 *      （那會隱形又脆、字面與實際不符——3 筆全文字卻 媒介✅）。corpusMedia 參數已不使用。
 */
/** 〔聚焦補償〕成員緊扣單一核心的比例：對群心 cosine ≥ densityFocusFitMin 的成員佔比。
 *  用「比例」而非「平均」——平均 cos-to-centroid 與 pairwise 密度是同一個量(群心向量長度)的單調
 *  變換、無新資訊；比例才能分出「單核但發散(facet 多)」vs「多核混雜」。embedding 不足 → 0。 */
function clusterCoreFrac_(embs) {
  const vs = (embs || []).filter(v => v && v.length === EMBED_DIM);
  if (vs.length < 2) return 0;
  const centroid = meanVector_(vs);
  let n = 0;
  vs.forEach(v => { if (cosineSim_(v, centroid) >= CONTEXT_CRITERIA.densityFocusFitMin) n++; });
  return n / vs.length;
}

/** 語意密度條件是否達標（含聚焦補償）：density ≥ min，或（開補償且 density ≥ floor 且 coreFrac ≥ 門檻）。
 *  全系統判「密度這條過了沒」的單一真相，卡片顯示與升格閘都走這裡，前景背景一致、不會「說沒過卻偷偷升格」。
 *  傳入已存的 criteria 物件（需含 semanticDensity、coreFrac）。 */
function densityConditionMet_(cr) {
  if (!cr) return false;
  const C = CONTEXT_CRITERIA;
  const d = cr.semanticDensity || 0;
  if (d >= C.semanticDensityMin) return true;
  if (!C.densityFocusCompensate) return false;
  return d >= C.densityFloorForFocus && (cr.coreFrac || 0) >= C.densityFocusCoreFracMin;
}

function evaluateContextCriteria_(clusterRecords, centroids, myIndex, corpusMedia) {
  const C = CONTEXT_CRITERIA;

  // 1. 語意密度 + 群間距.
  // 〔§B〕語意密度只算「語意內容」成員（CONTEXT_MEDIA_TYPES：文字/圖/語音/影片/檔/連結）；
  // 排除貼圖/地點——貼圖是對訊息的情緒、地點是空間錨點，非內容，算進去會稀釋群內相似度。
  const densityVecs = clusterRecords.filter(r => r && CONTEXT_MEDIA_TYPES[r.type]).map(r => r.embedding);
  const semanticDensity = avgPairwiseCosine_(densityVecs, 2000);
  const coreFrac = clusterCoreFrac_(densityVecs);
  let nearest = -Infinity;  // max cosine to any other centroid
  for (let j = 0; j < centroids.length; j++) {
    if (j === myIndex) continue;
    const sim = cosineSim_(centroids[myIndex], centroids[j]);
    if (sim > nearest) nearest = sim;
  }
  const clusterSeparation = nearest === -Infinity ? 1 : (1 - nearest);
  // 群間距僅供顯示，不再當升格關卡（絕對距離門檻在此 embedding 空間不可靠）。
  // 〔聚焦補償〕邊緣密度若成員緊扣單一核心(coreFrac 夠)也算達標——同一主題不同面向 pairwise 偏低、但聚焦。
  const densityPass = densityConditionMet_({ semanticDensity, coreFrac });

  // 2. 意向回返 — every member record, chronological. A new visit starts after a
  //    ≥ returnGapMinutes pause: an immediate quote-reply correction stays the
  //    same visit (no inflation), but coming back after a gap — even via
  //    quote-reply — counts as a genuine return. Must also span ≥ returnSpanHoursMin.
  const HOUR = 3600000;
  const gapMs = C.returnGapMinutes * 60000;
  const visitTs = clusterRecords
    .map(r => Date.parse(r.ts))
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);
  let returnVisits = 0, returnSpanHours = 0;
  if (visitTs.length) {
    returnVisits = 1;
    for (let i = 1; i < visitTs.length; i++) {
      if (visitTs[i] - visitTs[i - 1] >= gapMs) returnVisits++;
    }
    returnSpanHours = (visitTs[visitTs.length - 1] - visitTs[0]) / HOUR;
  }
  const returnPass = returnVisits >= C.returnVisitsMin &&
                     returnSpanHours >= C.returnSpanHoursMin;

  // 3. 跨媒介 — distinct kinds (sticker/location excluded) among THIS 脈絡's own members only.
  //    〔嚴格・2026-06-07〕拿掉「語意鄰近 attach 別群媒介」：那會用短中文 cosine 把不在本脈絡的
  //    圖/音硬算進來（隱形＋脆、字面與實際不符——3 筆全文字卻 媒介✅）。媒介只反映看得到的記錄類型。
  const kinds = {};
  for (const r of clusterRecords) if (CONTEXT_MEDIA_TYPES[r.type]) kinds[r.type] = 1;
  const mediaKinds = Object.keys(kinds).length;
  const mediaPass = mediaKinds >= C.mediaKindsMin;

  return {
    semanticDensity: round_(semanticDensity, 4),
    coreFrac: round_(coreFrac, 4),
    densityViaFocus: densityPass && semanticDensity < C.semanticDensityMin,  // 靠聚焦補償才過（卡片標示用）
    clusterSeparation: round_(clusterSeparation, 4),
    returnVisits,
    returnSpanHours: round_(returnSpanHours, 2),
    mediaKinds,
    passed: densityPass && returnPass && mediaPass
  };
}

/**
 * 〔已停用・2026-06-07〕跨媒介語意歸戶：曾把語意上夠靠近本群群心（cosine ≥ mediaAttachCosMin）的
 * 非文字媒介計入本群媒介種類，即使 k-means 把它分到隔壁群。改「嚴格：媒介只算本脈絡成員」後，
 * 三個呼叫處（evaluateContextCriteria_／淘汰重算／contextGapReport_）皆已移除呼叫。函式保留備查、
 * 目前無人呼叫——若日後要恢復語意歸戶（並把它畫到卡上、不再隱形），再從這裡接回。
 */
function attachNearbyMedia_(kinds, members, corpusMedia, centroid) {
  if (!corpusMedia || !corpusMedia.length || !centroid || !centroid.length) return;
  const C = CONTEXT_CRITERIA;
  const memberIds = new Set((members || []).map(r => r.id));
  for (const r of corpusMedia) {
    if (kinds[r.type] || memberIds.has(r.id) || !r.embedding) continue;
    if (cosineSim_(r.embedding, centroid) >= C.mediaAttachCosMin) kinds[r.type] = 1;
  }
}

/**
 * Human-readable "what's still missing to升格 into a 脈絡" for one cluster's
 * records. density / visits / media mirror evaluateContextCriteria_ exactly.
 * 群間距離(separation) is a global property judged in the background, not
 * something the user fixes by adding messages, so it's omitted here.
 * Returns { density, visits, spanHours, mediaKinds, gaps:[string], met:bool }.
 * corpusMedia (optional, non-text media of the whole corpus) enables 跨媒介
 * 語意歸戶 — same rule as evaluateContextCriteria_; omit it to count members only.
 */
function contextGapReport_(records, corpusMedia) {
  const C = CONTEXT_CRITERIA;
  const HOUR = 3600000;
  // 〔§B〕密度只算語意內容成員（排除貼圖/地點——貼圖是情緒、地點是錨點，非內容）。
  const densityVecs = records.filter(r => r && CONTEXT_MEDIA_TYPES[r.type]).map(r => r.embedding).filter(Boolean);
  const density = avgPairwiseCosine_(densityVecs, 2000);
  const coreFrac = clusterCoreFrac_(densityVecs);
  const densityMet = densityConditionMet_({ semanticDensity: density, coreFrac });

  const visitTs = records
    .map(r => Date.parse(r.ts))
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);
  let visits = 0, spanHours = 0;
  if (visitTs.length) {
    visits = 1;
    for (let i = 1; i < visitTs.length; i++) {
      if (visitTs[i] - visitTs[i - 1] >= C.returnGapMinutes * 60000) visits++;
    }
    spanHours = (visitTs[visitTs.length - 1] - visitTs[0]) / HOUR;
  }

  const kinds = {};
  records.forEach(r => { if (CONTEXT_MEDIA_TYPES[r.type]) kinds[r.type] = 1; });   // 〔嚴格〕只算本脈絡成員
  const mediaKinds = Object.keys(kinds).length;

  const allTs = records.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  const firstTs = allTs.length ? new Date(allTs[0]).toISOString() : null;
  const lastTs = allTs.length ? new Date(allTs[allTs.length - 1]).toISOString() : null;

  const gaps = [];
  if (!densityMet) {
    gaps.push(density >= C.densityFloorForFocus
      ? `語意再聚焦：密度 ${(Math.floor(density * 1000) / 1000).toFixed(3)} 已近門檻，但成員還不夠都扣同一核心（聚焦 ${Math.round(coreFrac * 100)}%，需 ≥ ${Math.round(C.densityFocusCoreFracMin * 100)}%）——把離題的分開、或多寫扣核心的`
      : `語意再聚焦：群內相似度 ${(Math.floor(density * 1000) / 1000).toFixed(3)}，需 ≥ ${C.semanticDensityMin}（內容更集中在同一件事）`);
  }
  if (visits < C.returnVisitsMin) {
    gaps.push(`意向回返：目前 ${visits} 次，還要在不同時段（彼此間隔 ≥ ${C.returnGapMinutes} 分）再回到這主題 ${C.returnVisitsMin - visits} 次`);
  } else if (spanHours < C.returnSpanHoursMin) {
    gaps.push(`意向回返：首末需橫跨 ≥ ${C.returnSpanHoursMin}h（目前僅 ${round_(spanHours, 1)}h）`);
  }
  if (mediaKinds < C.mediaKindsMin) {
    const have = Object.keys(kinds).map(typeLabel_).join('、') || '（無）';
    gaps.push(`跨媒介：目前 ${mediaKinds} 種（${have}），再加 ${C.mediaKindsMin - mediaKinds} 種（語音／圖片／影片／檔案）`);
  }
  return { density: round_(density, 4), coreFrac: round_(coreFrac, 4), visits, spanHours: round_(spanHours, 2), mediaKinds, firstTs, lastTs, gaps, met: gaps.length === 0 };
}

/** "MM/dd–MM/dd（N 天）" for a 脈絡's first→last record span (all records). */
function spanLabel_(firstTs, lastTs) {
  if (!firstTs || !lastTs) return '';
  const f = new Date(firstTs), l = new Date(lastTs);
  const fs = Utilities.formatDate(f, TIME_ZONE, 'MM/dd');
  const ls = Utilities.formatDate(l, TIME_ZONE, 'MM/dd');
  const days = Math.max(1, Math.round((l.getTime() - f.getTime()) / 86400000));
  return fs === ls ? `${fs}（當日）` : `${fs}–${ls}（${days} 天）`;
}

/**
 * Mean pairwise cosine similarity within a set of vectors. Exact for small
 * clusters; for clusters whose pair count exceeds maxPairs it estimates from
 * maxPairs random pairs, keeping the cost bounded (a 2000-record half of a
 * k=2 split would otherwise be ~2M pairs). < 2 vectors → 0 (not a field).
 */
function avgPairwiseCosine_(vectors, maxPairs) {
  let vs = vectors;
  // 〔C・防灌水〕小群先去掉「近乎一樣」的成員(逐字重複/反覆灌同一段),不讓它機械式拉高密度。
  // anti-spam 放在度量本身 → 前景背景一致(不會「前景說沒過、背景偷偷升格」)。門檻高、幾乎不誤傷
  // 正常相異紀錄。大群(走抽樣那條)略過去重:成本高、且少數重複對均值影響本就小。決定性、不洗牌。
  if (typeof DENSITY_DEDUP_COS === 'number' && vs.length >= 2 && (vs.length * (vs.length - 1) / 2) <= maxPairs) {
    const keepIdx = dedupeVectorIdx_(vs, DENSITY_DEDUP_COS);
    if (keepIdx.length >= 2 && keepIdx.length < vs.length) vs = keepIdx.map(i => vs[i]);
    else if (keepIdx.length < 2) return 0;   // 整群近乎同一段(純灌水) → 不算有密度
  }
  const m = vs.length;
  if (m < 2) return 0;
  const totalPairs = m * (m - 1) / 2;
  let sum = 0, count = 0;
  if (totalPairs <= maxPairs) {
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) { sum += cosineSim_(vs[i], vs[j]); count++; }
    }
  } else {
    // Deterministic sampling (seeded by cluster size) so 語意密度 — and the 升格
    // decision riding on it — is stable across runs, not a coin flip each time.
    const rng = seededRng_((m * 2654435761) >>> 0);
    for (let p = 0; p < maxPairs; p++) {
      const i = Math.floor(rng() * m);
      let j = Math.floor(rng() * m);
      if (i === j) j = (j + 1) % m;
      sum += cosineSim_(vs[i], vs[j]); count++;
    }
  }
  return count ? sum / count : 0;
}

/** 〔C・密度去近重複〕回傳要保留的索引：greedy 依序保留「與每個已留代表 cosine 皆 < threshold」
 *  的向量，近乎一樣的後來者(逐字重複/反覆灌同一段)被收斂掉。決定性(照原順序、不洗牌)，
 *  讓密度與升格判定可重現。O(m·k)；只在小群呼叫(見 avgPairwiseCosine_)。 */
function dedupeVectorIdx_(vectors, threshold) {
  const keep = [];
  for (let i = 0; i < vectors.length; i++) {
    let dup = false;
    for (let k = 0; k < keep.length; k++) {
      if (cosineSim_(vectors[i], vectors[keep[k]]) >= threshold) { dup = true; break; }
    }
    if (!dup) keep.push(i);
  }
  return keep;
}

/** True when two id arrays contain the same members (order-independent). */
function sameIdSet_(a, b) {
  a = a || []; b = b || [];
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

/** Jaccard overlap of two Sets: |A∩B| / |A∪B|. */
function jaccard_(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

/** Cheap label for a cluster: the member nearest the centroid, truncated. */
function representativeLabel_(records, centroid) {
  let best = null, bestSim = -Infinity;
  for (const r of records) {
    const sim = cosineSim_(r.embedding, centroid);
    if (sim > bestSim) { bestSim = sim; best = r; }
  }
  const text = best && best.text ? best.text.replace(/\s+/g, ' ').trim() : '';
  return truncate_(text, 24) || '未命名脈絡';
}

function round_(x, places) {
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
}

/** 〔診斷·根治殘留〕盤點/清理「分開」留下的封閉群 pin（非 m: 自動合併、非 x: 手動移出的群鍵）。
 *  舊版分開把**核心也釘成封閉群**，害新記錄／改歸／補轉折升格併不進來、長出同名殘留。
 *  Apps Script editor 直接跑：
 *    auditSplitPins()      → 只盤點（看有幾群、各幾筆）
 *    auditSplitPins(true)  → 清掉並立即重分群（分出去的靠改名標籤仍各自獨立；殘留同名筆會併回核心）
 */
function auditSplitPins(clear) {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const pins = loadChatMeta_(scope).recordPins || {};
  const byKey = {};
  Object.keys(pins).forEach(id => {
    const k = pins[id];
    if (k && k.indexOf('m:') !== 0 && k.indexOf('x:') !== 0) (byKey[k] = byKey[k] || []).push(id);
  });
  const keys = Object.keys(byKey);
  const total = keys.reduce((n, k) => n + byKey[k].length, 0);
  const L = [`分開封閉群 pin：${keys.length} 群、共 ${total} 筆`];
  keys.forEach(k => L.push(`  ${k.slice(0, 8)}… : ${byKey[k].length} 筆`));
  if (!keys.length) L.push('（沒有殘留的分開 pin，乾淨）');
  if (clear && keys.length) {
    updateChatMeta_(scope, m => {
      const p = m.recordPins || {};
      keys.forEach(k => byKey[k].forEach(id => { if (p[id]) delete p[id]; }));
      m.recordPins = p; m.lastContextUpgradeAt = null; return m;
    });
    try { upgradeContexts_(scope); } catch (e) { L.push('⚠️ 重分群失敗：' + (e && e.message)); }
    L.push('✅ 已清掉並重分群——核心重新開放，殘留同名筆會併回；分出去的靠改名標籤仍各自獨立。');
  }
  const out = L.join('\n');
  console.log(out);
  return out;
}

/**
 * Editor diagnostic: WIPE the derived 脈絡/歷程 stores so the next upgrade
 * rebuilds them from scratch with the current clustering rules. Safe — your
 * records (embeddings.jsonl) are untouched; contexts/journeys regenerate. Use
 * when monotonic 只進不退 has locked a stale / over-merged 脈絡 (e.g. distinct
 * topics fused before the determinism/merge fixes). Run, then runContextUpgradeNow
 * + runJourneyDetectNow.
 */
function runResetDerivedStores() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  saveContexts_(scope, []);
  saveJourneys_(scope, []);
  updateChatMeta_(scope, m => {
    m.notifiedContextIds = [];
    m.notifiedJourneyIds = [];
    m.lastContextUpgradeAt = null;
    return m;
  });
  console.log('reset: contexts.jsonl + journeys.jsonl cleared; next upgrade rebuilds from scratch.');
}

/**
 * Editor one-shot: full re-wash of the derived stores in one run —
 *   1) reset (wipe 脈絡/歷程)  2) rebuild 脈絡 (re-cluster)  3) re-judge 歷程 (+titles).
 * Use after clustering-rule changes or whenever the persisted 脈絡/歷程 look stale.
 * Records (embeddings.jsonl) are NOT touched — only the derived stores. Each stage
 * logs (cluster counts / per-脈絡 criteria / 歷程 verdicts) so you can sanity-check.
 */
function rebuildDerivedNow() {
  console.log('=== rebuildDerivedNow 1/3 · 重置衍生資料 ===');
  runResetDerivedStores();
  console.log('=== rebuildDerivedNow 2/3 · 重建脈絡 ===');
  runContextUpgradeNow();
  console.log('=== rebuildDerivedNow 3/3 · 重判歷程 ===');
  runJourneyDetectNow();
  // A rebuild re-creates everything, so without this the next background sweep
  // would push a giant "10 new 歷程" notification (all ids look unseen). Mark the
  // rebuilt set as already-notified → 進展通知 only fires for genuinely-new changes.
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  markUpgradesNotified_({ type: 'user', id: owner, key: `user_${owner}`, userId: owner });
  console.log('=== rebuildDerivedNow · 完成（重建結果已標記為已通知，不會再整批推播）===');
}

/** Seed meta.notified*Ids with the CURRENT 脈絡/歷程, so a bulk rebuild stays
 *  silent and only later, genuinely-new items trigger 進展通知. */
function markUpgradesNotified_(scope) {
  const ctxIds = loadContexts_(scope).filter(c => c.status === 'context').map(c => c.id);
  const jrnIds = loadJourneys_(scope).filter(j => j.status === 'journey').map(j => j.id);
  updateChatMeta_(scope, m => { m.notifiedContextIds = ctxIds; m.notifiedJourneyIds = jrnIds; return m; });
  console.log(`marked notified: ${ctxIds.length} 脈絡 / ${jrnIds.length} 歷程（重建不再整批推播）。`);
}

/**
 * 〔block 4a〕scope-aware 全重建（遠端命令 rebuild / editor 共用）：用**新模型**
 * （大類, 議題標籤 group-by）重建脈絡＋重判歷程。會先清掉 k-means 時代的 m: 自動合併
 * 釘選（recordPins 裡 m: 開頭的）——那是舊分群的產物，留著會強制把不該同群的 record
 * 綁在一起、污染新分群。手動「分開」pin（非 m:）保留。回傳人讀字串。
 */
function rebuildDerivedForScope_(scope) {
  // 1) 清 m: 釘選（保手動分開）
  let clearedPins = 0;
  updateChatMeta_(scope, m => {
    const pins = m.recordPins || {};
    const kept = {};
    for (const rid in pins) {
      if (typeof pins[rid] === 'string' && pins[rid].indexOf('m:') === 0) { clearedPins++; continue; }
      kept[rid] = pins[rid];
    }
    m.recordPins = kept;
    // 2) 清衍生資料 + 重置節流/通知
    m.notifiedContextIds = [];
    m.notifiedJourneyIds = [];
    m.lastContextUpgradeAt = null;
    return m;
  });
  saveContexts_(scope, []);
  saveJourneys_(scope, []);
  // 3) 用新模型重分群（純 CPU、(大類,議題標籤) group-by）
  const up = upgradeContexts_(scope);
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = new Date().toISOString(); return m; });
  // 4) 重判歷程（受每日上限保護；可能要多輪，背景 sweep 會接著補）
  let det = null;
  try { det = detectJourneys_(scope); } catch (e) { console.warn('rebuild detect failed:', e && e.message); }
  // 5) 標記已通知，避免整批推播
  markUpgradesNotified_(scope);
  const ctxN = loadContexts_(scope).length;
  const jrnN = loadJourneys_(scope).filter(j => j.status === 'journey').length;
  return `rebuild 完成：清 ${clearedPins} 個 m: 釘選；重建 ${ctxN} 條脈絡、${jrnN} 條歷程。\n`
    + `upgrade=${JSON.stringify(up)}\n`
    + (det ? `detect=${JSON.stringify(det)}` : 'detect: 略過/失敗（背景會補）');
}

/**
 * Editor diagnostic: force a 脈絡 upgrade on the OWNER's chat (ignores the
 * throttle) and log every resulting object's criteria, so the 3-condition
 * thresholds can be eyeballed and calibrated against real / simulated data.
 * UI-free, so the deploy block (200-version cap) doesn't affect it.
 */
function runContextUpgradeNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const all = loadEmbeddingRecords_(scope);
  const valid = all.filter(r => r.embedding && r.embedding.length === EMBED_DIM);
  const k = valid.length >= FOCUS_MIN_COUNT ? pickContextK_(valid.length) : '-';
  console.log(`records=${all.length} valid=${valid.length} k=${k}`);
  const summary = upgradeContexts_(scope);
  console.log('summary:', JSON.stringify(summary));
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const corpusMedia = Object.values(recById).filter(r =>
    r.embedding && CONTEXT_MEDIA_TYPES[r.type] && r.type !== 'text');
  for (const c of loadContexts_(scope)) {
    const cr = c.criteria || {};
    console.log(
      `[${c.status}] ${c.label} — ${(c.recordIds || []).length} 筆 ${spanLabel_(c.firstTs, c.lastTs)} | ` +
      `density=${cr.semanticDensity} sep=${cr.clusterSeparation} ` +
      `visits=${cr.returnVisits} span=${cr.returnSpanHours}h media=${cr.mediaKinds} ` +
      `passed=${cr.passed}`);
    if (!cr.passed) {
      const rep = contextGapReport_((c.recordIds || []).map(id => recById[id]).filter(Boolean), corpusMedia);
      if (rep.gaps.length) console.log('    還缺: ' + rep.gaps.join(' ｜ '));
    }
  }

  // 語意密度校準表：由高到低排序，找「真主題」與「噪音」之間的縫，據此訂 semanticDensityMin。
  const C = CONTEXT_CRITERIA;
  console.log(`--- 語意密度排序（門檻 semanticDensityMin=${C.semanticDensityMin}、群間距 clusterSeparationMin=${C.clusterSeparationMin}）---`);
  loadContexts_(scope).slice()
    .sort((a, b) => ((b.criteria || {}).semanticDensity || 0) - ((a.criteria || {}).semanticDensity || 0))
    .forEach(c => {
      const cr = c.criteria || {};
      const densMark = densityConditionMet_(cr) ? (cr.densityViaFocus || (cr.semanticDensity || 0) < C.semanticDensityMin ? '✓聚焦' : '✓') : '✗';
      const sepMark = cr.clusterSeparation >= C.clusterSeparationMin ? '✓' : '✗';
      console.log(`  density=${cr.semanticDensity} coreFrac=${cr.coreFrac} ${densMark}  sep=${cr.clusterSeparation} ${sepMark}  ${cr.passed ? '【passed】' : '         '} ${c.label}`);
    });
  return summary;
}

/**
 * 縝密診斷：逐筆檢視某條（或全部）脈絡的組成，揪出 blob。
 *   diagnoseContextComposition_()            // 全部 ≥8 則的脈絡
 *   diagnoseContextComposition_('3b1ce5ce')  // 只看 id 前綴相符的那條
 *
 * 每條印：
 *   - 群整體：density、status、筆數、跨度
 *   - 逐筆到群心 cosine（升序），< recordFitMin 標 ✗（= 該被淘汰卻還在的混入筆）
 *   - 2-means 子拆：把這群拆成兩半，印兩半群心互相 cosine + 各自代表片段。
 *     兩半 cosine 低（<0.85）→ 這群其實是兩個主題硬湊（blob 的鐵證）。
 */
function diagnoseContextComposition_(cidPrefix) {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { if (r && r.embedding) recById[r.id] = r; });
  const fitMin = (CONTEXT_CRITERIA && CONTEXT_CRITERIA.recordFitMin) || 0.55;
  const pins = loadChatMeta_(scope).recordPins || {};

  // 同時 console.log 與累積成文字，最後寫進 Drive `_diag.log`（開發端直接讀，免手動複製）。
  const L = [];
  const say = s => { console.log(s); L.push(s); };

  let contexts = loadContexts_(scope);
  if (cidPrefix) contexts = contexts.filter(c => c.id.indexOf(cidPrefix) === 0);
  else contexts = contexts.filter(c => (c.recordIds || []).length >= 8)
                          .sort((a, b) => (b.recordIds || []).length - (a.recordIds || []).length);
  if (!contexts.length) { say('沒有符合的脈絡。'); writeDiagFile_(scope, L.join('\n')); return; }

  for (const c of contexts) {
    const recs = (c.recordIds || []).map(id => recById[id]).filter(r => r && r.embedding);
    if (recs.length < 2) { say(`\n[${c.id.slice(0,8)}] ${c.label} — 筆數太少，略過`); continue; }
    const centroid = meanVector_(recs.map(r => r.embedding));
    const cr = c.criteria || {};

    // pin 統計：被自動合併 pin（m:）鎖在一起的筆數——這些 k-means 永遠拆不開。
    let mPins = 0, manualPins = 0;
    recs.forEach(r => { const g = pins[r.id]; if (g) { if (g.indexOf('m:') === 0) mPins++; else manualPins++; } });

    say(`\n══════════ [${c.id.slice(0,8)}] ${c.userTitle || c.label} ══════════`);
    say(`status=${c.status} 筆數=${recs.length} 跨度=${spanLabel_(c.firstTs, c.lastTs)} density=${cr.semanticDensity}`);
    say(`pin: ${mPins} 筆被自動合併鎖定(m:) / ${manualPins} 筆手動分開${mPins ? '  ⚠️ m: pin 會強制 must-link，k-means 無法拆開這群' : ''}`);

    // 逐筆到群心 cosine（升序）——最不像的排前面
    const scored = recs.map(r => ({ r, sim: cosineSim_(r.embedding, centroid) }))
                       .sort((a, b) => a.sim - b.sim);
    let belowN = 0;
    say(`── 逐筆到群心 cosine（升序；✗ = < ${fitMin} 本應淘汰）──`);
    scored.forEach(s => {
      const mark = s.sim < fitMin ? '✗' : ' ';
      if (s.sim < fitMin) belowN++;
      const d = Utilities.formatDate(new Date(s.r.ts), TIME_ZONE, 'MM/dd');
      const tx = ((s.r.aggregatedText || s.r.text) || '').replace(/\s+/g, ' ');
      const pinMark = (pins[s.r.id] && pins[s.r.id].indexOf('m:') === 0) ? '🔒' : '  ';
      say(`  ${mark}${pinMark} cos=${s.sim.toFixed(3)} [${typeLabel_(s.r.type)}][${d}] ${truncate_(tx, 46)}`);
    });
    say(`→ ${belowN} 筆 < ${fitMin}（混入嫌疑）`);

    // 2-means 子拆——看這群是不是兩個主題硬湊
    const sub = kmeansCluster_(recs, 2).filter(g => g.length > 0);
    if (sub.length === 2) {
      const cA = meanVector_(sub[0].map(r => r.embedding));
      const cB = meanVector_(sub[1].map(r => r.embedding));
      const mutual = cosineSim_(cA, cB);
      const repA = representativeLabel_(sub[0], cA);
      const repB = representativeLabel_(sub[1], cB);
      const verdict = mutual < 0.85 ? '⚠️ 兩半差很多 → 這群其實是兩個主題硬湊' : '兩半夠近 → 應屬同一主題';
      say(`── 2-means 子拆：兩半群心 cosine = ${mutual.toFixed(3)}  ${verdict}`);
      say(`   半A（${sub[0].length} 筆）代表：${repA}`);
      say(`   半B（${sub[1].length} 筆）代表：${repB}`);
    }
  }
  writeDiagFile_(scope, L.join('\n'));
}

/** Editor 入口：診斷全部 ≥8 則脈絡。 */
function runContextDiagnoseNow() { diagnoseContextComposition_(); }

/**
 * 把診斷文字寫進 chat 資料夾的 `_diag.log`（覆寫）。讓開發端（讀得到此 Drive）
 * 直接取用診斷輸出，不必使用者手動複製 Apps Script 執行記錄。
 */
function writeDiagFile_(scope, text) {
  try {
    const folder = chatFolder_(scope);
    const stamped = `[${new Date().toISOString()}]\n${text}`;
    const it = folder.getFilesByName('_diag.log');
    if (it.hasNext()) it.next().setContent(stamped);
    else folder.createFile('_diag.log', stamped, MimeType.PLAIN_TEXT);
  } catch (e) { console.warn('writeDiagFile_ failed:', e && e.message); }
}
