/**
 * Block 3 — 轉折偵測 (層4 脈絡 → 層5 學習歷程).
 * See docs/design/context-to-journey.md §三 + §八.
 *
 * For every 升格 脈絡 (contexts.jsonl, status === 'context') we run ONE Gemini
 * call that judges the four 轉折標記 (概念重述 / 跨主題整合 / 行動指向 / 後設反思).
 *   - ≥ 1 marker → write a 歷程 object (status 'journey').
 *   - 0 markers  → write a 'watch' object (持續關注、不升格), so the count stays
 *                  honest AND we remember we already checked this version.
 *
 * Cost control:
 *   - A 脈絡 is (re)judged only when its content changed — journey.basedOnUpdatedAt
 *     is compared to context.updatedAt, so unchanged 脈絡 cost nothing. Since
 *     block 2 only re-clusters every few hours, this naturally throttles itself.
 *   - A script-wide daily cap (JOURNEY_DETECT_DAILY_MAX) is the hard safety valve.
 * Runs in the background sweep, right after block 2.
 */

/** Cheap gate from backgroundSweep(): only reaches the LLM when a 脈絡 changed. */
function maybeDetectJourneys_(scope) {
  const contexts = loadContexts_(scope).filter(c => c.status === 'context');
  if (!contexts.length) return null;
  if (journeyDetectBudgetLeft_() <= 0) return null;
  const byCtx = journeysByContext_(loadJourneys_(scope));
  const needs = contexts.some(c => {
    const j = byCtx[c.id];
    return !j || j.basedOnUpdatedAt !== c.updatedAt || !j.summary || !j.keywords;
  });
  if (!needs) return null;
  return detectJourneys_(scope);
}

/** 純 CPU、零 LLM：把「已凍結 journey」的 basedOnUpdatedAt 對齊到目前 context.updatedAt。
 *  凍結歷程的轉折判定本就是最終態，但改歸/補一筆讓 context.updatedAt 變新後，網頁的 pending
 *  （updatedAt > basedOnUpdatedAt）會一直 true → 「正在背景重新對齊」banner 不消、定案被鎖。
 *  使用者主動開 /journey 或報告頁時呼叫，當下就清掉、不必等背景 sweep。已定案的不動。回更新筆數。 */
function alignFrozenJourneyStamps_(scope) {
  const ctxById = {};
  loadContexts_(scope).forEach(c => { ctxById[c.id] = c; });
  const journeys = loadJourneys_(scope);
  let changed = 0;
  journeys.forEach(j => {
    if (j.status !== 'journey' || j.finalized) return;
    const c = ctxById[j.contextId];
    if (c && c.updatedAt && j.basedOnUpdatedAt !== c.updatedAt) { j.basedOnUpdatedAt = c.updatedAt; changed++; }
  });
  if (changed) saveJourneys_(scope, journeys);
  return changed;
}

/** 歷程顯示名稱：使用者改名(context.userTitle)＝權威主標、永遠優先、升格不覆蓋；自動產生的
 *  journey.title 退為「副標」（依現況內容、更具代表性），只在與主標不同時顯示。回 {main, sub}。
 *  沒 userTitle → journey.title 當主標、無副標。各歷程顯示面（/journey 卡、歷程現況、報告頁）共用。 */
function journeyTitleParts_(context, journey) {
  const auto = (journey && (journey.title || journey.label)) || '';
  const user = (context && context.userTitle) || '';
  const norm = s => (s || '').replace(/\s+/g, '').trim();
  if (user) return { main: user, sub: (auto && norm(auto) !== norm(user)) ? auto : '' };
  return { main: auto || (context && context.label) || '未命名', sub: '' };
}

/**
 * Reconcile journeys.jsonl against the current 升格 脈絡 set, judging the ones
 * whose content changed (bounded by `maxCalls`, default = remaining daily
 * budget). One lock-protected rewrite. Returns a summary.
 */
function detectJourneys_(scope, maxCalls) {
  const allContexts = loadContexts_(scope);
  const contexts = allContexts.filter(c => c.status === 'context');
  const ctxById = {};
  contexts.forEach(c => { ctxById[c.id] = c; });
  // All statuses — a frozen 歷程 re-linked onto a 'candidate' 脈絡 must NOT be
  // dropped just because that 脈絡 isn't 'context' (it still exists).
  const allCtxById = {};
  allContexts.forEach(c => { allCtxById[c.id] = c; });

  // 載入時即去重：歷史殘留可能讓單一 contextId 有多條 journey；存檔前再去重一次以清乾淨。
  const existing = Object.values(journeysByContext_(loadJourneys_(scope)));
  const jrnByCtx = journeysByContext_(existing);

  // Which 脈絡 need (re)judging? 升格只進不退：已是 journey 的凍結、不再重判（省 LLM、
  // 不掉回 watch）——但缺可讀標題(title)、摘要(summary)、或關鍵字(keywords)的舊紀錄
  // 允許一次回填(仍不降級)。
  const pendingIds = {};
  const pending = contexts.filter(c => {
    const j = jrnByCtx[c.id];
    if (j && j.status === 'journey' && j.title && j.summary && j.keywords) return false;
    const need = !j || j.basedOnUpdatedAt !== c.updatedAt || !j.title || !j.summary || !j.keywords;
    if (need) pendingIds[c.id] = true;
    return need;
  });

  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });

  // Phase 2 markerGap：預算所有脈絡群心給「跨主題整合」分數用(對所有 status,
  // 因為整合對象可以是任何脈絡)。純 CPU,一次性。
  const centroidByCtxId = {};
  contextCentroids_(allContexts, recById).forEach(cc => { centroidByCtxId[cc.context.id] = cc.centroid; });

  let budget = maxCalls != null ? maxCalls : journeyDetectBudgetLeft_();
  let calls = 0, promoted = 0, watched = 0, dropped = 0;

  const out = [];
  // Carry forward journeys whose 脈絡 still exists (any status) and isn't being
  // re-judged; drop only those whose 脈絡 is truly gone.
  for (const j of existing) {
    if (!allCtxById[j.contextId]) { dropped++; continue; }
    if (pendingIds[j.contextId]) continue;  // recomputed below
    // 〔修「正在背景重新對齊」永遠卡住〕已凍結的 journey 不重判（升格只進不退），但仍把
    // basedOnUpdatedAt 對齊到目前 context.updatedAt——否則改歸/補一筆讓 updatedAt 變新後，
    // 網頁 pending（updatedAt > basedOnUpdatedAt）永遠 true、banner 不消、也無法定案。
    // 凍結＝這條的轉折判定本就是最終態（不會再自動變），對齊時間戳即可、不需再跑 LLM。
    if (j.status === 'journey') {
      const cu = allCtxById[j.contextId].updatedAt;
      if (cu && j.basedOnUpdatedAt !== cu) j.basedOnUpdatedAt = cu;
    }
    // Backfill markerGap：舊 watch 列沒算過的補上,純 CPU 不花 LLM。
    if (j.status === 'watch' && !j.markerGap) {
      const ctxObj = allCtxById[j.contextId];
      const recs = (ctxObj.recordIds || []).map(id => recById[id]).filter(Boolean);
      try {
        const gap = computeMarkerGap_(ctxObj, recs, centroidByCtxId);
        if (gap) j.markerGap = gap;
      } catch (e) { console.warn('markerGap backfill failed:', j.contextId, e && e.message); }
    }
    out.push(j);
  }

  for (const c of pending) {
    const prev = jrnByCtx[c.id];
    if (budget <= 0) { if (prev) out.push(prev); continue; }  // out of budget → keep prior
    const records = (c.recordIds || []).map(id => recById[id]).filter(Boolean);
    // Count each attempt up front (before the call) so a 脈絡 that errors every
    // time can't retry uncapped on every 5-min sweep — the daily cap bounds it.
    budget--; calls++; bumpJourneyDetect_();
    let res;
    try { res = detectContextMarkers_(c, records); }
    catch (e) {
      console.warn('journey detect failed', c.id, e && e.message);
      if (prev) out.push(prev);  // keep prior verdict on error
      continue;
    }
    // 升格只進不退：曾是 journey 的，即使這次沒抓到標記也保留歷程身分與原標記。
    // 但「孤兒轉折」（引用的記錄已不在本脈絡＝被移除或背景重新分群移走）要剔除，否則網頁
    // 會顯示對不上任何現存記錄的轉折。沿用 groundedMarkerTypes_／journeyKeySet_（與 ✕ 守門一致）。
    const wasJourney = prev && prev.status === 'journey';
    const groundedTypes = groundedMarkerTypes_(prev || {}, records);
    const keptPrev = wasJourney ? (prev.markers || []).filter(m => groundedTypes[m.type]) : [];
    const markers = res.markers.length ? res.markers : keptPrev;
    const nowIso = new Date().toISOString();
    const status = (markers.length || wasJourney) ? 'journey' : 'watch';
    const journeyRow = {
      id: prev ? prev.id : newId_(),
      createdAt: prev ? prev.createdAt : nowIso,
      updatedAt: nowIso,
      contextId: c.id,
      label: c.label,
      title: res.title || (prev && prev.title) || '',
      summary: res.summary || (prev && prev.summary) || '',
      keywords: res.keywords || (prev && prev.keywords) || null,
      markers: markers,
      status: status,
      basedOnUpdatedAt: c.updatedAt,
      keyRecordIds: (prev && prev.keyRecordIds) || []   // 保留「轉折關鍵」記錄(背景重判不可清掉)
    };
    if (status === 'watch') {
      try {
        const gap = computeMarkerGap_(c, records, centroidByCtxId);
        if (gap) journeyRow.markerGap = gap;
      } catch (e) { console.warn('markerGap compute failed:', c.id, e && e.message); }
    }
    out.push(journeyRow);
    if (markers.length) promoted++; else watched++;
  }

  // 寫回前再去一次重（同 cid 多條 → 留代表）；防呆萬一。
  const deduped = Object.values(journeysByContext_(out));
  saveJourneys_(scope, deduped);
  return {
    contexts: contexts.length,
    pending: pending.length,
    calls, promoted, watched, dropped,
    journeys: deduped.filter(j => j.status === 'journey').length
  };
}

// 4 個層級（敘事片段／主題群組／脈絡／歷程）共用同一套 keyword 字彙，避免「歷程
// 說教學/研究，底下主題群組卻冒出論文/課程開發」這種對不齊。預設大類由 LLM 從這份
// 清單擇一；自由細類(0-2 個 ≤6 字)則是貼近這條脈絡的具體名詞片語。改清單只需動
// 這裡。
const JOURNEY_KEYWORD_CATEGORIES = ['教學', '研究', '閱讀', '反思', '札記', '生活', '規劃', '隨想'];

/**
 * One Gemini call → a readable 標題 + 摘要 + keywords + the 轉折標記 present in
 * this 脈絡. Returns { title, summary, keywords:{category,tags}, markers: […] }.
 * 4 things piggy-back the same call (no extra round-trip) so cards show a concise
 * topic + summary + tags + transitions in one render pass.
 */
function detectContextMarkers_(context, records) {
  if (!records.length) return { title: '', summary: '', keywords: null, markers: [] };
  const sorted = records.slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(0, 40);
  const lines = sorted.map(r => {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
    const txt = ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
    return `[${d}][${typeLabel_(r.type)}] ${truncate_(txt, 200)}`;
  }).join('\n');

  const sys = '你是學習轉折偵測器。只根據提供的訊息判斷，不腦補、不臆測使用者沒寫的東西。嚴格輸出 JSON。';
  const prompt = [
    '以下是同一個「脈絡」內、依時間排序的訊息。',
    '先給標題、一句摘要、關鍵字，再逐一判定是否出現下列四種「學習轉折標記」：',
    '- 標題：≤14 字、具體可讀、像主題名而非句子，不要標點結尾、不要「關於」「我的」等贅詞。標題只描述脈絡的內容主題，嚴禁使用「偵測器」「轉折」「分析器」「助手」等工具或角色字眼，也不可照抄本指示的字詞。',
    '- 摘要：≤60 字、一句中文，客觀敘述這個脈絡裡發生了什麼學習／思考／行動（事實層面，不要主觀情緒詞、不要引用原文、不要重複標題、不要列點）。',
    `- 關鍵字：一個「大類」(必須從以下擇一：${JOURNEY_KEYWORD_CATEGORIES.join('／')}) + 0-2 個「細類」自由名詞片語(每個 ≤6 字、貼近這條脈絡實際在做什麼、不要與大類重複、不要動詞)。`,
    '- 概念重述：同一概念出現≥2次，後一次用自己的話重新表述（句法/用詞不同）並加入個人延伸。',
    '- 跨主題整合：主動把兩個原本分離的主題連起來（連結語句，或一句同時引用兩主題關鍵字）。',
    '- 行動指向：探問從「這是什麼」轉為含未來時態/決定的行動表述（我要…、預約了…、接下來該…）。',
    '- 後設反思：跳出當下任務、反思自己的學習狀態（我還在…階段、我是不是該…、我發現我一直在…）。',
    '',
    '只輸出 JSON（不要 markdown code fence、不要任何說明），格式：',
    '{"標題":"<≤14字主題標題>","摘要":"<≤60字一句摘要>","關鍵字":{"大類":"<8類擇一>","細類":["<≤6字>","<≤6字>"]},"概念重述":{"present":true,"evidence":"<引用實際原文>","confidence":0.0},"跨主題整合":{"present":false,"evidence":"","confidence":0.0},"行動指向":{"present":false,"evidence":"","confidence":0.0},"後設反思":{"present":false,"evidence":"","confidence":0.0}}',
    'present=false 的標記 evidence 留空字串。evidence 必須引用上面實際出現的文字，不可杜撰。',
    '',
    '訊息：',
    lines
  ].join('\n');

  const out = geminiGenerate_([{ text: prompt }], {
    systemInstruction: sys, temperature: 0.2, maxOutputTokens: 800
  }) || '';
  const json = extractJson_(out);
  if (!json) return { title: '', summary: '', keywords: null, markers: [] };
  const summary = truncate_(String(json['摘要'] || '').replace(/\s+/g, ' '), 80);
  const title = sanitizeJourneyTitle_(json['標題'], context, summary);
  // Keywords: 大類必須落在預設清單(否則丟掉)；細類去重、去贅、最多 2 個 ≤6 字。
  const kwRaw = json['關鍵字'] || {};
  const cat = JOURNEY_KEYWORD_CATEGORIES.indexOf(String(kwRaw['大類'] || '').trim()) >= 0 ? String(kwRaw['大類']).trim() : '';
  const tagsRaw = Array.isArray(kwRaw['細類']) ? kwRaw['細類'] : [];
  const seen = {}; if (cat) seen[cat] = true;
  const tags = [];
  for (const t of tagsRaw) {
    const v = truncate_(String(t || '').replace(/\s+/g, ''), 6);
    if (!v || seen[v]) continue;
    seen[v] = true;
    tags.push(v);
    if (tags.length >= 2) break;
  }
  const keywords = (cat || tags.length) ? { category: cat, tags: tags } : null;
  const nowIso = new Date().toISOString();
  const markers = [];
  for (const type of JOURNEY_MARKERS) {
    const m = json[type];
    if (m && m.present) {
      markers.push({
        type: type,
        evidence: truncate_(String(m.evidence || '').replace(/\s+/g, ' '), 200),
        confidence: clamp01_(m.confidence),
        detectedAt: nowIso
      });
    }
  }
  return { title: title, summary: summary, keywords: keywords, markers: markers };
}

/**
 * 標題消毒：LLM 偶爾把 system 人設（如「學習轉折偵測器」）或指示字眼當標題吐出來
 * （sys = 「你是學習轉折偵測器…」）。命中工具/角色字眼就丟掉，退回「主題化」後備：
 * 摘要首個子句 > 脈絡 label > 「未命名脈絡」。非空字串的後備保證 caller 的
 * `res.title || prev.title` 不會回退到舊的污染標題。
 */
function sanitizeJourneyTitle_(rawTitle, context, summary) {
  const t = String(rawTitle || '').replace(/\s+/g, ' ').replace(/[。！？，、.!?]+$/, '').trim();
  const looksLikePersona = !t || /轉折偵測|偵測器|分析器|^你是|系統指示|^json$/i.test(t);
  if (!looksLikePersona) return truncate_(t, 20);
  const fromSummary = String(summary || '').split(/[，。、；：\n]/)[0].trim();
  const fromLabel = String((context && (context.userTitle || context.label)) || '').replace(/\s+/g, ' ').trim();
  return truncate_(fromSummary || fromLabel, 16) || '未命名脈絡';
}

/* ============== Phase 3: 轉折成形卡 LLM (生題 + 評鑒) ============== */

/**
 * 〔融合診斷〕一次 LLM call,看脈絡代表片段,輸出:四種轉折各自「目前缺什麼」的具體診斷
 * + LLM 自己建議的起點 + 一句引導題目。取代主卡原本的 generateTransitionPrompt_(只給
 * 單一題目)+ 模板診斷——讓四項診斷都貼脈絡實況,並與 CPU markerGap 融合(caller 比對
 * 兩者是否一致)。
 *
 * 回 { diagnoses: {四項各一句}, suggest: '<type>', prompt: '<題目>' } 或 null。
 * ScriptCache 按 contextId+updatedAt+markerGapType 快取 24h。
 */
function diagnoseContextTransitions_(context, records, markerGapType) {
  if (!context) return null;
  const cacheKey = 'txdiag_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, context.id + '|' + (context.updatedAt || '') + '|' + (markerGapType || '')));
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (_) {} }

  const sorted = (records || []).slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-12);
  const lines = sorted.map(r => '· ' + truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), 80)).join('\n');
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];

  const sys = '你是學習轉折診斷師。看一條學習脈絡的代表片段,判斷它在四種轉折上各自「目前缺什麼」,並建議最該從哪一項開始補。嚴格輸出 JSON、繁體中文,不腦補沒寫的東西。';
  const prompt = [
    '四種轉折的意義:',
    '- 概念重述:用自己的話重講核心概念(不是複述)',
    '- 跨主題整合:把兩個原本分開的主題連起來',
    '- 行動指向:寫出含未來時態的具體下一步',
    '- 後設反思:跳出當下任務、觀察自己的學習狀態',
    '',
    `脈絡標題:${context.userTitle || context.label || ''}`,
    '代表片段:',
    lines,
    '',
    `系統依脈絡特徵初步判斷最該補的是「${markerGapType || '(未定)'}」,你可同意或不同意。`,
    '',
    '請完成:',
    '1. 對每一種轉折,用一句 ≤22 字的話說「這條目前在這項缺什麼」(貼這條的實際內容,不要空泛)。',
    '2. 建議最該從哪一項開始補(suggest,四項之一)。',
    '3. 給一句 ≤40 字的「建議題目」,引導使用者怎麼寫那一項。',
    '',
    '只輸出 JSON:{"概念重述":"<缺什麼>","跨主題整合":"<缺什麼>","行動指向":"<缺什麼>","後設反思":"<缺什麼>","建議":"<四項之一>","題目":"<引導>"}',
    '不要 markdown code fence、不要說明。'
  ].join('\n');

  let raw;
  try {
    bumpJourneyDetect_();
    raw = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.4, maxOutputTokens: 400 });
  } catch (e) { console.warn('diagnoseContextTransitions_ failed:', e && e.message); return null; }
  const json = extractJson_(raw || '');
  if (!json) return null;
  const diagnoses = {};
  TYPES.forEach(t => { diagnoses[t] = truncate_(String(json[t] || '').replace(/\s+/g, ' '), 40); });
  const suggest = TYPES.indexOf(String(json['建議'] || '').trim()) >= 0 ? String(json['建議']).trim() : (markerGapType || null);
  const promptText = truncate_(String(json['題目'] || '').replace(/\s+/g, ' '), 80);
  const result = { diagnoses: diagnoses, suggest: suggest, prompt: promptText };
  cache.put(cacheKey, JSON.stringify(result), 24 * 3600);
  return result;
}

/**
 * 根據 markerGap.type + 該脈絡 records 內容,生成「具體寫什麼」的引導句。
 * 不只「請寫一個行動指向」這種通用,而是「你問了 X、Y、Z 但都沒接下一步,試試...」
 * 這種貼著實際內容的提示。
 *
 * 回單句 ≤80 字。失敗回空字串(caller fallback 通用文案)。
 * 一次 Gemini call,結果由 ScriptCache 按 contextId+updatedAt 快取 24h——同一條
 * 脈絡內容沒變不重複算。
 */
function generateTransitionPrompt_(context, records, markerGap) {
  if (!context || !markerGap || !markerGap.type) return '';
  const cacheKey = 'txprompt_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, context.id + '|' + (context.updatedAt || '') + '|' + markerGap.type));
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const sorted = (records || []).slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(-12);   // 最近 12 筆當參考,避免 prompt 太長
  const lines = sorted.map(r => '· ' + truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), 80)).join('\n');

  const typeHint = {
    '概念重述': '請使用者用自己的話重講一次某個反覆出現的核心概念。指明是哪個概念。',
    '跨主題整合': '請使用者把這條脈絡跟另一條(如有)連起來。指明可能整合的對象主題。',
    '行動指向': '請使用者收斂幾個未閉合的探問句,寫出「下一步具體做什麼」。引出最該決定的事。',
    '後設反思': '請使用者跳出單純記錄,看自己累積了什麼、停在哪個階段。指出觀察很多但反思少的現象。'
  }[markerGap.type] || '請使用者寫一段反映這條脈絡學習進展的補充。';

  const sys = '你是學習轉折引導師。根據使用者的脈絡內容,生成「具體可寫」的單句引導,讓他知道該補什麼。不要重複指示,直接寫引導語。輸出純文字、繁體中文、≤80 字、一句完整中文(可含換行)。';
  const prompt = [
    `目標轉折類型:${markerGap.type}`,
    `引導方向:${typeHint}`,
    `提示:${markerGap.evidence || ''}`,
    '',
    `脈絡標題:${context.userTitle || context.label || ''}`,
    `脈絡內容(代表片段):`,
    lines,
    '',
    '請寫單句引導(≤80 字,繁體中文,直接給使用者看):'
  ].join('\n');

  let out;
  try {
    bumpJourneyDetect_();
    out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.5, maxOutputTokens: 200 });
  } catch (e) { console.warn('generateTransitionPrompt_ failed:', e && e.message); return ''; }
  const result = truncate_(String(out || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, ''), 120);
  if (result) cache.put(cacheKey, result, 24 * 3600);
  return result;
}

/**
 * 對使用者凝聚出的補充 draft 評鑒「對四種轉折類型的貢獻度」。
 *
 * v2:delegate 到 TransitionEval.gs 的 multi-signal composite scorer
 * (S1 LLM rubric with anchor exemplars + S2 結構特徵 regex)。
 * min(S1, S2) 確保 LLM 認定與結構特徵兩邊都過才算數,避免「我認為 X」這類空話
 * 靠 LLM 寬鬆過閘。校準與驗證見 Calibration.gs。
 */
function evaluateTransitionDraft_(draft, contextSummary) {
  return evaluateTransitionDraftComposite_(draft, contextSummary);
}

/** v1 留作備援(萬一新 composite 出問題,可在 Handlers.gs 改 caller 指回這版)。
 *  純 LLM 單信號、寬鬆,實機已證明會把「我認為 X」判 80%——不建議使用。 */
function evaluateTransitionDraftLegacyV1_(draft, contextSummary) {
  if (!draft) return null;
  const sys = '你是學習轉折評鑒員。對使用者的補充內容,獨立評估四種轉折類型的貢獻度。嚴格輸出 JSON、繁體中文。';
  const prompt = [
    '四種轉折的判定要點:',
    '- 概念重述:是否用自己的話講一個概念(不是引用)、是否含個人理解的延伸、措辭跟原文是否明顯不同。',
    '- 跨主題整合:是否同時提到兩個或以上主題、是否點出它們的關係(同一回事/相似/相對),不是只提一個主題的細節。',
    '- 行動指向:是否有未來時態的具體行動(我要、我會、下週、明天)+ 具體做什麼。空的決心(我應該努力)不算。',
    '- 後設反思:是否跳出當下任務、觀察自己處於哪個學習階段(我發現我一直在...、我還在 X 階段、原本以為 X 現在覺得 Y)。',
    '',
    `脈絡背景:${contextSummary || ''}`,
    '',
    '使用者補充:',
    draft,
    '',
    '對四種轉折分別評分(0~1,反映「對該轉折的具體性、完整度」,不是文字量)。',
    '選出最高分類型(topType)。若 topScore < 0.60,給「該類型還缺什麼」的提示(missingHint,簡短);若 topScore ≥ 0.60,missingHint 留空字串。',
    '只輸出 JSON,格式:{"scores":{"概念重述":0.x,"跨主題整合":0.x,"行動指向":0.x,"後設反思":0.x},"topType":"<類型名>","topScore":0.x,"missingHint":"..."}',
    '不要 markdown code fence、不要解說。'
  ].join('\n');

  let raw;
  try {
    bumpJourneyDetect_();
    raw = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.2, maxOutputTokens: 350 });
  } catch (e) { console.warn('evaluateTransitionDraftLegacyV1_ failed:', e && e.message); return null; }
  const json = extractJson_(raw || '');
  if (!json || !json.scores) return null;
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const scores = {};
  let topType = null, topScore = -1;
  for (const t of TYPES) {
    const s = clamp01_(json.scores[t]);
    scores[t] = s;
    if (s > topScore) { topScore = s; topType = t; }
  }
  if (json.topType && TYPES.indexOf(json.topType) >= 0) topType = json.topType;
  if (typeof json.topScore === 'number') topScore = clamp01_(json.topScore);
  const sum = TYPES.reduce((acc, t) => acc + scores[t], 0);
  return {
    scores: scores,
    topType: topType,
    topScore: topScore,
    sum: sum,
    missingHint: truncate_(String(json.missingHint || '').replace(/\s+/g, ' '), 80)
  };
}

/**
 * 〔Phase 3-B〕天花板鷹架:學習者寫了幾輪卻一直撞門檻時,bot 切換成「鷹架者」,
 * 給一個「可直接套用的句型骨架」幫他把已寫的內容收束成該轉折。形成性評量精神:
 * 過程中給支持,不只判分。**只給骨架/句型、不替他想內容**(留學習者填具體)。
 *
 * 回單句 ≤60 字(含一個帶 ___ 留白的句型),失敗回空字串。一次 Gemini call,只在
 * stuck 偵測命中時呼叫(頻率低)。
 */
function generateScaffoldHint_(draft, topType, contextSummary) {
  if (!draft || !topType) return '';
  const typeGuide = {
    '概念重述': '引導他把已寫的內容收束成「用自己的話講概念本質」。給一個帶留白的句型,例如「___對我來說,本質就是___」「___其實不是___,而是___」。',
    '跨主題整合': '引導他點出兩個主題的關係。給帶留白的句型,例如「___跟___其實是同一回事,因為___」「___跟___是一體兩面:前者___,後者___」。',
    '行動指向': '引導他把想法收束成具體下一步。給帶留白的句型,例如「下週起我會___,連續___,看___」。',
    '後設反思': '引導他跳出來看自己。給帶留白的句型,例如「我發現自己一直在___,卻很少___,我還停在___階段」。'
  }[topType] || '給一個帶留白的句型,幫他把內容收束成該轉折。';

  const sys = '你是學習鷹架引導師。學習者已經寫了一段、很努力但還沒收束成明確的學習轉折。你的任務不是評分、不是替他想內容,而是給「一個可直接套用、帶 ___ 留白的句型骨架」,讓他照填就能把已寫的內容收束成位。輸出純文字、繁體中文、≤60 字、只給句型(可含一句鼓勵),不要解釋。';
  const prompt = [
    `目標轉折:${topType}`,
    `引導方向:${typeGuide}`,
    `脈絡背景:${contextSummary || ''}`,
    '',
    '學習者已寫(內容很豐富、但還沒收束):',
    truncate_(draft, 300),
    '',
    '請給一個帶 ___ 留白的句型骨架(≤60 字),幫他把上面的內容收束成「' + topType + '」:'
  ].join('\n');

  let out;
  try {
    bumpJourneyDetect_();
    out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.5, maxOutputTokens: 150 });
  } catch (e) { console.warn('generateScaffoldHint_ failed:', e && e.message); return ''; }
  return truncate_(String(out || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, ''), 90);
}

/* ============== Phase 2: markerGap (純 CPU 算「最缺哪種轉折」) ============== */

/**
 * 對 status='watch' 的脈絡算 4 個轉折指標的分數,挑 top1 當「最可能的轉折候選」。
 * 之後 Phase 3 用 markerGap.type 生成具體題目、用 markerGap.evidence 給使用者看
 * 「為什麼是這種」。純 CPU、零 LLM。
 *
 *   - 概念重述:context.label 在 records 文字裡跨多個敘事片段重複出現 → 適合請重述
 *   - 跨主題整合:本脈絡群心對其他脈絡群心的 top1 cos 落在 0.40~0.65(夠近、但不同)
 *               → 有可整合的對象
 *   - 行動指向:探問句比例高 vs 未來動作句少 → 適合請寫下一步
 *   - 後設反思:span × visits 大、且 records 內反思詞少 → 適合請跳出來看自己
 *
 * 回 { type, score, scores, evidence, candidateId?, candidateLabel? }
 * 全部 < 0.2 時回 null(沒有明顯方向、Phase 3 退回通用 intro)。
 */
function computeMarkerGap_(context, records, centroidByCtxId) {
  if (!context || !records || !records.length) return null;
  const concept = scoreMarkerConcept_(context, records);
  const integ = scoreMarkerIntegration_(context, centroidByCtxId);
  const action = scoreMarkerAction_(records);
  const meta = scoreMarkerMeta_(context, records);
  const scores = {
    '概念重述': round2_(concept),
    '跨主題整合': round2_(integ.score),
    '行動指向': round2_(action),
    '後設反思': round2_(meta)
  };
  let topType = null, topVal = 0;
  for (const k in scores) if (scores[k] > topVal) { topVal = scores[k]; topType = k; }
  if (!topType || topVal < 0.2) return null;
  const out = {
    type: topType,
    score: topVal,
    scores: scores,
    evidence: markerGapEvidence_(topType, context, integ)
  };
  if (topType === '跨主題整合' && integ.candidate) {
    out.candidateId = integ.candidate.id;
    out.candidateLabel = integ.candidate.label || '';
  }
  return out;
}

/** 概念重述分數：脈絡名/userTitle 在 records 文字裡出現次數 + 跨多少敘事片段 */
function scoreMarkerConcept_(context, records) {
  const target = ((context.userTitle || context.label) || '').replace(/\s+/g, '').trim();
  if (!target || /^(未命名|未分類|思考與疑惑|日常對話|人際互動)/.test(target)) return 0;
  const matched = records
    .filter(r => r && r.ts && ((r.aggregatedText || r.text) || '').indexOf(target) >= 0)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (matched.length < 2) return matched.length * 0.1;
  let sessions = 1;
  for (let i = 1; i < matched.length; i++) {
    if (Date.parse(matched[i].ts) - Date.parse(matched[i - 1].ts) > EPISODE_GAP_MS) sessions++;
  }
  // matched=2,sess=1 → 0.5; matched=4,sess=3 → 0.9; matched≥6,sess≥4 → 1.0
  return Math.min(1, 0.2 + 0.1 * matched.length + 0.1 * sessions);
}

/** 跨主題整合分數：本脈絡群心對其他脈絡群心 top1 cos,落在 0.40~0.65 為甜蜜帶 */
function scoreMarkerIntegration_(context, centroidByCtxId) {
  const me = centroidByCtxId[context.id];
  if (!me) return { score: 0, candidate: null };
  let topCos = -1, topId = null;
  for (const cid in centroidByCtxId) {
    if (cid === context.id) continue;
    const s = cosineSim_(me, centroidByCtxId[cid]);
    if (s > topCos) { topCos = s; topId = cid; }
  }
  if (topCos < 0.4 || !topId) return { score: 0, candidate: null };
  // 0.40 → 0.50; 0.65 → 1.0; > 0.65 開始下滑(同領域而非整合對象)
  let score;
  if (topCos > 0.65) score = Math.max(0, 1 - (topCos - 0.65) * 4);
  else score = 0.5 + (topCos - 0.40) * 2;
  return { score: Math.min(1, score), candidate: { id: topId, cos: topCos } };
}

/** 行動指向分數：探問句多但未來動作句少 → 有「該決定下一步」的缺口 */
function scoreMarkerAction_(records) {
  if (!records.length) return 0;
  const qRe = /[?？]|為什麼|怎麼|是什麼|如何|哪一|該不該|要不要/;
  const aRe = /我要|我會|我打算|接下來|預約|明天|下週|下個月|計畫|將來|決定/;
  let q = 0, a = 0;
  for (const r of records) {
    const t = (r.aggregatedText || r.text) || '';
    if (qRe.test(t)) q++;
    if (aRe.test(t)) a++;
  }
  if (q < 2) return 0;
  const qRatio = q / records.length;
  const actionDeficit = Math.max(0, 1 - a / Math.max(1, q));
  return Math.min(1, qRatio * 1.5 * actionDeficit);
}

/** 後設反思分數：累積夠久夠多回返、但 record 內反思詞少 → 缺一個「跳出來看」的時機 */
function scoreMarkerMeta_(context, records) {
  const firstTs = Date.parse(context.firstTs || '') || 0;
  const lastTs = Date.parse(context.lastTs || '') || 0;
  if (!firstTs || !lastTs || lastTs <= firstTs) return 0;
  const spanDays = (lastTs - firstTs) / 86400000;
  const visits = (context.criteria || {}).returnVisits || 0;
  if (spanDays < 3 || visits < 3) return 0;
  const reflectRe = /我發現|我覺得|我意識|我突然|回頭看|現在想想|那時候|原本以為|沒想到/;
  let reflectCount = 0;
  for (const r of records) {
    if (reflectRe.test((r.aggregatedText || r.text) || '')) reflectCount++;
  }
  const alreadyReflective = reflectCount / Math.max(1, records.length);
  const base = Math.min(1, (spanDays / 14) * 0.5 + (visits / 6) * 0.5);
  return Math.max(0, base * (1 - alreadyReflective));
}

function markerGapEvidence_(type, context, integ) {
  const target = (context.userTitle || context.label || '這條脈絡').replace(/\s+/g, '');
  if (type === '概念重述') return `「${target}」反覆出現,可請你用自己的話再講一次`;
  if (type === '跨主題整合') return `跟另一條脈絡語意鄰近(cos ${(integ.candidate && integ.candidate.cos || 0).toFixed(2)}),可問你是不是同一回事`;
  if (type === '行動指向') return `多個探問還沒收尾,可請你寫「最具體的下一步」`;
  if (type === '後設反思') return `跨度長、回返多但反思詞少,可請你跳出來看自己學到什麼`;
  return '';
}

function round2_(x) { return Math.round((Number(x) || 0) * 100) / 100; }

/** Editor 一次性手術:把指定 context 的 journey 降回 watch、清 markers;
 *  選用 alsoRemoveLastRecord=true 同時移除該 context 最後一筆 record(假設是剛被
 *  「補一個轉折」流程推上去、引發假升格的那則),讓下次 detectJourneys_ 重判時
 *  不會吃進那則又重新升格。
 *
 *  Limitation:alsoRemoveLastRecord=true 只在「該 ctx 自從那次假升格後沒再加新成員」
 *  時安全(背景 sweep 可能會 reshuffle)。若不確定,先用 false 純降級看效果。
 *
 *  用法(editor):
 *    demoteJourneyToWatch('0dab82a2')          僅降級(萬一背景重判 + 仍有假 marker → 再執行)
 *    demoteJourneyToWatch('0dab82a2', true)    降級 + 移除該 ctx 最後一筆(這次用這個)
 */
function demoteJourneyToWatch(contextId, alsoRemoveLastRecord) {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const contexts = loadContexts_(scope);
  const c = contexts.find(x => x.id === contextId);
  if (!c) { console.log('no context for cid', contextId); return; }
  const journeys = loadJourneys_(scope);
  const j = journeys.find(x => x.contextId === contextId);
  if (!j) { console.log('no journey row for cid', contextId); return; }
  console.log(`before:「${j.title || j.label}」status=${j.status}, ${(j.markers||[]).length} markers`);
  j.status = 'watch';
  j.markers = [];
  j.basedOnUpdatedAt = '__demoted__';  // 下次 detect 會重判,但 record 已被清(若 alsoRemove)就不會抓到假 marker
  j.updatedAt = new Date().toISOString();
  saveJourneys_(scope, journeys);
  console.log(`after: status=watch, markers cleared`);
  if (alsoRemoveLastRecord && (c.recordIds || []).length) {
    const lastRid = c.recordIds[c.recordIds.length - 1];
    c.recordIds = c.recordIds.slice(0, -1);
    c.updatedAt = new Date().toISOString();
    saveContexts_(scope, contexts);
    console.log(`removed last record ${lastRid.slice(0,8)} from context.recordIds (該筆記錄本身仍在 embeddings.jsonl,可用 /recall 找到)`);
  }
  console.log('done — /journey 重看就不會有這條假歷程');
}

/** Editor diagnostic：列 OWNER 所有 watch 列的 markerGap 分布,給「最缺什麼」一個全景。
 *  跑之前先 runJourneyDetectNow() 強制重判一次,讓所有 watch 列都帶到最新 markerGap。
 *  ⚠️ 函式名不帶尾底線——Apps Script 編輯器只顯示非底線結尾的函式,底線版會被當私有。 */
function runMarkerGapReport() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const journeys = loadJourneys_(scope);
  const contexts = loadContexts_(scope);
  const ctxById = {}; contexts.forEach(c => { ctxById[c.id] = c; });
  const watches = journeys.filter(j => j.status === 'watch');
  const journeyRows = journeys.filter(j => j.status === 'journey');
  console.log(`watch ${watches.length} 條 / 已升格 journey ${journeyRows.length} 條`);
  const buckets = { '概念重述': [], '跨主題整合': [], '行動指向': [], '後設反思': [], '(無方向)': [] };
  for (const j of watches) {
    const c = ctxById[j.contextId];
    const name = (c && (c.userTitle || c.label)) || j.label || j.id.slice(0, 8);
    if (j.markerGap && j.markerGap.type) {
      buckets[j.markerGap.type].push({ name, score: j.markerGap.score, scores: j.markerGap.scores });
    } else {
      buckets['(無方向)'].push({ name, score: 0, scores: {} });
    }
  }
  for (const t in buckets) {
    const arr = buckets[t].sort((a, b) => b.score - a.score);
    if (!arr.length) continue;
    console.log(`\n[${t}] ${arr.length} 條:`);
    arr.forEach(x => {
      const sub = Object.keys(x.scores).map(k => `${k.slice(0,2)}${x.scores[k]}`).join(' ');
      console.log(`  ${x.score.toFixed(2)}  ${x.name}  (${sub})`);
    });
  }
}

/* ---- daily budget (script-wide, resets by calendar day in TIME_ZONE) ---- */
function journeyDetectDayKey_() {
  return 'journey_detect:' + Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}
function journeyDetectBudgetLeft_() {
  const used = parseInt(PropertiesService.getScriptProperties().getProperty(journeyDetectDayKey_()) || '0', 10);
  return Math.max(0, JOURNEY_DETECT_DAILY_MAX - used);
}
function bumpJourneyDetect_() {
  const props = PropertiesService.getScriptProperties();
  const key = journeyDetectDayKey_();
  props.setProperty(key, String(parseInt(props.getProperty(key) || '0', 10) + 1));
}

/** Parse a JSON object out of an LLM reply, tolerating code fences / prose. */
function extractJson_(text) {
  if (!text) return null;
  let s = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
  return null;
}

function clamp01_(x) {
  const n = Number(x);
  if (isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ─── 歷程後置合併：消除高度重疊的重複歷程 ──────────────────────────────── */

// k-means 把全語料切成「彼此不重疊」的群，所以同一個 sweep 跑出的兩條
// context.recordIds 之間 Jaccard 永遠為 0；只能用**語意群心**和時間訊號判定
// 「這兩條其實是同一件事被切開了」。閾值嚴格收：實測 0.85 strong + 50% 時間
// 重疊會把獨立的長期主題也吸進來（譬如「繪本+社群文化」吸進「國科會計畫」
// 變成 75 筆 33 天的怪物）。改為 0.90 + 短跨度限制，只合明確的同一事件
// 被切開的場景。
const JOURNEY_MERGE_CENTROID_STRONG = 0.90;
const JOURNEY_MERGE_CENTROID_SOFT = 0.82;
const JOURNEY_MERGE_LLM_GATE_MIN = 0.75;    // LLM 判定的最低觸發 cos（< 0.75 直接判定不同）
const JOURNEY_MERGE_TAG_JACCARD = 0.4;
const JOURNEY_MERGE_TIME_OVERLAP = 0.5;
const JOURNEY_MERGE_MAX_SPAN_SOFT_MS = 5 * 86400000;     // 5 days for soft path only
// Drift guard: refuse a merge if the target's centroid would shift more than
// this after absorbing the source. Pure geometry: post-merge centroid = weighted
// mean by record count. 0.04 ≈ 16° tilt — generous for true splits, tight enough
// to block "similar surface, drifts target into another topic". Strong path
// 不再用 span 雙重保險（會把 29 天跨度的同主題卡擋住合不回去），改由 drift
// guard 單獨負責「不能吸進不相關主題」的判斷。
const JOURNEY_MERGE_DRIFT_MAX = 0.04;
// 〔智慧合併·跨大類〕吸收候選進既有歷程時，同大類用一般門檻（0.75）；跨大類要 cosine「很高」才考慮
// （此 embedding 空間「相關」多落 0.55–0.75，故 0.85 已屬很高、是保守的預過濾），最終一律過 LLM
// 「同一主題?」gate 才真的合——避免誤判靠 LLM，cosine 只當門檻限縮 LLM 呼叫量。修「移出造新的重複主題
// 未併回既有」。待實測校準（太高＝該併的沒併；太低＝多花 LLM）。
const JOURNEY_ABSORB_CROSSCAT_COS = 0.85;
// 智慧合併「取消」的還原資料保留期：超過就從 meta 清掉（避免無限長）。14 天足夠回頭反悔。
const MERGE_UNDO_TTL_MS = 14 * 86400000;

/**
 * After detectJourneys_, scan all status='journey' entries pair-wise and
 * merge those that point at essentially the same learning thread — k-means
 * occasionally splits one coherent topic into 2–4 similar clusters because
 * Gemini embeddings have a narrow cosine band on short Chinese; without
 * post-merge, /journey shows 4 cards that are really one event.
 *
 * Decision (conservative — prefer leaving alone over wrong merges):
 *   - centroid cosine ≥ 0.85 AND time overlap ≥ 0.5  → strong, merge
 *   - centroid cosine ≥ 0.75 AND tags Jaccard ≥ 0.3 AND time overlap ≥ 0.5
 *                                                    → soft, merge
 *
 * Category is NOT a gate — LLM tags inconsistently (反思 vs 閱讀 for the
 * same event); centroid + time are the trustworthy signals.
 *
 * Merge target = the one with more records. Source is absorbed: recordIds
 * union, markers union (dedup by type+evidence), tags union capped at 3.
 * ALL merged-context records get pinned via meta.recordPins so the next
 * upgradeContexts_ k-means honors them as one cluster instead of
 * re-splitting (must-link via shared pin group key).
 *
 * Returns merge count.
 */
function mergeOverlappingJourneys_(scope) {
  return 0;   // 〔2026-06-11 改規則〕關閉 journey↔journey 自動合併——不再自動動到🌳學習歷程（再次併入新的不好）。
  // eslint-disable-next-line no-unreachable
  const contexts = loadContexts_(scope);
  const journeys = loadJourneys_(scope);
  const journeyRows = journeys.filter(j => j.status === 'journey');
  if (journeyRows.length < 2) return 0;

  const ctxById = {};
  contexts.forEach(c => { ctxById[c.id] = c; });
  // Load records once so we can build centroids per context.
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { if (r && r.embedding) recById[r.id] = r; });
  const centroidCache = {};
  const centroidOf = (ctxId) => {
    if (centroidCache[ctxId]) return centroidCache[ctxId];
    const c = ctxById[ctxId];
    if (!c) return null;
    const embs = (c.recordIds || []).map(id => recById[id]).filter(Boolean).map(r => r.embedding);
    if (!embs.length) return null;
    return (centroidCache[ctxId] = meanVector_(embs));
  };

  // Bigger journeys first → they become merge targets; smaller absorbed into them.
  journeyRows.sort((a, b) => {
    const aN = ((ctxById[a.contextId] || {}).recordIds || []).length;
    const bN = ((ctxById[b.contextId] || {}).recordIds || []).length;
    return bN - aN;
  });

  const absorbed = {};   // sourceContextId -> targetContextId
  const targetsHit = {}; // targetContextId -> true (which targets absorbed someone)
  for (let i = 0; i < journeyRows.length; i++) {
    if (absorbed[journeyRows[i].contextId]) continue;
    const targetJ = journeyRows[i];
    const targetCtx = ctxById[targetJ.contextId];
    if (!targetCtx) continue;
    let targetCentroid = centroidOf(targetCtx.id);
    if (!targetCentroid) continue;
    for (let j = i + 1; j < journeyRows.length; j++) {
      if (absorbed[journeyRows[j].contextId]) continue;
      const srcJ = journeyRows[j];
      const srcCtx = ctxById[srcJ.contextId];
      if (!srcCtx) continue;
      const srcCentroid = centroidOf(srcCtx.id);
      if (!srcCentroid) continue;
      if (!shouldMergeJourneyPair_(targetJ, targetCtx, targetCentroid, srcJ, srcCtx, srcCentroid)) continue;
      mergeJourneyPair_(targetJ, targetCtx, srcJ, srcCtx);
      absorbed[srcCtx.id] = targetCtx.id;
      targetsHit[targetCtx.id] = true;
      // Target centroid shifts after absorbing — invalidate the cache AND
      // re-fetch so the next inner iteration uses the updated centroid (not
      // the pre-merge one, which would be too permissive after target grows).
      delete centroidCache[targetCtx.id];
      targetCentroid = centroidOf(targetCtx.id) || targetCentroid;
    }
  }
  const mergeCount = Object.keys(absorbed).length;
  if (!mergeCount) return 0;

  // Persist: drop absorbed contexts/journeys, save the rest, pin all records
  // of the surviving merged contexts so k-means stays away from them next sweep.
  const survivingContexts = contexts.filter(c => !absorbed[c.id]);
  const survivingJourneys = Object.values(journeysByContext_(
    journeys.filter(j => !absorbed[j.contextId])
  ));
  saveContexts_(scope, survivingContexts);
  saveJourneys_(scope, survivingJourneys);
  updateChatMeta_(scope, m => {
    const pins = m.recordPins || {};
    for (const c of survivingContexts) {
      if (!targetsHit[c.id]) continue;
      const groupKey = `m:${c.id}`;
      for (const rid of (c.recordIds || [])) pins[rid] = groupKey;
    }
    m.recordPins = pins;
    return m;
  });
  console.log(`mergeOverlappingJourneys_: merged ${mergeCount} → ${Object.keys(targetsHit).length} targets`);
  return mergeCount;
}

function shouldMergeJourneyPair_(jA, ctxA, centroidA, jB, ctxB, centroidB) {
  // 同大類才考慮合併（新模型 block 5 之後 category 由 LLM 穩定判，可當硬閘）。
  // 跨類合併會讓 L0 大類筆數虛增（教學 91 vs r.category 真實 57，混入 34 筆其他類），
  // 且 context.category 失準。AI研習這種跨類學習線改為「同主題在各大類各自成卡」，
  // 使用者要合再用「📌 改歸主題」手動歸到同一條。
  if (themeNormCategory_(ctxA.category) !== themeNormCategory_(ctxB.category)) return false;
  const centroidSim = cosineSim_(centroidA, centroidB);
  // LLM gate 下限：低於此 cos 直接視為不同主題，省 LLM token 也省得錯合。
  if (centroidSim < JOURNEY_MERGE_LLM_GATE_MIN) return false;

  // 時間戳：strong / LLM path 不再用 time overlap 做守門（會擋住「同主題在新
  // 一天的延續」，譬如 30 天跨度 vs 1 天爆發的同主題卡）。soft fallback 仍需要。
  const aStart = Date.parse(ctxA.firstTs || '') || 0;
  const aEnd   = Date.parse(ctxA.lastTs  || '') || 0;
  const bStart = Date.parse(ctxB.firstTs || '') || 0;
  const bEnd   = Date.parse(ctxB.lastTs  || '') || 0;
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const maxSpan = Math.max(aEnd - aStart, bEnd - bStart);

  // Drift guard：即使其他關卡都過，若 target 群心吸進 source 後位移過大就拒合。
  // 純幾何，擋「相似但不同主題」的錯合（原本 0.85 過鬆造成雪球的場景就是它修掉的）。
  if (!passesDriftGuard_(centroidA, centroidB, ctxA, ctxB)) return false;

  // ⚠️ 原 strong path「cos ≥ 0.90 直接合、跳過 LLM」已移除（P1）：Gemini 短中文窄帶裡，
  // 同領域不同子題（formative vs 鷹架 vs 備課 vs 論文）的群心也常 ≥ 0.90 且 drift < 0.04，
  // 會在沒有 LLM 把關下無聲合併成巨無霸（154 筆教學 blob、密度跌到 0.57 的真因）。cosine 在
  // 窄帶無法分辨「同一條線被切碎」vs「同領域不同聚焦」——只有 LLM 能。故一律交給 LLM gate。

  // LLM concept gate：cos ≥ 0.75（drift 已過）一律問 Gemini 是不是「同一條學習線」。
  //   yes → 合（drift guard 已保護不會吸進不相關主題）
  //   no  → 不合
  //   null（額度用完 / LLM 錯） → 退回 soft path（cos≥0.82 + 時間重疊 + tags，最保守）
  const llmVerdict = checkSameThreadLLM_(jA, ctxA, jB, ctxB);
  if (llmVerdict === true) return true;
  if (llmVerdict === false) return false;

  // Soft path fallback（只在 LLM 不可用時跑）：要求 cos ≥ 0.82 + 時間重疊 + tags
  // + 短跨度——LLM 不在時用最保守的多訊號共識守住。
  if (centroidSim < JOURNEY_MERGE_CENTROID_SOFT) return false;
  const overlapMs = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const minSpan = Math.max(1, Math.min(aEnd - aStart, bEnd - bStart));
  if ((overlapMs / minSpan) < JOURNEY_MERGE_TIME_OVERLAP) return false;
  if (maxSpan > JOURNEY_MERGE_MAX_SPAN_SOFT_MS) return false;
  const tagsA = new Set(((jA.keywords && jA.keywords.tags) || []));
  const tagsB = new Set(((jB.keywords && jB.keywords.tags) || []));
  let tagInter = 0;
  tagsB.forEach(t => { if (tagsA.has(t)) tagInter++; });
  const tagUnion = tagsA.size + tagsB.size - tagInter;
  const tagJaccard = tagUnion > 0 ? tagInter / tagUnion : 0;
  return tagJaccard >= JOURNEY_MERGE_TAG_JACCARD;
}

function passesDriftGuard_(centroidA, centroidB, ctxA, ctxB) {
  const nA = (ctxA.recordIds || []).length;
  const nB = (ctxB.recordIds || []).length;
  if (!nA || !nB) return false;
  const total = nA + nB;
  const dim = centroidA.length;
  const post = new Array(dim);
  for (let i = 0; i < dim; i++) post[i] = (centroidA[i] * nA + centroidB[i] * nB) / total;
  return cosineSim_(centroidA, post) >= (1 - JOURNEY_MERGE_DRIFT_MAX);
}

/**
 * LLM concept gate：cos 落在 0.82~0.90「邊緣相似」帶時，問 Gemini 兩條歷程是不是
 * 同一條學習線。回傳 true / false / null（額度用完／LLM 錯，由 caller 退回 soft path）。
 *
 * 用既有的 journeyDetect 每日額度（JOURNEY_DETECT_DAILY_MAX），上限額度共用。
 * 結果用 ScriptCache 以 (排序後 id 對 + updatedAt 戳記) 為 key 快取 7 天——
 * 內容沒變的同一對不重複呼叫；任一邊更新後 cache key 自動換掉、會重判。
 */
function checkSameThreadLLM_(jA, ctxA, jB, ctxB) {
  const ids = [jA.id, jB.id].sort();
  const stamps = (jA.updatedAt || '') + '|' + (jB.updatedAt || '');
  const cacheKey = 'jmlm_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, ids[0] + '_' + ids[1] + '|' + stamps));
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached === 'yes') return true;
  if (cached === 'no') return false;

  if (journeyDetectBudgetLeft_() <= 0) return null;

  const titleA = jA.title || jA.label || '';
  const titleB = jB.title || jB.label || '';
  const summA = jA.summary || '';
  const summB = jB.summary || '';
  const tagsA = ((jA.keywords && jA.keywords.tags) || []).join('、');
  const tagsB = ((jB.keywords && jB.keywords.tags) || []).join('、');
  const markersA = (jA.markers || []).map(m => m.type).join('、');
  const markersB = (jB.markers || []).map(m => m.type).join('、');

  const sys = '你是學習歷程審視者。判斷兩條歷程是否同一條學習線。嚴格輸出 JSON。';
  const prompt = [
    '請判斷以下兩條學習歷程是否屬於「同一條學習線」。',
    '',
    '同主題的「不同階段／不同側面／被切碎的片段」 → same=true',
    '譬如「教學評量設計」和「評量結果分析」是同一條（評量這件事）。',
    '譬如「形成性評量上週的試做」和「形成性評量這週的觀察」是同一條。',
    '',
    '同主題但「聚焦點不同」、或表面詞彙相似但「領域不同」 → same=false',
    '譬如「教學設計」vs「教學評量」（同類但是不同事）。',
    '譬如「教學用 AI」vs「政府用 AI」（領域不同）。',
    '譬如「繪本教學」vs「繪本兒童心理」（角度不同）。',
    '',
    `歷程 A：「${titleA}」`,
    `  摘要：${summA}`,
    `  關鍵字：${tagsA}`,
    `  轉折：${markersA}`,
    '',
    `歷程 B：「${titleB}」`,
    `  摘要：${summB}`,
    `  關鍵字：${tagsB}`,
    `  轉折：${markersB}`,
    '',
    '輸出 JSON：{"same": true/false, "reason": "<≤20 字理由>"}',
    '不要 markdown code fence、不要說明。'
  ].join('\n');

  let raw;
  try {
    bumpJourneyDetect_();
    raw = geminiGenerate_([{ text: prompt }], {
      systemInstruction: sys, temperature: 0.1, maxOutputTokens: 200
    });
  } catch (e) {
    console.warn('LLM merge gate failed:', e && e.message);
    return null;
  }
  const json = extractJson_(raw || '');
  if (!json || typeof json.same !== 'boolean') return null;

  const verdict = json.same === true;
  cache.put(cacheKey, verdict ? 'yes' : 'no', 7 * 86400);
  console.log(`  LLM gate: 「${truncate_(titleA, 16)}」 vs 「${truncate_(titleB, 16)}」 → ${verdict ? 'SAME' : 'DIFF'}（${json.reason || ''}）`);
  return verdict;
}

function mergeJourneyPair_(targetJ, targetCtx, srcJ, srcCtx) {
  const ids = new Set((targetCtx.recordIds || []).concat(srcCtx.recordIds || []));
  targetCtx.recordIds = Array.from(ids);
  if (srcCtx.firstTs && (!targetCtx.firstTs || srcCtx.firstTs < targetCtx.firstTs)) targetCtx.firstTs = srcCtx.firstTs;
  if (srcCtx.lastTs && (!targetCtx.lastTs || srcCtx.lastTs > targetCtx.lastTs)) targetCtx.lastTs = srcCtx.lastTs;
  const nowIso = new Date().toISOString();
  targetCtx.updatedAt = nowIso;
  // Markers union, dedup by type + first 40 chars of evidence.
  const seen = {};
  const merged = [];
  for (const m of (targetJ.markers || []).concat(srcJ.markers || [])) {
    if (!m) continue;
    const key = (m.type || '') + '|' + ((m.evidence || '').slice(0, 40));
    if (seen[key]) continue;
    seen[key] = true;
    merged.push(m);
  }
  targetJ.markers = merged;
  // Keywords: keep target's category, union tags up to 3.
  if (targetJ.keywords && srcJ.keywords) {
    const tags = new Set((targetJ.keywords.tags || []).concat(srcJ.keywords.tags || []));
    targetJ.keywords.tags = Array.from(tags).slice(0, 3);
  }
  targetJ.updatedAt = nowIso;
}

/**
 * 候選 → 既有歷程的「自動融入」。使用者持續記寫同一主題時，新成形的進行中脈絡
 * （還沒升格成歷程的）若跟某條既有歷程是「同一條學習線」，就吸進那條歷程，而不是
 * 另開一張平行卡。這實現「一條學習線持續累積」的初衷。
 *
 * 對每個進行中脈絡（contexts 裡沒有對應 status='journey' 的）：
 *   1. 找群心 cosine 最高的既有歷程；< LLM gate 下限就跳過
 *   2. drift guard：吸進去不能把該歷程的概念拉太遠
 *   3. LLM 守門員：兩者是不是同一條學習線（候選端用 label + 代表片段當描述）
 *   過三關 → 候選 records 併入該歷程的脈絡、pin 成 m:（k-means 不再拆開）、
 *   清掉該歷程的 summary 逼下次 detectJourneys_ 重生標題/摘要/轉折（納入新內容）。
 *
 * 回傳吸收的候選數。
 */
function absorbCandidatesIntoJourneys_(scope) {
  const contexts = loadContexts_(scope);
  const journeys = loadJourneys_(scope);
  const isJourneyCtx = {};
  journeys.filter(j => j.status === 'journey').forEach(j => { isJourneyCtx[j.contextId] = true; });
  const ctxById = {};
  contexts.forEach(c => { ctxById[c.id] = c; });

  // 〔2026-06-11 改規則〕可合併池＝非學習歷程的脈絡（🌱進行中脈絡＋🌿候選歷程）。**絕不碰🌳學習歷程**。
  const pool = contexts.filter(c => !isJourneyCtx[c.id] && (c.recordIds || []).length >= 1);
  if (pool.length < 2) return 0;

  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { if (r && r.embedding) recById[r.id] = r; });
  const centroidOf = (ctx) => {
    const e = (ctx.recordIds || []).map(id => recById[id]).filter(Boolean).map(r => r.embedding);
    return e.length ? meanVector_(e) : null;
  };
  const sigOf = (c) => themeNormCategory_(c.category) + '|' + (c.label || c.topicLabel || '');
  // 使用者按過「取消這次合併」的還原紀錄：含這些 record 不再自動併回同一目標（以 target 主題簽名為鍵，穩定）。
  const mergeExclude = loadChatMeta_(scope).mergeExclude || {};

  const absorbedCtxIds = {};   // source ctxId -> target ctxId
  const mergeEvents = [];      // 真的合併的每一筆：供「主動告知＋一鍵取消」用
  // 少筆併入多筆：source 由小到大；target 必須筆數更多、且偏好🌿候選歷程(status='context')。
  const sources = pool.slice().sort((a, b) => (a.recordIds || []).length - (b.recordIds || []).length);
  for (const cand of sources) {
    if (journeyDetectBudgetLeft_() <= 0) break;   // LLM gate 吃共用每日上限，封頂
    if (absorbedCtxIds[cand.id]) continue;
    const candCent = centroidOf(cand);
    if (!candCent) continue;
    const candN = (cand.recordIds || []).length;
    // 找同一條線、筆數更多的非歷程脈絡當目標。同大類：一般門檻；跨大類：cosine 極高才考慮；
    // 兩者都一律過下方 LLM「同一主題?」gate 才真的合（避免誤判）。
    let best = null, bestScore = -1;
    for (const tc of pool) {
      if (tc.id === cand.id || absorbedCtxIds[tc.id]) continue;
      if ((tc.recordIds || []).length <= candN) continue;                       // 少筆併入多筆
      if (recordExcludedFromJourney_(mergeExclude, cand.recordIds, sigOf(tc))) continue;  // 使用者取消過
      const cent = centroidOf(tc);
      if (!cent) continue;
      const sim = cosineSim_(candCent, cent);
      const sameCat = themeNormCategory_(tc.category) === themeNormCategory_(cand.category);
      const minSim = sameCat ? JOURNEY_MERGE_LLM_GATE_MIN : JOURNEY_ABSORB_CROSSCAT_COS;
      if (sim < minSim) continue;
      const score = sim + (tc.status === 'context' ? 0.05 : 0);                  // 偏好🌿候選歷程為目標
      if (score > bestScore) { bestScore = score; best = { tc, cent }; }
    }
    if (!best) continue;
    if (!passesDriftGuard_(best.cent, candCent, best.tc, cand)) continue;
    bumpJourneyDetect_();
    const verdict = checkSameThreadLLM_(
      pseudoJourneyForContext_(best.tc, recById), best.tc,
      pseudoJourneyForContext_(cand, recById), cand);
    if (verdict !== true) continue;

    // 吸收：source records 併入 target 脈絡，延伸時間範圍。**target 名稱(label)不變**。
    const ids = new Set((best.tc.recordIds || []).concat(cand.recordIds || []));
    best.tc.recordIds = Array.from(ids);
    if (cand.firstTs && (!best.tc.firstTs || cand.firstTs < best.tc.firstTs)) best.tc.firstTs = cand.firstTs;
    if (cand.lastTs && (!best.tc.lastTs || cand.lastTs > best.tc.lastTs)) best.tc.lastTs = cand.lastTs;
    best.tc.updatedAt = new Date().toISOString();
    absorbedCtxIds[cand.id] = best.tc.id;
    // 記下這筆合併的細節，供 backgroundSweep 之後主動推卡告知＋一鍵取消。priorLabels 取自
    // recById（合併前的 (大類,議題)），是取消時的還原依據。
    const priorLabels = {};
    (cand.recordIds || []).forEach(rid => {
      const r = recById[rid];
      if (r) priorLabels[rid] = { category: r.category || '', topicLabel: r.topicLabel || '' };
    });
    mergeEvents.push({
      token: 'mg' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      targetCtxId: best.tc.id,
      targetTopicLabel: best.tc.label || '',
      targetCategory: themeNormCategory_(best.tc.category),
      targetSigRaw: (best.tc.category || '') + '|' + (best.tc.label || ''),   // /themes ✨/註記 鍵（與 makeContextFreshFn_ 同式：原始 category|label）
      candTitle: truncate_((cand.userTitle || cand.label || '未命名'), 24),
      targetTitle: truncate_((best.tc.userTitle || best.tc.label || '未命名'), 24),
      candCategory: themeNormCategory_(cand.category),
      sameCat: themeNormCategory_(best.tc.category) === themeNormCategory_(cand.category),
      movedRecordIds: (cand.recordIds || []).slice(),
      unionRecordIds: Array.from(ids),   // 合併後整個群（目標原成員＋移入）——pin 要釘全群才固定得住
      priorLabels: priorLabels
    });
  }

  const absorbed = Object.keys(absorbedCtxIds).length;
  if (!absorbed) return 0;

  // 持久化：丟掉被吸收的 source 脈絡；target 脈絡留著（名稱不變）。🌳學習歷程完全不動、不存。
  const survivingContexts = contexts.filter(c => !absorbedCtxIds[c.id]);
  saveContexts_(scope, survivingContexts);
  updateChatMeta_(scope, m => {
    const pins = m.recordPins || {};
    const undo = m.pendingMergeUndo || {};
    const notices = (m.pendingMergeNotices || []).slice();
    const noteMap = m.contextMergeNotes || {};      // target sig -> { from:[最近幾個來源], ts }（/themes 標註）
    const fresh = m.rehomedSignatures || {};        // /themes ✨
    // 清掉過期的取消還原資料（>MERGE_UNDO_TTL_MS），免得 meta 無限長。
    const cutoff = Date.now() - MERGE_UNDO_TTL_MS;
    for (const tk in undo) { if (!undo[tk] || (undo[tk].ts || 0) < cutoff) delete undo[tk]; }
    const sameIdSet_ = (a, b) => {
      if (!a || !b || a.length !== b.length) return false;
      const s = {}; a.forEach(x => { s[x] = true; });
      return b.every(x => s[x]);
    };
    for (const ev of mergeEvents) {
      const sig = ev.targetSigRaw;   // /themes 註記＋✨ 鍵（與 makeContextFreshFn_ 同式）
      // 〔去重〕同一組 record→同一 target 的舊 pending token 先收掉，通知卡不重複。
      for (const tk of Object.keys(undo)) {
        if (undo[tk] && undo[tk].targetCtxId === ev.targetCtxId &&
            sameIdSet_(undo[tk].movedRecordIds, ev.movedRecordIds)) {
          delete undo[tk];
          const i = notices.indexOf(tk); if (i >= 0) notices.splice(i, 1);
        }
      }
      // pin 釘「合併後整個群」同一把 m: 鍵（固定住、免無限重併）。
      const pinIds = ev.unionRecordIds || ev.movedRecordIds;
      const priorPins = {};
      pinIds.forEach(rid => { priorPins[rid] = pins[rid] || null; });   // 先存合併前的 pin（取消時還原）
      pinIds.forEach(rid => { pins[rid] = `m:${ev.targetCtxId}`; });
      undo[ev.token] = {
        ts: Date.now(),
        candTitle: ev.candTitle, targetTitle: ev.targetTitle,
        candCategory: ev.candCategory, targetCategory: ev.targetCategory, sameCat: ev.sameCat,
        targetCtxId: ev.targetCtxId, targetTopicLabel: ev.targetTopicLabel,
        movedRecordIds: ev.movedRecordIds,
        pinnedRecordIds: pinIds.slice(),
        priorLabels: ev.priorLabels, priorPins: priorPins
      };
      notices.push(ev.token);
      // /themes：被併入的目標脈絡標註「何時·併入了誰」＋亮 ✨（rehomedSignatures）。
      const note = noteMap[sig] || { from: [], ts: 0 };
      note.from = (note.from || []).concat([ev.candTitle]).slice(-5);
      note.ts = Date.now();
      noteMap[sig] = note;
      fresh[sig] = Date.now();
    }
    m.recordPins = pins;
    m.pendingMergeUndo = undo;
    m.pendingMergeNotices = notices;
    m.contextMergeNotes = noteMap;
    m.rehomedSignatures = fresh;
    // 〔重併哨兵·免 editor 自檢〕記每筆合併的指紋（同一組 record→同一 target）。n≥2 ＝沒固定住、迴圈還在。
    const rep = m.mergeRepeatLog || {};
    for (const ev of mergeEvents) {
      const fp = ev.targetCtxId + '|' + ev.movedRecordIds.slice().sort().join(',');
      rep[fp] = { n: ((rep[fp] && rep[fp].n) || 0) + 1, lastAt: Date.now(), t: `${ev.candTitle}→${ev.targetTitle}` };
    }
    const repKeys = Object.keys(rep).sort((a, b) => (rep[b].lastAt || 0) - (rep[a].lastAt || 0));
    repKeys.forEach((k, i) => { if (i >= 40 || Date.now() - (rep[k].lastAt || 0) > 14 * 86400000) delete rep[k]; });
    m.mergeRepeatLog = rep;
    return m;
  });
  // 把被吸收 records 的 (大類, 議題) 對齊到 target 脈絡（target 名稱即其 label；keepPins=true 不清剛下的 m: pin）。
  for (const candId in absorbedCtxIds) {
    const tc = ctxById[absorbedCtxIds[candId]], cand = ctxById[candId];
    if (!tc || !cand || !tc.category || !tc.label) continue;
    try { setRecordsCategoryTopic_(scope, cand.recordIds || [], tc.category, tc.label, true); } catch (_) {}
  }
  console.log(`absorbCandidatesIntoJourneys_(脈絡版): 合併 ${absorbed} 條（少筆併入多筆、不碰學習歷程）`);
  return absorbed;
}

/** 使用者按過「取消這次合併」後，這些 record 對該歷程設了 mergeExclude；背景智慧合併再遇到含這些
 *  record 的候選、目標又是同一條歷程時直接跳過、不再自動併回。以「歷程 id（穩定）＋ record id」為鍵，
 *  撐得過背景重分群（脈絡 id 會變、歷程 id 不變）。 */
function recordExcludedFromJourney_(mergeExclude, rids, jid) {
  if (!mergeExclude) return false;
  for (const rid of (rids || [])) { const e = mergeExclude[rid]; if (e && e[jid]) return true; }
  return false;
}

/**
 * 背景智慧合併（absorbCandidatesIntoJourneys_）真的併了東西時，主動推一張 Flex 卡告知每筆合併的
 * 細節（哪條重複主題併進哪條歷程、移入幾筆、是否跨大類），每筆附「↩️ 取消這次合併」一鍵還原
 * （undoJourneyMerge_）。對齊使用者「機器自動動了我的資料就要看得見、且可反悔」。資料來源＝absorb
 * 寫進 meta 的 pendingMergeNotices（token 清單）＋ pendingMergeUndo（細節）。掛在 backgroundSweep
 * 的 absorb 之後；不在合併當下推（沿用「背景處理、稍後告知」的節奏）。
 */
function notifyMergedJourneys_(scope) {
  if (!scope || scope.type !== 'user' || !scope.id) return;
  // 〔合宜〕reorg 通知也等停筆、不打斷寫作；再過全域守門（靜默窗/總開關/全域冷卻）。待推的 notices
  // 不清、保留到下輪——所以延後不丟失。
  if (!userSettledForReorg_(scope)) return;
  if (!proactivePushAllowed_(scope)) return;
  const meta = loadChatMeta_(scope);
  const undo = meta.pendingMergeUndo || {};
  const allTokens = (meta.pendingMergeNotices || []).filter(t => t && undo[t]);
  // 〔修·卡內重複〕同一組 record→同一歷程只顯示最新一列（背景重跑殘留的舊 token 不重複出現）。
  const seenKey = {};
  const tokens = [];
  for (let i = allTokens.length - 1; i >= 0; i--) {
    const u = undo[allTokens[i]];
    const k = (u.targetCtxId || u.targetJourneyId || '') + '|' + ((u.movedRecordIds || []).slice().sort().join(','));
    if (seenKey[k]) continue;
    seenKey[k] = true; tokens.unshift(allTokens[i]);
  }
  if (!tokens.length) {
    if ((meta.pendingMergeNotices || []).length) updateChatMeta_(scope, m => { m.pendingMergeNotices = []; return m; });
    return;
  }
  const show = tokens.slice(0, 20);   // 通知必須完整：列全部（極端多才截 20，附「另有 N」）。
  const body = [
    { type: 'text', text: `背景把 ${tokens.length} 條相似主題併入既有脈絡`, size: 'sm', weight: 'bold', color: THEME.ink, wrap: true },
    { type: 'text', text: '只在「進行中脈絡／候選歷程」之間聚合（少筆併入多筆、不動已成形的學習歷程）；併錯可一鍵取消、各自還原。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
  ];
  const repLog = meta.mergeRepeatLog || {};
  show.forEach(tk => {
    const u = undo[tk];
    const catNote = u.sameCat ? '' : ` · 跨大類 ${u.candCategory}→${u.targetCategory}`;
    let whenNote = ''; try { whenNote = u.ts ? ` · ${relativeAgoText_(new Date(u.ts).toISOString())}` : ''; } catch (_) {}
    // 〔重併哨兵〕同一組第 N 次合併（N≥2）＝上次沒固定住——直接在卡上亮警示，免 editor 自檢。
    const fp = (u.targetCtxId || u.targetJourneyId || '') + '|' + ((u.movedRecordIds || []).slice().sort().join(','));
    const repN = (repLog[fp] && repLog[fp].n) || 0;
    body.push({ type: 'separator', margin: 'lg' });
    body.push({
      type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: `「${u.candTitle}」`, size: 'sm', weight: 'bold', color: THEME.ink, wrap: true },
        { type: 'text', text: `↳ 併入「${u.targetTitle}」（名稱不變）`, size: 'xs', color: THEME.textBody, wrap: true },
        { type: 'text', text: `移入 ${(u.movedRecordIds || []).length} 筆${whenNote}${catNote}`, size: 'xxs', color: THEME.muted, wrap: true },
        ...(repN >= 2 ? [{ type: 'text', text: `⚠️ 同一組第 ${repN} 次合併——上次沒固定住，請截圖回報`, size: 'xxs', color: THEME.danger, weight: 'bold', wrap: true }] : []),
        { type: 'box', layout: 'vertical', margin: 'sm', paddingAll: 'sm', cornerRadius: 'md', borderWidth: '1px', borderColor: THEME.cta,
          action: { type: 'postback', label: '取消這次合併', data: `action=merge_undo&t=${tk}`, displayText: opEcho_('取消合併', u.candTitle) },
          contents: [{ type: 'text', text: '↩️ 取消這次合併', size: 'xs', weight: 'bold', color: THEME.cta, align: 'center' }] }
      ]
    });
  });
  if (tokens.length > show.length) {
    body.push({ type: 'text', text: `…另有 ${tokens.length - show.length} 條（下一輪續推）`, size: 'xxs', color: THEME.muted, margin: 'md', wrap: true });
  }
  const bubble = {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🔔 背景自動整理', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: '🔀 背景智慧合併', size: 'md', weight: 'bold', color: THEME.onDark, margin: 'xs' }
      ] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{ type: 'text', text: '不動作＝保留合併；之後也能在主題詳情手動改歸。', size: 'xxs', color: THEME.muted, wrap: true }] }
  };
  try { linePushFlex_(scope.id, `🔀 背景把 ${tokens.length} 條相似主題併入既有脈絡（可取消）`, bubble); }
  catch (e) { console.warn('notifyMergedJourneys_ push failed:', e && e.message); return; }
  markProactivePush_(scope);   // 餵全域冷卻（一輪一張）
  updateChatMeta_(scope, m => { m.pendingMergeNotices = []; return m; });
}

/**
 * 取消一次背景智慧合併（還原）：把被吸收的 records 還原成合併前的 (大類, 議題) 與 pin，並對該歷程
 * 設 mergeExclude（背景不再自動把這些 record 併回同一條歷程，撐得過重分群），最後放行立即重新整理
 * （maybeUpgradeContexts_）→ 被併走的主題當下重新自成一條、目標縮回。回 {ok, candTitle, targetTitle, n}。
 * 不需手動改 contexts.jsonl：脈絡成員由 record 的 (大類,議題)+pin 決定，upgradeContexts_ 依還原後標籤重算。
 */
function undoJourneyMerge_(scope, token) {
  const meta = loadChatMeta_(scope);
  const u = (meta.pendingMergeUndo || {})[token];
  if (!u) return { ok: false, reason: 'gone' };
  const moved = u.movedRecordIds || [];
  const priorLabels = u.priorLabels || {};

  // 1) 還原每筆的 (大類, 議題)（topicLock；keepPins＝true，pin 由下面自己還原）。罕見的「合併前無
  //    議題」→ 清掉 topicLabel，讓背景重判、不要再黏在目標主題。
  const groups = []; const toClear = [];
  moved.forEach(rid => {
    const pl = priorLabels[rid] || {};
    if (!pl.topicLabel) { toClear.push(rid); return; }
    let g = groups.find(x => x.cat === (pl.category || '') && x.topic === pl.topicLabel);
    if (!g) { g = { cat: pl.category || '', topic: pl.topicLabel, rids: [] }; groups.push(g); }
    g.rids.push(rid);
  });
  groups.forEach(g => { try { setRecordsCategoryTopic_(scope, g.rids, g.cat || '其他', g.topic, true); } catch (_) {} });
  toClear.forEach(rid => { try { clearRecordTopicForRehome_(scope, rid); } catch (_) {} });

  // 2) 還原 pin（移除 must-link 到目標）＋ 設 mergeExclude（防背景再自動併回同一歷程）＋ 用掉 token ＋
  //    放行立即重分群（同「移出找新家」）。
  updateChatMeta_(scope, m => {
    const pins = m.recordPins || {};
    const priorPins = u.priorPins || {};
    // 還原「當時被釘的全部」（新版＝合併後整群；舊 token 無 pinnedRecordIds → 退回 moved）。
    (u.pinnedRecordIds || moved).forEach(rid => { if (priorPins[rid]) pins[rid] = priorPins[rid]; else delete pins[rid]; });
    m.recordPins = pins;
    // 取消還原鍵：新版用 target 主題簽名（穩定，撐得過重分群）；舊 token 退回 targetJourneyId。
    const exKey = u.targetTopicLabel != null ? ((u.targetCategory || '') + '|' + u.targetTopicLabel) : u.targetJourneyId;
    const ex = m.mergeExclude || {};
    moved.forEach(rid => { (ex[rid] = ex[rid] || {})[exKey] = true; });
    m.mergeExclude = ex;
    const undo = m.pendingMergeUndo || {}; delete undo[token]; m.pendingMergeUndo = undo;
    m.pendingMergeNotices = (m.pendingMergeNotices || []).filter(t => t !== token);
    m.lastContextUpgradeAt = null;
    m.lastClassifyAt = new Date().toISOString();
    return m;
  });

  // 〔同名硬分開〕還原標籤後，若被取消的 records 與目標歷程的脈絡同 (大類, 議題)，純還原會被
  //  group-by 又聚回去（mergeExclude 只擋自動 absorb、擋不了同標籤分群）→ 取消看起來「沒效果」。
  //  此時把它們改名 + 釘 must-not-link 封閉群（同 handleContextSplit_ 的分出群做法），讓它們真的
  //  自成一條、看得出分開了。沿用合併當下記下的精確邊界（movedRecordIds），比 embedding 子分群準。
  let forcedSplit = '';
  try {
    const tCat = u.targetCategory || '';
    const tTopic = (u.targetTopicLabel != null) ? u.targetTopicLabel : '';
    if (tTopic && moved.length) {
      const collide = moved.some(rid => {
        const pl = priorLabels[rid] || {};
        return (pl.category || '') === tCat && (pl.topicLabel || '') === tTopic;
      });
      if (collide) {
        let newLabel = (u.candTitle && u.candTitle !== tTopic) ? u.candTitle : (tTopic + '（分出）');
        newLabel = truncate_(newLabel, 14);
        setRecordsCategoryTopic_(scope, moved, tCat, newLabel);   // 改名（會清舊 pin，故先做）
        const spunG = newId_();
        updateChatMeta_(scope, m => { const p = m.recordPins || {}; moved.forEach(rid => { p[rid] = spunG; }); m.recordPins = p; m.lastContextUpgradeAt = null; return m; });
        forcedSplit = newLabel;
      }
    }
  } catch (e) { console.warn('undoJourneyMerge_ force-split failed:', e && e.message); }

  // 3) 立即重新整理 → 被取消的主題當下自成一條、目標縮回。
  try { maybeUpgradeContexts_(scope, true); }
  catch (e) { console.warn('undoJourneyMerge_ re-upgrade failed:', e && e.message); }
  return { ok: true, candTitle: u.candTitle || '這條', targetTitle: u.targetTitle || '', n: moved.length, forcedSplit: forcedSplit };
}

/** 把一個 context 包成 checkSameThreadLLM_ 能吃的 pseudo-journey（label 當標題、
 *  代表片段當摘要），供候選 vs 既有歷程的同線判定。 */
function pseudoJourneyForContext_(ctx, recById) {
  const recs = (ctx.recordIds || []).map(id => recById[id]).filter(Boolean)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const snips = sampleEvenly_(recs, 4)
    .map(r => truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), 50))
    .filter(Boolean).join('；');
  return {
    id: ctx.id,
    title: ctx.userTitle || ctx.label || '',
    summary: snips,
    keywords: null,
    markers: [],
    updatedAt: ctx.updatedAt
  };
}

/** Editor 診斷：在 owner chat 跑一次自動融入，印結果。 */
function runAbsorbCandidatesNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const before = loadJourneys_(scope).filter(j => j.status === 'journey').length;
  const n = absorbCandidatesIntoJourneys_(scope);
  const afterCtx = loadContexts_(scope).length;
  console.log(`runAbsorbCandidatesNow: 吸收 ${n} 條候選；現在 ${before} 條歷程 / ${afterCtx} 條脈絡`);
}

/**
 * Editor rollback: clear all `m:*` (auto-merge) pins from meta.recordPins,
 * reset the upgrade throttle, and force a fresh upgradeContexts_. K-means
 * splits the formerly-pinned records back into natural clusters; orphaned
 * journey rows get re-linked to the best matching survivor via the existing
 * re-link path in upgradeContexts_.
 *
 * Use when an auto-merge over-consolidated unrelated journeys (e.g. a single
 * 75-record / 33-day blob absorbed multiple independent learning threads).
 * Manual 「分開」 (must-not-link, pins starting with non-`m:` prefix) are
 * untouched.
 */
function runJourneyMergeRollbackNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  let cleared = 0;
  updateChatMeta_(scope, m => {
    const pins = m.recordPins || {};
    const kept = {};
    for (const rid in pins) {
      if (typeof pins[rid] === 'string' && pins[rid].indexOf('m:') === 0) { cleared++; continue; }
      kept[rid] = pins[rid];
    }
    m.recordPins = kept;
    m.lastContextUpgradeAt = null;  // force the next upgrade to run
    return m;
  });
  console.log(`runJourneyMergeRollbackNow: cleared ${cleared} merge pins, forcing re-upgrade`);

  const summary = upgradeContexts_(scope);
  console.log('upgradeContexts_ summary:', JSON.stringify(summary));
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = new Date().toISOString(); return m; });

  const journeys = loadJourneys_(scope);
  const contexts = loadContexts_(scope);
  console.log(`after rollback: ${contexts.length} contexts, ${journeys.filter(j => j.status === 'journey').length} journey rows, ${journeys.filter(j => j.status === 'watch').length} watch rows`);
}

/**
 * Editor one-shot: 把現有 journeys.jsonl 裡 contextId 相同的多條 journey 合成
 * 一條（每個 contextId 只保留一條，挑 status='journey' > 有 title > 早 createdAt
 * 的優先）。upgradeContexts_ 的 re-link 修好之後新資料不會再出現這種重複，但
 * 既有的 9 條（其中 4 條是 dup）不會自動清——跑這個直接清掉。
 */
function dedupJourneysByContext() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const journeys = loadJourneys_(scope);
  const bestByCtx = {};
  for (const j of journeys) {
    const cur = bestByCtx[j.contextId];
    if (!cur) { bestByCtx[j.contextId] = j; continue; }
    const candScore = (j.status === 'journey' ? 2 : 0) + (j.title ? 1 : 0);
    const curScore = (cur.status === 'journey' ? 2 : 0) + (cur.title ? 1 : 0);
    if (candScore > curScore) bestByCtx[j.contextId] = j;
    else if (candScore === curScore && (j.createdAt || '') < (cur.createdAt || '')) bestByCtx[j.contextId] = j;
  }
  const kept = Object.values(bestByCtx);
  const dropped = journeys.length - kept.length;
  saveJourneys_(scope, kept);
  console.log(`dedupJourneysByContext: ${journeys.length} → ${kept.length} journeys (dropped ${dropped} 條 contextId 重複)`);
  return dropped;
}

/**
 * Editor diagnostic: 列出每條 journey 的 contextId / 筆數，以及兩兩之間的
 * recordIds Jaccard + centroid cosine。回答「相似卡到底是共用 records 還是
 * 真的不同 cluster」這個問題的最直接證據。
 */
function diagnoseJourneyOverlap() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const contexts = loadContexts_(scope);
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const ctxById = {};
  contexts.forEach(c => { ctxById[c.id] = c; });

  console.log(`=== Journey overlap diagnosis (${journeys.length} journeys) ===\n`);
  journeys.forEach((j, idx) => {
    const c = ctxById[j.contextId];
    const recCount = c ? (c.recordIds || []).length : 0;
    console.log(`[${idx + 1}] "${j.title || j.label}" — ctx=${j.contextId.slice(0,8)} ${recCount}筆 ${c ? `${c.firstTs && c.firstTs.slice(5,10)}~${c.lastTs && c.lastTs.slice(5,10)}` : ''}`);
  });

  console.log(`\n--- 兩兩比對：Jaccard（recordIds 重疊度）+ centroid cosine ---`);
  console.log('Jaccard=1.0 → 完全共用同一份 records (不該發生)');
  console.log('cos≥0.90 + span 太長被擋 → 鬆 span guard 才能合');
  console.log('cos 0.82~0.90 → 邊緣相似，要看 tag 或人工判斷');
  console.log('cos<0.82 → 系統判定不同主題（可能視覺上像但內容不同）\n');
  for (let i = 0; i < journeys.length; i++) {
    for (let k = i + 1; k < journeys.length; k++) {
      const cA = ctxById[journeys[i].contextId];
      const cB = ctxById[journeys[k].contextId];
      if (!cA || !cB) continue;
      const setA = new Set(cA.recordIds || []);
      const setB = new Set(cB.recordIds || []);
      let inter = 0;
      setB.forEach(id => { if (setA.has(id)) inter++; });
      const union = setA.size + setB.size - inter;
      const jaccard = union > 0 ? inter / union : 0;

      const embsA = (cA.recordIds || []).map(id => recById[id]).filter(r => r && r.embedding).map(r => r.embedding);
      const embsB = (cB.recordIds || []).map(id => recById[id]).filter(r => r && r.embedding).map(r => r.embedding);
      const centA = embsA.length ? meanVector_(embsA) : null;
      const centB = embsB.length ? meanVector_(embsB) : null;
      const cos = (centA && centB) ? cosineSim_(centA, centB) : -1;

      const aStart = Date.parse(cA.firstTs || '') || 0;
      const aEnd = Date.parse(cA.lastTs || '') || 0;
      const bStart = Date.parse(cB.firstTs || '') || 0;
      const bEnd = Date.parse(cB.lastTs || '') || 0;
      const maxSpanDays = Math.max(aEnd - aStart, bEnd - bStart) / 86400000;

      const tA = truncate_(journeys[i].title || journeys[i].label || '', 18);
      const tB = truncate_(journeys[k].title || journeys[k].label || '', 18);
      const verdict = jaccard >= 0.5 ? '⚠️ 共用 records（重分群 bug）' :
                      cos >= 0.92 ? '⚠️ 高度相似，被 span 擋住沒合' :
                      cos >= 0.82 ? '🤔 邊緣相似' : '✓ 系統判定不同';
      console.log(`  「${tA}」 vs 「${tB}」`);
      console.log(`     Jaccard=${jaccard.toFixed(2)} (共${inter}筆)  cos=${cos.toFixed(3)}  maxSpan=${maxSpanDays.toFixed(1)}d  → ${verdict}`);
    }
  }
}

/** Editor diagnostic: run merge pass on owner's chat, log result. */
function runJourneyMergeNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const beforeJ = loadJourneys_(scope);
  const beforeC = loadContexts_(scope);
  console.log(`BEFORE: ${beforeC.length} contexts, ${beforeJ.filter(j => j.status === 'journey').length} journey rows, ${beforeJ.filter(j => j.status === 'watch').length} watch rows`);
  const n = mergeOverlappingJourneys_(scope);
  const afterJ = loadJourneys_(scope);
  const afterC = loadContexts_(scope);
  console.log(`AFTER:  ${afterC.length} contexts, ${afterJ.filter(j => j.status === 'journey').length} journey rows, ${afterJ.filter(j => j.status === 'watch').length} watch rows`);
  console.log(`runJourneyMergeNow: merged ${n} pair(s)`);
  for (const j of afterJ.filter(j => j.status === 'journey')) {
    const c = afterC.find(x => x.id === j.contextId);
    console.log(`  journey id=${j.id.slice(0,8)} status=${j.status} contextId=${j.contextId.slice(0,8)} title="${j.title || j.label || ''}" ctxFound=${!!c} ctxStatus=${c && c.status} ctxRecs=${c && (c.recordIds||[]).length}`);
  }
}

/**
 * After a background upgrade/detect run, proactively push the user a short
 * report of any NEWLY升格 脈絡 / 歷程 — so they don't have to ask whether their
 * recent writing qualified. Only 1-on-1 user scopes (push goes to that user).
 *
 * De-duped via meta.notifiedContextIds / notifiedJourneyIds (accumulated): each
 * 脈絡/歷程 id is announced at most once, so threshold-boundary flicker can't
 * spam the chat or burn LINE push quota. Pushes only when there is something new.
 */
function notifyNewUpgrades_(scope) {
  if (!scope || scope.type !== 'user' || !scope.id) return;
  // 〔合宜〕reorg 通知也等停筆、不在打字中打斷；再過全域守門（靜默窗/總開關/全域冷卻）。
  if (!userSettledForReorg_(scope)) return;
  if (!proactivePushAllowed_(scope)) return;
  const meta = loadChatMeta_(scope);
  // Cooldown gate: after a push, hold off for NOTIFY_COOLDOWN_MS even if the
  // 5-min background sweep finds more new items. Skipped batches accumulate
  // naturally — they're not flagged as notified, so the next push past the
  // cooldown will pick them all up. Avoids spamming during a busy session.
  const lastAt = meta.lastNotifiedAt || 0;
  if (Date.now() - lastAt < NOTIFY_COOLDOWN_MS) return;

  const contexts = loadContexts_(scope).filter(c => c.status === 'context');
  const journeyRecs = loadJourneys_(scope);
  const journeys = journeyRecs.filter(j => j.status === 'journey');
  const jrnByCtx = journeysByContext_(journeyRecs);
  const isJourneyCtx = {}; journeys.forEach(j => { isJourneyCtx[j.contextId] = true; });

  const ctxSeen = {}; (meta.notifiedContextIds || []).forEach(id => { ctxSeen[id] = true; });
  const jrnSeen = {}; (meta.notifiedJourneyIds || []).forEach(id => { jrnSeen[id] = true; });
  const newJrn = journeys.filter(j => !jrnSeen[j.id]);
  // 已升格成歷程的脈絡不重複列在「新脈絡」段（它已在歷程段）；只列還是候選的。
  const newCtx = contexts.filter(c => !ctxSeen[c.id] && !isJourneyCtx[c.id]);
  if (!newJrn.length && !newCtx.length) return;

  const ctxTitle = c => truncate_((jrnByCtx[c.id] && jrnByCtx[c.id].title) || c.label || '未命名', 24);
  // Tappable bullet：包成 box+action，按下直接進對應動作（不必再去 /journey /me 找）。
  //   journey 條 → 開歷程說明 PDF
  //   進行中脈絡條 → 進「補一個轉折」流程
  const tappableBullet = (label, sublabel, action) => {
    const contents = [{ type: 'text', text: `• ${label}`, size: 'sm', color: THEME.cta, weight: 'bold', wrap: true, decoration: 'underline' }];
    if (sublabel) contents.push({ type: 'text', text: sublabel, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
    return {
      type: 'box', layout: 'vertical', margin: 'md', paddingAll: 'xs', cornerRadius: 'sm',
      action, contents
    };
  };
  const body = [];
  if (newJrn.length) {
    body.push({ type: 'text', text: `🌳 新學習歷程 ${newJrn.length} 條（點即開報告）`, size: 'sm', weight: 'bold', color: THEME.stage.supplement });
    newJrn.slice(0, 5).forEach(j => {
      const title = truncate_(j.title || j.label || '未命名', 24);
      const kinds = (j.markers || []).map(m => m.type).join('、');
      body.push(tappableBullet(title, kinds, {
        type: 'postback',
        label: '歷程現況',
        data: `action=journey_story&cid=${j.contextId}&jid=${j.id}`,   // jid 穩定：cid 之後 re-link 變動也找得回這條
        displayText: opEcho_('歷程現況', title)
      }));
    });
  }
  if (newCtx.length) {
    if (newJrn.length) body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'text', text: `🌿 新候選歷程 ${newCtx.length} 條（點即補一個轉折）`, size: 'sm', weight: 'bold', color: THEME.cta, margin: newJrn.length ? 'md' : 'none' });
    body.push({ type: 'text', text: '都已三條件齊備，差一個轉折就成學習歷程', size: 'xxs', color: THEME.muted, margin: 'xs' });
    newCtx.slice(0, 5).forEach(c => {
      const title = ctxTitle(c);
      body.push(tappableBullet(title, null, {
        type: 'postback',
        label: '補一個轉折',
        data: `action=ctx_supplement&cid=${c.id}`,
        displayText: opEcho_('補一個轉折', title)
      }));
    });
  }

  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.stage.supplement, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🔔 背景自動整理', size: 'xxs', color: THEME.onDark },
        { type: 'text', text: '🌱 你的記寫有新進展', size: 'md', weight: 'bold', color: THEME.onDark, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm', spacing: 'xs',
      contents: [
        { type: 'text', text: '直接點上方項目；或 /journey 看歷程、/me 看總覽', size: 'xxs', color: THEME.muted, wrap: true },
        { type: 'text', text: '🔕 背景提醒全關', size: 'xxs', color: THEME.cta, align: 'end',
          action: { type: 'postback', label: '背景提醒全關', data: 'action=proactive_mute', displayText: '🔕 背景提醒全關' } }
      ]
    }
  };
  const altParts = [];
  if (newJrn.length) altParts.push(`新歷程 ${newJrn.length}`);
  if (newCtx.length) altParts.push(`新脈絡 ${newCtx.length}`);

  try { linePushFlex_(scope.id, '🌱 記寫新進展：' + altParts.join('、'), bubble); }
  catch (e) { console.warn('notifyNewUpgrades_ push failed:', e && e.message); return; }
  markProactivePush_(scope);   // 餵全域冷卻（一輪一張）

  updateChatMeta_(scope, m => {
    m.notifiedContextIds = (m.notifiedContextIds || []).concat(newCtx.map(c => c.id));
    m.notifiedJourneyIds = (m.notifiedJourneyIds || []).concat(newJrn.map(j => j.id));
    m.lastNotifiedAt = Date.now();
    return m;
  });
}

/** Cooldown between consecutive 新進展 push notifications — 30 min keeps
 *  busy-session sweeps from emitting one push every 5 min. Skipped batches
 *  accumulate via notifiedContextIds/notifiedJourneyIds and surface in the
 *  next push past the cooldown. */
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Editor diagnostic: force a 轉折偵測 pass on the OWNER's chat (ignores the
 * change-gate but still honours the daily budget) and log every 脈絡's verdict.
 */
function runJourneyDetectNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  // Force re-judge: clear basedOnUpdatedAt stamps so every context is pending.
  saveJourneys_(scope, loadJourneys_(scope).map(j => { j.basedOnUpdatedAt = '__force__'; return j; }));
  // Editor-forced: pass an explicit budget so it BYPASSES the daily cap (the cap
  // bounds the background path; a manual run should always judge every 脈絡).
  const ctxCount = loadContexts_(scope).filter(c => c.status === 'context').length;
  const summary = detectJourneys_(scope, Math.max(1, ctxCount));
  console.log('journeyDetect summary:', JSON.stringify(summary));
  for (const j of loadJourneys_(scope)) {
    const tags = (j.markers || []).map(m => `${m.type}(${m.confidence})`).join('、') || '—';
    console.log(`[${j.status}] ${j.label} — markers: ${tags}`);
  }
  return summary;
}

/**
 * Editor one-shot: run the WHOLE chain on the OWNER's chat — 脈絡升格 then
 * 轉折偵測 (both forced past the throttle AND the daily cap) —
 * and log end-to-end whether each 脈絡 grew into a 歷程 (a transition marker was
 * found) or stayed 'watch' (持續關注、無轉折). The fastest way to test
 * "does a 脈絡 really produce a 歷程?". Then check /journey on the device.
 */
function runJourneyPipelineNow() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  console.log('=== 1) 脈絡升格 (層3→4) ===');
  console.log('upgrade:', JSON.stringify(upgradeContexts_(scope)));
  const contexts = loadContexts_(scope).filter(c => c.status === 'context');
  console.log(`升格脈絡 ${contexts.length} 條：${contexts.map(c => c.label).join('、') || '（無）'}`);
  if (!contexts.length) {
    console.log('→ 沒有脈絡升格，就不會有歷程。跑 runContextUpgradeNow 看密度排序找卡在哪一條件。');
    return { contexts: 0, journeys: 0 };
  }

  console.log('=== 2) 轉折偵測 (層4→5) ===');
  saveJourneys_(scope, loadJourneys_(scope).map(j => { j.basedOnUpdatedAt = '__force__'; return j; }));
  console.log('detect:', JSON.stringify(detectJourneys_(scope, Math.max(1, contexts.length))));

  console.log('=== 3) 結果（每條脈絡的判定）===');
  for (const j of loadJourneys_(scope)) {
    const tags = (j.markers || []).map(m => `${m.type}(${m.confidence})`).join('、') || '—';
    console.log(`[${j.status}] ${j.label} — ${tags}`);
  }
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey').length;
  console.log(`\n→ 歷程 ${journeys} 條（status=journey，有轉折）；其餘 watch＝偵測過但無轉折＝持續關注。`);
  console.log('  到 LINE 打 /journey 看（已部署的 /journey 也會反映，因為只是讀檔）。');
  return { contexts: contexts.length, journeys };
}

/**
 * 暫時的 LINE 測試指令 `/rebuild`：在聊天室裡手動把整條鏈跑一次（繞過 3h 節流，
 * 轉折偵測仍受每日上限），回報脈絡/歷程是否生成。OWNER 一對一限定（會花 Gemini）。
 */
function replyRebuild_(ctx) {
  const scope = ctx.scope;
  if (!isOwnerScope_(scope)) {
    return lineReply_(ctx.replyToken, '（暫時測試指令）僅限 OWNER 一對一使用。');
  }
  if (scope.type === 'user') { try { showLoadingAnimation_(scope.id, 40); } catch (_) {} }

  const up = upgradeContexts_(scope);
  if (!up) return lineReply_(ctx.replyToken, '🔄 資料量還不足以聚類（有效紀錄太少）。');

  // Force re-judge transitions on every升格 脈絡.
  saveJourneys_(scope, loadJourneys_(scope).map(j => { j.basedOnUpdatedAt = '__force__'; return j; }));
  detectJourneys_(scope);

  const contexts = loadContexts_(scope);
  const passed = contexts.filter(c => c.status === 'context');
  const candidates = contexts.filter(c => c.status === 'candidate');
  const allJourneys = loadJourneys_(scope);
  const journeys = allJourneys.filter(j => j.status === 'journey');
  const watches = allJourneys.filter(j => j.status === 'watch');

  const out = [
    '🔄 重算完成',
    `主題群組 ${up.clusters} 組 → 脈絡 ${passed.length}・候選 ${candidates.length}`,
    `歷程 ${journeys.length}・持續關注(無轉折) ${watches.length}`
  ];
  if (passed.length) {
    out.push('\n【脈絡】');
    passed.forEach(c => out.push(`• ${c.label}（${(c.recordIds || []).length} 則・${spanLabel_(c.firstTs, c.lastTs)}）`));
  }
  if (journeys.length) {
    out.push('\n【歷程・含轉折】');
    journeys.forEach(j => out.push(`• ${j.label}：${(j.markers || []).map(m => m.type).join('、')}`));
  }
  if (watches.length) {
    out.push('\n【持續關注・無轉折】');
    watches.forEach(j => out.push(`• ${j.label}`));
  }
  out.push('\n（暫時測試指令；平時背景每 ~3h 自動跑）');
  lineReply_(ctx.replyToken, out.join('\n'));
}
