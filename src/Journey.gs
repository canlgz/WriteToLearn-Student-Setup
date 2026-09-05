/**
 * 學習歷程 (層5) surface.
 *
 * Journeys are NOT woven on demand any more. They emerge in the background:
 * 主題群組 (k-means cluster) →升格→ 脈絡 (3 conditions, ContextUpgrade.gs) →
 * 偵測轉折→ 歷程 (JourneyDetect.gs). This file only renders the persisted
 * objects:
 *   /journey            → overview of升格 歷程 (journeys.jsonl, status 'journey')
 *   /journey <主題>     → that 歷程's detail (its 轉折標記)
 *   /themes cluster btn → that 主題群組's 升格進度 (what it still needs to become
 *                          a 脈絡) — see handleJourneyCluster_ / contextGapReport_.
 */

// 四種轉折標記的呈現樣式。
const JOURNEY_MARKER_STYLE = {
  '概念重述':   { icon: '🔁', color: '#2ea043' },
  '跨主題整合': { icon: '🧩', color: '#1a4480' },
  '行動指向':   { icon: '🎯', color: '#cc6600' },
  '後設反思':   { icon: '🔭', color: '#7986cb' }
};

/**
 * /journey dispatcher:
 *   no arg            → overview of升格 學習歷程 (層5).
 *   arg matches a 歷程 → that 歷程's detail (its 轉折標記).
 *   arg otherwise      → it hasn't升格 yet; point at /journey & /themes.
 */
function replyJourney_(ctx, arg) {
  arg = (arg || '').trim();
  if (!arg) return replyJourneyOverview_(ctx);
  const hit = findJourneyByLabel_(ctx.scope, arg);
  if (hit) return replyJourneyDetail_(ctx, hit.journey, hit.context);
  return lineReply_(ctx.replyToken,
    `還沒有「${truncate_(arg, 20)}」這條學習歷程。\n` +
    '歷程會在背景自動成形（某條脈絡出現轉折時）。輸入 /journey 看目前的歷程，' +
    '或 /themes 看這主題的主題群組與升格進度。');
}

/** Find a升格 歷程 by label (exact, then substring, case-insensitive). */
function findJourneyByLabel_(scope, arg) {
  const q = arg.toLowerCase();
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  const ctxById = {};
  loadContexts_(scope).forEach(c => { ctxById[c.id] = c; });
  const name = j => ((j.title || j.label) || '').toLowerCase();
  const hit = journeys.find(j => name(j) === q || (j.label || '').toLowerCase() === q)
           || journeys.find(j => name(j).indexOf(q) >= 0 || (j.label || '').toLowerCase().indexOf(q) >= 0);
  return hit ? { journey: hit, context: ctxById[hit.contextId] || null } : null;
}

function replyJourneyOverview_(ctx) {
  // /journey 是「讀」不是「重算」：純讀持久化的脈絡/歷程，不在每次開啟時強制重分群。
  // 之前每次都 maybeUpgradeContexts_(…, true) 強制重跑全語料 k-means，導致一加新資料
  // 就整個重洗、卡片每次不同（甚至凍結的歷程被吸進別群而消失）。重分群改由背景 sweep
  // 依排程負責——/journey 之間穩定，只在背景真的更新後才變。
  // 但「凍結歷程的 basedOnUpdatedAt 對齊」是純 CPU、不動成員/標籤，順手做：開頁即清掉
  // 報告頁那個會卡住的「正在背景重新對齊」狀態，不必等背景 sweep。
  try { alignFrozenJourneyStamps_(ctx.scope); } catch (e) { console.warn('align stamps failed:', e && e.message); }
  sendJourneyOverviewPage_(ctx.scope, ctx.replyToken, 0);
}

// Re-render a specific page of the /journey overview (postback navigation). No
// re-upgrade here — flipping pages must not change the set/order mid-navigation;
// the upgrade only runs on the initial /journey.
function handleJourneyPage_(ev, scope, page) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 10); } catch (_) {} }
  sendJourneyOverviewPage_(scope, ev.replyToken, page);
}

function sendJourneyOverviewPage_(scope, replyToken, page) {
  page = page || 0;
  const journeyRecs = loadJourneys_(scope);

  const allContexts = loadContexts_(scope);
  const ctxById = {};
  allContexts.forEach(c => { ctxById[c.id] = c; });  // any status — journey cards may link to a re-linked 'candidate' 脈絡
  const contexts = allContexts.filter(c => c.status === 'context');

  // 已升格歷程，依活動時間新→舊排列（取所屬脈絡的 lastTs）。
  const promoted = {};
  const journeys = journeyRecs.filter(j => j.status === 'journey');
  journeys.forEach(j => { promoted[j.contextId] = true; });
  const jTime = j => { const c = ctxById[j.contextId]; return c && c.lastTs ? Date.parse(c.lastTs) : 0; };
  // 已定案（結案）的排最前，其餘依活動時間新→舊。
  journeys.sort((a, b) => {
    const fa = a.finalized ? 0 : 1, fb = b.finalized ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return jTime(b) - jTime(a);
  });

  // 候選歷程 = 已成形脈絡(status context)但尚未升格成歷程。涵蓋「已判讀、暫無轉折」
  // (有 watch 紀錄) 與「剛成形、背景還沒判讀」(無紀錄) 兩種——只要是脈絡就現身，
  // 不因背景判讀時點而被藏起來。/themes 說三條件已達的，這裡就找得到。
  const candidates = contexts.filter(c => !promoted[c.id])
    .sort((a, b) => (b.recordIds || []).length - (a.recordIds || []).length);

  if (!journeys.length && !candidates.length) {
    const candCount = countContextCandidates_(scope);
    const hint = candCount
      ? `目前有 ${candCount} 條主題群組正在背景分析，尚未成形脈絡。`
      : '多寫一些、隔些時候回頭深化同一主題，脈絡就會成形。';
    return lineReply_(replyToken,
      '🌳 還沒有浮現「學習歷程」。\n' +
      '歷程會在背景自動成形：當某條脈絡出現概念重述／跨主題整合／行動指向／後設反思任一種轉折時。\n' +
      hint + '\n先試 /themes 看主題群組、/portfolio 產生學習歷程總冊。');
  }

  // 已升格歷程（時間新→舊）優先排列。候選歷程不再各佔一張卡（與 /themes L2 重複、把
  // /journey 糊成「另一個 themes」），P1-C 濃縮成最後一張「候選歷程入口」卡。整串再分頁。
  // Load embedding records once → per-context records (cross-media thumbnail +
  // 媒介組成 row need them). Build bubbles lazily so only the visible page slice
  // touches recordIds.
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const recsFor = c => ((c && c.recordIds) || []).map(id => recById[id]).filter(Boolean);

  // 與 /recall 同樣式分頁：每頁卡片數依總數縮放（searchPageSize_），頁碼卡另發一則
  // 訊息（buildPaginationBubble_：頁碼視窗 + « first ‹ pre next › last »），0-based。
  // 卡片含 24 格 timeline strip（~5KB），滿頁 10 張會超過 LINE 50KB carousel 上限；
  // paginateFlexCards_ 在 count 上限之上再加 JSON-byte 預算動態縮頁。
  const intro = buildJourneyIntroCard_(journeys.length, candidates.length);
  const allCards = [intro].concat(journeys.map(j => {
    const ctx = ctxById[j.contextId];
    return buildJourneyOverviewBubble_(j, ctx, recsFor(ctx));
  }));
  if (candidates.length) allCards.push(buildCandidateEntryCard_(candidates));

  const total = allCards.length - 1;  // intro 不算進總數，但仍占一張卡
  const pager = paginateFlexCards_(allCards, page);
  page = pager.page;
  const totalPages = pager.totalPages;
  const pageCards = pager.pageCards;

  const resultContents = pageCards.length === 1 ? pageCards[0] : { type: 'carousel', contents: pageCards };
  const altText = totalPages > 1
    ? `學習歷程（${journeys.length} 條・候選 ${candidates.length}）第 ${page + 1}/${totalPages} 頁`
    : `學習歷程（${journeys.length} 條・候選 ${candidates.length}）`;

  if (totalPages <= 1) {
    return lineReplyFlex_(replyToken, altText, resultContents);
  }
  const pagerTitle = `👉 學習歷程（${journeys.length} 條・候選 ${candidates.length} / ${totalPages} 頁）`;
  lineReplyMessages_(replyToken, [
    { type: 'flex', altText: altText, contents: resultContents },
    {
      type: 'flex',
      altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(pagerTitle, page, totalPages, p => `action=journey_page&p=${p}`)
    }
  ]);
}

/** /journey 輪播 index=0：總計＋圖例＋導航。 */
function buildJourneyIntroCard_(journeyN, candidateN) {
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: String(journeyN), size: '3xl', weight: 'bold', color: THEME.success, flex: 0 },
      { type: 'text', text: '學習歷程', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' }
    ]},
    { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm', contents: [
      { type: 'text', text: String(candidateN), size: 'xl', weight: 'bold', color: THEME.cta, flex: 0 },
      { type: 'text', text: '候選歷程', size: 'xs', color: THEME.muted, flex: 0, gravity: 'bottom' }
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '四種轉折', size: 'xxs', color: THEME.muted, margin: 'md' },
    { type: 'text', text: '🔁 概念重述　🧩 跨主題整合', size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' },
    { type: 'text', text: '🎯 行動指向　🔭 後設反思', size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '🌳 學習歷程＝出現任一轉折', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' },
    { type: 'text', text: '🌿 候選歷程＝三條件齊備、等一個轉折', size: 'xxs', color: THEME.muted, wrap: true },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '👉 滑右邊看每條學習歷程', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' },
    { type: 'text', text: candidateN ? '候選歷程收在最後一張；瀏覽全部主題與三狀態請用 /themes' : '瀏覽全部主題與三狀態請用 /themes', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
  ];
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['／journey', '總覽'], THEME.depth.l1),
        { type: 'text', text: '🌳', size: 'xxl', color: THEME.onDark, align: 'center' },
        { type: 'text', text: '學習歷程現況', size: 'md', weight: 'bold', color: THEME.onDark, align: 'center', margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

function markerBadgeRow_(m) {
  const st = JOURNEY_MARKER_STYLE[m.type] || { icon: '•', color: THEME.cta };
  const rows = [{
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: `${st.icon} ${m.type}`, size: 'xs', weight: 'bold', color: st.color, flex: 0 }
    ]
  }];
  if (m.evidence) {
    rows.push({ type: 'text', text: `「${m.evidence}」`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' });
  }
  return rows;
}

/* ---- Shared helpers for cross-media + keyword presentation on overview cards ---- */

// Keyword chip row 統一格式「大類｜細類1+細類2」 (1 preset 大類 + 0-2 自由細類,
// persisted on journey/watch by JourneyDetect). 與 /recall 敘事片段的標題格式
// 對齊。Shared with Focus.gs (/themes cluster cards borrow the overlapping
// context's keywords). Returns null if no keywords.
function keywordChipsRow_(keywords) {
  if (!keywords) return null;
  const cat = keywords.category || '';
  const tags = Array.isArray(keywords.tags) ? keywords.tags.filter(Boolean) : [];
  if (!cat && !tags.length) return null;
  const tagJoin = tags.join('+');
  const text = cat
    ? (tags.length ? `${cat}｜${tagJoin}` : cat)
    : tagJoin;
  return { type: 'text', text, size: 'xs', weight: 'bold', color: THEME.depth.l2.accent, margin: 'xs', wrap: true };
}


// Pick a representative thumbnail record. Prefer the newest image, then video —
// gives a recent visual cue for "what this is about". Returns null for text/audio
// only contexts (no fileId-bearing image/video found).
function pickJourneyHeroRecord_(records) {
  if (!records || !records.length) return null;
  const byTime = records.slice().sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  for (const r of byTime) if (r.type === 'image' && r.fileId) return r;
  for (const r of byTime) if (r.type === 'video' && r.fileId) return r;
  return null;
}

// Per-kind tally row (📝N 🖼️N 🎤N…) — same pattern as /recall episode bubbles
// (Handlers.gs EPISODE_TYPE_ICON). Surfaces cross-media composition at a glance.
function mediaMixRow_(records) {
  if (!records || !records.length) return null;
  const comp = {};
  for (const r of records) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ');
  if (!compStr) return null;
  return { type: 'text', text: compStr, size: 'sm', weight: 'bold', color: THEME.depth.l2.accent, margin: 'sm' };
}

// Hero bubble fragment for the representative thumbnail (image/video drive
// preview). Mirrors the hero on /recall raw record cards (Handlers.gs).
function journeyHeroFromRecord_(rec) {
  if (!rec || !rec.fileId) return null;
  return {
    type: 'image', url: `https://drive.google.com/thumbnail?id=${rec.fileId}&sz=w600`,
    size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
    action: { type: 'uri', label: '原檔', uri: `https://drive.google.com/file/d/${rec.fileId}/view` }
  };
}

/**
 * P1-C：/journey 的「候選歷程入口」卡——一張（不是 N 張）濃縮卡，取代原本每條候選歷程各佔一張
 * （那與 /themes L2 詳情重複、把 /journey 糊成第二個 themes）。列幾條可直接「補一個轉折」，
 * footer 一顆鈕回 /themes 看全部三狀態。對齊「/journey＝成就牆、瀏覽全狀態統一回 /themes」。
 */
function buildCandidateEntryCard_(candidates) {
  const shown = candidates.slice(0, 6);
  const sb = stateBadge_('context');
  const body = [
    { type: 'text', text: `${sb.icon} ${candidates.length} 條候選歷程`, size: 'sm', weight: 'bold', color: THEME.cta },
    { type: 'text', text: '三條件齊備、各差一個轉折就升學習歷程。點一條直接補轉折，或到 /themes 看全部主題與三狀態。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' },
    { type: 'separator', margin: 'sm' }
  ];
  shown.forEach(c => {
    const title = truncate_(c.userTitle || c.label || '未命名', 18);
    body.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'xs', margin: 'xs', cornerRadius: 'sm',
      action: { type: 'postback', label: truncate_(title, 18), data: `action=ctx_supplement&cid=${c.id}`, displayText: opEcho_('補一個轉折', title) },
      contents: [
        { type: 'text', text: sb.icon, size: 'sm', flex: 0, gravity: 'center', color: sb.color },
        { type: 'text', text: title, size: 'sm', color: THEME.ink, flex: 1, gravity: 'center', wrap: true },
        { type: 'text', text: '補轉折 ›', size: 'xs', color: THEME.cta, weight: 'bold', flex: 0, align: 'end', gravity: 'center' }
      ]
    });
  });
  if (candidates.length > shown.length) {
    body.push({ type: 'text', text: `…還有 ${candidates.length - shown.length} 條，到 /themes 看全部`, size: 'xxs', color: THEME.muted, margin: 'sm', wrap: true });
  }
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, paddingAll: 'md',
      contents: [
        breadcrumbTrail_(['／journey'], `${sb.icon} 候選歷程`, { headerSub: THEME.muted, headerText: THEME.ink }),
        { type: 'text', text: '差一個轉折就成歷程', size: 'xxs', color: THEME.muted, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '到 /themes 看全部主題', data: 'action=theme_home', displayText: '▸ 主題群組 · 大類總覽' },
        contents: [{ type: 'text', text: '🗂 到 /themes 看全部主題與三狀態', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
      }]
    }
  };
}

/**
 * 〔已退場·留作沿革〕原本 /journey 每條候選歷程各一張卡，P1-C 已改用 buildCandidateEntryCard_
 * 一張濃縮入口取代（candidate 的完整瀏覽統一回 /themes L2）。此函式目前不再被呼叫。
 * Overview bubble for a 候選歷程 — a 脈絡 (status:'context') that hasn't 升格 yet.
 * Covers two sub-states: judged (a watch record exists = 已判讀、暫無轉折) and
 * pending (no watch row = 剛成形、背景還沒判讀). Muted/light styling so it reads
 * as "not yet升格" next to the blue 升格 cards. Now also surfaces representative
 * thumbnail + per-kind media tally + the watch's persisted summary if present.
 */
function buildCandidateBubble_(context, watch, records) {
  const judged = !!watch;
  const title = (watch && watch.title) || '';
  const display = title || context.label || '未命名';
  const body = [];
  const span = context.firstTs ? spanLabel_(context.firstTs, context.lastTs) : '';
  body.push({ type: 'text', text: `${(context.recordIds || []).length} 則紀錄${span ? '・橫跨 ' + span : ''}`, size: 'xxs', color: THEME.muted, wrap: true });
  const kwRow = keywordChipsRow_(watch && watch.keywords);
  if (kwRow) body.push(kwRow);
  body.push({ type: 'separator', margin: 'sm' });
  body.push({ type: 'text', text: judged ? '脈絡已成形，還在等一個轉折' : '脈絡已成形，背景正在判讀轉折…', size: 'xs', weight: 'bold', color: THEME.ink, margin: 'sm', wrap: true });
  if (watch && watch.summary) {
    body.push({ type: 'text', text: watch.summary, size: 'sm', color: THEME.textBody, wrap: true, margin: 'sm', maxLines: 3 });
  }
  const mix = mediaMixRow_(records);
  if (mix) body.push(mix);
  const cr = context.criteria || {};
  if (cr.semanticDensity != null) {
    body.push({ type: 'text', text: `達標依據　語意密度 ${(cr.semanticDensity || 0).toFixed(2)}・回返 ${cr.returnVisits || 0} 次・媒介 ${cr.mediaKinds || 0} 種`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
  }
  body.push({ type: 'text', text: '出現概念重述／跨主題整合／行動指向／後設反思任一種，就升格成歷程。', size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  const label16 = truncate_(display, 16);
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, paddingAll: 'md',
      contents: [
        breadcrumbTrail_(['／journey'], `${stateBadge_('context').icon} 候選歷程 · ${judged ? '持續關注' : '判讀中'}`,
          { headerSub: THEME.muted, headerText: THEME.ink }),
        { type: 'text', text: truncate_(display, 22), size: 'md', weight: 'bold', color: THEME.ink, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm',
      contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', flex: 1,
          action: { type: 'postback', label: '看敘事片段', data: `action=ctx_episodes&cid=${context.id}`, displayText: `▸ 敘事片段 · ${label16}` },
          contents: [{ type: 'text', text: '看敘事片段', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
        },
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', flex: 1,
          action: { type: 'postback', label: '補一個轉折', data: `action=ctx_supplement&cid=${context.id}`, displayText: `▸ 補一個轉折 · ${label16}` },
          contents: [{ type: 'text', text: '補一個轉折', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
        }
      ]
    }
  };
  const hero = journeyHeroFromRecord_(pickJourneyHeroRecord_(records));
  if (hero) bubble.hero = hero;
  return bubble;
}

function buildJourneyOverviewBubble_(journey, context, records) {
  const markers = journey.markers || [];
  const body = [
    { type: 'text', text: markers.map(m => (JOURNEY_MARKER_STYLE[m.type] || {}).icon || '•').join(' ') +
        `　${markers.length} 種轉折`, size: 'xs', color: THEME.muted }
  ];
  // Keyword chip row（大類 · 細類1 · 細類2）— 第一眼就能定位這條歷程的領域。
  const kwRow = keywordChipsRow_(journey.keywords);
  if (kwRow) body.push(kwRow);
  // Body 用 LLM 生的 journey.summary（一句中文摘要，可讀性高）取代舊版逐字引述的
  // 200-字 evidence 引號。回填前的舊紀錄則退回 single-line trimmed evidence。
  body.push({ type: 'separator', margin: 'sm' });
  if (journey.summary) {
    // 摘要本就硬上限 80 字（detectContextMarkers_ truncate_ + LLM ≤60 字一句），裝得下整段，
    // 故不設 maxLines、完整呈現（不再 3 行截成「…」）。
    body.push({ type: 'text', text: journey.summary, size: 'sm', color: THEME.textBody, wrap: true, margin: 'sm' });
  } else {
    const top = markers.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (top && top.evidence) {
      body.push({ type: 'text', text: truncate_(top.evidence, 60), size: 'sm', color: THEME.textBody, wrap: true, margin: 'sm', maxLines: 2 });
    }
  }
  // 跨媒介組成 row + span line.
  const mix = mediaMixRow_(records);
  if (mix) body.push(mix);
  if (context && context.recordIds) {
    const span = context.firstTs ? spanLabel_(context.firstTs, context.lastTs) : '';
    body.push({ type: 'text', text: `${context.recordIds.length} 則紀錄${span ? '・橫跨 ' + span : ''}`, size: 'xxs', color: THEME.muted, margin: 'sm', wrap: true });
  }
  // 〔分享回執〕標注這條的分享/回執狀態（開放中或曾有回執都標）；點整行看回執名單。
  const ackN = (journey.acks || []).length;
  if (journey.shareToken || ackN > 0) {
    body.push({
      type: 'text',
      text: journey.shareToken ? `📩 已開放分享 · ${ackN} 人回執 ›` : `📩 已停止分享 · 曾 ${ackN} 人回執 ›`,
      size: 'xxs', color: THEME.cta, weight: 'bold', margin: 'xs', wrap: true,
      action: { type: 'postback', label: '回執狀況', data: `action=journey_acks&jid=${journey.id}`, displayText: '▸ 回執狀況' }
    });
  }
  const finalized = !!journey.finalized;
  const tp = journeyTitleParts_(context, journey);
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: finalized ? THEME.success : THEME.cta, paddingAll: 'md',
      contents: [
        breadcrumbTrail_(['／journey'], finalized ? '✅ 已定案・學習歷程' : '🌳 學習歷程現況',
          { headerSub: finalized ? THEME.onDark : THEME.depth.l2.headerSub, headerText: THEME.onDark }),
        { type: 'text', text: truncate_(tp.main, 22), size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' },
        ...(tp.sub ? [{ type: 'text', text: `依現況內容：${truncate_(tp.sub, 24)}`, size: 'xxs', color: THEME.onDark, wrap: true, margin: 'xs' }] : [])
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'sm',
      contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
          action: { type: 'postback', label: finalized ? '看已定案歷程' : '歷程現況', data: `action=journey_story&cid=${journey.contextId}&jid=${journey.id}`, displayText: `▸ ${finalized ? '已定案歷程' : '歷程現況'} · ${truncate_(tp.main, 16)}` },
          contents: [{ type: 'text', text: finalized ? '📖 看已定案歷程' : '📄 歷程現況', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
        }
      ]
    }
  };
  const hero = journeyHeroFromRecord_(pickJourneyHeroRecord_(records));
  if (hero) bubble.hero = hero;
  return bubble;
}

function replyJourneyDetail_(ctx, journey, context) {
  const markers = journey.markers || [];
  const body = [];
  markers.forEach((m, i) => {
    if (i) body.push({ type: 'separator', margin: 'md' });
    for (const el of markerBadgeRow_(m)) body.push(el);
    if (m.confidence != null) {
      body.push({ type: 'text', text: `信心 ${Math.round((m.confidence || 0) * 100)}%`, size: 'xxs', color: THEME.muted });
    }
  });
  if (!markers.length) body.push({ type: 'text', text: '（無轉折標記）', size: 'sm', color: THEME.muted });
  if (context && context.recordIds) {
    const span = context.firstTs ? spanLabel_(context.firstTs, context.lastTs) : '';
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: `源於 ${context.recordIds.length} 則紀錄的脈絡${span ? '・橫跨 ' + span : ''}`, size: 'xxs', color: THEME.muted, wrap: true });
  }
  const tp = journeyTitleParts_(context, journey);
  const bubble = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🌳 學習歷程現況 · 這條學到了什麼', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: truncate_(tp.main, 24), size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' },
        ...(tp.sub ? [{ type: 'text', text: `依現況內容：${truncate_(tp.sub, 26)}`, size: 'xxs', color: THEME.onDark, wrap: true, margin: 'xs' }] : [])
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '歷程現況', data: `action=journey_story&cid=${journey.contextId}&jid=${journey.id}`, displayText: `▸ 歷程現況 · ${truncate_(tp.main, 16)}` },
        contents: [{ type: 'text', text: '📄 歷程現況', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
      }]
    }
  };
  lineReplyFlex_(ctx.replyToken, `學習歷程 · ${truncate_(tp.main, 20)}`, bubble);
}

/* ---- /themes cluster snapshot → 升格進度 (what it needs to become a 脈絡) ---- */

function cacheJourneyCluster_(label, cluster) {
  const key = newId_();
  try { CacheService.getScriptCache().put('jcl_' + key, JSON.stringify({ label: label, ids: cluster.map(r => r.id) }), 21600); } catch (_) {}
  return key;
}

function handleJourneyCluster_(ev, scope, key) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 20); } catch (_) {} }
  let snap;
  try { snap = JSON.parse(CacheService.getScriptCache().get('jcl_' + key) || 'null'); } catch (_) {}
  if (!snap) return lineReply_(ev.replyToken, '這個片段快照已過期，請重新 /themes 後再試。');

  // Report against the whole-corpus persisted 脈絡 these records belong to — NOT a
  // fresh recompute on the /themes time-range subset. So 看進度 and /journey can't
  // disagree, and the (升格-gating) 群間距 is shown honestly.
  try { maybeUpgradeContexts_(scope, true); } catch (_) {}

  const idSet = {}; (snap.ids || []).forEach(id => idSet[id] = true);
  let best = null, bestOverlap = 0;
  for (const c of loadContexts_(scope)) {
    let n = 0; for (const rid of (c.recordIds || [])) if (idSet[rid]) n++;
    if (n > bestOverlap) { bestOverlap = n; best = c; }
  }

  if (!best) {
    return lineReply_(ev.replyToken,
      `「${truncate_(snap.label || '這個主題群組', 20)}」的紀錄還沒併成一條獨立脈絡（可能分散在不同主題，或還在累積）。\n再多寫、隔些時候回返同一主題，背景就會把它聚成脈絡。`);
  }
  const jrn = pickJourneyForContext_(loadJourneys_(scope), best.id);
  // Already a 歷程? Skip the progress checklist — show the full 歷程 directly.
  if (jrn && jrn.status === 'journey') {
    return replyJourneyDetail_({ scope: scope, replyToken: ev.replyToken }, jrn, best);
  }
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (best.recordIds || []).map(id => recById[id]).filter(Boolean);
  // 把原選主題群組的時段位置 (fromTs / toTs) 算出來，給進度卡的 strip 拿來標 ✓。
  const snapRecs = (snap.ids || []).map(id => recById[id]).filter(Boolean);
  const snapTsList = snapRecs.map(r => Date.parse(r.ts)).filter(t => !isNaN(t));
  const highlight = snapTsList.length
    ? { fromTs: Math.min.apply(null, snapTsList), toTs: Math.max.apply(null, snapTsList) }
    : null;
  lineReplyFlex_(ev.replyToken, `「${truncate_(best.label || snap.label, 16)}」升格進度`,
    buildContextStatusBubble_(best, jrn, snap.label, records, (snap.ids || []).length, highlight));
}

/**
 * Flex card: a 脈絡's real, persisted 升格 status — the three gates (語意密度、
 * 意向回返、跨媒介), read from context.criteria so it matches what actually gates
 * 升格. 群間距 is shown for reference only (no longer gates; absolute distance is
 * unreliable in this embedding space).
 */
function buildContextStatusBubble_(context, journey, clusterLabel, records, clusterRecordCount, highlight) {
  const C = CONTEXT_CRITERIA;
  const cr = context.criteria || {};
  const isJourney = journey && journey.status === 'journey';
  const isContext = context.status === 'context';
  const cond = (ok, title, detail) => ({
    type: 'box', layout: 'vertical', margin: 'md', contents: [
      { type: 'text', text: `${ok ? '✅' : '⬜'} ${title}`, size: 'sm', weight: 'bold', color: ok ? THEME.success : THEME.warning },
      { type: 'text', text: detail, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' }
    ]
  });
  const densOk = densityConditionMet_(cr);
  const densViaFocus = densOk && (cr.semanticDensity || 0) < C.semanticDensityMin;
  const visitOk = (cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin;
  const mediaOk = (cr.mediaKinds || 0) >= C.mediaKindsMin;
  const span = spanLabel_(context.firstTs, context.lastTs);

  const body = [];
  // Breadcrumb：/themes 卡是時段視窗的 transient k-means、進度卡報的是整體語料的
  // 持久脈絡。兩者標題不同會困惑(例:你點「日常交流與資料分享(今日 9 筆)」、進度
  // 卡卻顯示「演講與繪本分享(14 則・24 天)」)——所以當原選的群組名與此脈絡名不
  // 同時，明示這個對應，避免「為什麼換了？」。
  if (clusterLabel && clusterLabel !== context.label) {
    body.push({
      type: 'text',
      text: `🧭 原選主題群組「${truncate_(clusterLabel, 22)}」${clusterRecordCount ? `（${clusterRecordCount} 筆・/themes 時段視窗）` : ''}`,
      size: 'xs', weight: 'bold', color: THEME.cta, wrap: true
    });
    body.push({
      type: 'text',
      text: '↓ 在整體語料中合進此脈絡（升格進度只能以持久脈絡為單位評估）',
      size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs'
    });
    body.push({ type: 'separator', margin: 'sm' });
  }
  body.push({ type: 'text', text: `目前 ${(context.recordIds || []).length} 則紀錄${span ? '・橫跨 ' + span : ''}`, size: 'xs', color: THEME.muted, wrap: true });
  // What's actually inside — so you can see the mix and decide what 轉折 to write.
  const recs = (records || []).filter(r => r && r.ts).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (recs.length) {
    body.push({ type: 'text', text: '裡面寫了什麼（代表片段）', size: 'xxs', color: THEME.muted, margin: 'sm' });
    sampleEvenly_(recs, 4).forEach(r => {
      body.push({ type: 'text', text: `· ${truncate_(recText_(r), 38)}`, size: 'xs', color: THEME.textBody, wrap: true, maxLines: 2 });
    });
  }
  body.push({ type: 'separator', margin: 'sm' });
  body.push(cond(densOk, '語意密度', densViaFocus
    ? `群內相似度 ${(Math.floor((cr.semanticDensity || 0) * 1000) / 1000).toFixed(3)}（未到 ${C.semanticDensityMin}，但成員多扣同一核心 聚焦 ${Math.round((cr.coreFrac || 0) * 100)}%＝靠聚焦達標）`
    : `群內相似度 ${(Math.floor((cr.semanticDensity || 0) * 1000) / 1000).toFixed(3)}（需 ≥ ${C.semanticDensityMin}）`));
  body.push(cond(visitOk, '意向回返', `回返 ${cr.returnVisits || 0} 次・跨 ${cr.returnSpanHours || 0}h（需 ≥ ${C.returnVisitsMin} 次、跨 ≥ ${C.returnSpanHoursMin}h；間隔 ≥ ${C.returnGapMinutes} 分算一次）`));
  body.push(cond(mediaOk, '跨媒介', `${cr.mediaKinds || 0} 種媒介（需 ≥ ${C.mediaKindsMin} 種）`));
  body.push({ type: 'text', text: `群間距 ${(cr.clusterSeparation || 0).toFixed(2)}（與最近主題的區隔，僅供參考、不影響升格）`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });

  body.push({ type: 'separator', margin: 'md' });
  if (isJourney) {
    const kinds = (journey.markers || []).map(m => m.type).join('、') || '轉折';
    body.push({ type: 'text', text: `🎉 已升格成學習歷程（${kinds}）。到 /journey 看這條。`, size: 'xs', weight: 'bold', color: THEME.success, wrap: true });
  } else if (isContext) {
    body.push({ type: 'text', text: '✅ 已是脈絡（候選歷程），還在等一個轉折。到 /journey 可看、或按「補一個轉折」當場判。', size: 'xs', weight: 'bold', color: THEME.success, wrap: true });
  } else {
    const gaps = [];
    if (!densOk) gaps.push('語意再聚焦：內容更集中在同一件事');
    if (!visitOk) gaps.push(`意向回返：不同時段再回到這主題（間隔 ≥ ${C.returnGapMinutes} 分算一次，需 ≥ ${C.returnVisitsMin} 次、首末跨 ≥ ${C.returnSpanHoursMin}h）`);
    if (!mediaOk) gaps.push('跨媒介：再加一種媒介（語音／圖片／影片／檔案）');
    body.push({ type: 'text', text: '還缺什麼', size: 'xs', weight: 'bold', color: THEME.ink });
    gaps.forEach(g => body.push({ type: 'text', text: `• ${g}`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' }));
  }

  // Footer: actionable when these records are a 脈絡 — so 看進度 itself can guide
  // you to 補一個轉折 / 看敘事片段 (point 3: 主動被引導補充), not just inform.
  const lbl16 = truncate_(context.label || clusterLabel || '脈絡', 16);
  const pbtn = (label, data, primary) => ({
    type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', flex: 1,
    backgroundColor: primary ? THEME.cta : THEME.surfaceSoft,
    action: { type: 'postback', label: label, data: data, displayText: `▸ ${label} · ${lbl16}` },
    contents: [{ type: 'text', text: label, size: 'xs', align: 'center', weight: 'bold', color: primary ? THEME.onDark : THEME.cta }]
  });
  const footerRows = [];
  if (isContext && !isJourney) {
    footerRows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      pbtn('看敘事片段', `action=ctx_episodes&cid=${context.id}`, false),
      pbtn('補一個轉折', `action=ctx_supplement&cid=${context.id}`, true)
    ]});
  } else if (isJourney) {
    footerRows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      pbtn('看敘事片段', `action=ctx_episodes&cid=${context.id}`, false),
      pbtn('歷程現況', `action=journey_story&cid=${context.id}`, false)
    ]});
  } else {
    footerRows.push(pbtn('看敘事片段', `action=ctx_episodes&cid=${context.id}`, false));
  }
  // Manual split correction: when k-means fused distinct topics into this 脈絡,
  // let the user say "這其實是兩件事·分開" → pins each half apart (handleContextSplit_).
  if ((context.recordIds || []).length >= 4) {
    footerRows.push({
      type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', backgroundColor: THEME.surfaceSoft, margin: 'sm',
      action: { type: 'postback', label: '分開', data: `action=ctx_split&cid=${context.id}`, displayText: opEcho_('分開脈絡', context.label || '脈絡') },
      contents: [{ type: 'text', text: '🔀 內容其實是兩件事？分開', size: 'xs', align: 'center', weight: 'bold', color: THEME.cta }]
    });
  }
  // 記寫時間分布 strip — 統一放 body 最末 (footer 之前) 以呼應其他卡片的編排。
  if (recs.length >= 2) {
    body.push({ type: 'separator', margin: 'sm' });
    body.push(episodeTimelineStrip_({
      startTs: Date.parse(recs[0].ts),
      endTs: Date.parse(recs[recs.length - 1].ts),
      records: recs,
      highlight: highlight
    }));
  }

  const footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'sm', contents: footerRows };

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: isJourney ? '🌳 已是學習歷程現況' : '🌱 脈絡升格進度', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: truncate_((journey && journey.title) || context.label || clusterLabel || '主題', 22), size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: footer
  };
}
