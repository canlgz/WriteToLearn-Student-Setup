/**
 * /themes — 主題群組三層 UI（block 5）。資料全讀 contexts.jsonl 持久脈絡
 * （新模型下＝同 (大類, 議題標籤) 的 record 群，已排除收藏）：
 *   Layer 1 大類總覽  replyThemeCategories_：8 大類各幾個主題 / 幾筆 / 升格分布。
 *   Layer 2 主題列表  replyThemeCategory_：某大類底下的主題（=脈絡）逐列、按筆數排序。
 *   Layer 3 主題詳情  replyThemeTopic_：單一主題的 buildContextCard_（狀態 / 三條件 /
 *                    代表片段 / 時間分布 / 動作鈕），其「看全部記錄」再進 ctx_episodes。
 * 狀態三選一：🌳 學習歷程（journeys status='journey'）/ 🌿 候選歷程（contexts
 * status='context'）/ 🌱 進行中脈絡（contexts status='candidate'）。
 * 入口跑一次 maybeUpgradeContexts_(scope, true)（純 CPU、繞 3h 節流），剛寫的新訊息
 * 即時折進脈絡；翻層不重跑。
 *
 * 舊版時間範圍菜單 replyFocusMenu_ / 扁平卡 replyFocusRun_ / buildFocusBubble_ /
 * k-means 一族函式保留在本檔，只供歷史訊息裡的舊 focus_run postback 不致失效，
 * 不在新路徑被呼叫（dead-ish，留著不刪以防舊卡反咬）。
 */

const FOCUS_KMEANS_MAX_ITER = 20;
const FOCUS_SAMPLE_THRESHOLD = 2000;  // beyond this, cluster on a sample
const FOCUS_SAMPLE_SIZE = 1000;        // size of the sample used for k-means iters
const FOCUS_MIN_COUNT = 6;             // a range needs ≥ this many records to be offered

// /themes UX freshness：用「本次坐下」當錨——全語料最新一筆 record 的時間，往回推一個
// sitting 窗。比固定 24h 窗緊得多（不會整片亂閃），且 drill-down / 立即整理 之間穩定。
// 只在語料近期活躍時生效（最新一筆超過 GATE 久＝閒置，不標 fresh，免「隔天打開整片亮」）。
const CONTEXT_FRESH_SITTING_MS = 90 * 60 * 1000;   // 本次坐下窗（涵蓋一般一次寫作 session）
const CONTEXT_FRESH_GATE_MS = 3 * 3600 * 1000;     // 最新一筆超過這久 → 語料閒置、不標 fresh

/** 由 contexts 算出「本次坐下」freshness 判定器：fresh(c) = c.lastTs 落在最新活動的 sitting 窗內。
 *  回傳 function(context) → bool；語料閒置時恆 false。 */
function makeContextFreshFn_(contexts, rehomedSigs) {
  let latest = 0;
  (contexts || []).forEach(c => { const t = Date.parse((c && c.lastTs) || 0); if (t > latest) latest = t; });
  const active = latest && (Date.now() - latest) < CONTEXT_FRESH_GATE_MS;
  const since = latest - CONTEXT_FRESH_SITTING_MS;
  const sigs = rehomedSigs || {};
  const REHOME_FRESH_MS = CONTEXT_FRESH_GATE_MS;   // 重歸 ✨ 與新訊息 ✨ 同一時間尺度（不另撐長窗）
  return function (c) {
    if (!c) return false;
    // 剛收到「移出重歸」片段的主題：獨立於記錄時間，直接給 ✨（記錄 ts 多半是舊的，
    // 不會踩進 lastTs 新鮮窗——這正是使用者回報「重歸後沒亮星」的原因）。
    const sig = ((c.category || '') + '|' + (c.label || ''));
    if (sigs[sig] && (Date.now() - sigs[sig]) < REHOME_FRESH_MS) return true;
    if (!active) return false;
    const t = Date.parse(c.lastTs || 0);
    return !!t && t >= since;
  };
}
/** 把 timestamp 轉成絕對時鐘時間字串：今天 → "HH:mm"；其他日子 → "MM/dd HH:mm"。 */
function clockTimeText_(ts) {
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!ms) return '';
  const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const that = Utilities.formatDate(new Date(ms), TIME_ZONE, 'yyyy-MM-dd');
  return Utilities.formatDate(new Date(ms), TIME_ZONE, today === that ? 'HH:mm' : 'MM/dd HH:mm');
}

/** 把 timestamp 轉成相對時間字串，分鐘粒度。
 *  「剛剛」= < 1 分；其餘都標出具體 N 分／N 小時 M 分／N 天。 */
function relativeAgoText_(ts) {
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!ms) return '';
  const age = Date.now() - ms;
  if (age < 0) return '';
  if (age < 60 * 1000) return '剛剛';
  const minutes = Math.floor(age / 60000);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours} 小時 ${remainMin} 分前` : `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * Entry point. With no arg → show a Flex menu of time ranges that have
 * enough records to be worth clustering. With an arg (week, 30, all, etc.)
 * → actually run the clustering pipeline.
 */
function replyFocus_(ctx, arg) {
  // block 5：/themes 一律進大類總覽（Layer 1）。arg 不再用（舊的時間範圍語意已退場）。
  return replyThemeCategories_(ctx);
}

/**
 * Inventory current records, build a Flex card listing only the time
 * ranges that have at least FOCUS_MIN_COUNT records (and a count
 * meaningfully larger than the previous candidate). Each row is tappable
 * and fires the actual clustering via postback action=focus_run.
 */
function replyFocusMenu_(ctx) {
  const all = loadEmbeddingRecords_(ctx.scope);
  const valid = all.filter(r => r.embedding && r.embedding.length === EMBED_DIM);
  if (valid.length < FOCUS_MIN_COUNT) {
    return lineReply_(ctx.replyToken,
      `⚠️ 資料量不足，目前無法判斷主題群組分布。\n` +
      `已有 ${valid.length} 筆有效紀錄，建議累積至少 ${FOCUS_MIN_COUNT} 筆後再試。`);
  }

  const DAY = 86400000;
  const candidates = [
    { days: 1,   label: '今日',      arg: 'today' },
    { days: 3,   label: '近 3 日',   arg: '3'     },
    { days: 7,   label: '近 7 日',   arg: 'week'  },
    { days: 30,  label: '近 30 日',  arg: 'month' },
    { days: 90,  label: '近 90 日',  arg: '90'    },
    { days: 365, label: '近 365 日', arg: '365'   }
  ];

  const now = Date.now();
  const todayMs = startOfTodayMs_();   // 今日 = calendar day midnight, not rolling 24h
  const rangeOptions = [];
  let lastCount = 0;
  for (const c of candidates) {
    const cutoff = (c.arg === 'today') ? todayMs : (now - c.days * DAY);
    const count = valid.filter(r => Date.parse(r.ts) >= cutoff).length;
    if (count >= FOCUS_MIN_COUNT && count > lastCount) {
      rangeOptions.push({ label: c.label, arg: c.arg, count });
      lastCount = count;
    }
  }
  if (valid.length > lastCount && valid.length >= FOCUS_MIN_COUNT) {
    rangeOptions.push({ label: '全部', arg: 'all', count: valid.length });
  }

  // Density-aware: detect 30-min sessions, surface the densest ones that
  // individually clear FOCUS_MIN_COUNT. Top 5 by size.
  const sorted = valid.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const sessions = groupByEpisode_(sorted, SESSION_GAP_MINUTES * 60 * 1000);
  // Borrow keywords from the most-overlapping context so each 密集區段 picker
  // row carries a 大類｜關鍵字 hint, matching /themes 卡 / /recall 標題格式.
  // Brand-new records that haven't been swept into a context yet (or whose
  // context is still candidate with no LLM keywords) fall back to the first
  // record's text snippet — so every row gets some hint, even before the
  // background pipeline catches up.
  const allContexts = loadContexts_(ctx.scope);
  const jrnByCtxId = journeysByContext_(loadJourneys_(ctx.scope));
  const previewFor = (records) => {
    const idSet = {};
    records.forEach(r => { if (r && r.id) idSet[r.id] = true; });
    let bestCtx = null, bestOverlap = 0;
    for (const c of allContexts) {
      let overlap = 0;
      for (const id of (c.recordIds || [])) if (idSet[id]) overlap++;
      if (overlap > bestOverlap) { bestCtx = c; bestOverlap = overlap; }
    }
    if (bestCtx) {
      const jrn = jrnByCtxId[bestCtx.id];
      const kw = (jrn && jrn.keywords) || null;
      if (kw) {
        const cat = kw.category || '';
        const tags = (Array.isArray(kw.tags) ? kw.tags.filter(Boolean) : []).join('+');
        if (cat && tags) return `${cat}｜${tags}`;
        if (cat || tags) return cat || tags;
      }
    }
    // Fallback when no LLM keywords yet: first record's text snippet so the
    // row still says something useful (typical for very-recent 區段 the
    // background sweep hasn't gotten to).
    for (const r of records) {
      const txt = (r && (r.text || r.aggregatedText) || '').replace(/\s+/g, ' ');
      if (txt) return truncate_(txt, 18);
    }
    return '';
  };
  const sessionOptions = sessions
    .filter(s => s.records.length >= FOCUS_MIN_COUNT)
    .sort((a, b) => b.records.length - a.records.length)
    .slice(0, 5)
    .map(s => ({
      label: formatSessionLabel_(s),
      arg: `session_${s.startTs}_${s.endTs}`,
      count: s.records.length,
      preview: previewFor(s.records)
    }));

  if (!rangeOptions.length && !sessionOptions.length) {
    return lineReply_(ctx.replyToken,
      `⚠️ 資料分布不足以判斷主題群組。\n` +
      `任一時段／區段都不滿 ${FOCUS_MIN_COUNT} 筆（目前總紀錄 ${valid.length} 筆）。`);
  }

  const bubble = buildFocusMenuBubble_(rangeOptions, sessionOptions, valid.length);
  lineReplyFlex_(ctx.replyToken, `主題群組分布選項（共 ${valid.length} 筆）`, bubble);
}

function formatSessionLabel_(s) {
  const startD = Utilities.formatDate(new Date(s.startTs), TIME_ZONE, 'MM/dd HH:mm');
  const endD   = Utilities.formatDate(new Date(s.endTs),   TIME_ZONE, 'HH:mm');
  const sameDay = Utilities.formatDate(new Date(s.startTs), TIME_ZONE, 'MM/dd') ===
                  Utilities.formatDate(new Date(s.endTs),   TIME_ZONE, 'MM/dd');
  return sameDay
    ? `${startD}–${endD}`
    : `${startD} – ${Utilities.formatDate(new Date(s.endTs), TIME_ZONE, 'MM/dd HH:mm')}`;
}

function buildFocusMenuBubble_(rangeOptions, sessionOptions, totalValid) {
  const optionRow = (o) => {
    // Label side nests vertically so the optional preview (大類｜關鍵字) sits
    // under the time label without pushing the count column out of alignment.
    const labelStack = {
      type: 'box', layout: 'vertical', flex: 5,
      contents: [{ type: 'text', text: o.label, size: 'sm', color: THEME.text, weight: 'bold' }]
    };
    if (o.preview) {
      labelStack.contents.push({
        type: 'text', text: `└ ${o.preview}`, size: 'xxs', color: THEME.muted,
        wrap: true, margin: 'xs'
      });
    }
    return {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: THEME.surface,
      cornerRadius: 'sm',
      paddingAll: 'md',
      margin: 'sm',
      action: {
        type: 'postback',
        label: o.label.length > 20 ? o.label.slice(0, 20) : o.label,
        data: `action=focus_run&arg=${encodeURIComponent(o.arg)}`,
        displayText: opEcho_('主題群組分布', o.label)
      },
      contents: [
        labelStack,
        { type: 'text', text: `${o.count} 筆`, size: 'sm', flex: 2, color: THEME.cta, align: 'end', gravity: 'center' }
      ]
    };
  };

  const sectionHeader = (text) => ({
    type: 'text', text, size: 'xs', color: THEME.muted, weight: 'bold', margin: 'md'
  });

  const contents = [
    { type: 'text', text: `共 ${totalValid} 筆可分析`, size: 'xs', color: THEME.muted, align: 'center' },
    { type: 'text', text: '選擇範圍 → 跑聚類', size: 'xxs', color: THEME.muted, align: 'center' },
    { type: 'separator', margin: 'md' }
  ];

  if (sessionOptions.length) {
    contents.push(sectionHeader('⏱ 密集區段（自動偵測）'));
    sessionOptions.forEach(o => contents.push(optionRow(o)));
  }
  if (rangeOptions.length) {
    if (sessionOptions.length) contents.push({ type: 'separator', margin: 'md' });
    contents.push(sectionHeader('📅 時間範圍'));
    rangeOptions.forEach(o => contents.push(optionRow(o)));
  }
  contents.push({ type: 'separator', margin: 'md' });
  contents.push({
    type: 'text',
    text: `密集區段＝筆數最多的前 5 個「30 分鐘內連續」區段（每段 ≥ ${FOCUS_MIN_COUNT} 筆才夠分群）；較零散的時段請改用敘事片段瀏覽。`,
    size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm'
  });

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🔍 主題群組分布範圍', size: 'md', weight: 'bold', color: '#ffffff', align: 'center' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents }
  };
}

/**
 * /themes 主流程：讀持久脈絡、過濾在所選視窗內有記錄的、依「大類 → 狀態 → 視窗
 * 筆數」排序、分頁顯示。每張卡 = 一條持久脈絡（含狀態 badge + 三條件 inline）。
 *
 * `page` 從 postback 進來時是換頁，初次進來預設 0。換頁不重跑 maybeUpgradeContexts_，
 * 集合穩定。
 */
function replyFocusRun_(ctx, arg, page) {
  page = page || 0;
  const range = resolveFocusRange_(arg);

  // 入口才跑升級（純 CPU、繞 3h 節流），讓剛寫的訊息即時納入；翻頁不重跑。
  if (page === 0 && ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 20); } catch (_) {}
  }
  if (page === 0) {
    try { maybeUpgradeContexts_(ctx.scope, true); } catch (e) { console.warn('focus upgrade failed:', e && e.message); }
  }

  // 讀全部持久脈絡 + journey rows + 全部 records（id-map）。
  const allContexts = loadContexts_(ctx.scope);
  const jrnByCtx = journeysByContext_(loadJourneys_(ctx.scope));
  const recById = {};
  loadEmbeddingRecords_(ctx.scope).forEach(r => { recById[r.id] = r; });

  // 過濾「在所選視窗內有記錄」的脈絡——這就是「視窗內活躍的脈絡」定義。
  const inWindow = r => {
    if (!r || !r.ts) return false;
    const t = Date.parse(r.ts);
    if (isNaN(t) || t < range.startMs) return false;
    if (range.endMs != null && t > range.endMs) return false;
    return true;
  };
  const windowed = [];
  for (const c of allContexts) {
    const allRecs = (c.recordIds || []).map(id => recById[id]).filter(Boolean);
    const recsInWin = allRecs.filter(inWindow);
    if (!recsInWin.length) continue;
    windowed.push({
      context: c,
      journey: jrnByCtx[c.id] || null,  // journey row（'journey' 或 'watch'）
      recsInWindow: recsInWin,
      windowCount: recsInWin.length,
      allContextRecords: allRecs  // for the strip's "whole life" x-axis
    });
  }

  if (!windowed.length) {
    return lineReply_(ctx.replyToken,
      `⚠️ ${range.label}內沒有可顯示的脈絡。\n` +
      '剛寫的訊息可能還在累積中，繼續寫、隔些時候回返同一主題，背景就會把它聚成脈絡。');
  }

  // 三狀態的排序權重：學習歷程 0 → 候選歷程 1 → 進行中脈絡 2。
  const statusRank = w => {
    if (w.journey && w.journey.status === 'journey') return 0;
    if (w.context.status === 'context') return 1;
    return 2;
  };
  // 大類排序：照 JOURNEY_KEYWORD_CATEGORIES 預設順序；無分類最後。
  const catRank = w => {
    const cat = (w.journey && w.journey.keywords && w.journey.keywords.category) || '';
    const i = JOURNEY_KEYWORD_CATEGORIES.indexOf(cat);
    return i >= 0 ? i : JOURNEY_KEYWORD_CATEGORIES.length;
  };
  // 同大類內：剛活動過的主題往上浮（updatedAt 新→舊），讓使用者一進 /themes 就先看到
  // 自己「剛寫的東西去哪了」。再退回 status / windowCount 為次序。
  const updatedRank = w => -Date.parse(w.context.updatedAt || 0);
  windowed.sort((a, b) => {
    const r1 = catRank(a) - catRank(b);
    if (r1) return r1;
    const ru = updatedRank(a) - updatedRank(b);
    if (ru) return ru;
    const r2 = statusRank(a) - statusRank(b);
    if (r2) return r2;
    return b.windowCount - a.windowCount;
  });

  // 各卡的 strip 用「該脈絡完整生命期」當 x 軸（不再共用視圖視窗）——這樣使用者
  // 可以一眼看到本次選的時段視窗在這條脈絡的整段生命裡是什麼位置；當前視窗區段
  // 用 |-bars 標出。每張卡的 x 軸範圍各自獨立、為該脈絡的 firstTs..lastTs。
  // 與 /recall、/journey 同樣式分頁；額外加 JSON-size 上限（卡片含 24 格 strip，
  // 滿頁 10 張會超過 LINE 50KB carousel 上限），交給 paginateFlexCards_ 動態縮頁。
  const freshFn = makeContextFreshFn_(windowed.map(w => w.context));
  const allCards = windowed.map((w, i) => buildContextCard_(w, i, range, ctx.scope, freshFn));
  const total = allCards.length;
  const pager = paginateFlexCards_(allCards, page);
  page = pager.page;
  const totalPages = pager.totalPages;
  const pageCards = pager.pageCards;

  const resultContents = pageCards.length === 1 ? pageCards[0] : { type: 'carousel', contents: pageCards };
  const totalInWindow = windowed.reduce((sum, w) => sum + w.windowCount, 0);
  const altText = totalPages > 1
    ? `${range.label}主題分布 ${total} 條・第 ${page + 1}/${totalPages} 頁`
    : `${range.label}主題分布 ${total} 條（${totalInWindow} 筆紀錄在視窗內）`;

  if (totalPages <= 1) {
    return lineReplyFlex_(ctx.replyToken, altText, resultContents);
  }
  const pagerTitle = `👉 ${range.label}主題分布（${total} 條 / ${totalPages} 頁）`;
  const argEnc = encodeURIComponent(arg);
  lineReplyMessages_(ctx.replyToken, [
    { type: 'flex', altText: altText, contents: resultContents },
    {
      type: 'flex',
      altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(pagerTitle, page, totalPages, p => `action=focus_run&arg=${argEnc}&p=${p}`)
    }
  ]);
}

// 三條件 ✅/⬜ 一列；給進行中脈絡／候選歷程的卡用（學習歷程不顯示，已過閘）。
function criteriaStatusRow_(criteria) {
  const C = CONTEXT_CRITERIA;
  const cr = criteria || {};
  const densOk = densityConditionMet_(cr);
  const visitOk = (cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin;
  const mediaOk = (cr.mediaKinds || 0) >= C.mediaKindsMin;
  return {
    type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm',
    contents: [
      { type: 'text', text: `${densOk ? '✅' : '⬜'} 密度`, size: 'xxs', flex: 0, color: densOk ? THEME.success : THEME.warning },
      { type: 'text', text: `${visitOk ? '✅' : '⬜'} 回返 ${cr.returnVisits || 0}/${C.returnVisitsMin}`, size: 'xxs', flex: 0, color: visitOk ? THEME.success : THEME.warning },
      { type: 'text', text: `${mediaOk ? '✅' : '⬜'} 媒介 ${cr.mediaKinds || 0}/${C.mediaKindsMin}`, size: 'xxs', flex: 0, color: mediaOk ? THEME.success : THEME.warning }
    ]
  };
}

// 「還缺什麼」一行——條件沒過的給操作提示，全過的給「等一個轉折」。
function criteriaHintText_(context, journey) {
  const C = CONTEXT_CRITERIA;
  const cr = context.criteria || {};
  const isJourney = journey && journey.status === 'journey';
  if (isJourney) return null;
  const densOk = densityConditionMet_(cr);
  const visitOk = (cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin;
  const mediaOk = (cr.mediaKinds || 0) >= C.mediaKindsMin;
  if (densOk && visitOk && mediaOk) return '↳ 三條件齊備、等一個轉折就成歷程';
  const gaps = [];
  if (!densOk) gaps.push('語意再聚焦（同主題的紀錄群內相似度 ≥ ' + C.semanticDensityMin + '）');
  if (!visitOk) {
    const visits = cr.returnVisits || 0;
    const spanH = cr.returnSpanHours || 0;
    if (visits < C.returnVisitsMin) {
      gaps.push(`意向回返目前 ${visits} 次，需在不同時段（間隔 ≥ ${C.returnGapMinutes} 分算一次）再回到這主題 ${C.returnVisitsMin - visits} 次`
        + (spanH >= C.returnSpanHoursMin ? '（首末跨度已夠，只差次數）' : `、首末跨 ≥ ${C.returnSpanHoursMin}h`));
    } else {
      gaps.push(`意向回返首末需橫跨 ≥ ${C.returnSpanHoursMin}h（目前僅 ${Math.round(spanH * 10) / 10}h）`);
    }
  }
  if (!mediaOk) gaps.push(`再加媒介種類（${cr.mediaKinds || 0}/${C.mediaKindsMin}：語音／圖片／影片／檔案）`);
  return '↳ 還缺：' + gaps.join('；');
}

/**
 * 每張 /themes 卡 = 一條持久脈絡。狀態三選一（學習歷程 / 候選歷程 / 進行中脈絡），
 * 視覺、按鈕、文案各自鮮明。`w` 是 sendThemesPage 算出來的 wrapper：
 *   { context, journey, recsInWindow, windowCount }
 */
function buildContextCard_(w, idx, range, scope, freshFn) {
  const { context, journey, recsInWindow, windowCount, allContextRecords } = w;
  const whole = !!(range && range.whole);   // Layer 3 主題詳情：不分視窗、全卡聚焦本主題
  const asNav = !!(range && range.asNav);   // 作 episode 輪播 index-0 導覽卡：episodes 已內聯 → footer 省去敘事片段按鈕
  const isJourney = !!(journey && journey.status === 'journey');
  const isContext = context.status === 'context';
  // isCandidate = context.status === 'candidate'

  const title = context.userTitle || (journey && journey.title) || context.label || '未命名';
  const titleSub = journeyTitleParts_(context, journey).sub;   // 使用者改名後、自動歷程名退為副標
  // 狀態決定 header 底色 + 狀態 row 顏色／文案。Header 本身只保留「主題群組 N · 分類」，
  // 不放狀態 badge——/themes 是「看主題」的入口，狀態屬於主題的屬性、不是主題本身。
  let stageIcon, stageLabel, stateColor, headerBg;
  // L2 詳情卡保留三狀態完整說明（L0/L1 是二分鳥瞰；這裡是行動層、必須具體）。
  // 深度色階：L2 詳情（whole）走最深一階 depth.l3（＝/themes 鑽愈深底愈暗：L0 亮藍→L1 中藍→L2 深藍）；
  // 扁平卡仍用 cta；進行中脈絡＝淺底（「還沒成形」讀起來較輕，刻意不進色階）。
  const deepBg = whole ? THEME.depth.l3.headerBg : THEME.cta;
  if (isJourney) { stageIcon = '🌳'; stageLabel = '已是學習歷程現況'; stateColor = THEME.success; headerBg = deepBg; }
  else if (isContext) { stageIcon = '🌿'; stageLabel = '目前是候選歷程（差一個轉折就成歷程）'; stateColor = THEME.cta; headerBg = deepBg; }
  else { stageIcon = '🌱'; stageLabel = '目前是進行中脈絡（還在累積三條件）'; stateColor = THEME.warning; headerBg = THEME.surfaceSoft; }
  const darkHeader = headerBg !== THEME.surfaceSoft;
  const onHeader = darkHeader ? THEME.onDark : THEME.ink;
  const headerSub = darkHeader ? THEME.depth.l2.headerSub : THEME.muted;

  // 扁平卡的 category 沿用 journey.keywords；Layer 3 詳情卡用 context.category（＝L0 分桶的大類），
  // 才不會出現「從教學進來、詳情卡卻標規劃」（journey.keywords.category 與分桶大類可能不同）。
  const category = whole
    ? (context.category || (journey && journey.keywords && journey.keywords.category) || '')
    : ((journey && journey.keywords && journey.keywords.category) || '');
  // Header kicker：扁平卡「主題群組 N · 教學」；L2 詳情卡改成類路徑麵包屑
  // 「🗂 主題群組 › 📚 教學 › **主題詳情**」（§0.6.5），讓最深的卡也看得到「我在哪、怎麼回去」。
  const catIcon = THEME_CATEGORY_ICON[category] || '🗄️';
  const kicker = whole
    ? breadcrumbTrail_(['🗂 主題群組'].concat(category ? [`${catIcon} ${category}`] : []), '主題詳情',
        { headerSub: headerSub, headerText: onHeader })
    : { type: 'text', text: `主題群組 ${idx + 1}${category ? ' · ' + category : ''}`, size: 'xs', color: headerSub, wrap: true };

  // Body
  const body = [];

  // 狀態 row（取代原本長在 header 的 badge）。進行中脈絡時把「改名」放在同一行右側，
  // 緊鄰標題下方——候選階段的 label 只是「離群心最近的那句話」，使用者最常想糾正。
  // isContext/isJourney 階段不顯示：那時系統已有更好的標題（LLM 取的 journey.title）。
  const isCandidate = !isJourney && !isContext;
  const stateRowContents = [
    { type: 'text', text: `${stageIcon} ${stageLabel}`, size: 'sm', weight: 'bold', color: stateColor, wrap: true, flex: 1 }
  ];
  if (isCandidate) {
    stateRowContents.push({
      type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'xs', flex: 0,
      backgroundColor: THEME.surfaceSoft,
      action: { type: 'postback', label: '改名', data: `action=ctx_rename&cid=${context.id}`, displayText: opEcho_('改名', title) },
      contents: [{ type: 'text', text: '✎ 改名', size: 'xxs', align: 'center', color: THEME.cta, weight: 'bold' }]
    });
  }
  body.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: stateRowContents });

  const totalCount = (context.recordIds || []).length;
  let countText = whole ? `共 ${totalCount} 筆紀錄` : `本視窗 ${windowCount} 筆 · 全脈絡 ${totalCount} 筆`;
  if (freshFn && freshFn(context)) countText += ` · ✨${relativeAgoText_(context.lastTs)}更新`;
  body.push({
    type: 'text',
    text: countText,
    size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs'
  });

  // 探索敘事段：≥ 半數成員來自同一段 exploration 才顯示。同一視覺層級（micro 灰字），純 metadata。
  if (scope && allContextRecords && allContextRecords.length) {
    const lessonLine = dominantExplorationLineForCard_(scope, allContextRecords);
    if (lessonLine) body.push(lessonLine);
  }

  // 〔背景智慧合併·2026-06-11〕被併入的脈絡標註：何時·併入了誰（資料源 meta.contextMergeNotes，14 天）。
  if (scope) {
    try {
      const mn = (loadChatMeta_(scope).contextMergeNotes || {})[(context.category || '') + '|' + (context.label || '')];
      if (mn && mn.from && mn.from.length && mn.ts && (Date.now() - mn.ts) < MERGE_UNDO_TTL_MS) {
        const froms = mn.from.slice(-3).map(s => `「${s}」`).join('、');
        body.push({
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
          contents: [{
            type: 'text', wrap: true, size: 'xxs', color: THEME.muted,
            text: `🔀 ${relativeAgoText_(new Date(mn.ts).toISOString())}背景智慧合併·併入了 ${froms}（名稱不變；可在合併通知卡「取消」）`
          }]
        });
      }
    } catch (_) {}
  }

  // Keywords chip row（journey/watch 有的話借用）
  const kwRow = keywordChipsRow_(journey && journey.keywords);
  if (kwRow) body.push(kwRow);

  // Summary（journey/watch 有的話顯示，這是 LLM 生的一句摘要）
  if (journey && journey.summary) {
    body.push({ type: 'separator', margin: 'sm' });
    body.push({ type: 'text', text: journey.summary, size: 'sm', color: THEME.textBody, wrap: true, maxLines: 3, margin: 'sm' });
  }

  // 三條件 + 還缺什麼（非 journey 才顯示）
  if (!isJourney) {
    body.push(criteriaStatusRow_(context.criteria));
    const hint = criteriaHintText_(context, journey);
    if (hint) body.push({ type: 'text', text: hint, size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  }

  // 代表片段（用視窗內的記錄；最多 3 條）
  if (recsInWindow.length) {
    body.push({ type: 'separator', margin: 'sm' });
    body.push({ type: 'text', text: '代表片段', size: 'xxs', color: THEME.muted, margin: 'sm' });
    recsInWindow.slice(0, 3).forEach(r => {
      const txt = ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
      if (txt) body.push({ type: 'text', text: `· ${truncate_(txt, 40)}`, size: 'xs', color: THEME.text, wrap: true, maxLines: 2 });
    });
  }

  // 記寫時間分布 strip — 統一放 body 最末 (footer 之前) 以呼應 /recall、/ask、
  // /journey 等卡片的編排。X 軸 = 此脈絡完整生命期：✓ 視窗內、● 視窗外（同脈絡）、
  // ◯ 無紀錄。✓ 數對應卡上「本視窗 N 筆」。
  const ctxTsList = (allContextRecords || []).map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (ctxTsList.length) {
    const ctxStart = ctxTsList[0];
    const ctxEnd = ctxTsList[ctxTsList.length - 1];
    const winFrom = whole ? ctxStart : ((range && range.startMs) ? range.startMs : null);
    const winTo   = whole ? ctxEnd   : ((range && range.endMs != null) ? range.endMs : Date.now());
    body.push({ type: 'separator', margin: 'sm' });
    body.push(episodeTimelineStrip_({
      startTs: ctxStart,
      endTs: ctxEnd,
      records: allContextRecords,
      highlight: (winFrom != null) ? { fromTs: winFrom, toTs: winTo } : null,
      subLabel: `脈絡 ${formatClusterRange_(ctxStart, ctxEnd)}`,
      headPrefix: '所選主題群組'
    }));
  }

  // Footer — 按鈕依狀態給。Row 1 永遠是兩個敘事片段(主題視窗 / 全脈絡)；row 2 是
  // 主動作(補轉折 / 歷程現況),進行中脈絡沒有 row 2。
  const label16 = truncate_(title, 16);
  const btn = (label, primary, action) => ({
    type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', flex: 1,
    backgroundColor: primary ? THEME.cta : THEME.surfaceSoft,
    action: action,
    contents: [{ type: 'text', text: label, size: 'xs', align: 'center', weight: 'bold', color: primary ? THEME.onDark : THEME.cta }]
  });

  // 「看主題的敘事片段」帶上目前 /themes 視窗的時段範圍 → 進到 replyContextEpisodes_
  // 後依時段 filter records。`range.endMs` 若無就傳 0(沒上界)。
  const fromMs = (range && range.startMs) ? range.startMs : 0;
  const toMs   = (range && range.endMs != null) ? range.endMs : 0;
  const themeEpAct  = { type: 'postback', label: '主題敘事片段', data: `action=ctx_episodes&cid=${context.id}&from=${fromMs}${toMs ? '&to=' + toMs : ''}`, displayText: `▸ 主題敘事片段 · ${label16}` };
  const ctxEpAct    = { type: 'postback', label: '脈絡敘事片段', data: `action=ctx_episodes&cid=${context.id}`,                                            displayText: `▸ 脈絡敘事片段 · ${label16}` };
  const suppAct     = { type: 'postback', label: '補一轉折成歷程', data: `action=ctx_supplement&cid=${context.id}`,                                       displayText: `▸ 補一轉折成歷程 · ${label16}` };
  const storyLabel  = '歷程現況';   // 統一名（P1-D）：打開一條歷程的 in-LINE 完整視圖（journey_story），全卡同名
  const storyAct    = { type: 'postback', label: storyLabel, data: `action=journey_story&cid=${context.id}`,                                            displayText: `▸ ${storyLabel} · ${label16}` };

  // asNav（episode 輪播導覽卡）時 footer 不放敘事片段按鈕——episodes 已在同輪播後面。
  const footerRows = [];
  if (!asNav) {
    footerRows.push(whole
      ? { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [ btn('📂 全部敘事片段', false, ctxEpAct) ] }
      : { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          btn('看主題的敘事片段', false, themeEpAct),
          btn('看脈絡的敘事片段', false, ctxEpAct)
        ]});
  }
  if (isJourney) {
    footerRows.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: [btn(storyLabel, true, storyAct)] });
  } else if (isContext) {
    footerRows.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: [btn('補一轉折成歷程', true, suppAct)] });
  } else {
    // 進行中脈絡：條件式按鈕——只在使用者「現在能對症下藥」時才顯示，避免讓人按
    // 了沒效果。
    //   - 密度／媒介可以當下補（寫一段更聚焦的文字、上傳一個媒體）→ 補一筆按鈕
    //   - 回返本質要不同時段才能算，現在補不了 → 「之後再提醒」按鈕（隨機時間、依回返間隔規則）
    const cr = context.criteria || {};
    const C = CONTEXT_CRITERIA;
    const densOk = densityConditionMet_(cr);
    const visitOk = (cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin;
    const mediaOk = (cr.mediaKinds || 0) >= C.mediaKindsMin;
    if (!densOk || !mediaOk) {
      // 〔依缺項命名〕按鈕直接寫「在補哪一條」——顧密度／顧媒介（一看就知道要寫什麼），
      // 不用「撐到候選歷程」這種看不出要做什麼的結果式說法。媒介已 ✅ 就只說顧密度。
      const needs = []; if (!densOk) needs.push('密度'); if (!mediaOk) needs.push('媒介');
      const suppLabel = `補一筆顧${needs.join('／') || '密度'}`;
      const suppCandAct = { type: 'postback', label: suppLabel, data: `action=ctx_supp_cand&cid=${context.id}`, displayText: `▸ ${suppLabel} · ${label16}` };
      footerRows.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: [btn(suppLabel, true, suppCandAct)] });
    }
    if (!visitOk) {
      // 已排入提醒就顯示狀態、不再給可重複點的按鈕（免重複排程、省 push）。
      const rem = (scope && scope.key) ? getCandidateReminder_(scope, context.id) : null;
      if (rem && rem.dueTs > Date.now()) {
        const due = Utilities.formatDate(new Date(rem.dueTs), TIME_ZONE, 'MM/dd HH:mm');
        footerRows.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: [{
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
          contents: [{ type: 'text', text: `🔔 已排入提醒・約 ${due} 提醒你回來寫`, size: 'xxs', color: THEME.muted, align: 'center', wrap: true }]
        }] });
      } else {
        const remindAct = { type: 'postback', label: '之後提醒回返', data: `action=cand_remind&cid=${context.id}`, displayText: `▸ 之後再提醒我回返 · ${label16}` };
        // 只缺回返時提醒當 primary；同時缺密度/媒介時讓「補一筆」當 primary、提醒退到 secondary。
        const remindPrimary = densOk && mediaOk;
        footerRows.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm', contents: [btn('🔔 之後再提醒我回來寫一筆', remindPrimary, remindAct)] });
      }
    }
  }

  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: headerBg, paddingAll: 'md',
      contents: [
        kicker,
        { type: 'text', text: truncate_(title, 22), size: 'md', weight: 'bold', color: onHeader, wrap: true, margin: 'xs' },
        ...(titleSub ? [{ type: 'text', text: `依現況內容：${truncate_(titleSub, 24)}`, size: 'xxs', color: headerSub, wrap: true, margin: 'xs' }] : [])
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
  // footer 可能為空（asNav 導覽卡遇到三條件已齊、尚未升格的罕見候選）→ 省略 footer，避免空 box。
  if (footerRows.length) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'sm', contents: footerRows };
  }
  return bubble;
}

/** Default to 90 days when no arg; `all` = no time filter; session_<s>_<e> = explicit window. */
function resolveFocusRange_(arg) {
  const DAY = 86400000;
  if (!arg) return { startMs: Date.now() - 90 * DAY, label: '近 90 日' };
  const lower = arg.toLowerCase();
  if (lower === 'all'   || lower === '全部') return { startMs: 0, label: '全部' };
  // 「今日」= calendar day in TIME_ZONE (midnight → now), NOT a rolling 24h
  // window. Naming should match: a 6am-current user expects 今日 to mean
  // "since I woke up today", not "since 6am yesterday".
  if (lower === 'today' || lower === '今日') return { startMs: startOfTodayMs_(), label: '今日' };
  if (lower === 'week'  || lower === '本週') return { startMs: Date.now() - 7  * DAY,  label: '近 7 日' };
  if (lower === 'month' || lower === '本月') return { startMs: Date.now() - 30 * DAY,  label: '近 30 日' };
  const sess = lower.match(/^session_(\d+)_(\d+)$/);
  if (sess) {
    const startMs = parseInt(sess[1], 10);
    const endMs = parseInt(sess[2], 10);
    const label = formatSessionLabel_({ startTs: startMs, endTs: endMs });
    return { startMs, endMs, label: `區段 ${label}` };
  }
  const m = lower.match(/^(\d+)d?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0) return { startMs: Date.now() - n * DAY, label: `近 ${n} 日` };
  }
  return { startMs: Date.now() - 90 * DAY, label: '近 90 日' };
}

/** Midnight of today in TIME_ZONE, as ms since epoch. Done via Utilities so
 *  it respects the configured zone (Asia/Taipei etc.) rather than the GAS
 *  runtime's UTC. */
function startOfTodayMs_() {
  const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  return Utilities.parseDate(today + ' 00:00:00', TIME_ZONE, 'yyyy-MM-dd HH:mm:ss').getTime();
}

function pickFocusK_(n) {
  if (n < 10)  return 2;
  if (n < 50)  return 4;
  if (n < 200) return 6;
  return 8;
}

/**
 * K-means clustering by cosine similarity. For large N, iterates on a
 * random sample (size FOCUS_SAMPLE_SIZE) to keep run time bounded, then
 * does one O(N) pass to assign every record to the nearest converged
 * centroid. Result is the same shape: groups of records.
 */
/**
 * Deterministic PRNG (mulberry32) + stable per-corpus seed, so clustering is
 * reproducible: the same record set always yields the same clusters. Without
 * this, k-means's random init reshuffled 主題群組 on every run — making /themes and
 * /journey disagree and silently demoting/dropping already-formed 脈絡/歷程.
 */
function seededRng_(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a record set (FNV-1a over ids); changes only when the
 *  records themselves change. */
function recordsSeed_(records) {
  let h = 0x811c9dc5;
  for (const r of records) {
    const id = String((r && r.id) || '');
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return h >>> 0;
}

/** Fisher–Yates using a supplied RNG, then take the first n. */
function seededShuffleSlice_(arr, n, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out.slice(0, Math.min(n, out.length));
}

function kmeansCluster_(records, k) {
  if (records.length === 0) return [];
  if (records.length <= k) return records.map(r => [r]);

  // Deterministic: seed from the record set so identical input → identical clusters.
  const rng = seededRng_(recordsSeed_(records));
  let sample = records;
  if (records.length > FOCUS_SAMPLE_THRESHOLD) {
    sample = seededShuffleSlice_(records, FOCUS_SAMPLE_SIZE, rng);
  }

  // Initial centroids: k-means++（依距離平方加權挑種子，彼此盡量散開）。
  // 取代原本「隨機挑 k 個」——在 Gemini 短中文的窄 cosine 帶，隨機種子會塌成
  // 一個巨群 + 一堆小群（blob 製造機）。k-means++ 讓不同主題各自分到種子。
  // 仍走 seededRng_，故結果決定性。
  let centroids = kmeansppInit_(sample, k, rng);

  // K-means iterations on the sample only.
  const sampleAssign = new Array(sample.length).fill(-1);
  for (let iter = 0; iter < FOCUS_KMEANS_MAX_ITER; iter++) {
    let changed = false;
    for (let i = 0; i < sample.length; i++) {
      let best = 0, bestSim = -Infinity;
      for (let j = 0; j < k; j++) {
        const sim = cosineSim_(sample[i].embedding, centroids[j]);
        if (sim > bestSim) { bestSim = sim; best = j; }
      }
      if (sampleAssign[i] !== best) { sampleAssign[i] = best; changed = true; }
    }
    if (!changed) break;
    for (let j = 0; j < k; j++) {
      const members = [];
      for (let i = 0; i < sample.length; i++) {
        if (sampleAssign[i] === j) members.push(sample[i].embedding);
      }
      if (members.length) centroids[j] = meanVector_(members);
    }
  }

  // Final O(N) pass: assign every record (incl. ones outside the sample)
  // to its nearest converged centroid. Single iteration.
  const groups = Array.from({ length: k }, () => []);
  for (const r of records) {
    let best = 0, bestSim = -Infinity;
    for (let j = 0; j < k; j++) {
      const sim = cosineSim_(r.embedding, centroids[j]);
      if (sim > bestSim) { bestSim = sim; best = j; }
    }
    groups[best].push(r);
  }
  return groups.filter(g => g.length > 0);
}

/**
 * k-means++ 種子選取（cosine 距離 = 1 - cos）。第一顆隨機（seeded），之後每顆
 * 以「到最近已選種子的距離平方」加權隨機挑——種子彼此散開，避免塌成巨群。
 * 回傳 k 個 centroid 向量（embedding 複本）。rng 為 seeded，故決定性。
 */
function kmeansppInit_(sample, k, rng) {
  const n = sample.length;
  const centroids = [];
  const first = Math.floor(rng() * n);
  centroids.push(sample[first].embedding.slice());
  // 每點到「最近已選種子」的 cosine 距離（1 - 最大 cos），逐步更新。
  const dist = new Array(n);
  for (let i = 0; i < n; i++) dist[i] = 1 - cosineSim_(sample[i].embedding, centroids[0]);
  while (centroids.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += dist[i] * dist[i];
    let pick;
    if (total <= 1e-12) {
      pick = Math.floor(rng() * n);   // 全部幾乎重合 → 退回隨機
    } else {
      let threshold = rng() * total, acc = 0; pick = n - 1;
      for (let i = 0; i < n; i++) { acc += dist[i] * dist[i]; if (acc >= threshold) { pick = i; break; } }
    }
    centroids.push(sample[pick].embedding.slice());
    const last = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = 1 - cosineSim_(sample[i].embedding, last);
      if (d < dist[i]) dist[i] = d;     // 更新到最近種子的距離
    }
  }
  return centroids;
}

/** Return up to n random elements from arr (Fisher-Yates). */
function shuffleSlice_(arr, n) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out.slice(0, Math.min(n, out.length));
}

function meanVector_(vectors) {
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return sum;
}

/** Single Gemini call to name every cluster. Falls back to "主題 N" on failure. */
function labelClustersWithGemini_(clusters) {
  const sections = clusters.map((cluster, i) => {
    const samples = cluster.slice(0, 5).map(r => truncate_((r.text || '').replace(/\s+/g, ' '), 150));
    return `第 ${i + 1} 群（${cluster.length} 筆）：\n` + samples.map(s => `- ${s}`).join('\n');
  }).join('\n\n');

  const prompt = [
    `以下是 ${clusters.length} 群已聚類的學習紀錄。請為每群輸出兩樣，用 ||| 分隔：`,
    '1) 一個 10 字內、具體有代表性的繁中主題標籤。',
    '2) 這群最核心、最關鍵的一個問題 —— 必須緊扣這群紀錄實際在探究的事物（用裡面出現的具體概念 / 名詞），一句繁中問句、以「？」結尾、具體且可被回答，不要空泛或換句話說標籤。',
    '回覆格式每行一群，務必照此格式：',
    'Cluster 1: <主題> ||| <核心問題>',
    'Cluster 2: <主題> ||| <核心問題>',
    '...',
    '不要寫其他說明、不要編號重複、不要空話（如「學習」「研究」「分享」）。',
    '',
    '紀錄：',
    sections
  ].join('\n');

  let response;
  try {
    response = geminiGenerate_([{ text: prompt }], {
      systemInstruction: '你是學習主題分析師。主題與問題都要具體（寫出實際概念 / 名詞 / 領域），問題要直指該群在探究的核心。',
      temperature: 0.3,
      maxOutputTokens: 800
    });
  } catch (e) {
    console.warn('Cluster labeling failed:', e && e.message);
    return { labels: clusters.map((_, i) => `主題群組 ${i + 1}`), questions: clusters.map(() => '') };
  }

  const labels = clusters.map((_, i) => `主題群組 ${i + 1}`);
  const questions = clusters.map(() => '');
  for (const line of (response || '').split('\n')) {
    const m = line.match(/^[Cc]luster\s*(\d+)[:：\.\s]+(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < clusters.length) {
        const parts = m[2].split('|||');
        labels[idx] = parts[0].trim().slice(0, 30);
        if (parts[1]) questions[idx] = parts[1].trim().slice(0, 200);
      }
    }
  }
  return { labels, questions };
}

// 自適應時間區間文字：同分鐘只到秒、同日只到分、跨日帶月日、長跨度回到日期。讓 /themes
// 卡上的時間區間文字能對應使用者選的視窗精度（不再固定 yyyy/MM/dd → 11:47–11:50 視窗
// 全卡只看到「2026/05/25 — 2026/05/25」）。
function formatClusterRange_(startMs, endMs) {
  if (startMs == null || endMs == null) return '—';
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const span = Math.max(0, endMs - startMs);
  const fmt = (ts, p) => Utilities.formatDate(new Date(ts), TIME_ZONE, p);
  if (span < MIN) return fmt(startMs, 'HH:mm:ss');
  const sameDay = fmt(startMs, 'yyyyMMdd') === fmt(endMs, 'yyyyMMdd');
  if (sameDay) return fmt(startMs, 'HH:mm') + '–' + fmt(endMs, 'HH:mm');
  if (span < 30 * DAY) return fmt(startMs, 'MM/dd HH:mm') + '–' + fmt(endMs, 'MM/dd HH:mm');
  return fmt(startMs, 'MM/dd') + '–' + fmt(endMs, 'MM/dd');
}

// 短跨度文字（秒/分/時/天），給「(3 分)」「(2 天)」這種附註用。
function formatSpanShort_(ms) {
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} 分`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)} 時`;
  return `${Math.max(1, Math.round(ms / DAY))} 天`;
}

function buildFocusBubble_(label, question, cluster, total, idx, journeyKey, link, stripWindow) {
  const pct = (cluster.length / total * 100).toFixed(1);
  const samples = cluster.slice(0, 3)
    .map(r => '· ' + truncate_((r.text || '').replace(/\s+/g, ' '), 40))
    .join('\n');
  const tsList = cluster.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort();
  const clusterStart = tsList.length ? tsList[0] : null;
  const clusterEnd   = tsList.length ? tsList[tsList.length - 1] : null;
  const rangeText = formatClusterRange_(clusterStart, clusterEnd);
  const spanNote = (clusterStart != null && clusterEnd != null && clusterEnd > clusterStart)
    ? `（${formatSpanShort_(clusterEnd - clusterStart)}）` : '';

  const body = [
    { type: 'text', text: `${cluster.length} 筆 (${pct}%)`, size: 'md', weight: 'bold', color: THEME.cta },
    { type: 'text', text: `🕐 ${rangeText}${spanNote}`, size: 'xxs', color: THEME.muted, wrap: true }
  ];
  // 關鍵字 row（從重疊脈絡借過來）— 與歷程卡同一份字彙，視覺對齊。
  const kwRow = keywordChipsRow_(link && link.keywords);
  if (kwRow) body.push(kwRow);
  // 時間／資料密度 strip — 全卡共用 stripWindow 為 x 軸，所以同 /themes 視圖各卡可
  // 橫向比較（不再各算各的 span 導致 bucket 大小不同）。1 筆 cluster 也顯示一格 ●，
  // 呈現規則一致。subLabel 寫出視窗範圍，看 strip 就知道 x 軸對應到什麼時間。
  if (stripWindow) {
    body.push(episodeTimelineStrip_({
      startTs: stripWindow.startMs,
      endTs: stripWindow.endMs,
      records: cluster,
      subLabel: `視窗 ${formatClusterRange_(stripWindow.startMs, stripWindow.endMs)}`
    }));
  }
  // The cluster's core question — turns "a topic you keep returning to" into a
  // concrete, answerable inquiry the learner can choose to pursue. The 直接問這個
  // button sits right under it (not buried in the footer).
  if (question) {
    body.push({ type: 'separator', margin: 'sm' });
    body.push({ type: 'text', text: '🤔 這群在探究的核心問題', size: 'xxs', color: THEME.muted, margin: 'sm' });
    body.push({ type: 'text', text: question, size: 'sm', weight: 'bold', color: THEME.ink, wrap: true });
    body.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
      action: { type: 'message', label: '直接問這個', text: `/ask ${question}` },
      contents: [{ type: 'text', text: '💬 直接問這個', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
    });
  }
  body.push({ type: 'separator', margin: 'sm' });
  body.push({ type: 'text', text: '代表片段：', size: 'xs', color: THEME.muted, margin: 'sm' });
  body.push({ type: 'text', text: samples || '(無)', size: 'xs', color: THEME.text, wrap: true, maxLines: 4 });

  // Footer: browse the topic; when there's NO core question, the ask fallback
  // lives here (paired with browse); otherwise ask已在問題旁。
  const browseBtn = {
    type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', flex: 1,
    action: { type: 'message', label: '回想此片段', text: `/recall ${label}` },
    contents: [{ type: 'text', text: '回想此片段', size: 'xs', color: '#ffffff', align: 'center', weight: 'bold', wrap: true }]
  };
  const row1 = question ? [browseBtn] : [browseBtn, {
    type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', flex: 1,
    action: { type: 'message', label: '問問此片段', text: `/ask ${label}` },
    contents: [{ type: 'text', text: '問問此片段', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold', wrap: true }]
  }];

  const headerSub = `主題群組 ${idx + 1}${link && link.hasJourney ? ' · 🌳 已升格成歷程' : ''}`;
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: headerSub, size: 'xs', color: THEME.depth.l2.headerSub, wrap: true },
        { type: 'text', text: label, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: row1 },
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.surface, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
          action: { type: 'postback', label: '升格進度', data: `action=journey_cluster&k=${journeyKey}`, displayText: opEcho_('看升格進度', label) },
          contents: [{ type: 'text', text: '🌱 能不能成脈絡？看進度', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
        }
      ]
    }
  };
}

/* ============================================================================
 * 主題群組三層 UI（block 5）。見檔首說明。資料全讀持久脈絡（contexts.jsonl）。
 * ==========================================================================*/

// 大類 emoji（純視覺；大類清單以 JOURNEY_KEYWORD_CATEGORIES 為準，非 8 類者歸「其他」）。
const THEME_CATEGORY_ICON = {
  '教學': '📚', '研究': '🔬', '閱讀': '📖', '反思': '🪞',
  '札記': '📓', '生活': '🏡', '規劃': '🗓️', '隨想': '💭', '其他': '🗄️'
};
const THEME_STATUS_ICON  = { journey: '🌳', context: '🌿', candidate: '🌱' };
const THEME_STATUS_RANK  = { journey: 0, context: 1, candidate: 2 };
const THEME_TOPICS_PER_PAGE = 12;   // L1 完整主題清單每頁列數
const THEME_CARD_TOPICS = 5;        // L0 大類卡內預覽幾名主題（前幾名，單筆另開）

// 一條脈絡的「狀態色」：學習歷程綠 / 候選歷程藍 / 進行中脈絡橘。
function themeStatusColor_(status) {
  return status === 'journey' ? THEME.success : (status === 'context' ? THEME.cta : THEME.warning);
}

// 一條脈絡目前的顯示狀態：journey（學習歷程）/ context（候選歷程）/ candidate（進行中脈絡）。
function themeContextStatus_(context, journey) {
  if (journey && journey.status === 'journey') return 'journey';
  if (context && context.status === 'context') return 'context';
  return 'candidate';
}

// 三狀態「一張臉」：icon＋名稱＋色，全系統凡是顯示脈絡/歷程狀態都走這裡——同一個狀態跨卡
// 一律長同一張臉（修「同一狀態在 /journey 是 ⏳、通知裡是 🌱、L2 又是 🌿」的四面孔問題）。
// icon/色沿用既有單一真相 THEME_STATUS_ICON / themeStatusColor_，這裡只補正典名稱。
function stateBadge_(status) {
  const label = status === 'journey' ? '學習歷程' : (status === 'context' ? '候選歷程' : '進行中脈絡');
  return { icon: THEME_STATUS_ICON[status] || '🌱', label: label, color: themeStatusColor_(status) };
}

// 把脈絡 category 正規化到 8 大類之一，否則歸「其他」。
function themeNormCategory_(cat) {
  return (JOURNEY_KEYWORD_CATEGORIES.indexOf(cat) >= 0) ? cat : '其他';
}

/* ---- L0：大類瀏覽（一卡一大類的輪播，卡內預覽前幾名主題，單筆另開）---- */
function replyThemeCategories_(ctx) {
  // 入口跑一次升級（純 CPU、繞 3h 節流），把剛寫的訊息折進脈絡；翻層不重跑。
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 15); } catch (_) {}
  }
  try { maybeUpgradeContexts_(ctx.scope, true); } catch (e) { console.warn('themes upgrade failed:', e && e.message); }

  const contexts = loadContexts_(ctx.scope);
  if (!contexts.length) {
    return lineReply_(ctx.replyToken,
      '⚠️ 目前還沒有成形的主題群組。\n繼續記寫，背景會先把訊息歸到大類、再切出議題，這裡就會長出主題。');
  }
  const jrnByCtx = journeysByContext_(loadJourneys_(ctx.scope));

  // 每個大類收一份 { cat, topics:[{context,journey,status,count}], records, 狀態計數 }。
  const byCat = {};
  for (const c of contexts) {
    const cat = themeNormCategory_(c.category);
    const b = byCat[cat] || (byCat[cat] = { cat, topics: [], records: 0, journey: 0, context: 0, candidate: 0 });
    const j = jrnByCtx[c.id] || null;
    const status = themeContextStatus_(c, j);
    const count = (c.recordIds || []).length;
    b.topics.push({ context: c, journey: j, status, count });
    b.records += count;
    b[status]++;
  }
  const order = JOURNEY_KEYWORD_CATEGORIES.concat(['其他']);
  const cats = order.filter(c => byCat[c]).map(c => byCat[c]);
  const totalTopics = cats.reduce((s, b) => s + b.topics.length, 0);
  const totalRecords = cats.reduce((s, b) => s + b.records, 0);

  // intro 卡當輪播第 0 張（與 /recall 概覽同款 index=0 設計）。8 大類 + intro = 9 張，
  // 在 LINE carousel 12 上限內。所有 bubble size 一致為 kilo，無 size 混搭錯誤。
  const totalJ = cats.reduce((s, b) => s + b.journey, 0);
  const totalC = cats.reduce((s, b) => s + b.context, 0);
  const totalCa = cats.reduce((s, b) => s + b.candidate, 0);
  const freshFn = makeContextFreshFn_(contexts, (loadChatMeta_(ctx.scope).rehomedSignatures || {}));
  // 含 fresh topic 的大類置頂（同類內 fresh 卡已置頂；這層讓含 fresh 的大類也卡先見）。
  cats.sort((a, b) => {
    const fa = a.topics.some(t => freshFn(t.context)) ? 0 : 1;
    const fb = b.topics.some(t => freshFn(t.context)) ? 0 : 1;
    return fa - fb;
  });
  // 「最近更新」＝成員真的變動過的最新時間（max updatedAt）。upgradeContexts_ 只在成員改變時
  // 才 bump updatedAt，所以這個值在「進 themes 沒折到新東西」時會維持舊時間，不會每次都「剛剛」。
  let lastChangeMs = 0;
  contexts.forEach(c => { const t = Date.parse(c.updatedAt || 0); if (t > lastChangeMs) lastChangeMs = t; });
  // 「處理中」= 有 embedding 但還沒在任何脈絡的 records（未分類 / 已分類但未升格），給使用者
  // 「我剛寫的還沒整進來」一個明確的數字。排除收藏 / 裸連結。
  const linkIntent = loadChatMeta_(ctx.scope).linkIntent || {};
  const allRecs = loadEmbeddingRecords_(ctx.scope);
  const inCtxs = new Set();
  contexts.forEach(c => (c.recordIds || []).forEach(id => inCtxs.add(id)));
  const pendingCount = allRecs.filter(r =>
    r.embedding && r.embedding.length === EMBED_DIM
      && !isCollectionRecord_(r, linkIntent)
      && (!r.category || !r.topicLabel || !inCtxs.has(r.id))
  ).length;
  const introCard = buildThemesIntroCard_(cats.length, totalTopics, totalRecords, totalJ, totalC, totalCa, lastChangeMs, pendingCount);
  // 探索來源查找器：複用上面已載的 allRecs（不重載），讓每張大類卡的主題列標「來自哪段探索」。
  const expoLookup = buildExplorationLookup_(ctx.scope, allRecs);
  const allBubbles = [introCard].concat(cats.map(b => buildThemeCategoryCard_(b, freshFn, expoLookup)));
  const contents = { type: 'carousel', contents: allBubbles };
  lineReplyFlex_(ctx.replyToken,
    `主題群組 · ${cats.length} 大類 / ${totalTopics} 主題 / ${totalRecords} 筆`,
    contents);
}

/** /themes 輪播第 0 張：圖例 + 計數摘要 + 導航提示，視覺與 8 大類卡對齊（kilo + CTA header）。 */
function buildThemesIntroCard_(catN, topicN, recordN, journeyN, contextN, candidateN, lastChangeMs, pendingCount) {
  const legendRow = (icon, label, n, color) => ({
    type: 'box', layout: 'baseline', spacing: 'sm', margin: 'xs', contents: [
      { type: 'text', text: icon, size: 'md', flex: 0, color: color },
      { type: 'text', text: label, size: 'sm', weight: 'bold', color: color, flex: 0 },
      { type: 'text', text: `${n} 條`, size: 'xs', color: THEME.muted, flex: 1, align: 'end' }
    ]
  });
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: String(topicN), size: '3xl', weight: 'bold', color: THEME.cta, flex: 0 },
      { type: 'text', text: '主題', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' },
      { type: 'text', text: `／ ${catN} 大類 · ${recordN} 筆`, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', gravity: 'bottom' }
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '三狀態（越往下越成形）', size: 'xxs', color: THEME.muted, margin: 'md' },
    legendRow('🌳', '學習歷程', journeyN, THEME.success),
    legendRow('🌿', '候選歷程', contextN || 0, THEME.cta),
    legendRow('🌱', '進行中脈絡', candidateN || 0, THEME.warning),
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '👉 滑右邊 → 點大類', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' },
    { type: 'text', text: '→ 看底下主題 → 看主題詳情', size: 'xs', color: THEME.textBody, wrap: true },
    { type: 'separator', margin: 'md' }
  ];
  // 「更新時間」行根據 pending 狀態切換語意：
  //   pending > 0 → 預計下次背景整理時間（背景 sweep 每 5 分跑一次，往上 round 到下個 5 分）
  //   pending = 0 → 上次更新時間（max context.updatedAt）
  // 都用月日時格式 "MM/dd HH:mm"——一眼分得清哪天、不會看一下就變動。
  const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  if (pendingCount > 0) {
    const nextSweepMs = Math.ceil(Date.now() / SWEEP_INTERVAL_MS) * SWEEP_INTERVAL_MS;
    body.push({
      type: 'text',
      text: `預計下次更新：${Utilities.formatDate(new Date(nextSweepMs), TIME_ZONE, 'MM/dd HH:mm')}`,
      size: 'xxs', color: THEME.textDim, margin: 'md', wrap: true
    });
    // 等待整理整塊＝按鈕（點＝立即整理，不等下次 sweep）。
    body.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceWarm,
      cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
      action: { type: 'postback', label: '立即整理',
        data: 'action=themes_refresh', displayText: '▸ 立即整理主題群組' },
      contents: [
        { type: 'text', text: `🔄 ${pendingCount} 筆等待整理`, size: 'xs', color: THEME.warning, weight: 'bold', wrap: true },
        { type: 'text', text: '點此立即分類 + 整入主題 ›', size: 'xxs', color: THEME.warning, margin: 'xs' }
      ]
    });
  } else {
    body.push({
      type: 'text',
      text: lastChangeMs
        ? `上次更新時間：${Utilities.formatDate(new Date(lastChangeMs), TIME_ZONE, 'MM/dd HH:mm')}`
        : '尚未形成主題',
      size: 'xxs', color: THEME.textDim, margin: 'md', wrap: true
    });
  }
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['／themes', '大類總覽'], THEME.depth.l1),
        { type: 'text', text: '🗂', size: 'xxl', color: THEME.onDark, align: 'center' },
        { type: 'text', text: '主題群組', size: 'md', weight: 'bold', color: THEME.onDark, align: 'center', margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

/** 一張大類卡：header（大類＋筆數＋狀態組成）＋ 前幾名主題列（單筆排除）＋
 *  footer 鈕（全部主題 / N 個單筆）。每條主題列點進去看該主題全部記錄（L2）。 */
function buildThemeCategoryCard_(b, freshFn, expoLookup) {
  freshFn = freshFn || function () { return false; };
  const icon = THEME_CATEGORY_ICON[b.cat] || '🗄️';
  // 排序：fresh 先（任何 count）→ fresh 內按 lastTs 新→舊 → 非 fresh 按 count 大→小
  // → 同 count 升格高者優先。preview rows 的視覺順序＝同卡內最新動過的主題自然置頂。
  const ranked = b.topics.slice().sort((x, y) => {
    const fx = freshFn(x.context) ? 0 : 1;
    const fy = freshFn(y.context) ? 0 : 1;
    if (fx !== fy) return fx - fy;
    if (fx === 0) {
      const tx = Date.parse(x.context.lastTs || 0);
      const ty = Date.parse(y.context.lastTs || 0);
      if (tx !== ty) return ty - tx;   // fresh 之間：最近 lastTs 在前
    }
    return (y.count - x.count) || (THEME_STATUS_RANK[x.status] - THEME_STATUS_RANK[y.status]);
  });
  // preview 候選＝多筆主題（≥ 2 筆）OR fresh 單筆（新動的單筆不該被「≥2」過濾掉）。
  // 全空才退而從 ranked 取（顯示前 N 個，免空卡）。
  const eligible = ranked.filter(t => t.count >= 2 || freshFn(t.context));
  const preview = (eligible.length ? eligible : ranked).slice(0, THEME_CARD_TOPICS);
  const moreTotal = b.topics.length - preview.length;
  const multiTotal = ranked.filter(t => t.count >= 2).length;
  const singlesTotal = ranked.filter(t => t.count < 2).length;

  const statusBits = [];
  if (b.journey)   statusBits.push(`🌳${b.journey}`);
  if (b.context)   statusBits.push(`🌿${b.context}`);
  if (b.candidate) statusBits.push(`🌱${b.candidate}`);

  const topicRow = (t) => {
    const c = t.context;
    const title = c.userTitle || (t.journey && t.journey.title) || c.label || '未命名';
    const fresh = freshFn(c);
    const span = spanLabel_(c.firstTs, c.lastTs);
    const expoN = expoLookup ? expoLookup.count(c.recordIds) : 0;
    // 標題＋（資料區間 · 探索筆數）兩行：第二行小灰字墊在標題下，不和 icon／✨／筆數搶
    // 水平空間。🎒 N 探索訊息＝該主題內有幾則是在某段 explore 裡寫的，純 metadata。
    let meta = span || '';
    if (expoN > 0) meta += (meta ? ' · ' : '') + '🎒 ' + expoN + ' 探索訊息';
    const titleCell = {
      type: 'box', layout: 'vertical', flex: 1,
      contents: [
        { type: 'text', text: truncate_(title, 16), size: 'sm', color: THEME.ink, wrap: true }
      ]
    };
    if (meta) titleCell.contents.push({ type: 'text', text: meta, size: 'xxs', color: THEME.muted, wrap: false });
    const contents = [
      { type: 'text', text: stateBadge_(t.status).icon, size: 'sm', flex: 0, gravity: 'center', color: themeStatusColor_(t.status) },
      titleCell
    ];
    if (fresh) contents.push({ type: 'text', text: '✨', size: 'xxs', flex: 0, gravity: 'center', color: THEME.warning });
    contents.push({ type: 'text', text: `${t.count} ›`, size: 'xs', color: THEME.cta, weight: 'bold', flex: 0, align: 'end', gravity: 'center' });
    return {
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'xs', margin: 'xs',
      action: { type: 'postback', label: truncate_(title, 18), data: `action=theme_topic&cid=${c.id}`, displayText: opEcho_('主題', title) },
      contents: contents
    };
  };

  const body = [{ type: 'text', text: statusBits.join('   ') || '—', size: 'xs', color: THEME.muted }];
  if (!ranked.length) {
    body.push({ type: 'text', text: '（還沒有主題）', size: 'xs', color: THEME.muted, margin: 'sm' });
  } else if (!multiTotal) {
    body.push({ type: 'text', text: '此大類目前都是單筆主題', size: 'xxs', color: THEME.muted, margin: 'sm' });
  }
  body.push({ type: 'separator', margin: 'sm' });
  preview.forEach(t => body.push(topicRow(t)));

  const catEnc = encodeURIComponent(b.cat);
  const chip = (text, data, primary) => ({
    type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', flex: 1,
    backgroundColor: primary ? THEME.cta : THEME.surfaceSoft,
    action: { type: 'postback', label: truncate_(text, 18), data: data, displayText: opEcho_(text) },
    contents: [{ type: 'text', text: text, size: 'xs', align: 'center', weight: 'bold', color: primary ? THEME.onDark : THEME.cta, wrap: true }]
  });
  const chips = [];
  if (moreTotal > 0) chips.push(chip(`全部 ${b.topics.length} 主題`, `action=theme_cat&cat=${catEnc}`, true));
  // 單筆鈕只在「卡內已有 ≥2 筆主題、單筆被藏起來」時出現，標真實單筆總數（全是單筆的大類
  // 已退而把單筆顯示在卡內，由「全部主題」涵蓋，不再另立單筆鈕）。
  if (multiTotal > 0 && singlesTotal > 0) chips.push(chip(`🌱 ${singlesTotal} 單筆`, `action=theme_singles&cat=${catEnc}`, false));

  const card = {
    type: 'bubble', size: 'kilo',
    header: (function () {
      const freshN = b.topics.filter(t => freshFn(t.context)).length;
      const sub = freshN > 0
        ? `${b.topics.length} 主題 · ${b.records} 筆 · ✨ ${freshN} 本次`
        : `${b.topics.length} 主題 · ${b.records} 筆`;
      return {
        type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
        contents: [
          { type: 'text', text: `${icon} ${b.cat}`, size: 'lg', weight: 'bold', color: THEME.onDark },
          { type: 'text', text: sub, size: 'xxs', color: THEME.depth.l1.headerSub, margin: 'xs', wrap: true }
        ]
      };
    })(),
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'xs', contents: body }
  };
  if (chips.length) card.footer = { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm', contents: chips };
  return card;
}

/* ---- L1：某大類的完整主題清單（「全部主題」入口；輪播：一卡一主題） ---- */
function replyThemeCategory_(ctx, cat, page) {
  page = page || 0;
  const wantCat = themeNormCategory_(cat);
  const contexts = loadContexts_(ctx.scope).filter(c => themeNormCategory_(c.category) === wantCat);
  if (!contexts.length) {
    return lineReply_(ctx.replyToken, `「${cat}」目前沒有主題。回 /themes 看其他大類。`);
  }
  const jrnByCtx = journeysByContext_(loadJourneys_(ctx.scope));

  const entries = contexts.map(c => {
    const j = jrnByCtx[c.id] || null;
    return { context: c, journey: j, status: themeContextStatus_(c, j), count: (c.recordIds || []).length };
  });
  // 按筆數降序；同筆數升格高者先（journey > context > candidate）。
  entries.sort((a, b) => (b.count - a.count) || (THEME_STATUS_RANK[a.status] - THEME_STATUS_RANK[b.status]));

  const totalRecords = entries.reduce((s, e) => s + e.count, 0);
  // L1 改為「一卡一主題」輪播；LINE carousel 12 上限，扣掉 pager 另發訊息，這裡每頁 10 張。
  const PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
  page = Math.max(0, Math.min(totalPages - 1, page));
  const pageEntries = entries.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const icon = THEME_CATEGORY_ICON[wantCat] || '🗄️';
  const multiCount = entries.filter(e => e.count >= 2).length;
  const singleCount = entries.length - multiCount;
  // intro 卡當輪播 index=0（與 L0 同套）
  const introCard = buildThemeCategoryIntroCard_(wantCat, icon, entries.length, totalRecords, multiCount, singleCount, page, totalPages);
  const l1FreshFn = makeContextFreshFn_(loadContexts_(ctx.scope), (loadChatMeta_(ctx.scope).rehomedSignatures || {}));
  const expoLookup = buildExplorationLookup_(ctx.scope);
  const topicCards = pageEntries.map(e => buildThemeTopicCard_(wantCat, e, l1FreshFn, expoLookup));
  const allBubbles = [introCard].concat(topicCards);
  const carousel = { type: 'carousel', contents: allBubbles };
  const altText = `${wantCat} · ${entries.length} 主題 / ${totalRecords} 筆` + (totalPages > 1 ? `（第 ${page + 1}/${totalPages} 頁）` : '');

  const messages = [
    { type: 'flex', altText: altText, contents: carousel }
  ];
  // pager bubble 上多掛一顆「‹ 返回大類」按鈕，讓 L1 ↔ L0 隨時往回（取代原本在卡上的列）。
  const catEnc = encodeURIComponent(wantCat);
  const pagerBubble = buildPaginationBubble_(
    `👉 ${wantCat}（${entries.length} 主題 / ${totalPages} 頁）`,
    page, totalPages,
    p => `action=theme_cat&cat=${catEnc}&p=${p}`
  );
  // append a 返回大類 button row to the pager bubble's footer
  const backRow = { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: '返回大類', data: 'action=theme_home', displayText: '▸ 主題群組 · 大類總覽' },
    contents: [{ type: 'text', text: '‹ 返回大類總覽', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }] };
  if (pagerBubble && pagerBubble.footer && pagerBubble.footer.contents) {
    pagerBubble.footer.contents.push(backRow);
  } else if (pagerBubble) {
    pagerBubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [backRow] };
  }
  messages.push({ type: 'flex', altText: totalPages > 1 ? `分頁（第 ${page + 1}/${totalPages} 頁）` : '返回大類', contents: pagerBubble });
  lineReplyMessages_(ctx.replyToken, messages);
}

/** 一張主題卡（L1 輪播用）：header（麵包屑：大類）／body（狀態 icon+標籤＋標題＋筆數＋摘要）／footer（看主題詳情）。 */
function buildThemeTopicCard_(cat, e, freshFn, expoLookup) {
  const c = e.context;
  const title = c.userTitle || (e.journey && e.journey.title) || c.label || '未命名';
  const icon = THEME_CATEGORY_ICON[cat] || '🗄️';
  // 三狀態一張臉：與 L0 預覽列、L2 詳情、/journey、/me 同 icon/同名（修舊版 L0/L1 把候選歷程
  // 與進行中脈絡都壓成 🌿「進行中」、下鑽到 L2 又變 🌱 的對不上）。
  const sb = stateBadge_(e.status);
  const sIcon = sb.icon;
  const sLabel = e.status === 'journey' ? '學習歷程現況' : sb.label;
  const sColor = sb.color;

  const fresh = freshFn ? freshFn(c) : false;
  const countTxt = fresh ? `${e.count} 筆 · ✨${relativeAgoText_(c.lastTs)}` : `${e.count} 筆`;
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: sIcon, size: 'md', flex: 0, color: sColor },
      { type: 'text', text: sLabel, size: 'xs', weight: 'bold', color: sColor, flex: 0 },
      { type: 'text', text: countTxt, size: 'xxs', color: fresh ? THEME.warning : THEME.muted, flex: 1, align: 'end', wrap: true }
    ]},
    { type: 'text', text: title, size: 'md', weight: 'bold', color: THEME.ink, wrap: true, maxLines: 2, margin: 'sm' }
  ];
  const span = spanLabel_(c.firstTs, c.lastTs);
  if (span) body.push({ type: 'text', text: '📅 ' + span, size: 'xxs', color: THEME.muted, margin: 'xs' });
  const expoN = expoLookup ? expoLookup.count(c.recordIds) : 0;
  if (expoN > 0) body.push({ type: 'text', text: '🎒 含 ' + expoN + ' 則探索訊息', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
  if (e.journey && e.journey.summary) {
    body.push({ type: 'text', text: truncate_(e.journey.summary, 70), size: 'xs', color: THEME.textBody, wrap: true, maxLines: 3, margin: 'sm' });
  } else if (e.count < 2) {
    body.push({ type: 'text', text: '單筆主題（還在累積中）', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
  }

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: `🗂 主題群組 › ${icon} ${cat}`, size: 'xxs', color: THEME.depth.l2.headerSub, wrap: true },
        { type: 'text', text: '主題', size: 'xs', color: THEME.onDark, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
      action: { type: 'postback', label: truncate_(title, 18), data: `action=theme_topic&cid=${c.id}`, displayText: opEcho_('主題', title) },
      contents: [{ type: 'text', text: '看主題詳情 ›', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
    }]}
  };
}

/** L1 全部主題輪播 index=0：麵包屑＋計數＋導航。視覺與主題卡對齊（kilo + CTA header）。 */
function buildThemeCategoryIntroCard_(cat, icon, topicN, recordN, multiN, singleN, page, totalPages) {
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: String(topicN), size: '3xl', weight: 'bold', color: THEME.cta, flex: 0 },
      { type: 'text', text: '主題', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' },
      { type: 'text', text: `／ ${recordN} 筆`, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', gravity: 'bottom' }
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md', contents: [
      { type: 'text', text: `多筆主題 ${multiN}`, size: 'xs', color: THEME.cta, flex: 1, weight: 'bold' },
      { type: 'text', text: `🌱 單筆 ${singleN}`, size: 'xs', color: THEME.warning, flex: 0 }
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '👉 滑右邊看主題、點開看詳情　·　← 回大類按下方分頁卡', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' }
  ];
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🗂 主題群組', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: `${icon} ${cat}`, size: 'md', weight: 'bold', color: THEME.onDark, margin: 'xs' },
        { type: 'text', text: totalPages > 1 ? `主題清單 · 第 ${page + 1}/${totalPages} 頁` : '主題清單（按筆數）', size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

/** 單筆主題輪播 index=0：麵包屑＋計數＋導航。 */
function buildThemeSinglesIntroCard_(cat, icon, singleN, page, totalPages, strip) {
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: '🌱', size: 'xxl', flex: 0, color: THEME.warning },
      { type: 'text', text: String(singleN), size: '3xl', weight: 'bold', color: THEME.warning, flex: 0 },
      { type: 'text', text: '個單筆主題', size: 'xs', color: THEME.muted, flex: 1, gravity: 'bottom' }
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '只寫過一筆的零星主題（按時間新→舊）', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '👉 滑右邊點開看那一筆內容', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' }
  ];
  if (strip) { body.push({ type: 'separator', margin: 'md' }); body.push(strip); }  // 記寫時間分布示意
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: `🗂 主題群組 › ${icon} ${cat}`, size: 'xxs', color: THEME.depth.l2.headerSub, wrap: true },
        { type: 'text', text: '🌱 單筆主題', size: 'md', weight: 'bold', color: THEME.onDark, margin: 'xs' },
        { type: 'text', text: totalPages > 1 ? `第 ${page + 1}/${totalPages} 頁` : '一頁全列', size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

// dead-stub kept to avoid breaking older callers; replaced by buildThemeTopicCard_ + L1 carousel.
function buildThemeTopicListBubble_(cat /*, entries, totalTopics, totalRecords, page, totalPages */) {
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [{ type: 'text', text: `${THEME_CATEGORY_ICON[cat] || '🗄️'} ${cat || ''}（此卡式已棄用，請重新 /themes）`, size: 'xxs', color: THEME.onDark, wrap: true }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [{ type: 'text', text: '回 /themes 重新進入', size: 'sm', color: THEME.text }] }
  };
}

/* ---- L2：單一主題詳情 → 直接給 episode 輪播（導覽卡＝主題詳情卡本身） ---- */
function replyThemeTopic_(ctx, cid) {
  // 從 /themes 點主題後直接出現「導覽卡＋瀏覽卡」：不再先回一張獨立主題詳情卡、再讓使用者
  // 點『全部敘事片段』（多一步、且詳情卡會重複出現）。導覽卡＝replyContextEpisodes_ 內以
  // buildContextCard_ 產出的主題詳情卡（footer 依狀態精簡、不放敘事片段按鈕）。
  return replyContextEpisodes_(ctx, cid, {});
}

/* ---- 單筆主題清單（L0 大類卡的「N 單筆」入口）：只列 1 筆的主題，點進去看那一筆 ---- */
function replyThemeCategorySingles_(ctx, cat, page) {
  page = page || 0;
  const wantCat = themeNormCategory_(cat);
  const jrnByCtx = journeysByContext_(loadJourneys_(ctx.scope));
  const singles = loadContexts_(ctx.scope)
    .filter(c => themeNormCategory_(c.category) === wantCat && (c.recordIds || []).length < 2)
    .map(c => ({ context: c, journey: jrnByCtx[c.id] || null, status: themeContextStatus_(c, jrnByCtx[c.id]), count: (c.recordIds || []).length }));
  if (!singles.length) {
    return lineReply_(ctx.replyToken, `「${cat}」目前沒有單筆主題。`);
  }
  // 單筆多是零星，照時間新 → 舊較直覺。
  singles.sort((a, b) => Date.parse(b.context.lastTs || b.context.firstTs || 0) - Date.parse(a.context.lastTs || a.context.firstTs || 0));

  // 一卡一單筆主題輪播（與 L1 一致）。10/頁，pager 另發訊息。
  const PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(singles.length / PER_PAGE));
  page = Math.max(0, Math.min(totalPages - 1, page));
  const pageItems = singles.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const icon = THEME_CATEGORY_ICON[wantCat] || '🗄️';
  // 單筆主題的記寫時間分布：彙整這些單筆的記錄，導覽卡也標出何時寫的（無焦點 → 全部以 ● 中性顯示）。
  const singleRecIds = {};
  singles.forEach(s => (s.context.recordIds || []).forEach(id => { singleRecIds[id] = 1; }));
  const singleRecs = loadEmbeddingRecords_(ctx.scope).filter(r => r && r.ts && singleRecIds[r.id]);
  const sTs = singleRecs.map(r => Date.parse(r.ts)).filter(t => !isNaN(t));
  const sStart = sTs.length ? Math.min.apply(null, sTs) : 0;
  const sEnd = sTs.length ? Math.max.apply(null, sTs) : 0;
  const singlesStrip = (sEnd > sStart) ? episodeTimelineStrip_({
    startTs: sStart, endTs: sEnd, records: [], otherRecords: singleRecs,
    headText: `單筆主題記寫時間分布 · ${formatClusterRange_(sStart, sEnd)}`
  }) : null;
  const introCard = buildThemeSinglesIntroCard_(wantCat, icon, singles.length, page, totalPages, singlesStrip);
  const singlesFreshFn = makeContextFreshFn_(loadContexts_(ctx.scope), (loadChatMeta_(ctx.scope).rehomedSignatures || {}));
  const expoLookup = buildExplorationLookup_(ctx.scope);
  const topicCards = pageItems.map(it => buildThemeTopicCard_(wantCat, it, singlesFreshFn, expoLookup));
  const allBubbles = [introCard].concat(topicCards);
  const carousel = { type: 'carousel', contents: allBubbles };

  const catEnc = encodeURIComponent(wantCat);
  const pagerBubble = buildPaginationBubble_(
    `👉 ${wantCat}·單筆（${singles.length} 個 / ${totalPages} 頁）`,
    page, totalPages,
    p => `action=theme_singles&cat=${catEnc}&p=${p}`
  );
  const backRow = { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: '返回大類', data: 'action=theme_home', displayText: '▸ 主題群組 · 大類總覽' },
    contents: [{ type: 'text', text: '‹ 返回大類總覽', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }] };
  if (pagerBubble && pagerBubble.footer && pagerBubble.footer.contents) {
    pagerBubble.footer.contents.push(backRow);
  } else if (pagerBubble) {
    pagerBubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [backRow] };
  }
  const altText = `${wantCat} · ${singles.length} 個單筆主題` + (totalPages > 1 ? `（第 ${page + 1}/${totalPages} 頁）` : '');
  lineReplyMessages_(ctx.replyToken, [
    { type: 'flex', altText: altText, contents: carousel },
    { type: 'flex', altText: totalPages > 1 ? `分頁（第 ${page + 1}/${totalPages} 頁）` : '返回大類', contents: pagerBubble }
  ]);
}

function buildThemeSinglesBubble_(cat, items, total, page, totalPages) {
  const icon = THEME_CATEGORY_ICON[cat] || '🗄️';
  const itemRow = (it) => {
    const c = it.context;
    const title = c.userTitle || (it.journey && it.journey.title) || c.label || '未命名';
    const when = c.lastTs ? Utilities.formatDate(new Date(c.lastTs), TIME_ZONE, 'MM/dd') : '';
    return {
      type: 'box', layout: 'horizontal', backgroundColor: THEME.surface, cornerRadius: 'md',
      paddingAll: 'md', margin: 'sm', spacing: 'sm',
      action: { type: 'postback', label: truncate_(title, 18), data: `action=theme_topic&cid=${c.id}`, displayText: opEcho_('主題', title) },
      contents: [
        { type: 'text', text: THEME_STATUS_ICON[it.status] || '🌱', size: 'md', flex: 0, gravity: 'center', color: themeStatusColor_(it.status) },
        { type: 'text', text: truncate_(title, 18), size: 'sm', color: THEME.ink, flex: 1, wrap: true, gravity: 'center' },
        { type: 'text', text: when ? `${when} ›` : '›', size: 'xxs', color: THEME.muted, align: 'end', gravity: 'center', flex: 0 }
      ]
    };
  };

  const contents = [
    { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '‹ 返回大類', size: 'xs', color: THEME.cta, weight: 'bold', flex: 0,
        action: { type: 'postback', label: '返回大類', data: 'action=theme_home', displayText: '▸ 主題群組 · 大類總覽' } },
      { type: 'text', text: `${total} 個單筆`, size: 'xxs', color: THEME.muted, align: 'end', flex: 1, gravity: 'center' }
    ]},
    { type: 'separator', margin: 'md' }
  ];
  items.forEach(it => contents.push(itemRow(it)));

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: `${icon} ${cat}·單筆主題`, size: 'md', weight: 'bold', color: THEME.onDark },
        { type: 'text', text: totalPages > 1 ? `只記到一筆的主題 · 第 ${page + 1}/${totalPages} 頁` : '只記到一筆的主題', size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents }
  };
}

/* ============================================================================
 * 手動「歸到某主題」(must-link override)。記錄詳情卡的「📌 歸到某主題」進這裡：
 * 依語意相近列現有主題 → 一鍵把該筆的 (大類,議題標籤) 改成目標主題、釘住、立即重分群。
 * 機器判錯時的硬保證；也用來救「明明是延續卻沒被編進」的紀錄。
 * ==========================================================================*/

// 算每條脈絡的群心（成員 embedding 平均）。recById = id→record。回傳 [{context, centroid}]，
// 只含有有效成員 embedding 的脈絡。亦供向量輔助分類共用。
function contextCentroids_(contexts, recById) {
  const out = [];
  for (const c of contexts) {
    const embs = (c.recordIds || [])
      .map(id => recById[id])
      .filter(r => r && r.embedding && r.embedding.length === EMBED_DIM)
      .map(r => r.embedding);
    if (embs.length) out.push({ context: c, centroid: meanVector_(embs) });
  }
  return out;
}

// 向量輔助分類（block 5+）用的「夠相近才給提示」門檻。Gemini 短中文 cosine 是窄帶，
// 低於此就別給提示、免得誤導 LLM（CONTEXT_CRITERIA.semanticDensityMin=0.60 同量級參考）。
const CONTEXT_HINT_SIM_FLOOR = 0.55;

/**
 * 給每個 record 找「語意最接近的現有脈絡」當分類提示——輔助 LLM 認出「延續舊主題」。
 * centroidList = contextCentroids_() 的結果（呼叫端算一次、各片段重用）。
 * restrictCategory：非空時只在該大類的脈絡裡找（議題階段用）；null = 全部脈絡（大類階段）。
 * 回傳 { [recordId]: { label, category, sim } }，只收 sim ≥ FLOOR 的（太遠不給）。
 */
function nearestContextHints_(records, centroidList, restrictCategory) {
  const pool = restrictCategory
    ? centroidList.filter(cc => themeNormCategory_(cc.context.category) === themeNormCategory_(restrictCategory))
    : centroidList;
  if (!pool.length) return {};
  const out = {};
  for (const r of records) {
    if (!r || !r.embedding || r.embedding.length !== EMBED_DIM) continue;
    let best = null, bestSim = -1;
    for (const cc of pool) {
      const s = cosineSim_(r.embedding, cc.centroid);
      if (s > bestSim) { bestSim = s; best = cc.context; }
    }
    if (best && bestSim >= CONTEXT_HINT_SIM_FLOOR) {
      out[r.id] = { label: best.userTitle || best.label || '', category: best.category || '', sim: bestSim };
    }
  }
  return out;
}

// 把所有脈絡按「與給定 embedding 的語意相近」排序（無 embedding 時退時間新→舊），供改歸選單共用。
function rankContextsBySim_(scope, embedding, excludeIds) {
  const records = loadEmbeddingRecords_(scope);
  let contexts = loadContexts_(scope);
  if (excludeIds && excludeIds.length) {                 // 排除「自己原本的主題」，改歸選單不列現屬脈絡
    const ex = {}; excludeIds.forEach(id => { ex[id] = true; });
    contexts = contexts.filter(c => !ex[c.id]);
  }
  const recById = {}; records.forEach(r => { recById[r.id] = r; });
  const jrnByCtx = journeysByContext_(loadJourneys_(scope));
  const hasEmb = !!(embedding && embedding.length === EMBED_DIM);
  const simById = {};
  if (hasEmb) contextCentroids_(contexts, recById).forEach(cc => { simById[cc.context.id] = cosineSim_(embedding, cc.centroid); });
  const entries = contexts.map(c => ({
    context: c, journey: jrnByCtx[c.id] || null, status: themeContextStatus_(c, jrnByCtx[c.id]),
    count: (c.recordIds || []).length, sim: (simById[c.id] != null) ? simById[c.id] : -1
  }));
  if (hasEmb) entries.sort((a, b) => b.sim - a.sim);
  else entries.sort((a, b) => Date.parse(b.context.lastTs || 0) - Date.parse(a.context.lastTs || 0));
  return { entries, hasEmb };
}

// 改歸選單的分頁＋送出（記錄改歸 / 整段改歸共用）。rowDataFn(contextId)→列的 postback data；
// pagerDataFn(p)→換頁 data。
function paginateTopicPicker_(ev, entries, hasEmb, page, headerText, subjectLine, rowDataFn, pagerDataFn) {
  const PER = 8;
  const totalPages = Math.max(1, Math.ceil(entries.length / PER));
  page = Math.max(0, Math.min(totalPages - 1, page || 0));
  const items = entries.slice(page * PER, (page + 1) * PER);
  const bubble = buildTopicPickerBubble_(headerText, subjectLine, items, hasEmb, rowDataFn);
  const altText = `${headerText}（${entries.length} 個候選${hasEmb ? '・依語意相近' : ''}）`;
  if (totalPages <= 1) return lineReplyFlex_(ev.replyToken, altText, bubble);
  lineReplyMessages_(ev.replyToken, [
    { type: 'flex', altText: altText, contents: bubble },
    { type: 'flex', altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(`👉 選主題（${entries.length} 個 / ${totalPages} 頁）`, page, totalPages, pagerDataFn) }
  ]);
}

function buildTopicPickerBubble_(headerText, subjectLine, items, hasEmb, rowDataFn) {
  const row = (it) => {
    const c = it.context;
    const title = c.userTitle || (it.journey && it.journey.title) || c.label || '未命名';
    const cat = themeNormCategory_(c.category);
    const simTxt = (hasEmb && it.sim >= 0) ? `${Math.round(it.sim * 100)}% ›` : '›';
    return {
      type: 'box', layout: 'horizontal', backgroundColor: THEME.surface, cornerRadius: 'md', paddingAll: 'md', margin: 'sm', spacing: 'sm',
      action: { type: 'postback', label: truncate_(title, 18), data: rowDataFn(c.id), displayText: opEcho_('歸到主題', title) },
      contents: [
        { type: 'text', text: THEME_STATUS_ICON[it.status] || '🌱', size: 'sm', flex: 0, gravity: 'center', color: themeStatusColor_(it.status) },
        { type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: truncate_(title, 16), size: 'sm', weight: 'bold', color: THEME.ink, wrap: true },
          { type: 'text', text: `${THEME_CATEGORY_ICON[cat] || '🗄️'} ${cat} · ${it.count} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs' }
        ]},
        { type: 'text', text: simTxt, size: 'xxs', color: THEME.cta, weight: 'bold', flex: 0, align: 'end', gravity: 'center' }
      ]
    };
  };
  const contents = [
    { type: 'text', text: subjectLine, size: 'xs', color: THEME.textBody, wrap: true, maxLines: 2 },
    { type: 'text', text: hasEmb ? '依語意相近排序，選一個歸進去：' : '選一個主題歸進去：', size: 'xxs', color: THEME.muted, margin: 'xs' },
    { type: 'separator', margin: 'md' }
  ];
  items.forEach(it => contents.push(row(it)));
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [{ type: 'text', text: headerText, size: 'md', weight: 'bold', color: THEME.onDark }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents }
  };
}

function replyRecordTopicPicker_(ev, scope, rid, page) {
  const rec = loadEmbeddingRecords_(scope).find(r => r.id === rid);
  if (!rec) return lineReply_(ev.replyToken, '⚠️ 找不到該筆紀錄。');
  const homeIds = loadContexts_(scope).filter(c => (c.recordIds || []).indexOf(rid) >= 0).map(c => c.id);  // 排除現屬主題
  const { entries, hasEmb } = rankContextsBySim_(scope, rec.embedding, homeIds);
  if (!entries.length) return lineReply_(ev.replyToken, '目前沒有「其他」主題可改歸（只有它現在所屬的這條）。先多記幾筆、長出別的主題。');
  const snippet = truncate_(((rec.aggregatedText || rec.text) || '').replace(/\s+/g, ' '), 44) || `(${typeLabel_(rec.type)})`;
  return paginateTopicPicker_(ev, entries, hasEmb, page || 0,
    '📌 把這筆歸到某主題', `這筆：${snippet}`,
    cid => `action=rec_link_topic&rid=${rid}&cid=${cid}`,
    p => `action=rec_pick_topic&rid=${rid}&p=${p}`);
}

function handleRecordLinkTopic_(ev, scope, rid, cid) {
  const records = loadEmbeddingRecords_(scope);
  const rec = records.find(r => r.id === rid);
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!rec || !context) return lineReply_(ev.replyToken, '這筆或這個主題已更新，請重新 /themes 後再試。');

  const recById = {}; records.forEach(r => { recById[r.id] = r; });
  const members = (context.recordIds || []).map(id => recById[id]).filter(Boolean);
  const majority = (arr) => {
    const v = {}; let best = '', n = -1;
    for (const x of arr) { if (!x) continue; v[x] = (v[x] || 0) + 1; if (v[x] > n) { n = v[x]; best = x; } }
    return best;
  };
  const category = context.category || majority(members.map(m => m.category)) || '其他';
  const topicLabel = majority(members.map(m => m.topicLabel)) || context.label || category;

  if (!setRecordCategoryTopic_(scope, rid, category, topicLabel)) {
    return lineReply_(ev.replyToken, '⚠️ 寫入失敗，請再試一次。');
  }
  // 〔修 bug·改歸進「被釘成封閉群」的目標〕若目標脈絡的成員帶共同 pin 群鍵（例如先前「分開」把
  // 它們釘成自群、或升格成歷程後仍帶該 pin），純 label-group 無法把「剛清掉自身 pin 的這筆」併進
  // 那個封閉群——改歸看似沒生效、那筆自成一條同名脈絡（實測：選「教師備課經驗與策略」卻留在「備課」）。
  // 把這筆也 must-link 釘到目標的同一個鍵，保證併進目標群（升格歷程靠 re-link 把這筆一併納入）。
  try {
    const pins = loadChatMeta_(scope).recordPins || {};
    const keyVotes = {};
    members.forEach(mm => { const k = mm && pins[mm.id]; if (k) keyVotes[k] = (keyVotes[k] || 0) + 1; });
    const sharedKey = Object.keys(keyVotes).sort((a, b) => keyVotes[b] - keyVotes[a])[0];
    if (sharedKey) { pins[rid] = sharedKey; updateChatMeta_(scope, m => { m.recordPins = pins; return m; }); }
  } catch (e) { console.warn('relink pin-join failed:', e && e.message); }
  // 強制立即重分群（lastContextUpgradeAt=null → 閘門放行；lastClassifyAt 一併標記）。
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = null; m.lastClassifyAt = new Date().toISOString(); return m; });
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 20); } catch (_) {} }
  try { maybeUpgradeContexts_(scope, true); } catch (e) { console.warn('relink upgrade failed:', e && e.message); }

  // 重新讀回「現在包含這筆的脈絡」（重分群多半復用原 id，極少數因配對門檻另起新 id）。
  const afterAll = loadContexts_(scope);
  const after = afterAll.find(c => (c.recordIds || []).indexOf(rid) >= 0) || afterAll.find(c => c.id === cid);
  if (!after) {
    // 用「使用者剛點選那條」的顯示名（含 journey.title），別用 raw topicLabel，免得名稱對不上所選。
    const pickedJourney = pickJourneyForContext_(loadJourneys_(scope), cid);
    const pickedTitle = context.userTitle || (pickedJourney && pickedJourney.title) || context.label || topicLabel;
    return lineReply_(ev.replyToken, `✅ 已把這筆歸到「${truncate_(pickedTitle, 16)}」(${themeNormCategory_(category)})。下次 /themes 看得到。`);
  }
  const joined = (after.recordIds || []).indexOf(rid) >= 0;
  const journey = pickJourneyForContext_(loadJourneys_(scope), after.id);
  // 〔名稱一致〕訊息與卡片同口徑：userTitle → journey.title → label、大類用 after.category。否則會出現
  // 「卡片寫德國演講與學術交流、訊息卻寫 raw label 人脈連結」這種對不上（raw topicLabel ≠ 顯示名）。
  const title = after.userTitle || (journey && journey.title) || after.label || topicLabel;
  const dispCat = themeNormCategory_(after.category) || themeNormCategory_(category);
  const recById2 = {}; loadEmbeddingRecords_(scope).forEach(r => { recById2[r.id] = r; });
  const recs2 = (after.recordIds || []).map(id => recById2[id]).filter(Boolean);
  const w = { context: after, journey, recsInWindow: recs2, windowCount: recs2.length, allContextRecords: recs2 };
  const card = buildContextCard_(w, 0, { whole: true, label: '全部' }, scope);
  const note = joined
    ? `✅ 已把這筆歸到「${truncate_(title, 16)}」(${dispCat})，並重新分群。`
    : `已標記歸到「${truncate_(title, 16)}」(${dispCat})；下次 /themes 會折進去。`;
  lineReplyMessages_(ev.replyToken, [
    { type: 'text', text: note },
    { type: 'flex', altText: `主題 · ${truncate_(title, 16)}`, contents: card }
  ]);
}

/* ---- 整段改歸（一個敘事片段的所有記錄一起歸到某主題）---- */

// 由 epRef 還原該敘事片段的記錄。mode=ctx → 在脈絡 ek 的成員裡切；否則 mode=day → 在某日 ek 裡切。
function episodeRecordsFromRef_(scope, mode, ek, startTs) {
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts);
  let pool;
  if (mode === 'ctx') {
    const c = loadContexts_(scope).find(x => x.id === ek);
    if (!c) return [];
    const idset = {}; (c.recordIds || []).forEach(id => { idset[id] = true; });
    pool = all.filter(r => idset[r.id]);
  } else {
    pool = all.filter(r => Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd') === ek);
  }
  pool.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const ep = groupByEpisode_(pool, EPISODE_GAP_MS).find(e => e.startTs === startTs);
  return ep ? ep.records : [];
}

function replyEpisodeTopicPicker_(ev, scope, mode, ek, startTs, page) {
  const recs = episodeRecordsFromRef_(scope, mode, ek, startTs);
  if (!recs.length) return lineReply_(ev.replyToken, '找不到該敘事片段（紀錄可能已變動）。');
  const embs = recs.filter(r => r.embedding && r.embedding.length === EMBED_DIM).map(r => r.embedding);
  // 排除這段目前的「家」（成員重疊最多且過半的脈絡）——不讓人改歸到自己原本的主題。
  const recIdSet = {}; recs.forEach(r => { recIdSet[r.id] = true; });
  let homeIds = [];
  { let bestC = null, bestN = 0;
    loadContexts_(scope).forEach(c => { const n = (c.recordIds || []).filter(id => recIdSet[id]).length; if (n > bestN) { bestN = n; bestC = c; } });
    if (bestC && bestN >= Math.ceil(recs.length / 2)) homeIds = [bestC.id]; }
  const { entries, hasEmb } = rankContextsBySim_(scope, embs.length ? meanVector_(embs) : null, homeIds);
  if (!entries.length) return lineReply_(ev.replyToken, '目前沒有「其他」主題可改歸（這段都在同一條主題裡）。');
  const epRef = `mode=${mode}&ek=${encodeURIComponent(ek)}&s=${startTs}`;
  return paginateTopicPicker_(ev, entries, hasEmb, page || 0,
    `📌 整段 ${recs.length} 筆改歸主題`, `整段 ${recs.length} 筆一起歸進所選主題`,
    cid => `action=ep_link_topic&${epRef}&cid=${cid}`,
    p => `action=ep_pick_topic&${epRef}&p=${p}`);
}

function handleEpisodeLinkTopic_(ev, scope, mode, ek, startTs, cid) {
  const recs = episodeRecordsFromRef_(scope, mode, ek, startTs);
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!recs.length || !context) return lineReply_(ev.replyToken, '這段或這個主題已更新，請重新操作。');
  const recById = {}; loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const members = (context.recordIds || []).map(id => recById[id]).filter(Boolean);
  const majority = (arr) => {
    const v = {}; let best = '', n = -1;
    for (const x of arr) { if (!x) continue; v[x] = (v[x] || 0) + 1; if (v[x] > n) { n = v[x]; best = x; } }
    return best;
  };
  const category = context.category || majority(members.map(m => m.category)) || '其他';
  const topicLabel = majority(members.map(m => m.topicLabel)) || context.label || category;
  // 收藏/裸連結不進主題，整段改歸時跳過。
  const linkIntent = loadChatMeta_(scope).linkIntent || {};
  const ids = recs.filter(r => !isCollectionRecord_(r, linkIntent)).map(r => r.id);
  const n = setRecordsCategoryTopic_(scope, ids, category, topicLabel);
  if (!n) return lineReply_(ev.replyToken, '這段沒有可改歸的紀錄（可能都是收藏/連結）。');
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = null; m.lastClassifyAt = new Date().toISOString(); return m; });
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 20); } catch (_) {} }
  try { maybeUpgradeContexts_(scope, true); } catch (e) { console.warn('ep relink upgrade failed:', e && e.message); }
  // 〔直接帶到該主題〕重分群後找「現在含這段紀錄」的脈絡（多半復用原 id；少數因配對門檻另起新 id），
  // 回一張 L2 主題詳情卡直接落地，不再叫使用者自己 /themes→大類→主題（多此一舉）。
  const idSet = {}; ids.forEach(id => { idSet[id] = true; });
  const afterAll = loadContexts_(scope);
  let after = afterAll.find(c => c.id === cid);
  if (!after || !(after.recordIds || []).some(id => idSet[id])) {
    let best = null, bestN = 0;
    afterAll.forEach(c => { const k = (c.recordIds || []).filter(id => idSet[id]).length; if (k > bestN) { bestN = k; best = c; } });
    if (best) after = best;
  }
  const journey = after ? pickJourneyForContext_(loadJourneys_(scope), after.id) : null;
  const tp = journeyTitleParts_(after, journey);
  const dispCat = themeNormCategory_((after && after.category) || category);
  if (!after) {
    return lineReply_(ev.replyToken, `✅ 已把整段 ${n} 筆歸到「${truncate_(tp.main || topicLabel, 16)}」(${dispCat})。下次 /themes 看得到。`);
  }
  const recById2 = {}; loadEmbeddingRecords_(scope).forEach(r => { recById2[r.id] = r; });
  const recs2 = (after.recordIds || []).map(id => recById2[id]).filter(Boolean);
  const w = { context: after, journey, recsInWindow: recs2, windowCount: recs2.length, allContextRecords: recs2 };
  const card = buildContextCard_(w, 0, { whole: true, label: '全部' }, scope);
  lineReplyMessages_(ev.replyToken, [
    { type: 'text', text: `✅ 已把整段 ${n} 筆歸到「${truncate_(tp.main, 16)}」(${dispCat})，並重新分群。` },
    { type: 'flex', altText: `主題 · ${truncate_(tp.main, 16)}`, contents: card }
  ]);
}
