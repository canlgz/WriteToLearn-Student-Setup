/**
 * 桶內議題標籤 (record.topicLabel) — 主題群組新模型 block 3a。
 * 見 docs/design/context-to-journey.md（待驗收後補規格）。
 *
 * 模型要點（討論定案）：
 *   - 「主題＝脈絡」，首重**議題一致**（在講同一件事），不靠向量幾何（k-means 在短中文
 *     embedding 不可靠、是巨無霸幫兇）。改由 LLM 判議題、給可命名標籤。
 *   - 在**大類桶內**做：每筆 record 在它的 category 桶裡，被指派一個「議題標籤」(topicLabel)，
 *     ≤8 字名詞片語（例：大類=教學 → topicLabel=「形成性評量」）。同 (category, topicLabel)
 *     = 同一個主題群（= 脈絡，承載升格）。
 *   - **不發散**：判標籤時把該桶**現有的議題標籤清單**給 LLM，能歸現有就歸、真新才開。
 *     → 主題集合穩定增長、只增不洗（每次進 /themes 不隨機跳）。
 *   - **判定單位 = 敘事片段**（給上下文，與大類同理）；判一次存著、不重判。
 *   - 向量在此可做「候選收斂」（大桶時先用向量挑最近的現有標籤給 LLM）——目前資料量小，
 *     直接把整桶現有標籤給 LLM（菜單不長），向量收斂列為日後規模優化。
 */

const TOPIC_BATCH_EPISODES_PER_SWEEP = 6;
const TOPIC_EPISODE_GAP_MS = 30 * 60 * 1000;
const TOPIC_LABEL_MAXLEN = 8;

/**
 * 對一個敘事片段（已同屬一個大類桶）的 record 判議題標籤：一次 LLM、給整段上下文 +
 * 該桶現有議題標籤清單，回每筆的 topicLabel（能歸現有就用現有原字、真新才造新）。
 * 回傳 { [recordId]: 'topicLabel' }（只含成功判定的）。失敗回 {}。
 */
function classifyEpisodeTopics_(records, category, existingLabels, hints, excludeMap) {
  const recs = (records || []).filter(r => r && r.id);
  if (!recs.length) return {};
  const sorted = recs.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(0, 40);
  const H = hints || {};
  const EX = excludeMap || {};
  // 綁串：同一件事的連續記寫標同一〔串X〕，提示 LLM「同串給同一議題」。
  const threads = segmentThreads_(sorted);
  const threadTag = {};
  threads.forEach((th, ti) => { const tag = String.fromCharCode(65 + (ti % 26)); th.forEach(r => { threadTag[r.id] = tag; }); });
  const lines = sorted.map((r, i) => {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
    const tx = ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
    let line = `[#${i + 1}][${d}][${typeLabel_(r.type)}]〔串${threadTag[r.id] || '?'}〕 ${truncate_(tx, 180)}`;
    const h = H[r.id];   // 向量比對給的「延續」提示（此大類內語意最接近的現有議題）
    if (h && h.label) line += `　⟨語意最接近現有議題「${truncate_(h.label, 12)}」· 相似度 ${h.sim.toFixed(2)}⟩`;
    if (EX[r.id]) line += `　⟨此筆已被使用者從議題「${truncate_(EX[r.id], 12)}」移出，請務必避開它，改判其他最合適議題或造新⟩`;
    return line;
  }).join('\n');

  const menu = (existingLabels && existingLabels.length)
    ? existingLabels.map(l => `「${l}」`).join('、')
    : '（目前此大類還沒有任何議題標籤）';
  const sys = [
    `你是學習記寫的「議題歸戶器」。以下訊息都屬於「${category}」這個大類，是同一個時間片段`,
    '（30 分內連續）陸續記下的，依時間排序、各有編號 #N。請為**每一則**指派一個「議題標籤」。',
    '議題標籤＝這則在講的「具體題目」，≤8 字的名詞片語（例：形成性評量、繪本教學、論文寫作、',
    '家庭時光、跑步習慣）。**首重議題一致**：在講同一件事的，標同一個標籤。',
    '',
    `這個大類目前已有的議題標籤：${menu}`,
    '規則：',
    '- 能歸到上面現有標籤就**原字照用**（不要改字、不要造近義新詞），維持議題收斂、不發散。',
    '- 每則句末若附 ⟨語意最接近現有議題…⟩，是向量比對給的「延續」提示：若該則確實延續那個議題，**原字沿用該標籤**；若只是表面相近、其實在講別的事，再照內容判。',
    '- 每則句末若附 ⟨已被使用者從議題「X」移出…⟩，代表使用者判定它不屬於 X：**絕對不要再判成 X**，請挑最合適的其他議題或造一個新標籤。',
    '- 真的是新議題才造一個新標籤（≤8 字、名詞片語、不要動詞、不要套「學習/分享/記錄」空話）。',
    '- 句首〔串X〕＝這幾則是連續記寫、通常同一件事：**同一串請給同一個議題標籤**，別把一件事拆成多個議題。',
    '- **不同串之間**才可以有不同議題，該分就分；善用上下文理解每一則在講什麼，但不要把不相干的事硬湊成同一個議題。',
    '- 嚴格依實際內容，不腦補。',
    '只輸出 JSON（不要 markdown、不要說明）：{"items":[{"n":1,"議題":"形成性評量"},{"n":2,"議題":"家庭時光"}]}',
    '每一則編號都要有一筆。'
  ].join('\n');

  let raw;
  try {
    raw = geminiGenerate_([{ text: lines }], { systemInstruction: sys, temperature: 0.1, maxOutputTokens: 800 });
  } catch (e) { console.warn('classifyEpisodeTopics_ LLM failed:', e && e.message); return {}; }
  const json = extractJson_(raw || '');
  if (!json || !Array.isArray(json.items)) return {};
  // 標籤正規化：截長、去標點空白；若與現有標籤去空白後相同，吸附回現有原字（防大小寫/空白發散）。
  const norm = s => String(s || '').replace(/\s+/g, '').replace(/[。，、！？.!?]+$/, '').slice(0, TOPIC_LABEL_MAXLEN);
  const existNorm = {};
  (existingLabels || []).forEach(l => { existNorm[norm(l)] = l; });
  const out = {};
  for (const it of json.items) {
    const n = parseInt(it && it.n, 10);
    if (isNaN(n) || n < 1 || n > sorted.length) continue;
    let lab = norm(it['議題'] || it.topic || it.label);
    if (!lab) continue;
    if (existNorm[lab]) lab = existNorm[lab];   // 吸附回現有原字
    out[sorted[n - 1].id] = lab;
  }
  // 同串收斂：一串一個議題標籤（多數決、平手取最早）。EX（被移出）仍以軟提示傳給 LLM（句末
  // ⟨…請務必避開…⟩），硬性保證改由「移出當下即時 LLM 重歸＋topicLock」（rehomeDroppedRecord_）負責。
  collapseLabelByThread_(threads, out, 'topicLabel');
  return out;
}

/** 片段判完補 LLM 漏掉的：用同片段同桶已知議題的多數決；全無則用大類名當議題標籤。 */
function fillEpisodeTopicFallback_(episodeRecords, category, map) {
  const votes = {};
  for (const r of episodeRecords) {
    const t = r.topicLabel || map[r.id];
    if (t) votes[t] = (votes[t] || 0) + 1;
  }
  let majority = category, best = -1;   // 全無已知 → 退大類名（至少同桶聚一起）
  for (const t in votes) if (votes[t] > best) { best = votes[t]; majority = t; }
  for (const r of episodeRecords) {
    if (!r.topicLabel && !map[r.id]) map[r.id] = majority;
  }
  return map;
}

/** 一次寫回 id→topicLabel（單次 read+write）。只覆寫尚無 topicLabel 或不同者。回傳更新筆數。 */
function bulkSetTopicLabel_(scope, idToLabel, provisional) {
  const ids = Object.keys(idToLabel || {});
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
      const lab = idToLabel[r.id];
      if (!lab) continue;
      // provisional=true：額度用完的 CPU 暫定（topicProv，額度回來要重判）；false：正式判定（清旗標）。
      const want = provisional ? 1 : 0;
      const cur = r.topicProv ? 1 : 0;
      if (r.topicLabel !== lab || cur !== want) {
        r.topicLabel = lab;
        if (provisional) r.topicProv = 1; else delete r.topicProv;
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
 * 處理「有 category、還沒 topicLabel」的 record：按 (大類桶 → 敘事片段) 成批判議題標籤。
 * 只處理含未判 topic 的片段、只寫回未判的；LLM 漏的用多數決後備。受每日上限保護。
 * 回傳本輪寫入筆數。maxEpisodes 限制每次處理的片段數（背景用 6；backfill 傳 Infinity）。
 */
function assignTopicsForScope_(scope, maxEpisodes, deadlineMs) {
  const meta0 = loadChatMeta_(scope);
  const linkIntent = meta0.linkIntent || {};
  // 移出重歸（C）：被移出的記錄帶「避開原主題」，重判時告訴 LLM 別判回去。
  const excludeMap = {};
  const excMeta = meta0.recordExclude || {};
  for (const id in excMeta) if (excMeta[id] && excMeta[id].topic) excludeMap[id] = excMeta[id].topic;
  const allRaw = loadEmbeddingRecords_(scope);
  const all = allRaw.filter(r =>
    r && r.ts && r.category && !isCollectionRecord_(r, linkIntent));   // 收藏不進主題
  const needs = r => !r.topicLabel || r.topicProv;   // 未判 or 暫定（額度回來要補真判）

  // 〔兜底·Fix1〕額度用完：純 CPU 後備（同桶同片段多數決/退大類名、零 LLM）給「完全未判」的記錄一個
  // **暫定**議題（topicProv），不卡「等待整理」；額度回來後由下方 LLM 重判、清掉暫定旗標。
  if (journeyDetectBudgetLeft_() <= 0) {
    if (!all.some(r => !r.topicLabel)) return { wrote: 0, eps: 0, remaining: -1, budgetOut: true };   // 只剩暫定→等額度
    const acc = {}; const byCat = {};
    all.forEach(r => { if (!r.topicLabel) (byCat[r.category] = byCat[r.category] || []).push(r); });
    for (const cat in byCat) {
      const bucketAll = all.filter(r => r.category === cat).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      groupByEpisode_(bucketAll, TOPIC_EPISODE_GAP_MS)
        .filter(ep => ep.records.some(r => !r.topicLabel))
        .forEach(ep => {
          const m = {}; fillEpisodeTopicFallback_(ep.records, cat, m);
          ep.records.forEach(r => { if (!r.topicLabel && m[r.id]) acc[r.id] = m[r.id]; });
        });
    }
    const wrote = bulkSetTopicLabel_(scope, acc, true);
    if (wrote) markClassificationAdvanced_(scope);
    return { wrote, eps: 0, remaining: -1, budgetOut: true };
  }

  // 向量輔助：算一次現有脈絡群心（用全部紀錄當 id→record，含脈絡成員）。
  const recById = {}; allRaw.forEach(r => { recById[r.id] = r; });
  const centroidList = contextCentroids_(loadContexts_(scope), recById);
  // 每桶現有議題標籤清單（給 LLM 當菜單）——只收正式標籤，暫定的不進菜單（免 LLM「原字沿用」粗標籤）。
  const labelsByCat = {};
  all.forEach(r => {
    if (r.topicLabel && !r.topicProv) (labelsByCat[r.category] = labelsByCat[r.category] || new Set()).add(r.topicLabel);
  });
  // 待判：有 category、需判（未判 or 暫定）
  const pendingByCat = {};
  all.forEach(r => { if (needs(r)) (pendingByCat[r.category] = pendingByCat[r.category] || []).push(r); });
  const cats = Object.keys(pendingByCat);
  if (!cats.length) return { wrote: 0, eps: 0, remaining: 0, budgetOut: false };

  const t0 = Date.now();
  const acc = {};
  let eps = 0, budgetOut = false, timeOut = false;
  const limit = maxEpisodes || Infinity;
  const dl = deadlineMs || Infinity;

  // 桶內：把待判 record 連同**同桶已判的鄰居**一起分敘事片段（保上下文），只判含未判的片段。
  outer:
  for (const cat of cats) {
    const bucketAll = all.filter(r => r.category === cat);
    bucketAll.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const episodes = groupByEpisode_(bucketAll, TOPIC_EPISODE_GAP_MS)
      .filter(ep => ep.records.some(needs));
    for (const ep of episodes) {
      if (eps >= limit) break outer;
      if (Date.now() - t0 > dl) { timeOut = true; break outer; }
      if (journeyDetectBudgetLeft_() <= 0) { budgetOut = true; break outer; }
      bumpJourneyDetect_();
      const existing = Array.from(labelsByCat[cat] || []);
      const hints = nearestContextHints_(ep.records.filter(needs), centroidList, cat);
      const map = classifyEpisodeTopics_(ep.records, cat, existing, hints, excludeMap);
      fillEpisodeTopicFallback_(ep.records, cat, map);
      for (const r of ep.records) {
        if (!needs(r)) continue;
        const lab = map[r.id] || r.topicLabel;   // LLM 新判優先；暫定漏判則用其暫定值升為正式
        if (lab) {
          acc[r.id] = lab;
          (labelsByCat[cat] = labelsByCat[cat] || new Set()).add(lab);  // 新標籤即時進菜單
        }
      }
      eps++;
    }
  }
  const wrote = bulkSetTopicLabel_(scope, acc, false);   // 正式判定（清暫定旗標）
  if (wrote) markClassificationAdvanced_(scope);   // 觸發重分群（assignTopicsForScope_ 同供背景與 backfill）
  // 重歸只記 ✨ 標記（/themes 被動暗示），不再 push 打擾。to≠from 才算真換家。
  const rehomed = Object.keys(acc).filter(id => excludeMap[id]);
  if (rehomed.length) updateChatMeta_(scope, m => {
    const e = m.recordExclude || {};
    const sigs = m.rehomedSignatures || {};
    rehomed.forEach(id => {
      const from = excludeMap[id], to = acc[id];
      if (to && to !== from) {
        const rec = recById[id];
        const cat = (rec && rec.category) || (e[id] && e[id].category) || '';
        sigs[cat + '|' + to] = Date.now();   // 讓 /themes 對這主題亮 ✨
      }
      delete e[id];
    });
    const cutoff = Date.now() - CONTEXT_FRESH_GATE_MS;   // 修剪過期的重歸 ✨ 標記（同 fresh 窗）
    for (const k in sigs) if (sigs[k] < cutoff) delete sigs[k];
    m.recordExclude = e;
    m.rehomedSignatures = sigs;
    return m;
  });
  const after = loadEmbeddingRecords_(scope).filter(r =>
    r && r.ts && r.category && !isCollectionRecord_(r, linkIntent));
  const remaining = after.filter(r => !r.topicLabel).length;
  return { wrote, eps, remaining, budgetOut, timeOut };
}

/** 背景 sweep 入口：每輪最多 TOPIC_BATCH_EPISODES_PER_SWEEP 片段。 */
function maybeAssignTopics_(scope) {
  const r = assignTopicsForScope_(scope, TOPIC_BATCH_EPISODES_PER_SWEEP, null);
  if (r.wrote) console.log(`maybeAssignTopics_ ${scope.key}: 判定 ${r.wrote} 筆議題標籤`);
  return r.wrote;
}

/** scope-aware backfill（editor + 遠端命令共用）：時間預算 4.5 分、可多次接力。回人讀字串。 */
function backfillTopicsForScope_(scope) {
  const r = assignTopicsForScope_(scope, Infinity, 4.5 * 60 * 1000);
  if (r.remaining === 0 && r.wrote === 0 && r.eps === 0) return '全部已有議題標籤，無需補判。\n' + topicDistForScope_(scope);
  const note = r.timeOut ? '（接近執行時間上限，先停；再觸發一次接著補）'
             : r.budgetOut ? '（每日 LLM 額度用完，先停；再觸發一次接著補）' : '';
  return `topic backfill 本輪：判 ${r.eps} 片段、寫 ${r.wrote} 筆${note}。尚餘 ${r.remaining} 筆待判。\n` + topicDistForScope_(scope);
}

/** 議題標籤分布概覽：每大類底下各議題的筆數。
 *  ⚠️ 與 assignTopicsForScope_ 用**同一個過濾**（排除收藏/裸連結）——否則收藏 record 沒有
 *  topicLabel（本就不該有），會被誤計成 (未判)、虛報殘留。收藏數另行附註。 */
function topicDistForScope_(scope) {
  const linkIntent = loadChatMeta_(scope).linkIntent || {};
  const withCat = loadEmbeddingRecords_(scope).filter(r => r && r.ts && r.category);
  const collected = withCat.filter(r => isCollectionRecord_(r, linkIntent)).length;
  const all = withCat.filter(r => !isCollectionRecord_(r, linkIntent));   // 收藏不進主題
  const byCat = {};
  all.forEach(r => {
    const c = r.category, t = r.topicLabel || '(未判)';
    ((byCat[c] = byCat[c] || {})[t] = (byCat[c][t] || 0) + 1);
  });
  const L = [];
  for (const c of JOURNEY_KEYWORD_CATEGORIES) {
    if (!byCat[c]) continue;
    const topics = Object.keys(byCat[c]).sort((a, b) => byCat[c][b] - byCat[c][a])
      .map(t => `${t}:${byCat[c][t]}`).join('  ');
    L.push(`【${c}】${topics}`);
  }
  if (collected) L.push(`（另有 ${collected} 筆收藏/裸連結，不進主題）`);
  // 診斷：若仍有真正的 (未判)（非收藏），列出它們的型別分布，找出為何沒被判到。
  const unlabeled = all.filter(r => !r.topicLabel);
  if (unlabeled.length) {
    const byType = {};
    unlabeled.forEach(r => { byType[r.type || '?'] = (byType[r.type || '?'] || 0) + 1; });
    const emptyText = unlabeled.filter(r => !((r.aggregatedText || r.text) || '').trim()).length;
    L.push(`〔診斷〕真未判 ${unlabeled.length} 筆，型別 ${JSON.stringify(byType)}，其中空內容 ${emptyText} 筆`);
  }
  return L.join('\n');
}

/** Editor 一鍵。 */
function backfillTopicsNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  console.log(backfillTopicsForScope_(scope));
}
