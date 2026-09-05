/**
 * 大類歸戶 (record.category) — 主題群組新模型 block 2。
 * 見 docs/design/context-to-journey.md（待驗收後補規格）。
 *
 * 模型要點（討論定案）：
 *   - 8 固定大類（JOURNEY_KEYWORD_CATEGORIES）：教學/研究/閱讀/反思/札記/生活/規劃/隨想。
 *   - 每筆 record 歸一個大類，存進 record.category，**判一次、永不重判**（大類穩定的地基）。
 *   - LLM 判定**單位 = 敘事片段（30 分 gap）**，不是逐筆：給 LLM 整段上下文，一次回
 *     該片段每筆的大類。價值＝單筆看不出歸哪類時，靠上下文（同片段鄰句）正確歸戶；
 *     但 prompt 要求「上下文用來看懂、不是硬湊一團」——一片段可含多個大類，該分就分。
 *   - 背景 sweep 每輪挑「還沒 category 的 record」按片段成批判（受每日上限保護）。
 *   - 既有資料：editor 跑 backfillCategoriesNow() 一次補齊。
 */

// 每輪 sweep 最多判幾個敘事片段（一片段一次 LLM）——bound 延遲與成本。
const CATEGORY_BATCH_EPISODES_PER_SWEEP = 6;
// 敘事片段 gap：與 EPISODE_GAP_MS 同義（30 分），這裡獨立常數避免載入順序耦合。
const CATEGORY_EPISODE_GAP_MS = 30 * 60 * 1000;

/**
 * 對一個敘事片段（一批時間相近的 record）判大類：一次 LLM、給整段上下文，回每筆的大類。
 * 回傳 { [recordId]: '大類' }（只含成功判定的）。失敗回 {}。
 */
function classifyEpisodeCategories_(records, hints) {
  const recs = (records || []).filter(r => r && r.id);
  if (!recs.length) return {};
  const sorted = recs.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(0, 40);
  const H = hints || {};
  // 綁串：把連續記寫（同一件事）的多則標上同一個〔串X〕，提示 LLM「同串給同一大類」。
  const threads = segmentThreads_(sorted);
  const threadTag = {};
  threads.forEach((th, ti) => { const tag = String.fromCharCode(65 + (ti % 26)); th.forEach(r => { threadTag[r.id] = tag; }); });
  const lines = sorted.map((r, i) => {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
    const tx = ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
    let line = `[#${i + 1}][${d}][${typeLabel_(r.type)}]〔串${threadTag[r.id] || '?'}〕 ${truncate_(tx, 180)}`;
    const h = H[r.id];   // 向量比對給的「延續」提示（語意最接近的現有脈絡）
    if (h && h.label) line += `　⟨語意最接近現有脈絡「${truncate_(h.label, 16)}」· 大類 ${h.category || '?'} · 相似度 ${h.sim.toFixed(2)}⟩`;
    return line;
  }).join('\n');

  const cats = JOURNEY_KEYWORD_CATEGORIES;
  const sys = [
    '你是學習記寫的「大類歸戶器」。以下是同一個時間片段（30 分鐘內連續）陸續記下的訊息，',
    '依時間排序、各有編號 #N。請為**每一則**指派一個最貼近的「大類」。',
    `大類只能從這 8 個擇一：${cats.join('／')}。`,
    '判定原則：',
    '- 善用上下文：單獨一句看不出歸哪類時，參考同片段的前後句來理解它在講什麼。',
    '- 句首〔串X〕標示「這幾則是連續記寫、通常在講同一件事」：**同一串請給同一個大類**，不要把一件事的連續記寫拆成多類（例：「德國演講後」「留下來跟研究室的人吃飯」「他們很熱情」是同一串、同一件事）。',
    '- **不同串之間**才可以是不同大類，該分就分；上下文是用來「看懂」，不是把不相干的事硬湊成一類。',
    '- 每則句末若附 ⟨語意最接近現有脈絡…⟩，是向量比對給的「延續」提示：若該則確實延續那條脈絡（例如它是該主題的後續心得/結果），優先沿用提示的大類；若只是字面相近、實際在講別的事（如在抱怨群組而非延續該主題），仍以實際內容為準。這能避免「夾在無關訊息中的延續句」被整段語氣帶偏。',
    '- 嚴格依實際內容，不腦補、不臆測沒寫的東西。真的無法判斷時給最接近的一個。',
    '只輸出 JSON（不要 markdown、不要說明）：{"items":[{"n":1,"大類":"教學"},{"n":2,"大類":"生活"}]}',
    '每一則編號都要有一筆，大類必須是上面 8 個之一。'
  ].join('\n');

  let raw;
  try {
    raw = geminiGenerate_([{ text: lines }], { systemInstruction: sys, temperature: 0.1, maxOutputTokens: 800 });
  } catch (e) { console.warn('classifyEpisodeCategories_ LLM failed:', e && e.message); return {}; }
  const json = extractJson_(raw || '');
  if (!json || !Array.isArray(json.items)) return {};
  const out = {};
  for (const it of json.items) {
    const n = parseInt(it && it.n, 10);
    if (isNaN(n) || n < 1 || n > sorted.length) continue;
    const rawCat = String((it['大類'] || it.category) || '').trim();
    let cat = '';
    for (const c of cats) { if (rawCat.indexOf(c) >= 0) { cat = c; break; } }
    if (cat) out[sorted[n - 1].id] = cat;
  }
  // 同串收斂：一串一個大類（多數決、平手取最早），把連續記寫綁成同一件事。
  collapseLabelByThread_(threads, out, 'category');
  return out;
}

/**
 * 片段判完後，補上 LLM 漏掉的未判 record（短句/噪音/媒介常被 LLM 從批次回應裡略過）：
 * 用「同片段已知大類的多數決」當後備（這些 record 本就有上下文鄰居），全無已知時退 '隨想'。
 * 就地把後備寫進 map（只填未判且 LLM 沒給的），避免任何 record 永遠卡住。
 */
function fillEpisodeCategoryFallback_(episodeRecords, map) {
  const votes = {};
  for (const r of episodeRecords) {
    const c = r.category || map[r.id];
    if (c) votes[c] = (votes[c] || 0) + 1;
  }
  let majority = '隨想', best = -1;
  for (const c in votes) if (votes[c] > best) { best = votes[c]; majority = c; }
  for (const r of episodeRecords) {
    if (!r.category && !map[r.id]) map[r.id] = majority;   // LLM 漏的 → 後備
  }
  return map;
}

/**
 * 把 id→category 一次寫回 embeddings.jsonl（單次 read+write，避免逐筆 O(N) 重寫）。
 * 只覆寫 map 內、且該 record 尚無 category（或不同）的；回傳實際更新筆數。Lock 保護。
 */
function bulkSetCategory_(scope, idToCat, provisional) {
  const ids = Object.keys(idToCat || {});
  if (!ids.length) return 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (!text) return 0;
    const lines = text.split('\n');
    let changed = 0;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch (_) { continue; }
      const cat = idToCat[r.id];
      if (!cat) continue;
      // provisional=true：額度用完的 CPU 暫定（categoryProv，額度回來要重判）；false：正式判定（清旗標）。
      const want = provisional ? 1 : 0;
      const cur = r.categoryProv ? 1 : 0;
      if (r.category !== cat || cur !== want) {
        r.category = cat;
        if (provisional) r.categoryProv = 1; else delete r.categoryProv;
        lines[i] = JSON.stringify(r); changed++;
      }
    }
    if (changed) file.setContent(lines.join('\n'));
    return changed;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 背景 sweep 入口：挑「還沒 category」的 record，按敘事片段成批判，最多
 * CATEGORY_BATCH_EPISODES_PER_SWEEP 個片段／輪。受 journeyDetect 每日上限保護
 * （共用額度——同樣是 LLM 呼叫）。回傳本輪判定的 record 數。
 */
function maybeClassifyCategories_(scope) {
  const all = loadEmbeddingRecords_(scope);
  const withTs = all.filter(r => r && r.ts);
  const needs = r => !r.category || r.categoryProv;   // 未判 or 暫定（額度回來要補真判）
  if (!withTs.some(needs)) return 0;
  withTs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // 〔兜底·Fix1〕額度用完時，仍用純 CPU 後備（同片段多數決/退「隨想」、零 LLM）給「完全未判」的記錄
  // 一個**暫定**大類（categoryProv），絕不讓它卡在「尚未歸類／等待整理」；額度回來後由下方 LLM 重判、
  // 清掉暫定旗標。這是修「基礎分類的 CPU 保底被關在 LLM 額度閘後面、額度耗盡就永久卡住」的安全網。
  if (journeyDetectBudgetLeft_() <= 0) {
    if (!withTs.some(r => !r.category)) return 0;   // 只剩暫定的→等額度回來重判，不必每輪空跑
    const acc = {};
    groupByEpisode_(withTs, CATEGORY_EPISODE_GAP_MS)
      .filter(ep => ep.records.some(r => !r.category))
      .forEach(ep => {
        const m = {};
        fillEpisodeCategoryFallback_(ep.records, m);
        ep.records.forEach(r => { if (!r.category && m[r.id]) acc[r.id] = m[r.id]; });
      });
    const n = bulkSetCategory_(scope, acc, true);
    if (n) { markClassificationAdvanced_(scope); console.log(`maybeClassifyCategories_ ${scope.key}: 額度用完→CPU 暫定 ${n} 筆大類（待補真判）`); }
    return n;
  }

  // 用完整敘事片段當單位（含已判鄰居給上下文），挑含「需判」record 的片段；含暫定的也重判（升為正式）。
  const episodes = groupByEpisode_(withTs, CATEGORY_EPISODE_GAP_MS)
    .filter(ep => ep.records.some(needs))
    .slice(0, CATEGORY_BATCH_EPISODES_PER_SWEEP);
  // 向量輔助：算一次現有脈絡群心，給每個待判 record 找「語意最接近的現有脈絡」當提示。
  const recById = {}; all.forEach(r => { recById[r.id] = r; });
  const centroidList = contextCentroids_(loadContexts_(scope), recById);
  const acc = {};
  for (const ep of episodes) {
    if (journeyDetectBudgetLeft_() <= 0) break;
    bumpJourneyDetect_();
    const hints = nearestContextHints_(ep.records.filter(needs), centroidList, null);
    const map = classifyEpisodeCategories_(ep.records, hints);
    fillEpisodeCategoryFallback_(ep.records, map);   // LLM 漏判的用同片段多數決補，不卡住
    // LLM 新判優先；暫定記錄即使 LLM 漏判也用其暫定值升為正式（清旗標），避免無限重判。
    for (const r of ep.records) { if (!needs(r)) continue; const lab = map[r.id] || r.category; if (lab) acc[r.id] = lab; }
  }
  const total = bulkSetCategory_(scope, acc, false);
  if (total) {
    markClassificationAdvanced_(scope);   // 觸發重分群（見 maybeUpgradeContexts_ 閘門）
    console.log(`maybeClassifyCategories_ ${scope.key}: 判定 ${total} 筆大類`);
  }
  return total;
}

/** 標記「分類有進展」：bump meta.lastClassifyAt，讓 maybeUpgradeContexts_ 的「無新資料」閘
 *  放行重分群——否則背景晚補的大類/議題標籤永遠折不進主題（沒新訊息就不重分群）。 */
function markClassificationAdvanced_(scope) {
  updateChatMeta_(scope, m => { m.lastClassifyAt = new Date().toISOString(); return m; });
}

/**
 * 手動把多筆 record 釘到指定 (大類, 議題標籤) —— 「歸到某主題 / 整段改歸」用（must-link）。
 * 一次 read+write 設 category + topicLabel + topicLocked=true（鎖住；背景判一次的規則本就跳過
 * 「已有標籤」者，這旗標再加一層保險、也記錄人工意向）。回傳實際更新筆數。
 */
function setRecordsCategoryTopic_(scope, ids, category, topicLabel, keepPins) {
  const idset = {}; (ids || []).forEach(id => { if (id) idset[id] = true; });
  if (!Object.keys(idset).length) return 0;
  // 已定案封存的脈絡成員不可改歸（must-not move）——所有改歸路徑都經過這裡，集中守衛。
  try {
    loadContexts_(scope).forEach(c => {
      if (c && c.finalized) (c.recordIds || []).forEach(rid => { delete idset[rid]; });
    });
  } catch (_) {}
  if (!Object.keys(idset).length) return 0;
  let n = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (text) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (!s) continue;
        let r;
        try { r = JSON.parse(s); } catch (_) { continue; }
        if (idset[r.id]) {
          r.category = category; r.topicLabel = topicLabel; r.topicLocked = true;
          delete r.categoryProv; delete r.topicProv;   // 手動改歸＝正式置放，清掉額度用完的暫定旗標
          lines[i] = JSON.stringify(r); n++;
        }
      }
      if (n) file.setContent(lines.join('\n'));
    }
  } finally {
    lock.releaseLock();
  }
  // 〔改歸＝明確置放〕清掉這些 record 的 pin（含「移出」下的 x: must-not-link、分開的群 pin）：
  // 否則 pin 會讓 upgradeContexts_ 仍把它當自成一群、改歸不生效。改歸是最新的明確意圖，蓋過 pin。
  // 同時把目標主題標 ✨（rehomedSignatures）：使用者主動把記錄歸進來＝這條主題本次有變動，即使移入
  // 的記錄 ts 是舊的、踩不進 lastTs 新鮮窗，/themes 也該亮星（與「移出重歸」同尺度、同 sig 格式
  // category|topicLabel，見 makeContextFreshFn_）。keepPins=true（背景智慧合併）自有通知，不在此亮。
  if (n && !keepPins) {
    try {
      updateChatMeta_(scope, m => {
        const p = m.recordPins || {};
        Object.keys(idset).forEach(id => { if (p[id]) delete p[id]; });
        m.recordPins = p;
        const sigs = m.rehomedSignatures || {};
        sigs[(category || '') + '|' + topicLabel] = Date.now();   // 讓 /themes 對目標主題亮 ✨
        const cutoff = Date.now() - CONTEXT_FRESH_GATE_MS;        // 修剪過期 ✨（同 fresh 窗）
        for (const k in sigs) if (sigs[k] < cutoff) delete sigs[k];
        m.rehomedSignatures = sigs;
        return m;
      });
    } catch (e) { console.warn('clear pins / mark fresh on reclassify failed:', e && e.message); }
  }
  return n;
}

/** 單筆版（記錄改歸用）：回傳是否成功。 */
function setRecordCategoryTopic_(scope, rid, category, topicLabel) {
  return setRecordsCategoryTopic_(scope, [rid], category, topicLabel) > 0;
}

/**
 * 移出重歸（語意 C）用：清掉某筆的 topicLabel + topicLocked，讓背景下輪重判它的議題。
 * 回傳被清掉的原 topicLabel（給 meta.recordExclude 記「避開原主題」、放回時還原用）。
 */
function clearRecordTopicForRehome_(scope, rid) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (!text) return '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch (_) { continue; }
      if (r.id === rid) {
        const orig = r.topicLabel || '';
        delete r.topicLabel; delete r.topicLocked;
        lines[i] = JSON.stringify(r);
        file.setContent(lines.join('\n'));
        return orig;
      }
    }
    return '';
  } finally {
    lock.releaseLock();
  }
}

/**
 * 把某 scope 所有「沒 category」的 record 全部補判（按片段成批），一次反應過來。
 * 受每日上限保護；資料多時可能需要分幾次跑（額度用完會停，下次接著補）。回傳人讀字串。
 * scope-aware 核心，供 editor 入口與遠端命令佇列（category.backfill）共用。
 */
function backfillCategoriesForScope_(scope) {
  const all = loadEmbeddingRecords_(scope);
  const withTs = all.filter(r => r && r.ts);
  const pendingCount0 = withTs.filter(r => !r.category).length;
  if (!pendingCount0) return `全部 ${all.length} 筆已有 category，無需補判。` + categoryDistForScope_(scope);

  // ⚠️ 用「完整敘事片段」當單位（含已判的鄰居當上下文），只挑「含未判 record」的片段判，
  // 且只寫回未判的。先前只把 pending 抽出來分組 → 未判筆散落、被切成大量單筆小片段、
  // 缺上下文、品質差甚至判不出（這就是上一輪只寫 1 筆的原因）。回到設計初衷：上下文歸類。
  withTs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const episodes = groupByEpisode_(withTs, CATEGORY_EPISODE_GAP_MS)
    .filter(ep => ep.records.some(r => !r.category));   // 只處理還有未判的片段

  const DEADLINE_MS = 4.5 * 60 * 1000;
  const t0 = Date.now();
  // 向量輔助：算一次現有脈絡群心，給每個待判 record 找「語意最接近的現有脈絡」當提示。
  const recById = {}; all.forEach(r => { recById[r.id] = r; });
  const centroidList = contextCentroids_(loadContexts_(scope), recById);
  const acc = {};           // id → category（只收未判的）
  let eps = 0, budgetOut = false, timeOut = false;
  for (const ep of episodes) {
    if (Date.now() - t0 > DEADLINE_MS) { timeOut = true; break; }
    if (journeyDetectBudgetLeft_() <= 0) { budgetOut = true; break; }
    bumpJourneyDetect_();
    const hints = nearestContextHints_(ep.records.filter(r => !r.category), centroidList, null);
    const map = classifyEpisodeCategories_(ep.records, hints);   // 整段（含已判鄰居）給上下文
    fillEpisodeCategoryFallback_(ep.records, map);          // LLM 漏判的用同片段多數決補，不卡住
    for (const r of ep.records) {                          // 只寫回未判的
      if (!r.category && map[r.id]) acc[r.id] = map[r.id];
    }
    eps++;
  }
  const wrote = bulkSetCategory_(scope, acc);
  if (wrote) markClassificationAdvanced_(scope);   // 觸發重分群
  const after = loadEmbeddingRecords_(scope);
  const remaining = after.filter(r => r && r.ts && !r.category).length;
  const note = timeOut ? '（接近執行時間上限，先停；再觸發一次接著補）'
             : budgetOut ? '（每日 LLM 額度用完，先停；再觸發一次接著補）'
             : (wrote === 0 && remaining > 0) ? '（本輪未寫入：剩餘片段 LLM 判不出，可再觸發一次）' : '';
  return `backfill 本輪：判 ${eps} 片段、寫 ${wrote} 筆${note}。尚餘 ${remaining} 筆待判。\n` + categoryDistForScope_(scope);
}

/** 大類分布概覽（人讀字串）：總筆數、各大類筆數、尚無 category 筆數。 */
function categoryDistForScope_(scope) {
  const all = loadEmbeddingRecords_(scope);
  const dist = {};
  let uncat = 0;
  all.forEach(r => { if (r && r.ts) { if (r.category) dist[r.category] = (dist[r.category] || 0) + 1; else uncat++; } });
  const ordered = JOURNEY_KEYWORD_CATEGORIES
    .map(c => `${c}:${dist[c] || 0}`).join('  ');
  return `大類分布（共 ${all.length} 筆）：${ordered}  未判:${uncat}`;
}

/** Editor 一鍵：把既有所有「沒 category」的 record 全部補判，印結果。 */
function backfillCategoriesNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  console.log(backfillCategoriesForScope_(scope));
}
