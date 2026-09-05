/**
 * 互動式學習歷程報告（web app, doGet）.
 *
 * 取代伺服器端產 PDF：一條 journey 渲染成一頁可互動 HTML——圖點開放大、音檔/影片
 * 直接播、地圖/連結可點、敘事片段可看原始訊息、瀏覽器列印即存 PDF（學習歷程檔案）。
 *
 *   doGet ?view=journey&jid=<journeyId>&t=<token>
 *
 * v1（本檔）零新增 LLM：靠現成 journey.summary / markers / context.criteria + 即時
 * 算的 episodes 呈現「發生節奏 + 訊息流 + 媒體 + 升格判準 + 轉折」。§2 片段語意摘要
 * 與網絡關係（需 LLM、會預先算好存起來）之後再鋪。
 *
 * 隱私：web app 部署成「任何人可存取」，網址帶不可猜的 token（存在 owner meta），
 * doGet 驗證。與現有 Drive ANYONE_WITH_LINK 同一信任等級。
 */

/** doGet 路由分流（Main.gs 的 doGet 呼叫這裡）。非報告請求回 null，讓 caller 回健康檢查文字。 */
function routeGetRequest_(e) {
  const p = (e && e.parameter) || {};
  if (p.view === 'journey' && p.jid) return serveJourneyReport_(p.jid, p.t, p);
  if (p.view === 'compendium') return serveCompendium_(p);                        // 學習歷程總冊（彙編全部歷程）
  if (p.view === 'shared' && p.jid) return serveSharedJourney_(p.jid, p.st, p);   // 分享回執（訪客）
  if (p.action) return serveAction_(p.action, p.t);
  return null;
}

/**
 * 遠端維運觸發端點（?action=<name>&t=<token>）。token = reportToken。
 * 只跑白名單內的安全/可再生函式；結果寫進 `_action.log`（+ 診斷另寫 `_diag.log`），
 * 供開發端讀回判斷。回傳純文字結果。
 *
 * 白名單（皆只動衍生資料，可從 embeddings 再生；LLM 者受每日上限保護）：
 *   state        總覽（脈絡/歷程清單）
 *   diag.context 逐筆組成診斷（另寫 _diag.log）
 *   upgrade      重分群升格
 *   detect       判轉折
 *   merge        合併重複歷程
 *   absorb       候選自動融入既有歷程
 * 不開放（破壞性/設定變更，須人工）：reset/wipe/rollback/config。
 */
function serveAction_(action, token) {
  const scope = ownerScope_();
  if (!scope) return actionPlain_('no owner');
  const meta = loadChatMeta_(scope);
  if (!meta.reportToken || token !== meta.reportToken) return actionPlain_('bad token');

  let out;
  try { out = runWhitelistedAction_(scope, action); }
  catch (e) { out = 'ERROR: ' + ((e && e.message) || e); }
  try {
    const stamped = `[${new Date().toISOString()}] action=${action}\n${out}`;
    const folder = chatFolder_(scope);
    const it = folder.getFilesByName('_action.log');
    if (it.hasNext()) it.next().setContent(stamped);
    else folder.createFile('_action.log', stamped, MimeType.PLAIN_TEXT);
  } catch (_) {}
  return actionPlain_(out);
}

function runWhitelistedAction_(scope, action) {
  switch (action) {
    case 'state':
      return summarizeStateForAction_(scope);
    case 'diag.context':
      diagnoseContextComposition_();
      return 'diagnoseContextComposition_ 完成 → 詳見 _diag.log';
    case 'upgrade': {
      const s = upgradeContexts_(scope);
      updateChatMeta_(scope, m => { m.lastContextUpgradeAt = new Date().toISOString(); return m; });
      return 'upgradeContexts_: ' + JSON.stringify(s);
    }
    case 'detect':
      return 'detectJourneys_: ' + JSON.stringify(detectJourneys_(scope));
    case 'merge':
      return 'mergeOverlappingJourneys_: 合併 ' + mergeOverlappingJourneys_(scope) + ' 對';
    case 'absorb':
      return 'absorbCandidatesIntoJourneys_: 吸收 ' + absorbCandidatesIntoJourneys_(scope) + ' 條';
    case 'category.backfill':
      return backfillCategoriesForScope_(scope);
    case 'category.dist':
      return categoryDistForScope_(scope);
    case 'topic.backfill':
      return backfillTopicsForScope_(scope);
    case 'topic.dist':
      return topicDistForScope_(scope);
    case 'rebuild':                 // 測試期：用新模型重建脈絡/歷程（清 m: 釘選）。衍生資料可再生。
      return rebuildDerivedForScope_(scope);
    // 落差量尺驗證（GapCalibration.gs）：只跑合成校準例、只寫 _reports/gap_*.json，不動真實資料。
    case 'gap.calibration':
      return runGapCalibration();
    case 'gap.monotonicity':
      return runGapMonotonicity();
    case 'gap.reliability':
      return runGapReliability(3);
    case 'richmenu.setup': {                       // 重建 rich menu（免 editor）：先清舊、再建新並設為預設
      try { deleteAllRichMenus(); } catch (_) {}
      const rid = setupRichMenu();
      return 'richmenu.setup: 已重建並設為預設，richMenuId=' + rid;
    }
    default:
      return '未知 action：' + action + '（可用：state, diag.context, upgrade, detect, merge, absorb, category.backfill, category.dist, gap.calibration, gap.monotonicity, gap.reliability, richmenu.setup）';
  }
}

/**
 * Drive 命令佇列：背景 sweep 每輪呼叫。讀 chat 資料夾的 `_cmd.txt`（內容 = 白名單
 * action 名），執行、寫 `_action.log`、刪除命令檔。讓開發端（能寫 Drive、但無法用
 * WebFetch 打 GAS——Google 擋資料中心請求）改用「寫命令檔」觸發維運，全程不需使用者
 * 操作。只跑 runWhitelistedAction_ 的白名單，破壞性操作仍不在內。
 */
function processCommandQueue_(scope) {
  let folder;
  try { folder = chatFolder_(scope); } catch (_) { return; }
  const it = folder.getFilesByName('_cmd.txt');
  if (!it.hasNext()) return;
  const f = it.next();
  let action = '';
  try { action = (f.getBlob().getDataAsString() || '').trim(); } catch (_) {}
  // 先全部刪掉（含重複檔）——失敗的命令不可在每輪 sweep 無限重跑。
  try { f.setTrashed(true); } catch (_) {}
  while (it.hasNext()) { try { it.next().setTrashed(true); } catch (_) {} }
  if (!action) return;
  let out;
  try { out = runWhitelistedAction_(scope, action); }
  catch (e) { out = 'ERROR: ' + ((e && e.message) || e); }
  try {
    const stamped = `[${new Date().toISOString()}] (queue) action=${action}\n${out}`;
    const a = folder.getFilesByName('_action.log');
    if (a.hasNext()) a.next().setContent(stamped);
    else folder.createFile('_action.log', stamped, MimeType.PLAIN_TEXT);
  } catch (_) {}
  console.log(`processCommandQueue_: ran ${action}`);
}

/** 緊湊狀態總覽：脈絡/歷程清單（給開發端快速掌握）。 */
function summarizeStateForAction_(scope) {
  const contexts = loadContexts_(scope);
  const journeys = loadJourneys_(scope);
  const jr = journeys.filter(j => j.status === 'journey');
  const watch = journeys.filter(j => j.status === 'watch');
  const jset = {}; jr.forEach(j => { jset[j.contextId] = true; });
  const L = [];
  L.push(`contexts=${contexts.length} journeys=${jr.length} watch=${watch.length}`);
  L.push('── 學習歷程 ──');
  jr.forEach(j => {
    const c = contexts.find(x => x.id === j.contextId);
    const n = c ? (c.recordIds || []).length : '?';
    const mk = (j.markers || []).map(m => m.type).join('+') || '(無)';
    L.push(`🌳 [${j.contextId.slice(0, 8)}] "${j.title || j.label}" ${n}筆 轉折=${mk}`);
  });
  L.push('── 候選（無歷程的脈絡）──');
  contexts.filter(c => !jset[c.id]).sort((a, b) => (b.recordIds || []).length - (a.recordIds || []).length)
    .forEach(c => {
      const cr = c.criteria || {};
      L.push(`${c.status === 'context' ? '🌿' : '🌱'} [${c.id.slice(0, 8)}] "${c.userTitle || c.label}" ${(c.recordIds || []).length}筆 dens=${cr.semanticDensity} pass=${cr.passed}`);
    });
  return L.join('\n');
}

/** 純文字回應（給遠端 action）。 */
function actionPlain_(text) {
  return ContentService.createTextOutput(String(text == null ? '' : text))
    .setMimeType(ContentService.MimeType.TEXT);
}

/** 取得（必要時生成）owner 的報告存取 token，存在 meta.reportToken。 */
function ensureReportToken_(scope) {
  const meta = loadChatMeta_(scope);
  if (meta.reportToken) return meta.reportToken;
  const tok = newId_() + newId_();
  updateChatMeta_(scope, m => { m.reportToken = tok; return m; });
  return tok;
}

/** owner scope（這個 bot 以個人為主，報告只服務 owner 的資料）。 */
/** 建立者（bot 擁有者）顯示姓名：快取在 meta.ownerDisplayName，避免每次渲染都打 LINE profile API。
 *  優先用 Script Property OWNER_DISPLAY_NAME（管理員可自訂）。 */
function ownerDisplayName_(scope) {
  try {
    const override = getPropOptional_('OWNER_DISPLAY_NAME');
    if (override) return override;
    const meta = loadChatMeta_(scope);
    if (meta.ownerDisplayName) return meta.ownerDisplayName;
    const p = getUserProfile_(scope.id);
    const name = (p && p.displayName) || '';
    if (name) { updateChatMeta_(scope, m => { m.ownerDisplayName = name; return m; }); }
    return name;
  } catch (_) { return ''; }
}

function ownerScope_() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  if (!owner) return null;
  return { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
}

/**
 * 在 webhook 請求（doPost）內自學固定 /exec。webhook 是打到 /exec 部署的，
 * 此情境 getService().getUrl() 回的就是 /exec；只在「結尾是 /exec 且尚未存過」
 * 時寫入。→ 部署後第一則訊息進來就自動設好，分享給別人套用也免手動。
 * （編輯器裡跑 getUrl() 會回需登入的 /dev，所以不在那裡學。）
 *
 * 另外強制清洗 /u/N/（多帳號切換器路徑片段）——它會把網址綁到「使用者 N 號的
 * 帳號上下文」，未登入裝置（iPad Safari 等）直接 404。
 */
function captureExecUrl_() {
  try {
    const existing = getPropOptional_(PROP.WEB_APP_EXEC_URL);
    if (existing) {
      const cleaned = stripUserPathSegment_(existing);
      if (cleaned !== existing) {
        PropertiesService.getScriptProperties().setProperty(PROP.WEB_APP_EXEC_URL, cleaned);
        console.log('captureExecUrl_: 清洗 /u/N/ →', cleaned);
      }
      return;
    }
    const u = ScriptApp.getService().getUrl();
    if (u && /\/exec$/.test(u)) {
      const cleaned = stripUserPathSegment_(u);
      PropertiesService.getScriptProperties().setProperty(PROP.WEB_APP_EXEC_URL, cleaned);
      console.log('captureExecUrl_: 自動學到 /exec =', cleaned);
    }
  } catch (_) { /* best-effort */ }
}

/** 移除 /macros/u/N/ → /macros/，讓網址是匿名可開的乾淨形式。 */
function stripUserPathSegment_(url) {
  return String(url || '').replace(/\/macros\/u\/\d+\//, '/macros/');
}

/** 報告網址：固定 /exec（Script Property）+ 查詢參數。
 *  優先用 WEB_APP_EXEC_URL（doPost 自學或手動設）；未設才退回 getService().getUrl()
 *  （在 webhook 內也是 /exec；只有從編輯器跑才會是需登入的 /dev）。 */
function journeyReportUrl_(scope, journeyId) {
  let base = getPropOptional_(PROP.WEB_APP_EXEC_URL);
  if (!base) {
    base = ScriptApp.getService().getUrl();
    if (base && /\/exec$/.test(base)) {
      try { PropertiesService.getScriptProperties().setProperty(PROP.WEB_APP_EXEC_URL, stripUserPathSegment_(base)); } catch (_) {}
    }
  }
  base = stripUserPathSegment_(base);     // 最後再保險清一次，避免任何路徑帶 /u/N/
  const t = ensureReportToken_(scope);
  return `${base}?view=journey&jid=${encodeURIComponent(journeyId)}&t=${encodeURIComponent(t)}`;
}

/** 學習歷程總冊網址：固定 /exec + `view=compendium&t=token`（與單篇報告同信任等級）。 */
function compendiumReportUrl_(scope) {
  let base = getPropOptional_(PROP.WEB_APP_EXEC_URL);
  if (!base) {
    base = ScriptApp.getService().getUrl();
    if (base && /\/exec$/.test(base)) {
      try { PropertiesService.getScriptProperties().setProperty(PROP.WEB_APP_EXEC_URL, stripUserPathSegment_(base)); } catch (_) {}
    }
  }
  base = stripUserPathSegment_(base);
  const t = ensureReportToken_(scope);
  return `${base}?view=compendium&t=${encodeURIComponent(t)}`;
}

/** Editor 診斷：印出報告連結會用哪個 base、以及 getService 回什麼，方便對照 /exec vs /dev。
 *  也順手把當前 getService /exec 寫進 WEB_APP_EXEC_URL（若它確實是 /exec 結尾且尚未設定）。 */
function logReportUrl() {
  const svc = ScriptApp.getService().getUrl();
  const prop = getPropOptional_(PROP.WEB_APP_EXEC_URL);
  console.log('WEB_APP_EXEC_URL prop =', prop || '(未設定)');
  console.log('ScriptApp.getService().getUrl() =', svc);
  const scope = ownerScope_();
  if (scope) {
    const j = loadJourneys_(scope).find(x => x.status === 'journey');
    console.log('範例報告連結 =', j ? journeyReportUrl_(scope, j.id) : '(沒有 journey 可測)');
  }
  console.log('→ 若上面連結是 /dev 結尾，請用 setWebAppExecUrl("https://script.google.com/macros/s/XXX/exec") 設定固定 /exec。');
}

/** Editor：設定固定 /exec 網址（從 LINE webhook 設定複製那串，結尾要是 /exec）。 */
function setWebAppExecUrl(url) {
  if (!url || !/\/exec$/.test(url)) throw new Error('請傳入結尾為 /exec 的網址');
  PropertiesService.getScriptProperties().setProperty(PROP.WEB_APP_EXEC_URL, url);
  console.log('已設定 WEB_APP_EXEC_URL =', url);
}

function serveJourneyReport_(jid, token, params) {
  params = params || {};
  const scope = ownerScope_();
  if (!scope) return reportErrorPage_('尚未設定擁有者。');
  const meta = loadChatMeta_(scope);
  if (!meta.reportToken || token !== meta.reportToken) {
    return reportErrorPage_('連結無效或已過期。請回 LINE 重新點「歷程現況」取得新連結。');
  }
  // 網頁版＝想清楚後的完整現況，唯讀。策展（移出片段）一律在 LINE 的「歷程現況」輪播做；
  // 唯一的網頁寫入動作＝定案/解除定案（使用者確認無誤後鎖定）。
  // 開頁順手對齊凍結歷程的時間戳（純 CPU、零 LLM、不動成員）：否則改歸/補一筆後 pending 永遠
  // true、「正在背景重新對齊」banner 不消、也無法定案。對齊後本次 doGet 就讀到清掉的狀態。
  try { alignFrozenJourneyStamps_(scope); } catch (e) { console.warn('report align stamps failed:', e && e.message); }
  const journey = loadJourneys_(scope).find(j => j.id === jid && j.status === 'journey');
  if (!journey) return reportErrorPage_('這條歷程已更新或不存在，請回 LINE 重新進入。');
  // 整理中(剛編輯過、背景偵測還沒追上現況)→ 暫不允許定案：定案會永久凍結，必須等對齊好的最終狀態。
  const _ctx0 = loadContexts_(scope).find(c => c.id === journey.contextId);
  const _pending0 = !!(journey.basedOnUpdatedAt && _ctx0 && _ctx0.updatedAt && Date.parse(_ctx0.updatedAt) > Date.parse(journey.basedOnUpdatedAt));
  if (params.finalize && !_pending0) { try { finalizeJourney_(scope, jid); } catch (_) {} }
  // 解除定案只在測試期（JOURNEY_REPORT_TEST_BYPASS=true）開放——連端點一起鎖，
  // 正式版即使手刻 &unfinalize=1 也無效，定案＝不可逆。
  if (params.unfinalize && JOURNEY_REPORT_TEST_BYPASS) { try { unfinalizeJourney_(scope, jid); } catch (_) {} }
  // 分享回執（§0.6.13 後續）：定案後才可開放分享；share=1 開（產 shareToken）、share=0 停（回執名單保留）。
  if (params.share === '1') { try { enableJourneyShare_(scope, jid); } catch (e) { console.warn('enable share failed:', e && e.message); } }
  if (params.share === '0') { try { revokeJourneyShare_(scope, jid); } catch (_) {} }

  const j2 = loadJourneys_(scope).find(j => j.id === jid && j.status === 'journey') || journey;
  const context = loadContexts_(scope).find(c => c.id === j2.contextId);
  if (!context) return reportErrorPage_('這條歷程已更新或不存在，請回 LINE 重新進入。');

  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (context.recordIds || []).map(id => recById[id]).filter(Boolean)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const gap = getOrComputeJourneyGap_(scope, j2, context, records);
  const rpt = {
    baseUrl: journeyReportUrl_(scope, jid),
    shareUrl: j2.shareToken ? journeyShareUrl_(jid, j2.shareToken) : '',
    acks: j2.acks || [],
    ownerName: ownerDisplayName_(scope)
  };
  // 「整理中」＝剛編輯過、背景偵測/重整還沒追上 → 三條件/轉折顯示對齊中、定案暫鎖。
  const pending = !j2.finalized && !!(j2.basedOnUpdatedAt && context.updatedAt && Date.parse(context.updatedAt) > Date.parse(j2.basedOnUpdatedAt));
  const html = buildJourneyReportHtml_(j2, context, records, gap, rpt, pending);
  return HtmlService.createHtmlOutput(html)
    .setTitle('學習歷程現況 · ' + (journeyTitleParts_(context, j2).main || ''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 學習歷程總冊（/portfolio 的「完整版」網頁）。把（已定案優先的）所有學習歷程彙編成「一本」：
 *   封面 → 卷首語（LLM 1 通）→ 學習地圖（大類/轉折型態分布，純 CPU）→ 收錄目次 →
 *   各篇完整章節（章節扉頁 + 落差分析 + 語意地圖 + 三條件 + 發生節奏/敘事片段 + 偵測到的轉折）。
 * 每篇章節重用單篇「歷程現況」的區塊渲染器，但去掉定案/分享等操作（總冊唯讀、可瀏覽器列印成 PDF）。
 * 與單篇報告同信任等級（reportToken）。設計依 docs/design/context-to-journey.md §0.6.15（待驗收後補）。
 */
function serveCompendium_(params) {
  params = params || {};
  const scope = ownerScope_();
  if (!scope) return reportErrorPage_('尚未設定擁有者。');
  const meta = loadChatMeta_(scope);
  if (!meta.reportToken || params.t !== meta.reportToken) {
    return reportErrorPage_('連結無效或已過期。請回 LINE 重新點「瀏覽總冊」取得新連結。');
  }
  try { alignFrozenJourneyStamps_(scope); } catch (_) {}

  const ctxById = {};
  loadContexts_(scope).forEach(c => { ctxById[c.id] = c; });
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  if (!journeys.length) return reportErrorPage_('還沒有任何學習歷程。先在 LINE 用 /themes、/journey 累積，再回來。');

  // 定案優先（與入口卡同規則）；無定案退回全部、標現況。
  const jTime = j => { const c = ctxById[j.contextId]; return c && c.lastTs ? Date.parse(c.lastTs) : 0; };
  const finalized = journeys.filter(j => j.finalized);
  const isDraft = !finalized.length;
  const useJourneys = (finalized.length ? finalized : journeys).slice().sort((a, b) => {
    if (a.finalized && b.finalized) return Date.parse(b.finalizedAt || 0) - Date.parse(a.finalizedAt || 0);
    return jTime(b) - jTime(a);
  });

  // 每篇彙整資料（CPU；落差分析快取）。
  const chapters = useJourneys.map(j => {
    const c = ctxById[j.contextId];
    const records = c ? (c.recordIds || []).map(id => recById[id]).filter(Boolean)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) : [];
    let gap = null;
    try { gap = getOrComputeJourneyGap_(scope, j, c, records); } catch (_) {}
    return { j: j, c: c, records: records, gap: gap };
  }).filter(ch => ch.c);
  if (!chapters.length) return reportErrorPage_('歷程資料正在背景重整，請稍後再回來。');

  const owner = ownerDisplayName_(scope);
  const allTs = [];
  chapters.forEach(ch => ch.records.forEach(r => { const t = Date.parse(r.ts); if (t) allTs.push(t); }));
  allTs.sort((a, b) => a - b);
  const totalRecs = allTs.length;
  const span = totalRecs ? reportSpanLabel_(new Date(allTs[0]).toISOString(), new Date(allTs[totalRecs - 1]).toISOString()) : '';

  const parts = [];
  parts.push(compendiumStyle_());

  // ---- 封面 ----
  parts.push(`<header class="cover vol-cover">
    <div class="eyebrow">📚 學習歷程總冊</div>
    <h1>學習歷程總冊${isDraft ? '（現況）' : ''}</h1>
    ${owner ? `<div class="byline">👤 建立者：${escapeHtml_(owner)}</div>` : ''}
    <div class="scale">
      <span>📖 ${useJourneys.length} 篇學習歷程</span>
      ${finalized.length ? `<span>✅ ${finalized.length} 篇已定案</span>` : '<span>尚無定案</span>'}
      ${span ? `<span>📅 ${escapeHtml_(span)}</span>` : ''}
      <span>📝 ${totalRecs} 則紀錄</span>
    </div>
  </header>`);
  if (isDraft) parts.push('<div class="realign">尚無已定案歷程，以下為目前現況；到單篇「歷程現況」按「定案封存」可鎖定最終版。</div>');

  // ---- 卷首語（LLM 1 通；失敗就略過，不擋整本）----
  let preface = '';
  try { preface = summarizeCompendiumPreface_(useJourneys, ctxById); }
  catch (e) { console.warn('compendium preface failed:', e && e.message); }
  if (preface) parts.push(`<section class="vol-preface"><h2>卷首語 · 這段期間的學習樣貌</h2><p class="lead2">${escapeHtml_(preface).replace(/\n+/g, '<br>')}</p></section>`);

  // ---- 學習地圖（CPU）＋ 收錄目次 ----
  parts.push(compendiumStatsHtml_(chapters));
  parts.push(compendiumTocHtml_(chapters));

  // ---- 各篇完整章節（共用一份 episode 敘事預算，避免一次開很多 LLM）----
  const budgetRef = { left: (typeof EPISODE_NARRATIVE_BUDGET !== 'undefined') ? EPISODE_NARRATIVE_BUDGET : 6 };
  chapters.forEach((ch, i) => parts.push(compendiumChapterHtml_(ch.j, ch.c, ch.records, ch.gap, i + 1, budgetRef)));

  return HtmlService.createHtmlOutput(reportPageShell_('學習歷程總冊', parts.join('\n')))
    .setTitle('學習歷程總冊' + (owner ? ' · ' + owner : ''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 總冊專屬 CSS（放 body 內、不動共用 shell；重用 shell 既有 class 處理 gap/markers/episodes）。 */
function compendiumStyle_() {
  return `<style>
  .vol-cover{background:linear-gradient(135deg,#4a3b2a,#6b5538)}
  .lead2{font-size:14.5px;line-height:1.8;color:var(--ink);margin:0}
  .statline{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
  .statchip{font-size:12.5px;font-weight:bold;background:var(--soft);color:var(--cta);border-radius:999px;padding:4px 11px}
  .statchip .n{color:var(--ink);margin-left:4px}
  .vol-toc ol{margin:.2em 0;padding-left:1.5em}
  .vol-toc li{font-size:14px;margin:7px 0;line-height:1.5}
  .vol-toc a{color:var(--cta);text-decoration:none;font-weight:bold}
  .vol-toc .toc-mk{color:var(--muted);font-size:12px;margin-left:8px}
  .chapter-head{background:linear-gradient(135deg,#3a6ea5,#2a5a9e);color:#fff;border:none}
  .chapter-head h2{color:#fff;border:none;margin:.1em 0 0;padding:0}
  .chapter-head .chnum{font-size:12px;opacity:.85;letter-spacing:1px}
  .chapter-head .chkw{font-size:13px;opacity:.92;font-weight:bold;margin-top:.3em}
  .chapter-head .statepill{display:inline-block;font-size:12px;background:rgba(255,255,255,.2);padding:2px 11px;border-radius:999px;margin-top:.5em}
  .chapter-head .chlead{font-size:14px;opacity:.96;margin:.7em 0 0}
  .chapter-head .chscale{display:flex;flex-wrap:wrap;gap:6px 13px;font-size:12.5px;opacity:.95;margin-top:.7em;border-top:1px solid rgba(255,255,255,.25);padding-top:10px}
  .chhero{width:100%;max-height:200px;object-fit:cover;border-radius:10px;margin-top:.8em}
  @media print{.vol-cover{background:#4a3b2a !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .chapter-head{background:#2a5a9e !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;break-before:page}}
  </style>`;
}

/** 學習地圖（純 CPU）：關注領域（大類）分布 ＋ 學習轉折型態分布（只計 grounded 轉折）。 */
function compendiumStatsHtml_(chapters) {
  const catCount = {};
  chapters.forEach(ch => { const cat = (ch.j.keywords && ch.j.keywords.category) || '未分類'; catCount[cat] = (catCount[cat] || 0) + 1; });
  const catChips = Object.keys(catCount).sort((a, b) => catCount[b] - catCount[a])
    .map(c => `<span class="statchip">${escapeHtml_(c)}<span class="n">×${catCount[c]}</span></span>`).join('');
  const mkStyle = { '概念重述': '🔁', '跨主題整合': '🧩', '行動指向': '🎯', '後設反思': '🔭' };
  const mkCount = { '概念重述': 0, '跨主題整合': 0, '行動指向': 0, '後設反思': 0 };
  chapters.forEach(ch => {
    let g = {};
    try { g = groundedMarkerTypes_(ch.j, ch.records); } catch (_) {}
    Object.keys(mkCount).forEach(t => { if (g[t]) mkCount[t]++; });
  });
  const mkChips = Object.keys(mkCount).map(t => `<span class="statchip">${mkStyle[t]} ${t}<span class="n">×${mkCount[t]}</span></span>`).join('');
  return `<section><h2>學習地圖</h2>
    <p class="hint">這本總冊橫跨的關注領域，與學習轉折的型態分布——後者是貼整本歷程的後設觀察。</p>
    <div class="comp-t">關注領域（大類）</div><div class="statline">${catChips}</div>
    <div class="comp-t" style="margin-top:14px">學習轉折型態（幾篇出現過）</div><div class="statline">${mkChips}</div>
  </section>`;
}

/** 收錄目次：每篇可點錨點跳到章節，標 ✅已定案日期 / 🌳現況。 */
function compendiumTocHtml_(chapters) {
  const items = chapters.map((ch, i) => {
    const title = journeyTitleParts_(ch.c, ch.j).main || ch.j.title || '學習歷程';
    const mark = ch.j.finalized
      ? `✅ 已定案${ch.j.finalizedAt ? ' ' + Utilities.formatDate(new Date(ch.j.finalizedAt), TIME_ZONE, 'yyyy/MM/dd') : ''}`
      : '🌳 現況';
    return `<li><a href="#ch-${i + 1}">${i + 1}. ${escapeHtml_(title)}</a><span class="toc-mk">${escapeHtml_(mark)}</span></li>`;
  }).join('');
  return `<section class="vol-toc"><h2>收錄目次</h2><ol>${items}</ol></section>`;
}

/** 一篇完整章節：章節扉頁 + 落差 + 語意地圖 + 三條件 + 發生節奏/敘事片段 + 偵測到的轉折。
 *  重用單篇「歷程現況」的渲染器，去掉定案/分享操作（總冊唯讀）。budgetRef 是跨全本共用的
 *  episode 敘事 LLM 預算（{left}），避免一次開很多次。 */
function compendiumChapterHtml_(journey, context, records, gap, idx, budgetRef) {
  const tp = journeyTitleParts_(context, journey);
  const title = tp.main;
  const kw = journey.keywords || {};
  const kwStr = [kw.category].concat(kw.tags || []).filter(Boolean).join('｜');
  const episodes = groupByEpisode_(records, SESSION_GAP_MINUTES * 60 * 1000);
  const mediaKinds = {};
  records.forEach(r => { if (r.type && r.type !== 'text') mediaKinds[r.type] = (mediaKinds[r.type] || 0) + 1; });
  const askCount = records.filter(r => /^🔍\s*探問/.test((r.text || ''))).length;
  const realFirstTs = records.length ? records[0].ts : context.firstTs;
  const realLastTs = records.length ? records[records.length - 1].ts : context.lastTs;
  const spanStr = reportSpanLabel_(realFirstTs, realLastTs);
  const statePill = journey.finalized
    ? `✅ 已定案${journey.finalizedAt ? ' ' + Utilities.formatDate(new Date(journey.finalizedAt), TIME_ZONE, 'yyyy/MM/dd') : ''}`
    : '🌳 學習歷程現況（未定案）';
  const hero = pickJourneyHeroRecord_(records);
  const heroHtml = (hero && hero.fileId)
    ? `<img class="chhero" src="https://drive.google.com/thumbnail?id=${escapeAttr_(hero.fileId)}&sz=w600" alt="">`
    : '';

  const parts = [];

  // ---- 章節扉頁 ----
  parts.push(`<section class="chapter-head" id="ch-${idx}">
    <div class="chnum">第 ${idx} 篇</div>
    <h2>${escapeHtml_(title)}</h2>
    ${kwStr ? `<div class="chkw">${escapeHtml_(kwStr)}</div>` : ''}
    <div class="statepill">${escapeHtml_(statePill)}</div>
    ${journey.summary ? `<p class="chlead">${escapeHtml_(journey.summary)}</p>` : ''}
    <div class="chscale">
      <span>📅 ${escapeHtml_(spanStr)}</span>
      <span>📝 ${records.length} 則</span>
      <span>📜 ${episodes.length} 段</span>
      ${Object.keys(mediaKinds).length ? `<span>🎞 ${Object.keys(mediaKinds).map(t => typeLabel_(t)).join('、')}</span>` : ''}
      ${askCount ? `<span>🔍 ${askCount} 探問</span>` : ''}
    </div>
    ${heroHtml}
  </section>`);

  // ---- 落差分析 + 語意地圖 ----
  if (gap) { parts.push(reportGapHtml_(gap)); parts.push(reportSemanticMapHtml_(gap, journey)); }

  // ---- 三條件 ----
  const cr = context.criteria || {};
  const C = (typeof CONTEXT_CRITERIA !== 'undefined') ? CONTEXT_CRITERIA : {};
  const critRow = (ok, label, detail) =>
    `<div class="crit ${ok ? 'ok' : 'no'}"><span class="mk">${ok ? '✓' : '○'}</span><span class="cl">${label}</span><span class="cd">${detail}</span></div>`;
  const densOk = densityConditionMet_(cr);
  const densViaFocus = densOk && (cr.semanticDensity || 0) < (C.semanticDensityMin || 0.6);
  const visitOk = (cr.returnVisits || 0) >= (C.returnVisitsMin || 3) && (cr.returnSpanHours || 0) >= (C.returnSpanHoursMin || 1);
  const mediaOk = (cr.mediaKinds || 0) >= (C.mediaKindsMin || 2);
  parts.push(`<section><h2>怎麼成形的</h2>
    <div class="crits">
      ${critRow(densOk, '語意密度', densViaFocus
        ? `群內相似度 ${(cr.semanticDensity != null ? cr.semanticDensity : '–')}（靠聚焦達標 ${Math.round((cr.coreFrac || 0) * 100)}%）`
        : `群內相似度 ${(cr.semanticDensity != null ? cr.semanticDensity : '–')}`)}
      ${critRow(visitOk, '意向回返', `${cr.returnVisits || 0} 次回返・橫跨 ${cr.returnSpanHours || 0}h`)}
      ${critRow(mediaOk, '跨媒介協同', `${cr.mediaKinds || 0} 種媒介`)}
    </div>
  </section>`);

  // ---- 發生節奏 + 敘事片段（與單篇相同邏輯；共用 budgetRef 控 LLM 次數）----
  const rp = [`<section><h2>發生節奏與訊息流</h2><p class="hint">依「敘事片段」（30 分鐘內連續記寫為一段）排列，每段標出角色：●歷程起點／↩回返（標隔多久）／★橋接（標轉折種類）。</p>${reportRhythmTimelineHtml_(records, journey, context)}`];
  const keySet = journeyKeySet_(journey, records);
  const recByIdR = {}; records.forEach(r => { recByIdR[r.id] = r; });
  const markerHits = [];
  Object.keys(keySet).forEach(rid => {
    const r = recByIdR[rid]; if (!r) return;
    const ts = Date.parse(r.ts);
    (keySet[rid] || []).forEach(type => markerHits.push({ ts: ts, type: type }));
  });
  let prevEnd = null;
  episodes.forEach((ep, i) => {
    const gapHtml = (prevEnd != null) ? reportGapLabel_(prevEnd, ep.startTs) : '';
    if (gapHtml) rp.push(`<div class="gap">⟡ ${gapHtml}</div>`);
    let narr = episodeNarrativeCached_(ep);
    if (!narr && budgetRef.left > 0) { narr = episodeNarrativeGenerate_(ep); if (narr) budgetRef.left--; }
    const role = episodeRole_(i, ep, markerHits, prevEnd);
    rp.push(reportEpisodeHtml_(ep, i + 1, narr, role));
    prevEnd = ep.endTs;
  });
  rp.push('</section>');
  parts.push(rp.join('\n'));

  // ---- 偵測到的轉折 ----
  const markersHtml = reportMarkersHtml_(journey, records);
  if (markersHtml) {
    const intro = markerHits.length > 0
      ? '這條脈絡升格成「學習歷程」，是因為偵測到下面的轉折。'
      : '下面偵測到的轉折目前都對不上現存記錄，僅供參考。';
    parts.push(`<section><h2>偵測到的學習轉折</h2><p class="hint">${intro}</p>${markersHtml}</section>`);
  }

  return parts.join('\n');
}

/** 卷首語（總冊層級綜述，1 通 LLM）：讀全部歷程的標題/摘要/類別/轉折種類，寫「這段期間的學習樣貌」。 */
function summarizeCompendiumPreface_(journeys, ctxById) {
  if (!journeys.length) return '';
  const lines = journeys.map((j, i) => {
    const cat = (j.keywords && j.keywords.category) || '—';
    const tags = ((j.keywords && j.keywords.tags) || []).join('、');
    const marks = (j.markers || []).map(m => m.type);
    const uniq = marks.filter((t, k) => marks.indexOf(t) === k).join('、') || '—';
    const title = journeyTitleParts_(ctxById[j.contextId] || {}, j).main || j.title || '';
    return `${i + 1}. [${cat}] ${title}${tags ? '（' + tags + '）' : ''}｜摘要：${j.summary || '—'}｜轉折：${uniq}`;
  }).join('\n');
  const sys = '你是學習歷程檔案的總編。讀完這位學習者這段期間的所有學習歷程，寫一段「卷首語：這段期間的學習樣貌」。要求：≤150 字、第一人稱對學習者說（用「你」）、涵蓋（a）關注領域的廣度與重心、（b）學習方式的特徵、（c）一個誠實的後設觀察（例如哪種轉折偏多或偏少、可往哪裡深化）。只根據提供內容、不腦補、不說教、不寒暄、不條列，直接從正文開始。';
  const prompt = `以下是全部學習歷程（依收錄序）：\n\n${lines}\n\n請寫卷首語。`;
  return geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.5, maxOutputTokens: 1024 });
}

/** 是否已定案（封存）。歷程或其脈絡任一帶 finalized 旗標即視為定案。 */
function isContextFinalized_(scope, cid) {
  const c = loadContexts_(scope).find(x => x.id === cid);
  return !!(c && c.finalized);
}
function isRecordFinalized_(scope, rid) {
  return loadContexts_(scope).some(c => c.finalized && (c.recordIds || []).indexOf(rid) >= 0);
}

/**
 * 定案封存：鎖定這條歷程——journey/context 標 finalized，並把脈絡所有 record must-link
 * 釘到 `final:<cid>`（非 m: 前綴，重分群一律尊重、rollback 也保留）→ 背景不再增/減/移其成員。
 * 之後 改歸/刪除/移出 皆被守衛擋下，LINE 歷程現況轉唯讀。
 */
function finalizeJourney_(scope, jid) {
  const j = loadJourneys_(scope).find(x => x.id === jid && x.status === 'journey');
  if (!j) return false;
  const when = new Date().toISOString();
  j.finalized = true; j.finalizedAt = when;
  upsertJourney_(scope, j);
  const ctx = loadContexts_(scope).find(c => c.id === j.contextId);
  if (ctx) {
    ctx.finalized = true; ctx.finalizedAt = when;
    upsertContext_(scope, ctx);
    updateChatMeta_(scope, m => {
      const p = m.recordPins || {};
      (ctx.recordIds || []).forEach(rid => { p[rid] = 'final:' + ctx.id; });
      m.recordPins = p;
      return m;
    });
  }
  return true;
}

/** 解除定案：清旗標與 final: 釘選，放行重分群，回到可編輯狀態。 */
function unfinalizeJourney_(scope, jid) {
  const j = loadJourneys_(scope).find(x => x.id === jid);
  if (!j) return false;
  delete j.finalized; delete j.finalizedAt;
  upsertJourney_(scope, j);
  const ctx = loadContexts_(scope).find(c => c.id === j.contextId);
  if (ctx) {
    delete ctx.finalized; delete ctx.finalizedAt;
    upsertContext_(scope, ctx);
    updateChatMeta_(scope, m => {
      const p = m.recordPins || {};
      for (const rid in p) if (p[rid] === 'final:' + ctx.id) delete p[rid];
      m.recordPins = p;
      m.lastClassifyAt = new Date().toISOString();
      return m;
    });
  }
  return true;
}

/* ===== 分享回執（建立者 1 ↔ 多名訪客）=====
 * 定案後的歷程可開放分享：產生「專屬分享連結」（shareToken，與建立者的 reportToken 完全分離、
 * 訪客頁不含任何建立者操作）。拿到連結的人看唯讀現況＋填名字（＋一句留言）回執 →
 * 建立者收 LINE 推播、歷程卡標注「📩 已分享 · N 人回執」、LINE/網頁都可查回執名單。 */

/** 開放分享：定案後才可；產 shareToken（冪等——已開放就沿用，連結不變）。 */
function enableJourneyShare_(scope, jid) {
  const j = loadJourneys_(scope).find(x => x.id === jid && x.status === 'journey');
  if (!j || !j.finalized) return false;           // 未定案不可分享（內容還會變，分享出去會失真）
  if (!j.shareToken) {
    j.shareToken = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    j.sharedAt = new Date().toISOString();
    upsertJourney_(scope, j);
  }
  return true;
}

/** 停止分享：撤 token（舊連結立即失效）；回執名單保留。 */
function revokeJourneyShare_(scope, jid) {
  const j = loadJourneys_(scope).find(x => x.id === jid);
  if (!j || !j.shareToken) return false;
  delete j.shareToken;
  upsertJourney_(scope, j);
  return true;
}

/** 訪客分享連結（st=shareToken，與 reportToken 分離）。 */
function journeyShareUrl_(jid, shareToken) {
  let base = getPropOptional_(PROP.WEB_APP_EXEC_URL) || ScriptApp.getService().getUrl();
  base = stripUserPathSegment_(base);
  return `${base}?view=shared&jid=${encodeURIComponent(jid)}&st=${encodeURIComponent(shareToken)}`;
}

/** 記一筆回執：{name, note, ts}，同名 2 分鐘內重送視為重複（不重記）。回累計人次。 */
function recordJourneyAck_(scope, jid, name, note) {
  const j = loadJourneys_(scope).find(x => x.id === jid);
  if (!j) return 0;
  const acks = j.acks || [];
  const now = Date.now();
  const dup = acks.some(a => a && a.name === name && now - Date.parse(a.ts || 0) < 2 * 60 * 1000);
  if (!dup) {
    acks.push({ name: name, note: note || '', ts: new Date().toISOString() });
    j.acks = acks.slice(-100);
    upsertJourney_(scope, j);
  }
  return (j.acks || acks).length;
}

/** 訪客頁：驗 shareToken → 唯讀現況＋回執表單；ack=1 → 記回執＋推播建立者＋回執成功頁。 */
function serveSharedJourney_(jid, shareToken, params) {
  params = params || {};
  const scope = ownerScope_();
  if (!scope) return reportErrorPage_('尚未設定擁有者。');
  const journey = loadJourneys_(scope).find(j => j.id === jid && j.status === 'journey');
  if (!journey || !journey.finalized || !journey.shareToken || shareToken !== journey.shareToken) {
    return reportErrorPage_('分享連結無效或已停止分享。請向建立者索取新連結。');
  }
  const context = loadContexts_(scope).find(c => c.id === journey.contextId);
  if (!context) return reportErrorPage_('這條歷程已更新，請向建立者索取新連結。');
  const title = journeyTitleParts_(context, journey).main || '學習歷程';

  // 送出回執
  if (params.ack === '1') {
    const name = String(params.name || '').trim().slice(0, 24);
    const note = String(params.note || '').trim().slice(0, 200);
    if (!name) return reportErrorPage_('請填寫你的名字再送出回執。（按上一頁返回）');
    recordJourneyAck_(scope, jid, name, note);
    // 〔省 push 額度〕不每筆即時推——進佇列，由 backgroundSweep 的 notifyPendingAcks_ 彙整成一張卡
    // 推一次（走合宜守門：夜間不推/一輪一張/可全關）；/me 學習狀態卡也隨時免費查（同一佇列）。
    try {
      updateChatMeta_(scope, m => {
        const q = m.pendingAckNotices || [];
        q.push({ jid: jid, title: truncate_(title, 24), name: name, note: truncate_(note, 40), ts: new Date().toISOString() });
        m.pendingAckNotices = q.slice(-50);
        return m;
      });
    } catch (e) { console.warn('queue ack notice failed:', e && e.message); }
    return HtmlService.createHtmlOutput(reportPageShell_('回執成功', `
      <section class="finalized" style="text-align:center">
        <div class="fz">✅ 回執成功</div>
        <p class="hint">已通知建立者：<b>${escapeHtml_(name)}</b> 看過「${escapeHtml_(truncate_(title, 24))}」。</p>
        <a class="finalbtn" target="_top" href="${escapeAttr_(journeyShareUrl_(jid, journey.shareToken))}">↩ 回到歷程頁</a>
      </section>`))
      .setTitle('回執成功')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // 唯讀現況（visitor 模式：不出現任何建立者操作/連結，baseUrl＝分享連結本身）
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (context.recordIds || []).map(id => recById[id]).filter(Boolean)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const gap = getOrComputeJourneyGap_(scope, journey, context, records);
  const rpt = { visitor: true, baseUrl: journeyShareUrl_(jid, journey.shareToken), ownerName: ownerDisplayName_(scope) };
  const html = buildJourneyReportHtml_(journey, context, records, gap, rpt, false);
  return HtmlService.createHtmlOutput(html)
    .setTitle('學習歷程分享 · ' + title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 取得（必要時計算並持久化）一條歷程的落差分析。網頁(serveJourneyReport_)與
 * LINE 導覽卡共用同一個——同內容必同分:version(內容版本)沒變就讀 journey.gapAnalysis
 * 存檔、不重打 LLM;只有內容變動(新記錄/補充/移出片段＝正當外力，會 bump
 * context.updatedAt)才重算。回傳 null 表示太薄或 LLM 不可用，呼叫端略過分數呈現。
 */
function getOrComputeJourneyGap_(scope, journey, context, records) {
  const version = 'g9|' + (journey.basedOnUpdatedAt || journey.updatedAt || '') + '|' + (context.updatedAt || '');
  if (journey.gapAnalysis && journey.gapAnalysis.version === version) return journey.gapAnalysis;
  // 把「既有的其他主題」餵進去，讓 missing / crossTopic 從真實脈絡推斷、不憑空發明。
  const otherTopics = loadContexts_(scope).filter(c => c.id !== context.id).map(c => c.label || c.topicLabel).filter(Boolean);
  const computed = computeJourneyGap_(journey, context, records, otherTopics);
  if (computed) {
    computed.version = version;
    journey.gapAnalysis = computed;
    try { upsertJourney_(scope, journey); } catch (_) {}
    return computed;
  }
  return null;
}

/**
 * 每段「對有意義學習歷程的貢獻度」(留一法 / leave-one-out)：拿掉這段，整條的落差分數掉多少。
 *   貢獻 = 全分數 − 拿掉這段後的分數。正＝載重(該留)、0＝可有可無、負＝在稀釋(拿掉反而升)。
 * 同內容必同分：算一次存進 journey.contribAnalysis、隨版本快取。轉折關鍵那段標 'key' 不算
 * (它載重又不可移除，省一次 LLM)。回傳 { 'startTs': 貢獻數或 'key' 或 null(算不出) }。
 */
function getOrComputeContributions_(scope, journey, context, records, episodes, keySet) {
  const version = (journey.basedOnUpdatedAt || journey.updatedAt || '') + '|' + (context.updatedAt || '');
  if (journey.contribAnalysis && journey.contribAnalysis.version === version && journey.contribAnalysis.byStartTs) {
    return journey.contribAnalysis.byStartTs;
  }
  const fullGap = getOrComputeJourneyGap_(scope, journey, context, records);
  const fullScore = fullGap ? fullGap.score : 0;
  const otherTopics = loadContexts_(scope).filter(c => c.id !== context.id).map(c => c.label || c.topicLabel).filter(Boolean);
  const byStartTs = {};
  (episodes || []).forEach(ep => {
    const k = String(ep.startTs);
    if (ep.records.some(r => keySet && keySet[r.id])) { byStartTs[k] = 'key'; return; }  // 轉折關鍵：不算
    const rm = {}; ep.records.forEach(r => { rm[r.id] = true; });
    const subset = records.filter(r => !rm[r.id]);
    let sub;
    if (subset.length < 2) sub = 0;                       // 移掉剩太少＝掏空 → 高貢獻
    else { const g = computeJourneyGap_(journey, context, subset, otherTopics); sub = g ? g.score : null; }
    byStartTs[k] = (sub == null) ? null : (fullScore - sub);
  });
  journey.contribAnalysis = { version: version, byStartTs: byStartTs };
  try { upsertJourney_(scope, journey); } catch (_) {}
  return byStartTs;
}

/**
 * 移出一則片段（語意 C・重歸）：從脈絡 recordIds 移除、清掉它的 topicLabel（讓背景重判）、
 * 記下 meta.recordExclude[rid]＝原主題（重判時避開、不繞回原處）。不刪記錄、不碰時間軸
 * （/recall、/ask、/episodes 仍找得到）。下一輪 sweep 重判→歸到別的合適主題或自成新主題。
 * bump updatedAt → 落差分數重算；bump lastClassifyAt → 放行背景重判/重分群。
 */
/** 重算脈絡時間區段（firstTs/lastTs）＝成員記錄的最早/最晚 ts。移出/放回片段後呼叫，
 *  否則網頁跨度標籤、時間軸 X 範圍、LINE 卡跨度會殘留被移除片段的舊時間。 */
function recomputeContextSpan_(scope, ctx) {
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const tss = (ctx.recordIds || []).map(id => recById[id]).filter(Boolean)
    .map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  ctx.firstTs = tss.length ? new Date(tss[0]).toISOString() : null;
  ctx.lastTs = tss.length ? new Date(tss[tss.length - 1]).toISOString() : null;
}

function dropRecordFromContext_(scope, cid, rid) {
  const ctx = loadContexts_(scope).find(c => c.id === cid);
  if (!ctx || !rid) return;
  const ids = ctx.recordIds || [];
  if (ids.indexOf(rid) < 0 && (ctx.droppedRecordIds || []).indexOf(rid) >= 0) return; // 已移出
  ctx.recordIds = ids.filter(x => x !== rid);
  ctx.droppedRecordIds = (ctx.droppedRecordIds || []).filter(x => x !== rid).concat([rid]);
  recomputeContextSpan_(scope, ctx);   // 移除後重算時間區段，否則跨度殘留舊時間
  ctx.updatedAt = new Date().toISOString();
  upsertContext_(scope, ctx);
  const origTopic = clearRecordTopicForRehome_(scope, rid);   // 清 topicLabel，回傳原主題
  updateChatMeta_(scope, m => {
    const ex = m.recordExclude || {};
    ex[rid] = { cid: ctx.id, topic: origTopic || '', category: ctx.category || '' };
    m.recordExclude = ex;
    const p = m.recordPins || {}; if (p[rid]) delete p[rid]; m.recordPins = p;   // 清掉舊 pin
    m.lastContextUpgradeAt = null;            // 放行立即重分群，讓新家當下成形
    m.lastClassifyAt = new Date().toISOString();
    return m;
  });
  // 〔移出當下即時找新家〕一通 LLM 直接給它新的 (大類, 議題)（絕不是原議題、可跨大類如 AI研習營，
  // 真的都不合才造新），並 topicLock 鎖住——保證馬上落地、不卡「等待整理」、也回不到原脈絡。
  // 背景自動重判對「語意本就屬原主題」的記錄找不到別的家、會卡住，所以這裡主動給家。
  try { rehomeDroppedRecord_(scope, rid, origTopic, cid); }
  catch (e) { console.warn('rehome dropped record failed:', e && e.message); }
}

// 移出找新家：與既有脈絡群心 cosine ≥ 此值就直接歸進那條現有主題（優先用既有、別動不動造新）。短中文偏低、取中庸。待校準。
const REHOME_JOIN_COS = 0.50;

/** 移出當下即時「找新家」：① 先用向量找「最相近的既有脈絡」（排除原脈絡/原議題），夠相近就直接歸進
 *  那條現有主題（完全符合的既有主題如 AI研習營會被選中、不會造新）；② 都不夠相近才用一通 LLM 判
 *  (大類, 議題)（硬性排除原議題、能歸現有就歸、否則造新）。topicLock 鎖住 → 立即落地、不回原脈絡。回 {category, topic}。 */
function rehomeDroppedRecord_(scope, rid, excludeTopic, excludeCid) {
  const allRecs = loadEmbeddingRecords_(scope);
  const rec = allRecs.find(r => r.id === rid);
  if (!rec) return null;
  const exNorm = String(excludeTopic || '').replace(/\s+/g, '');
  const recById = {}; allRecs.forEach(r => { recById[r.id] = r; });
  const majTopic = (c) => {
    const v = {}; let bt = '', bn = -1;
    (c.recordIds || []).forEach(id => { const r = recById[id]; if (r && r.topicLabel) { v[r.topicLabel] = (v[r.topicLabel] || 0) + 1; if (v[r.topicLabel] > bn) { bn = v[r.topicLabel]; bt = r.topicLabel; } } });
    return bt || c.label || '';
  };

  // ① 向量：找最相近的既有脈絡（排除原脈絡 cid、原議題）→ 夠相近就直接歸現有（含跨大類，如 AI研習營）。
  if (rec.embedding && rec.embedding.length === EMBED_DIM) {
    const ccs = contextCentroids_(loadContexts_(scope), recById);
    let bestCtx = null, bestTopic = '', bestCos = -2;
    for (const cc of ccs) {
      const c = cc.context;
      if (excludeCid && c.id === excludeCid) continue;          // 不回原脈絡
      const mt = majTopic(c);
      if (!mt || mt.replace(/\s+/g, '') === exNorm) continue;   // 不回原議題
      const cos = cosineSim_(rec.embedding, cc.centroid);
      if (cos > bestCos) { bestCos = cos; bestCtx = c; bestTopic = mt; }
    }
    if (bestCtx && bestCos >= REHOME_JOIN_COS) {
      const cat = bestCtx.category || rec.category || '其他';
      try { setRecordsCategoryTopic_(scope, [rid], cat, bestTopic); } catch (_) {}
      return { category: cat, topic: bestTopic, joined: true };
    }
  }

  // ② 向量沒有夠相近的既有家 → LLM 判 (大類, 議題)（硬性排除原議題；能歸現有就歸、否則造新）。
  const text = ((rec.aggregatedText || rec.text) || '').replace(/\s+/g, ' ').slice(0, 500);
  if (!text) return null;
  const byCat = {};
  allRecs.forEach(r => { if (r.category && r.topicLabel) (byCat[r.category] = byCat[r.category] || {})[r.topicLabel] = 1; });
  const cats = (typeof JOURNEY_KEYWORD_CATEGORIES !== 'undefined') ? JOURNEY_KEYWORD_CATEGORIES : ['教學', '研究', '閱讀', '反思', '札記', '生活', '規劃', '進修'];
  const menu = Object.keys(byCat).map(c => `${c}：${Object.keys(byCat[c]).map(t => '「' + t + '」').join('、')}`).join('\n') || '（尚無）';
  const sys = '你是學習記寫的歸戶器。給你一則記錄，請判它的「大類」（從這幾類擇一：' + cats.join('、')
    + '）與「議題標籤」（≤8 字名詞片語）。使用者剛把它從議題「' + (excludeTopic || '')
    + '」移出，所以**議題標籤絕對不可以是「' + (excludeTopic || '') + '」**。能歸到下方現有的其他議題就原字照用；'
    + '真的都不合才造一個新的 ≤8 字議題標籤。只輸出 JSON：{"大類":"<擇一>","議題":"<≤8字>"}。';
  let category = rec.category || '其他', topic = '';
  try {
    const out = geminiGenerate_([{ text: '現有主題：\n' + menu + '\n\n這則記錄：\n' + text }],
      { systemInstruction: sys, temperature: 0.2, maxOutputTokens: 200 });
    const j = extractJson_(out || '');
    if (j) {
      const c = String(j['大類'] || j.category || '').trim();
      const t = String(j['議題'] || j.topic || '').replace(/\s+/g, '').replace(/[。，、！？.!?]+$/, '').slice(0, 16);
      if (cats.indexOf(c) >= 0) category = c;
      if (t && t.replace(/\s+/g, '') !== exNorm) topic = t;
    }
  } catch (e) { console.warn('rehomeDroppedRecord_ LLM failed:', e && e.message); }
  if (!topic) topic = '待整理記錄';   // 後備：LLM 失敗或又給原議題 → 中性新標籤，確保落地、不回原處
  try { setRecordsCategoryTopic_(scope, [rid], category, topic); } catch (_) {}
  // 不清 recordExclude：放回（undrop）要靠它還原原議題；記錄已 topicLock，背景也不會再重判。
  return { category: category, topic: topic };
}

/** 放回（undo 移出）：還原原主題、清掉排除與 droppedRecordIds、移回脈絡。bump 觸發重分群。 */
function undropRecordFromContext_(scope, cid, rid) {
  const ctx = loadContexts_(scope).find(c => c.id === cid);
  if (!ctx || !rid) return;
  ctx.droppedRecordIds = (ctx.droppedRecordIds || []).filter(x => x !== rid);
  if ((ctx.recordIds || []).indexOf(rid) < 0) ctx.recordIds = (ctx.recordIds || []).concat([rid]);
  recomputeContextSpan_(scope, ctx);   // 放回後重算時間區段
  ctx.updatedAt = new Date().toISOString();
  upsertContext_(scope, ctx);
  const ex = (loadChatMeta_(scope).recordExclude || {})[rid];
  if (ex && ex.topic) { try { setRecordCategoryTopic_(scope, rid, ex.category || ctx.category, ex.topic); } catch (_) {} }
  updateChatMeta_(scope, m => {
    const e = m.recordExclude || {}; delete e[rid]; m.recordExclude = e;
    const p = m.recordPins || {}; if (p[rid]) delete p[rid]; m.recordPins = p;
    m.lastClassifyAt = new Date().toISOString();
    return m;
  });
}

function reportErrorPage_(msg) {
  const safe = escapeHtml_(msg);
  return HtmlService.createHtmlOutput(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<div style="font-family:sans-serif;padding:40px;color:#444;text-align:center">` +
    `<div style="font-size:48px">🔒</div><p style="font-size:16px">${safe}</p></div>`
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ============================ HTML 構成 ============================ */

function buildJourneyReportHtml_(journey, context, records, gap, rpt, pending) {
  const tp = journeyTitleParts_(context, journey);   // 使用者改名＝主標、自動名退為副標
  const title = tp.main;
  const realignNote = pending ? '<div class="realign">🛠 你剛調整過內容，這區正在背景重新對齊（約幾分鐘），數字稍後會更新。</div>' : '';
  const cr = context.criteria || {};
  const C = (typeof CONTEXT_CRITERIA !== 'undefined') ? CONTEXT_CRITERIA : {};

  // 規模統計
  const episodes = groupByEpisode_(records, SESSION_GAP_MINUTES * 60 * 1000);
  const mediaKinds = {};
  records.forEach(r => { if (r.type && r.type !== 'text') mediaKinds[r.type] = (mediaKinds[r.type] || 0) + 1; });
  const askCount = records.filter(r => /^🔍\s*探問/.test((r.text || ''))).length;
  // 時間區段以實際成員（records 已排序）為準，防 context.firstTs/lastTs 在某些路徑殘留舊時間。
  const realFirstTs = records.length ? records[0].ts : context.firstTs;
  const realLastTs = records.length ? records[records.length - 1].ts : context.lastTs;
  const spanStr = reportSpanLabel_(realFirstTs, realLastTs);

  // 關鍵字
  const kw = journey.keywords || {};
  const kwStr = [kw.category].concat(kw.tags || []).filter(Boolean).join('｜');

  const parts = [];

  // ---- 封面 ----
  parts.push(`<header class="cover">
    <div class="eyebrow">🌳 學習歷程現況</div>
    <h1>${escapeHtml_(title)}</h1>
    ${rpt && rpt.ownerName ? `<div class="byline">👤 建立者：${escapeHtml_(rpt.ownerName)}</div>` : ''}
    ${tp.sub ? `<div class="subt">依現況內容：${escapeHtml_(tp.sub)}</div>` : ''}
    ${kwStr ? `<div class="kw">${escapeHtml_(kwStr)}</div>` : ''}
    ${journey.summary ? `<p class="lead">${escapeHtml_(journey.summary)}</p>` : ''}
    <div class="scale">
      <span>📅 ${escapeHtml_(spanStr)}</span>
      <span>📝 ${records.length} 則訊息</span>
      <span>📜 ${episodes.length} 個敘事片段</span>
      ${Object.keys(mediaKinds).length ? `<span>🎞 ${Object.keys(mediaKinds).map(t => typeLabel_(t)).join('、')}</span>` : ''}
      ${askCount ? `<span>🔍 ${askCount} 次探問</span>` : ''}
    </div>
  </header>`);

  // ---- 落差分析（現況 vs 有意義的學習歷程）：頭條鏡子，非評分、非閘 ----
  // gap 由 serveJourneyReport_ 算好＋持久化後傳入（同內容必同分；不在渲染層打 LLM）。
  parts.push(reportGapHtml_(gap));
  parts.push(reportSemanticMapHtml_(gap, journey));

  // ---- 升格判準（為何成為脈絡 / 歷程）----
  const critRow = (ok, label, detail) =>
    `<div class="crit ${ok ? 'ok' : 'no'}"><span class="mk">${ok ? '✓' : '○'}</span><span class="cl">${label}</span><span class="cd">${detail}</span></div>`;
  const densOk = densityConditionMet_(cr);
  const densViaFocus = densOk && (cr.semanticDensity || 0) < (C.semanticDensityMin || 0.6);
  const visitOk = (cr.returnVisits || 0) >= (C.returnVisitsMin || 3) && (cr.returnSpanHours || 0) >= (C.returnSpanHoursMin || 1);
  const mediaOk = (cr.mediaKinds || 0) >= (C.mediaKindsMin || 2);
  parts.push(`<section>
    <h2>記寫脈絡：怎麼成形的</h2>
    <p class="hint">這條從「隨手記寫」長成一條脈絡，靠的是三個條件——下面是達成情況。</p>
    ${realignNote}
    <div class="crits">
      ${critRow(densOk, '語意密度', densViaFocus
        ? `群內相似度 ${(cr.semanticDensity != null ? cr.semanticDensity : '–')}（未到 ${C.semanticDensityMin || 0.6}，但成員多扣同一核心 聚焦 ${Math.round((cr.coreFrac || 0) * 100)}%＝靠聚焦達標）`
        : `群內相似度 ${(cr.semanticDensity != null ? cr.semanticDensity : '–')}（內容是否聚焦同一件事）`)}
      ${critRow(visitOk, '意向回返', `${cr.returnVisits || 0} 次回返・橫跨 ${cr.returnSpanHours || 0}h（是否持續關注）`)}
      ${critRow(mediaOk, '跨媒介協同', `${cr.mediaKinds || 0} 種媒介（是否多種形式記寫）`)}
    </div>
  </section>`);

  // ---- 發生節奏 + 敘事片段（訊息流 + 媒體）----
  parts.push(`<section><h2>發生節奏與訊息流</h2><p class="hint">依「敘事片段」（30 分鐘內連續記寫為一段）排列，每段標出它在做什麼，片段之間標出回返間隔。每段並標出它在這條線裡的角色：●歷程起點／↩回返（標隔多久回來）／★橋接（標出轉折種類）；夠長的片段再附「片段內節奏」小圖。點圖可放大，音檔／影片可直接播放。</p>${reportRhythmTimelineHtml_(records, journey, context)}`);
  // 片段角色（點線面）：轉折落點＋類型 → 判斷哪段是橋接、是哪種轉折。沿用 journeyKeySet_
  // 的歸戶判定（與 ✕ 守門同一套）；引用的記錄已不在本脈絡的「孤兒轉折」自然不會配到任何片段。
  const keySet = journeyKeySet_(journey, records);
  const recByIdR = {}; records.forEach(r => { recByIdR[r.id] = r; });
  const markerHits = [];
  Object.keys(keySet).forEach(rid => {
    const r = recByIdR[rid]; if (!r) return;
    const ts = Date.parse(r.ts);
    (keySet[rid] || []).forEach(type => markerHits.push({ ts: ts, type: type }));
  });
  let prevEnd = null;
  // 片段語意摘要（§2）：沿用既有 episodeNarrative 快取（6h、記錄變才重算）。每次開報告
  // 最多即時生成 EPISODE_NARRATIVE_BUDGET 段（其餘讀快取或留白），下次再開補滿——bound 延遲。
  let narrBudget = (typeof EPISODE_NARRATIVE_BUDGET !== 'undefined') ? EPISODE_NARRATIVE_BUDGET : 6;
  episodes.forEach((ep, i) => {
    const gapHtml = (prevEnd != null) ? reportGapLabel_(prevEnd, ep.startTs) : '';
    if (gapHtml) parts.push(`<div class="gap">⟡ ${gapHtml}</div>`);
    let narr = episodeNarrativeCached_(ep);
    if (!narr && narrBudget > 0) { narr = episodeNarrativeGenerate_(ep); if (narr) narrBudget--; }
    const role = episodeRole_(i, ep, markerHits, prevEnd);
    parts.push(reportEpisodeHtml_(ep, i + 1, narr, role));
    prevEnd = ep.endTs;
  });
  parts.push(`</section>`);

  // ---- 脈絡生歷程：偵測到的轉折 ----
  const markersHtml = reportMarkersHtml_(journey, records);
  if (markersHtml) {
    const anyGrounded = markerHits.length > 0;
    const intro = anyGrounded
      ? '這條脈絡升格成「學習歷程」，是因為偵測到下面的轉折。'
      : '下面偵測到的轉折，目前都<b>對不上現存記錄</b>——對應的記錄已不在本脈絡（多半是被移除、或背景重新分群歸去別條了）。僅供參考，不足以支撐這條成為「學習歷程」。';
    parts.push(`<section><h2>脈絡生歷程：偵測到的轉折</h2><p class="hint">${intro}</p>${realignNote}${markersHtml}</section>`);
  }

  // ---- 定案 / 已定案 ＋ 分享回執 ----
  // visitor（分享連結開的）＝唯讀＋回執表單，**絕不**渲染建立者操作（定案/解除/分享管理——那些
  // 連結帶 reportToken，洩漏＝交出管理權）。owner＝定案區＋（定案後）分享回執管理區。
  if (rpt && rpt.visitor) {
    parts.push(reportAckFormHtml_(journey, rpt));
  } else {
    parts.push(reportFinalizeHtml_(journey, rpt, pending));
    parts.push(reportShareHtml_(journey, rpt));
  }

  const body = parts.join('\n');
  return reportPageShell_(title, body);
}

/** 〔owner〕分享回執管理區：定案後才出現。未開放＝說明＋「開放分享回執」；已開放＝分享連結
 *  （複製鈕）＋回執名單＋停止分享。 */
function reportShareHtml_(journey, rpt) {
  if (!rpt || !rpt.baseUrl || !journey.finalized) return '';
  const css = `<style>
    .share{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:14px}
    .share h2{font-size:15px;margin:0 0 6px;color:var(--cta)}
    .sharelink{display:flex;gap:6px;margin:8px 0}
    .sharelink input{flex:1;font-size:12px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;color:#555;background:var(--soft)}
    .sharelink button{font-size:12px;font-weight:bold;border:0;border-radius:8px;padding:7px 12px;background:var(--cta);color:#fff;cursor:pointer}
    .acks{margin:10px 0 0;padding:0;list-style:none}
    .acks li{font-size:13px;padding:6px 0;border-bottom:1px solid #f0f3f7}
    .acks li:last-child{border-bottom:0}
    .acks .at{color:var(--muted);font-size:11px;margin-left:6px}
    .acks .nt{display:block;color:#555;font-size:12px;margin-top:2px}
    .stopshare{font-size:12px;color:var(--muted);text-decoration:underline}
  </style>`;
  const acks = (rpt.acks || []).slice().reverse();
  const ackList = acks.length
    ? `<ul class="acks">` + acks.map(a =>
        `<li>📩 <b>${escapeHtml_(a.name || '')}</b><span class="at">${a.ts ? escapeHtml_(Utilities.formatDate(new Date(a.ts), TIME_ZONE, 'MM/dd HH:mm')) : ''}</span>` +
        (a.note ? `<span class="nt">💬 ${escapeHtml_(a.note)}</span>` : '') + `</li>`).join('') + `</ul>`
    : `<p class="hint">尚無回執。把上面的分享連結傳給對方，對方看完填名字送出，你會收到 LINE 通知。</p>`;
  if (!rpt.shareUrl) {
    return `${css}<section class="share">
      <h2>📩 分享與回執</h2>
      <p class="hint">已定案的歷程可以分享給其他人：系統會產生一條<b>專屬分享連結</b>（與你的管理連結分開），對方打開只能<b>唯讀瀏覽</b>並「回執」——回執後你會收到 LINE 通知。</p>
      ${acks.length ? ackList : ''}
      <a class="finalbtn" target="_top" href="${escapeAttr_(rpt.baseUrl + '&share=1')}">🔗 開放分享回執</a>
    </section>`;
  }
  return `${css}<section class="share">
    <h2>📩 分享與回執（${acks.length} 人已回執）</h2>
    <div class="sharelink"><input id="shurl" readonly value="${escapeAttr_(rpt.shareUrl)}"><button onclick="var i=document.getElementById('shurl');i.select();document.execCommand('copy');this.textContent='已複製 ✓'">複製連結</button></div>
    <p class="hint">把這條連結傳給要分享的人（可多人）。對方唯讀瀏覽＋回執；<b>不會</b>看到你的管理按鈕。</p>
    ${ackList}
    <p style="margin-top:10px"><a class="stopshare" target="_top" href="${escapeAttr_(rpt.baseUrl + '&share=0')}" onclick="return confirm('停止分享？舊連結立即失效（回執名單會保留）。')">停止分享（連結失效）</a></p>
  </section>`;
}

/** 〔visitor〕回執區：已定案徽章（無任何解鎖/管理連結）＋「我看過了」回執表單。 */
function reportAckFormHtml_(journey, rpt) {
  const when = journey.finalizedAt ? Utilities.formatDate(new Date(journey.finalizedAt), TIME_ZONE, 'yyyy/MM/dd') : '';
  const m = String(rpt.baseUrl || '').match(/^([^?]+)\?(.*)$/);
  const base = m ? m[1] : rpt.baseUrl;
  const hidden = (m ? m[2].split('&') : []).map(kv => {
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
    return `<input type="hidden" name="${escapeAttr_(k)}" value="${escapeAttr_(v)}">`;
  }).join('');
  return `<style>
    .ackform{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:14px}
    .ackform h2{font-size:15px;margin:0 0 6px;color:var(--cta)}
    .ackform input[type=text]{width:100%;box-sizing:border-box;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0}
    .ackform button{font-size:14px;font-weight:bold;border:0;border-radius:10px;padding:10px 16px;background:var(--ok);color:#fff;cursor:pointer;width:100%}
  </style>
  <section class="finalized"><div class="fz">✅ 這是已定案的學習歷程${when ? '（' + escapeHtml_(when) + ' 封存）' : ''}</div>
    <p class="hint">由建立者分享給你瀏覽（唯讀）。</p></section>
  <section class="ackform">
    <h2>📩 回執給建立者</h2>
    <p class="hint">看完了嗎？留下你的名字（可附一句話），建立者會收到通知。</p>
    <form method="get" action="${escapeAttr_(base)}" target="_top">
      ${hidden}
      <input type="hidden" name="ack" value="1">
      <input type="text" name="name" maxlength="24" placeholder="你的名字（必填）" required>
      <input type="text" name="note" maxlength="200" placeholder="想說的一句話（可空白）">
      <button type="submit">✅ 我看過了，送出回執</button>
    </form>
  </section>`;
}

/** 定案區塊：未定案＝確認後封存的按鈕；已定案＝封存徽章（測試期可解除）。 */
function reportFinalizeHtml_(journey, rpt, pending) {
  if (!rpt || !rpt.baseUrl) return '';
  if (pending && !journey.finalized) {
    return `<section class="finalize">
      <h2>確認無誤了嗎？</h2>
      <p class="hint">你剛調整過內容，三條件與轉折正在背景重新對齊（約幾分鐘）。定案會<b>永久鎖定</b>，必須等忠實的最終狀態——<b>對齊完成前暫時無法定案</b>。稍後重新整理本頁再來。</p>
      <div class="finalwait">🛠 整理中，暫時無法定案（稍候重整本頁）</div>
    </section>`;
  }
  if (journey.finalized) {
    const when = journey.finalizedAt ? Utilities.formatDate(new Date(journey.finalizedAt), TIME_ZONE, 'yyyy/MM/dd HH:mm') : '';
    const unlock = JOURNEY_REPORT_TEST_BYPASS
      ? `　<a class="unfinal" target="_top" href="${escapeAttr_(rpt.baseUrl + '&unfinalize=1')}" onclick="return confirm('解除定案？這條會回到可編輯狀態。')">解除定案（測試）</a>` : '';
    return `<section class="finalized">
      <div class="fz">✅ 已定案・封存${when ? '於 ' + escapeHtml_(when) : ''}</div>
      <p class="hint">這條學習歷程已定案：內容鎖定，不能再改歸或移除片段，LINE 的「歷程現況」也轉為唯讀。${unlock}</p>
    </section>`;
  }
  // 定案＝頁內兩段式確認（不用瀏覽器原生 confirm()——那會硬塞「An embedded page at …
  // googleusercontent.com says」一長串網址前綴，看起來很複雜）。第一顆鈕只展開確認面板；
  // 真正送出的鈕按下即自我鎖死（pointer-events:none + dataset.go 旗標），擋二次點選。
  const finalUrl = escapeAttr_(rpt.baseUrl + '&finalize=1');
  return `<section class="finalize">
    <h2>確認無誤了嗎？</h2>
    <p class="hint">瀏覽完上面的內容，若這就是你要的學習歷程初版，就可以「定案封存」——之後內容鎖定，不能再改歸或移除片段（LINE 的「歷程現況」也轉唯讀）。</p>
    <button type="button" id="finalstart" class="finalbtn" onclick="askFinal(true)">✅ 定案封存</button>
    <div id="finalask" class="finalask" style="display:none">
      <p>確定要定案封存？<b>定案後內容就鎖定、不能再改</b>。</p>
      <div class="finalask-btns">
        <a id="finalgo" class="finalbtn" target="_top" href="${finalUrl}" onclick="return goFinal(this)">確定定案</a>
        <button type="button" class="finalcancel" onclick="askFinal(false)">取消</button>
      </div>
    </div>
  </section>`;
}

/**
 * 落差分析：把「這條現況」對照「有意義的學習歷程」，照出落差。
 * 一致性保證——分數不是 LLM 喊出來的數字，而是 LLM 只判四項「離散等級」(temperature 0)，
 * 分數由下面固定權重公式算出 → 同內容必同分、不隨機浮動；只有內容變動才會變（呼叫端用
 * version 控制、算一次存進 journey.gapAnalysis）。回傳 null 時報告就不顯示此區塊。
 */
/** 落差量尺四軸權重（與系統「四種學習轉折」同構；合計 100）。可調點集中於此，校準集共用。 */
const GAP_DIM_WEIGHTS = { conceptDepth: 30, crossTopic: 25, actionOrient: 20, metaReflection: 25 };
/** 聚合曲線指數（<1）：把「加權線性」再過一條凹曲線＝獎勵深度——把強項做深就接近滿分、不必四軸都滿。
 *  治「線性對『深而窄』歷程系統性低估」（校準集 MAE 14.9→5.2、見 GapCalibration.gs）。改聚合只動這裡。 */
const GAP_AGG_GAMMA = 0.6;

/** 落差分數的單一真相公式：四軸「發展程度」(連續 0~1)×權重＝加權線性(0~100)，再過 GAP_AGG_GAMMA
 *  凹曲線換算成最終分數——獎勵深度（強項做深就拉得上來）、不要求四軸都滿才高分。
 *  computeJourneyGap_（線上）與 GapCalibration.gs（驗證）共用，兩邊一致、不漂移。 */
function gapScoreFromLevels_(lv) {
  lv = lv || {};
  const c = x => Math.max(0, Math.min(1, Number(x) || 0));
  let base = 0;
  for (const k in GAP_DIM_WEIGHTS) base += c(lv[k]) * GAP_DIM_WEIGHTS[k];   // 加權線性 0~100
  return Math.round(100 * Math.pow(base / 100, GAP_AGG_GAMMA));             // 獎勵深度曲線
}

function computeJourneyGap_(journey, context, records, otherTopics) {
  records = (records || []).filter(r => r && r.text);
  if (records.length < 2) return null;   // 太薄、觀察不出軌跡，不硬編

  const lines = records
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .map((r, i) => `${i + 1}. [${Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd')}] ${truncate_(String(r.text).replace(/\s+/g, ' '), 160)}`);
  const otherList = (otherTopics || []).filter(Boolean).slice(0, 30).join('、') || '（暫無其他主題）';

  // 已偵測到的學習轉折（grounded：evidence 對得上現存記錄）——餵進去當「發展程度」的評分基準，
  // 讓落差判斷與偵測一致（治本：同一條歷程不再兩套 LLM 各打各的、整合維與偵測打架）。
  let grounded = {};
  try { grounded = groundedMarkerTypes_(journey, records); } catch (_) {}
  const mkLines = ((journey && journey.markers) || [])
    .filter(m => m && m.evidence && grounded[m.type])
    .map(m => `- ${m.type}（信心 ${Math.round((m.confidence || 0) * 100)}%）：「${truncate_(String(m.evidence).replace(/\s+/g, ' '), 120)}」`);
  const mkBlock = mkLines.length ? mkLines.join('\n') : '（目前沒有對得上現存記錄的轉折）';

  const sys = '你是學習歷程診斷者。把「這條記寫脈絡的現況」對照「一條有意義的學習歷程該有的樣子」，照出兩者的距離——不是評分定高下，是指出可以再往哪走。'
    + '一條有意義的學習歷程，會在四種「學習轉折」上有發展：概念深化、跨主題整合、行動指向、後設反思。'
    + '請為這四軸各評一個「發展程度」(連續 0~1)，嚴格照錨點、只根據提供內容、不腦補、不寒暄，輸出 JSON。';
  const prompt = [
    `【這條現況的標題】${journey.title || journey.label || ''}`,
    `【這位學習者既有的其他主題】${otherList}`,
    '【系統已偵測到的學習轉折（已對得上現存記錄）】',
    mkBlock,
    '※ 上列轉折已成立——對應軸的發展程度「不應為 0」(至少萌芽 0.3)；但仍要依內容判斷它停在萌芽、成形、還是充分。未列出的軸，內容裡若其實有也照給、確實沒有才 0。不要與上列偵測相矛盾。',
    '',
    '【依時間排序的記寫內容】', lines.join('\n'), '',
    '四軸「發展程度」錨點（連續 0~1，可取小數）：',
    '  0=完全沒有；0.3=萌芽（點到、沒展開）；0.6=成形（有自己的話／明確一步／已連起來）；0.85=充分（展開、可佐證、連成整體）；1.0=非常充分。',
    '- conceptDepth 概念深化：把關鍵概念用自己的話想透的程度（只點名=0.3、有自己的說法=0.6+）。',
    '- crossTopic 跨主題整合：把本主題「自己的不同子面向」連成整體，或連到真實相關的其他主題。只要有真實的子面向整合就 >0；不要因為「沒連到外部主題」而歸 0。連外部主題只能用上面清單或記寫內容中明確出現的名稱、嚴禁發明。',
    '- actionOrient 行動指向：從「這是什麼」走到「我接下來要怎麼做」的具體程度（含未來時態、計畫、可執行步驟；越具體可執行越高）。',
    '- metaReflection 後設反思：跳出當下任務、觀察自己學習狀態／姿態的程度（對事物的評價≠後設；對自己學習的觀察才算）。',
    '',
    '另外給佐證與對照（只根據內容、不腦補）：',
    'missing／thoughtNotThrough＝本主題內距一條有意義歷程還缺的具體東西（哪個子面向沒想透／沒連成整體／沒反思到上層），從內容抽、要具體；不要用「未連結其他學術主題」這種外部框。',
    '對四軸各寫「現況 now」與「理想版 ideal」(byDim)，各 ≤28 字、具體到本主題、繁中。',
    '三句一句話總結：haveSummary＝現況已做到的；gapSummary＝還缺/可加強的；meaningfulSummary＝在這主題下更有意義的歷程會長怎樣。各 ≤30 字（meaningfulSummary ≤40）。',
    '',
    '輸出 JSON：',
    '{',
    '  "conceptDepth": 0~1, "crossTopic": 0~1, "actionOrient": 0~1, "metaReflection": 0~1,',
    '  "has": ["現況已經有的、像樣的地方"],            // 1-3 條',
    '  "missing": ["本主題內距有意義歷程還缺的具體東西"], // 1-3 條',
    '  "thoughtNotThrough": ["提到了、卻沒往下想透的點"], // 0-3 條',
    '  "from": "看得出的起點理解（從哪來）",   // 看不出就空字串',
    '  "to": "看得出的終點理解（走到哪）",     // 還沒移動就空字串',
    '  "notReached": "本來可以再走到、但還沒到的地方",',
    '  "byDim": {',
    '    "conceptDepth":   {"now": "", "ideal": ""},',
    '    "crossTopic":     {"now": "", "ideal": ""},',
    '    "actionOrient":   {"now": "", "ideal": ""},',
    '    "metaReflection": {"now": "", "ideal": ""}',
    '  },',
    '  "haveSummary": "現況已做到的一句",   // ≤30 字',
    '  "gapSummary": "還可以再加強/補上的一句",  // ≤30 字',
    '  "meaningfulSummary": "在這主題下、更有意義的學習歷程會長怎樣，一句",  // ≤40 字',
    '  "linkedTopics": ["這條已實際連到的既有其他主題名稱"]  // 0-3，從上面清單或內容明確出現者取；無則空陣列',
    '}'
  ].join('\n');

  let out;
  try {
    out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0, maxOutputTokens: 1400 });
  } catch (e) { return null; }
  const j = extractJson_(out || '');
  if (!j) return null;

  // 連續四軸（0~1）→ 加權公式（gapScoreFromLevels_，與校準集共用、不漂移）。
  const c01 = x => Math.max(0, Math.min(1, Number(x) || 0));
  const lv = {
    conceptDepth:   c01(j.conceptDepth),
    crossTopic:     c01(j.crossTopic),
    actionOrient:   c01(j.actionOrient),
    metaReflection: c01(j.metaReflection)
  };
  const score = gapScoreFromLevels_(lv);

  const arr = x => Array.isArray(x) ? x.filter(s => s && String(s).trim()).map(s => String(s).trim()).slice(0, 3) : [];
  const dim = o => ({ now: String((o && o.now) || '').trim().slice(0, 60), ideal: String((o && o.ideal) || '').trim().slice(0, 60) });
  const bd = j.byDim || {};
  // linkedTopics 只當「已連到的外部主題」顯示用，仍綁真實清單避免發明；其有無已不影響 crossTopic 分數（治 L4）。
  const otherSet = {}; (otherTopics || []).forEach(t => { if (t) otherSet[String(t).trim()] = 1; });
  return {
    score: score, levels: lv,
    has: arr(j.has), missing: arr(j.missing), thoughtNotThrough: arr(j.thoughtNotThrough),
    from: String(j.from || '').trim(), to: String(j.to || '').trim(), notReached: String(j.notReached || '').trim(),
    haveSummary: String(j.haveSummary || '').trim().slice(0, 80),
    gapSummary: String(j.gapSummary || '').trim().slice(0, 80),
    meaningfulSummary: String(j.meaningfulSummary || '').trim().slice(0, 100),
    linkedTopics: arr(j.linkedTopics).filter(t => otherSet[t]),
    byDim: {
      conceptDepth: dim(bd.conceptDepth), crossTopic: dim(bd.crossTopic),
      actionOrient: dim(bd.actionOrient), metaReflection: dim(bd.metaReflection)
    },
    computedAt: new Date().toISOString()
  };
}

/** 落差分析區塊（頭條鏡子）。gap 為 null（太薄／LLM 不可用）時整段省略。 */
function reportGapHtml_(gap) {
  if (!gap) return '';
  const pct = gap.score;
  const lv = gap.levels || {};
  const bd = gap.byDim || {};
  const dots = f => { const n = Math.round(Math.max(0, Math.min(1, f || 0)) * 4); let s = ''; for (let i = 0; i < 4; i++) s += (i < n ? '●' : '○'); return s; };

  // 四軸＝四種學習轉折；段寬＝權重占比、彩色填滿＝該軸發展程度(連續)。
  const W = (typeof GAP_DIM_WEIGHTS !== 'undefined') ? GAP_DIM_WEIGHTS : { conceptDepth: 30, crossTopic: 25, actionOrient: 20, metaReflection: 25 };
  const DIMS = [
    { key: 'conceptDepth',   name: '概念深化',   color: '#2ea043' },
    { key: 'crossTopic',     name: '跨主題整合', color: '#e0a83e' },
    { key: 'actionOrient',   name: '行動指向',   color: '#1a4480' },
    { key: 'metaReflection', name: '後設反思',   color: '#7a5cc0' }
  ];
  const devPct = d => Math.round((lv[d.key] || 0) * 100);   // 該軸發展到幾成
  // byDim 缺（舊快取）時，從既有欄位拼現況/理想，向後相容。
  const fb = {
    conceptDepth:   { now: (gap.has && gap.has[0]) || '概念還停在點名', ideal: '用自己的話把核心概念想透' },
    crossTopic:     { now: (lv.crossTopic || 0) >= 0.3 ? '已把一些子面向連起來' : '各子面向還各自獨立', ideal: (gap.missing && gap.missing[0]) ? `連成整體：${gap.missing[0]}` : '把本主題的子面向連成整體' },
    actionOrient:   { now: (lv.actionOrient || 0) >= 0.3 ? '已開始指向行動' : '還停在理解、沒指向行動', ideal: '走到「我接下來要怎麼做」的具體一步' },
    metaReflection: { now: (lv.metaReflection || 0) >= 0.3 ? '有後設觀察' : '還停在記錄、沒回看', ideal: '跳出來看自己學到什麼' }
  };

  // (a) 四軸發展度：四種學習轉折各一段；段寬＝權重（越寬越關鍵）、彩色填滿＝該軸發展到幾成。
  // 段的「未填」底色也染上該軸色的淡版（~15%）→ 每軸佔哪一段一眼可見（色變＋細白分界＝隱喻分界），
  // 整體仍是一條連續 bar。
  const compSegs = DIMS.map(d =>
    `<div class="cseg" style="flex:${W[d.key]};background:${d.color}26" title="${d.name} ${devPct(d)}%"><div class="cfill" style="width:${devPct(d)}%;background:${d.color}"></div></div>`
  ).join('');
  const compLabs = DIMS.map(d =>
    `<div class="clab" style="flex:${W[d.key]}"><span class="cl-n" style="color:${d.color}">${d.name}</span><span class="cl-s">${devPct(d)}%</span></div>`
  ).join('');
  const compbar = `<div class="comp"><div class="comp-t">四軸發展度（你的強項在哪）</div><div class="compbar">${compSegs}</div><div class="complabs">${compLabs}</div><div class="comp-cap">這條色帶把「一條有意義的學習歷程」拆成四種學習轉折。每一段的<b>寬度</b>，代表這種轉折有多關鍵（越寬越重要）；段內<b>填色的多寡</b>，代表你目前在這種轉折上發展到幾成。總分採「獎勵深度」計算——只要把其中一兩種做得夠深，分數就會明顯往上、接近滿分，不必四種都做滿；因此總分不是把四段直接相加，而是讓你的強項發揮更大的作用。</div></div>`;
  const numColor = pct < 40 ? '#e0a83e' : (pct < 70 ? 'var(--cta)' : 'var(--ok)');
  const haveSum = gap.haveSummary || ((gap.has && gap.has.length) ? gap.has.join('、') : '');
  const gapSum = gap.gapSummary || [].concat(gap.missing || [], gap.notReached ? [gap.notReached] : []).join('、');
  const meaningSum = gap.meaningfulSummary || (gap.notReached ? `走到「${gap.notReached}」` : '把概念想透、連到別的主題、再回看自己學到什麼');
  const cir = (cls, k, num, v) => `<div class="gcircle ${cls}"><div class="gc-k">${k}<span class="gc-n">${num}</span></div><div class="gc-v">${v ? escapeHtml_(v) : '—'}</div></div>`;
  const growth = `<div class="growth">
      ${cir('done', '① 現況已做到', `現況 ${pct}`, haveSum)}
      <div class="gc-arrow">↓</div>
      ${cir('add', '② 再加強', `還可 +${100 - pct}`, gapSum)}
      <div class="gc-arrow">↓</div>
      ${cir('goal', '③ 在這主題下，更有意義的學習歷程', '滿 100', meaningSum)}
    </div>`;
  const gauge = `<div class="numden"><span class="nd-now" style="color:${numColor}">現況 ${pct}</span><span class="nd-sep">／</span><span class="nd-den">有意義 100</span></div>
    ${growth}
    ${compbar}`;

  // (b) 四軸對照列：左現況 ↔ 右有意義
  const mrows = DIMS.map(d => {
    const cell = (bd[d.key] && bd[d.key].now) ? bd[d.key] : fb[d.key];
    return `<div class="mrow">
      <div class="mdim">${d.name}<span class="mpts">${devPct(d)}%</span><b>${dots(lv[d.key] || 0)}</b></div>
      <div class="cells">
        <div class="mnow"><span class="ml">現況</span>${escapeHtml_(cell.now || '—')}</div>
        <div class="mideal"><span class="ml">有意義</span>${escapeHtml_(cell.ideal || '—')}</div>
      </div>
    </div>`;
  }).join('');

  // (c) 細項佐證（沿用既有）
  const block = (icon, title, items) => (items && items.length)
    ? `<div class="gapblk"><div class="gbh">${icon} ${title}</div><ul>${items.map(s => `<li>${escapeHtml_(s)}</li>`).join('')}</ul></div>` : '';
  const ft = (gap.from || gap.to || gap.notReached)
    ? `<div class="gapblk"><div class="gbh">↔ 從哪來、還沒到哪</div>
        <div class="ft">
          <span class="ftx">從這裡來：${gap.from ? escapeHtml_(gap.from) : '（還看不出明確起點）'}</span>
          <span class="fta">→ ${gap.to ? escapeHtml_(gap.to) : '（還沒移動到新的理解）'}</span>
        </div>
        ${gap.notReached ? `<div class="nr">可以再走到：${escapeHtml_(gap.notReached)}</div>` : ''}
      </div>`
    : '';

  return `<section class="gap-an">
    <h2>你的現況 → 更有意義的學習歷程</h2>
    ${gauge}
    <div class="mirror">${mrows}</div>
    ${block('✅', '有了什麼', gap.has)}
    ${block('⬜', '缺了什麼', gap.missing)}
    ${block('💭', '想到了、卻沒想透', gap.thoughtNotThrough)}
    ${ft}
    <div class="gnote">分數＝四軸發展度×權重，再過一條「獎勵深度」曲線換算（把強項做深就拉得上來、不必四軸都滿才高分）；與上方偵測到的轉折一致，同內容必同分。</div>
  </section>`;
}

/** 四種轉折標記區塊。 */
function reportMarkersHtml_(journey, records) {
  const markers = (journey && journey.markers) || [];
  if (!markers.length) return '';
  const style = {
    '概念重述':   '🔁', '跨主題整合': '🧩', '行動指向': '🎯', '後設反思': '🔭'
  };
  // 孤兒轉折（引用的記錄已不在本脈絡）不再當成已成立的轉折，改標 ⚠ 並講明原因——不是 AI 誤判。
  const groundedTypes = groundedMarkerTypes_(journey, records);
  const items = markers.map(m => {
    const conf = (m.confidence != null) ? ` <span class="conf">${Math.round(m.confidence * 100)}%</span>` : '';
    const ev = m.evidence ? `<div class="ev">「${escapeHtml_(m.evidence)}」</div>` : '';
    if (groundedTypes[m.type]) {
      const icon = style[m.type] || '•';
      return `<div class="marker"><div class="mt">${icon} ${escapeHtml_(m.type)}${conf}</div>${ev}</div>`;
    }
    return `<div class="marker orphan"><div class="mt">⚠ ${escapeHtml_(m.type)}${conf}<span class="orphan-tag">對應記錄已不在本脈絡</span></div>${ev}`
      + `<div class="orphan-note">這個轉折偵測當下成立，但引用的記錄目前已不在這條脈絡裡（被移除、或背景重新分群歸去別條）。不再當成已成立的轉折。</div></div>`;
  }).join('');
  return `<div class="markers"><div class="sub">偵測到的學習轉折</div>${items}</div>`;
}

/** 片段在「點線面」裡的角色（純時間判定）：
 *  歷程起點＝第一段（線還沒成形、只是起點）；
 *  回返＝之後每段（隔了 gap 又回到同一條，線在此成形）；標上隔多久回來。
 *  橋接＝該片段時間範圍內偵測到轉折（回返又轉了彎）；標出是哪一種轉折——
 *    本報告只有一條線，沒有「兩線交錯」，所以不用交錯框，直接寫轉折種類。
 *  第一段即使含轉折仍記歷程起點（無前段可橋接）。 */
function episodeRole_(i, ep, markerHits, prevEnd) {
  if (i === 0) return { key: 'seed', icon: '●', label: '歷程起點' };
  const types = (markerHits || []).filter(h => h.ts >= ep.startTs && h.ts <= ep.endTs).map(h => h.type);
  if (types.length) {
    const uniq = types.filter((t, k) => types.indexOf(t) === k);
    return { key: 'bridge', icon: '★', label: uniq.join('＋') };
  }
  const gap = (prevEnd != null) ? reportGapCompact_(ep.startTs - prevEnd) : '';
  return { key: 'return', icon: '↩', label: gap ? '回返 · ' + gap : '回返' };
}

/** 片段內節奏＋聚焦趨勢小圖：底軸＝每一筆依實際時間的刻度（密＝連寫、疏＝停頓；媒介筆紫色高刻）；
 *  上方折線＝聚焦趨勢——每一筆對「本片段群心」的 cosine（越高＝越貼這段核心），看得出寫著寫著是
 *  越來越聚焦還是越岔開；caption 帶整段聚焦度。〔2026-06-07〕記寫時間分布「一律示意」（資料再少也畫），
 *  聚焦趨勢需筆數 ≥5、時間 ≥2 分、可分析文字 ≥3 才畫；不畫時明寫原因（免得有的片段有、有的沒有卻沒解釋）。 */
function episodeMicroRhythmHtml_(ep) {
  const recs = (ep.records || []).filter(r => r && r.ts).slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!recs.length) return '';
  const spanMs = Math.max(0, ep.endTs - ep.startTs);
  const W = 300, padX = 3, usableW = W - padX * 2;
  const xOf = ts => padX + (Date.parse(ts) - ep.startTs) / spanMs * usableW;
  const mins = Math.round(spanMs / 60000);

  // 〔聚焦趨勢〕需筆數夠（≥5）、時間夠（≥2 分）、且可分析文字夠（≥3 筆有 embedding）才畫；否則註明原因。
  const embs = recs.map(r => (r.embedding && r.embedding.length === EMBED_DIM) ? r.embedding : null);
  const have = embs.filter(Boolean);
  const enoughRecs = recs.length >= 5, enoughSpan = spanMs >= 120000, enoughEmb = have.length >= 3;
  let focusSvg = '', overall = null, turnsHtml = '', focusNote = '';
  if (enoughRecs && enoughSpan && enoughEmb) {
    const centroid = meanVector_(have);
    overall = avgPairwiseCosine_(have, 2000);
    const FLO = 0.40, FHI = 1.0, yOf = cos => 20 - Math.max(0, Math.min(1, (cos - FLO) / (FHI - FLO))) * 16;
    const seq = [];
    recs.forEach((r, i) => { if (embs[i]) seq.push({ x: xOf(r.ts), cos: cosineSim_(embs[i], centroid), ts: r.ts }); });
    if (seq.length >= 2) {
      const poly = seq.map(p => `${p.x.toFixed(1)},${yOf(p.cos).toFixed(1)}`).join(' ');
      let svg = `<polygon points="${seq[0].x.toFixed(1)},20 ${poly} ${seq[seq.length - 1].x.toFixed(1)},20" class="mr-focusarea"/><polyline points="${poly}" class="mr-focus"/>`;
      const DELTA = 0.06, turns = [];
      for (let i = 1; i < seq.length - 1; i++) {
        const a = seq[i - 1].cos, b = seq[i].cos, c = seq[i + 1].cos;
        const isMin = b <= a && b <= c, isMax = b >= a && b >= c;
        if (!isMin && !isMax) continue;
        const swing = Math.max(Math.abs(b - a), Math.abs(b - c));
        if (swing < DELTA) continue;
        turns.push({ x: seq[i].x, cos: b, ts: seq[i].ts, dir: isMin ? '↓' : '↑', swing: swing });
      }
      turns.sort((p, q) => q.swing - p.swing);
      const top = turns.slice(0, 2).sort((p, q) => p.x - q.x);
      top.forEach(t => { svg += `<line x1="${t.x.toFixed(1)}" y1="2" x2="${t.x.toFixed(1)}" y2="20" class="mr-turn"/>`; });
      focusSvg = `<svg viewBox="0 0 ${W} 22" preserveAspectRatio="none" class="mr-svg" role="img" aria-label="片段內聚焦趨勢">${svg}</svg>`;
      if (top.length) {
        turnsHtml = `<span class="mr-turns">★ 聚焦轉折：` + top.map(t =>
          `${Utilities.formatDate(new Date(t.ts), TIME_ZONE, 'HH:mm')} ${t.dir}${t.cos.toFixed(2)}（${t.dir === '↓' ? '岔開' : '回核'}）`
        ).join('、') + '</span>';
      }
    }
  } else {
    const why = [];
    if (!enoughRecs) why.push(`筆數太少（${recs.length}，需 ≥5）`);
    if (!enoughSpan) why.push(`時間太短（${mins} 分，需 ≥2 分）`);
    if (enoughRecs && enoughSpan && !enoughEmb) why.push(`可分析的文字太少（${have.length}，需 ≥3）`);
    focusNote = `<span class="mr-nofocus">ℹ️ 資料量不足、未顯示聚焦趨勢（${why.join('、')}）；下方僅示意記寫時間分布。</span>`;
  }

  // 〔記寫時間分布〕一律示意：分格 cell、每格一點，點大小／深淺＝該格筆數；含媒介的格用紫色。
  // span=0（全部同一刻）退化成一句說明。
  let cellsHtml;
  if (spanMs > 0) {
    const B = 12;
    const cnt = new Array(B).fill(0), med = new Array(B).fill(0);
    recs.forEach(r => {
      let b = Math.floor((Date.parse(r.ts) - ep.startTs) / spanMs * B);
      if (b < 0) b = 0; if (b >= B) b = B - 1;
      cnt[b]++; if (r.type && r.type !== 'text') med[b]++;
    });
    const cells = cnt.map((n, i) => {
      const cls = n === 0 ? 'd0' : (n === 1 ? 'd1' : 'd2');
      const m = (med[i] && n > 0) ? ' dm' : '';
      return `<span class="mr-cell"><i class="${cls}${m}"></i></span>`;
    }).join('');
    cellsHtml = `<div class="mr-cells">${cells}</div>`;
    // 〔心情軌跡同步〕節奏分格正下方、同 12 格對齊：貼圖落哪格 emoji 就在哪格（同格取最後一張）。
    const emo = new Array(B).fill('');
    let anyEmo = false;
    recs.forEach(r => {
      if (r.type !== 'sticker') return;
      let b = Math.floor((Date.parse(r.ts) - ep.startTs) / spanMs * B);
      if (b < 0) b = 0; if (b >= B) b = B - 1;
      emo[b] = recordEmoji_(r); anyEmo = true;
    });
    if (anyEmo) {
      cellsHtml += `<div class="mr-emo">` + emo.map(e => `<span class="mr-emocell">${e || ''}</span>`).join('') + `</div>`
        + `<span class="mr-emocap">↑ 心情軌跡（貼圖落點）</span>`;
    }
  } else {
    cellsHtml = `<span class="mr-nofocus">${recs.length === 1 ? '單筆記錄，無時間分布可示意。' : `${recs.length} 筆都在同一時刻，無時間分布可示意。`}</span>`;
  }

  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ' ' + (mins % 60) + ' 分' : ''}` : `${mins} 分鐘`;
  const cap = `片段內節奏${overall != null ? '＋聚焦' : ''} · ${dur}` + (overall != null ? ` · 聚焦 ${overall.toFixed(2)}` : '');
  return `<div class="ep-rhythm"><span class="mr-cap">${cap}</span>${focusSvg}${cellsHtml}${turnsHtml}${focusNote}</div>`;
}

/** 一個敘事片段：時間、片段內每則訊息（含內嵌媒體）。 */
function reportEpisodeHtml_(ep, idx, narr, role) {
  const range = reportEpRange_(ep.startTs, ep.endTs);
  const rows = ep.records.map(r => reportRecordHtml_(r)).join('');
  const roleBadge = role ? `<span class="ep-role ${role.key}">${role.icon} ${escapeHtml_(role.label)}</span>` : '';
  const rhythm = episodeMicroRhythmHtml_(ep);
  const topic = (narr && (narr.title || narr.category))
    ? `${narr.category ? escapeHtml_(narr.category) + '｜' : ''}${escapeHtml_(narr.title || '')}`
    : '';
  const summaryLine = (narr && narr.summary)
    ? `<div class="ep-summary">${escapeHtml_(narr.summary)}</div>` : '';
  return `<div class="episode">
    <div class="ep-head"><span class="ep-no">片段 ${idx}</span>${roleBadge}${topic ? `<span class="ep-topic">${topic}</span>` : ''}<span class="ep-time">${escapeHtml_(range)}</span><span class="ep-n">${ep.records.length} 則</span></div>
    ${summaryLine}
    ${rhythm}
    <div class="ep-body">${rows}</div>
  </div>`;
}

/** 單則訊息：時間戳 + 型別徽章 + 內容（探問特別標示／貼圖出原圖）+ 媒體（可點選互動播放）。 */
function reportRecordHtml_(r) {
  const time = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'HH:mm');
  const isAsk = /^🔍\s*探問/.test((r.text || ''));
  const isSticker = r.type === 'sticker';
  // 型別徽章：讓「這則是哪種形式」一眼可見（文字不標、其餘標）。
  const TYPE_BADGE = { image: '🖼️ 圖片', video: '🎬 影片', audio: '🎤 語音', file: '📄 檔案', sticker: '😀 貼圖', location: '📍 地點', link: '🔗 連結' };
  const badge = (!isAsk && TYPE_BADGE[r.type]) ? `<span class="rtype">${TYPE_BADGE[r.type]}</span>` : '';
  // 貼圖：呈現 emoji＋情緒詞（去掉「[貼圖] 」），原貼圖由 reportMediaHtml_ 出圖。
  let txt = (r.text || '').trim();
  if (isSticker) txt = `${recordEmoji_(r)} ${txt.replace(/^\[貼圖\]\s*/, '')}`.trim();
  const media = reportMediaHtml_(r);
  return `<div class="rec ${isAsk ? 'ask' : ''}${isSticker ? ' sticker' : ''}">
    <span class="rt">${time}</span>
    <div class="rc">
      ${badge}${txt ? `<div class="rtext">${escapeHtml_(txt).replace(/\n/g, '<br>')}</div>` : ''}
      ${media}
    </div>
  </div>`;
}

/** 內嵌媒體：圖（可放大）／音／影片／檔案／貼圖（出原圖）／地圖／連結。媒體一律可點選互動。 */
function reportMediaHtml_(r) {
  const fid = r.fileId;
  if (r.type === 'image' && fid) {
    return `<img class="media img" loading="lazy" src="https://drive.google.com/thumbnail?id=${fid}&sz=w1000" onclick="zoom(this.src)">`;
  }
  if (r.type === 'video' && fid) {
    return `<video class="media" controls preload="none" poster="https://drive.google.com/thumbnail?id=${fid}&sz=w1000"><source src="https://drive.google.com/uc?export=download&id=${fid}"></video>`;
  }
  if (r.type === 'audio' && fid) {
    return `<audio class="media" controls preload="none" src="https://drive.google.com/uc?export=download&id=${fid}"></audio>`;
  }
  if (r.type === 'file' && fid) {
    return `<a class="media link" target="_blank" href="https://drive.google.com/file/d/${fid}/view">📄 開啟檔案</a>`;
  }
  if (r.type === 'sticker' && r.stickerUrl) {
    return `<img class="media sticker-img" loading="lazy" src="${escapeAttr_(r.stickerUrl)}" alt="貼圖">`;
  }
  if (r.mapsUrl) {
    return `<a class="media link" target="_blank" href="${escapeAttr_(r.mapsUrl)}">🗺 開啟地圖</a>`;
  }
  return '';
}

/** 語意地圖（純 HTML/CSS、無 JS、無 LLM）：不畫向量相似度團（看字面、會誤導），而是
 *  ① 概念軌跡 spine：from→to→(虛線)notReached；② 跨主題：中心＝這條歷程，支線＝已連
 *  (linkedTopics 實線)/可連(missing 虛線)的既有主題。資料全來自已快取的 gap，不打 LLM。 */
function reportSemanticMapHtml_(gap, journey) {
  if (!gap) return '';
  const from = gap.from, to = gap.to, nr = gap.notReached;
  const linked = gap.linkedTopics || [];
  const missing = gap.missing || [];
  if (!from && !to && !nr && !linked.length && !missing.length) return '';
  // 網頁版＝想清楚的完整現況：描述內容不截斷（gap 各欄 LLM 已限 ≤28–40 字，網頁會自動換行）。
  const center = escapeHtml_(journey.title || journey.label || '這條歷程');

  const spineNodes = [];
  if (from) spineNodes.push(`<div class="sp-node start"><span class="sp-k">起點</span>${escapeHtml_(from)}</div>`);
  spineNodes.push(`<div class="sp-node now"><span class="sp-k">走到</span>${to ? escapeHtml_(to) : '（還沒移動到新的理解）'}</div>`);
  if (nr) spineNodes.push(`<div class="sp-node not"><span class="sp-k">還沒到</span>${escapeHtml_(nr)}</div>`);
  const spine = `<div class="smap-blk"><div class="smap-t">概念軌跡（這條怎麼走）</div><div class="spine">${spineNodes.join('<div class="sp-arrow">↓</div>')}</div></div>`;

  let hub = '';
  if (linked.length || missing.length) {
    const chips = []
      .concat(linked.map(t => `<div class="hub-chip linked">${escapeHtml_(t)}</div>`))
      .concat(missing.map(t => `<div class="hub-chip oppo">${escapeHtml_(t)}</div>`))
      .join('');
    hub = `<div class="smap-blk"><div class="smap-t">跨主題連結（接到你別的主題）</div>
      <div class="hub"><div class="hub-center">${center}</div><div class="hub-branches">${chips}</div>
      <div class="hub-legend">實線＝已連到的主題　·　虛線＝可以連、還沒連（機會）</div></div></div>`;
  }

  return `<section class="smap">
    <h2>這條歷程的語意地圖</h2>
    <p class="hint">以記寫脈絡的語意軌跡來描繪你的現況歷程。</p>
    ${spine}
    ${hub}
  </section>`;
}

/** 記寫節奏時間軸（純 SVG/HTML、無 JS、無 LLM、不用 cosine）：
 *  X＝時間(左→右,最右＝現況);線上圓點＝敘事片段(大小＝記寫筆數、編號對應段);
 *  線上方冒出＝偵測到的轉折(四型各色+圖示,連接線回到時間點)。
 *  一眼看「何時爆發、何時發生哪種轉折」＝這條歷程的演進與現況。 */
function reportRhythmTimelineHtml_(records, journey, context) {
  records = (records || []).filter(r => r && r.ts).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (records.length < 2) return '';
  const firstTs = Date.parse(records[0].ts);                      // 以實際成員為準（records 已排序）
  const lastTs = Date.parse(records[records.length - 1].ts);
  const span = Math.max(1, lastTs - firstTs);
  const W = 700, H = 125, AX = 84, padL = 28, padR = 38;
  const usableW = W - padL - padR;
  const xOf = ts => padL + (Math.max(firstTs, Math.min(lastTs, ts)) - firstTs) / span * usableW;

  // 敘事片段：線上圓點，大小＝筆數、編號對應段。
  const eps = groupByEpisode_(records, SESSION_GAP_MINUTES * 60 * 1000);
  let maxCount = 1; eps.forEach(e => { if (e.records.length > maxCount) maxCount = e.records.length; });
  const epDots = eps.map((e, i) => {
    const cx = xOf((e.startTs + e.endTs) / 2);
    const r = 4 + Math.round(Math.sqrt(e.records.length / maxCount) * 11);
    return `<circle cx="${cx.toFixed(1)}" cy="${AX}" r="${r}" fill="#1a4480" fill-opacity="0.85"/>`
         + `<text x="${cx.toFixed(1)}" y="${(AX + r + 13).toFixed(1)}" class="tl-num">${i + 1}</text>`;
  }).join('');

  // 轉折：線上方冒出（四型各色+圖示；用 evidence 比對找到對應記錄的時間點）。
  const MK = { '概念重述': { c: '#2ea043', i: '🔁' }, '跨主題整合': { c: '#7a5cc0', i: '🧩' }, '行動指向': { c: '#e0a83e', i: '🎯' }, '後設反思': { c: '#c0508a', i: '🔭' } };
  const markTs = m => {
    const ev = (m.evidence || '').replace(/\s+/g, '').slice(0, 12);
    if (ev) { const hit = records.find(r => (r.text || '').replace(/\s+/g, '').indexOf(ev) >= 0); if (hit) return Date.parse(hit.ts); }
    return Date.parse(m.detectedAt) || lastTs;
  };
  const markers = (journey.markers || []).map(m => ({ m: m, ts: markTs(m) })).sort((a, b) => a.ts - b.ts);
  const mkDots = markers.map((o, k) => {
    const cx = xOf(o.ts);
    const st = MK[o.m.type] || { c: '#888', i: '•' };
    const my = AX - 28 - (k % 2) * 24;   // 兩段高度交錯，降低重疊
    return `<line x1="${cx.toFixed(1)}" y1="${AX}" x2="${cx.toFixed(1)}" y2="${(my + 7).toFixed(1)}" stroke="${st.c}" stroke-width="1.5" stroke-opacity="0.55"/>`
         + `<text x="${cx.toFixed(1)}" y="${my.toFixed(1)}" class="tl-mk">${st.i}</text>`;
  }).join('');

  const axis = `<line x1="${padL}" y1="${AX}" x2="${W - padR + 6}" y2="${AX}" stroke="#9aa7b4" stroke-width="2"/>`
    + `<polygon points="${W - padR + 7},${AX} ${W - padR - 1},${AX - 5} ${W - padR - 1},${AX + 5}" fill="#9aa7b4"/>`;

  const fmt = ts => Utilities.formatDate(new Date(ts), TIME_ZONE, 'MM/dd');
  const usedTypes = Object.keys(MK).filter(t => (journey.markers || []).some(m => m.type === t));
  const legend = usedTypes.length
    ? usedTypes.map(t => `<span class="tl-lgi"><i style="background:${MK[t].c}"></i>${MK[t].i}${t}</span>`).join('')
    : '（這條暫無偵測到的轉折）';

  return `<div class="tl-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="tl-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="記寫節奏與轉折時間軸">
      ${axis}${mkDots}${epDots}
    </svg>
    <div class="tl-dates"><span>${fmt(firstTs)}</span><span>${fmt(lastTs)}（現況）</span></div>
    <div class="tl-legend">● 點＝敘事片段（大小＝記寫筆數、編號對應段）；上方冒出＝偵測到的轉折：${legend}</div>
  </div>`;
}

/* ---- 時間格式 ---- */
function reportSpanLabel_(firstTs, lastTs) {
  if (!firstTs || !lastTs) return '';
  const f = new Date(firstTs), l = new Date(lastTs);
  const fs = Utilities.formatDate(f, TIME_ZONE, 'yyyy/MM/dd');
  const ls = Utilities.formatDate(l, TIME_ZONE, 'yyyy/MM/dd');
  const days = Math.max(1, Math.round((l.getTime() - f.getTime()) / 86400000));
  return fs === ls ? `${fs}（當日）` : `${fs}–${ls}（${days} 天）`;
}
function reportEpRange_(startMs, endMs) {
  const s = new Date(startMs), e = new Date(endMs);
  const sd = Utilities.formatDate(s, TIME_ZONE, 'MM/dd HH:mm');
  if (startMs === endMs) return sd;
  const sameDay = Utilities.formatDate(s, TIME_ZONE, 'yyyyMMdd') === Utilities.formatDate(e, TIME_ZONE, 'yyyyMMdd');
  const ee = Utilities.formatDate(e, TIME_ZONE, sameDay ? 'HH:mm' : 'MM/dd HH:mm');
  return `${sd}–${ee}`;
}
function reportGapLabel_(prevEndMs, nextStartMs) {
  const ms = nextStartMs - prevEndMs;
  if (ms <= 0) return '';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days >= 1) return `隔 ${days} 天${hours ? ` ${hours} 小時` : ''}後回返`;
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `隔 ${hours} 小時${mins ? ` ${mins} 分` : ''}後回返`;
  return `隔 ${mins} 分後`;
}
/** 緊湊版 gap（給回返角色標用）：隔1天5h／隔11h30m／隔30m。 */
function reportGapCompact_(ms) {
  if (ms <= 0) return '';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d >= 1) return `隔${d}天${h ? h + 'h' : ''}`;
  if (h >= 1) return `隔${h}h${m ? m + 'm' : ''}`;
  return `隔${m}m`;
}

/* ---- HTML/CSS shell + JS ---- */
function reportPageShell_(title, body) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml_(title)}</title>
<style>
:root{--ink:#1a2733;--muted:#7a8794;--cta:#1a4480;--soft:#eef2f7;--ok:#2ea043;--line:#e3e8ee}
*{box-sizing:border-box}
body{font-family:'Noto Sans CJK TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;color:var(--ink);margin:0;background:#f7f9fb;line-height:1.7}
.wrap{max-width:720px;margin:0 auto;padding:20px 18px 80px}
.cover{background:linear-gradient(135deg,#1a4480,#2a5a9e);color:#fff;border-radius:16px;padding:26px 24px;margin-bottom:20px}
.cover .eyebrow{font-size:12px;opacity:.8;letter-spacing:1px}
.cover h1{font-size:24px;margin:.3em 0 .2em;line-height:1.3}
.cover .byline{display:inline-block;font-size:12.5px;background:rgba(255,255,255,.18);padding:3px 10px;border-radius:20px;margin:.1em 0 .4em}
.cover .subt{font-size:13px;opacity:.85;margin:0 0 .3em}
.cover .kw{font-size:13px;opacity:.92;font-weight:bold}
.cover .lead{font-size:15px;opacity:.95;margin:.8em 0 1em}
.scale{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:13px;opacity:.95;border-top:1px solid rgba(255,255,255,.25);padding-top:12px}
section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
h2{font-size:17px;color:var(--cta);margin:0 0 .6em;border-bottom:2px solid var(--soft);padding-bottom:.4em}
.hint{font-size:12px;color:var(--muted);margin:-.2em 0 1.2em}
.crits{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.crit{display:flex;align-items:baseline;gap:8px;font-size:14px}
.crit .mk{font-weight:bold;width:1.2em}.crit.ok .mk{color:var(--ok)}.crit.no .mk{color:var(--muted)}
.crit .cl{font-weight:bold;min-width:5em}.crit .cd{color:var(--muted);font-size:13px}
.markers{margin-top:12px;border-top:1px dashed var(--line);padding-top:12px}
.markers .sub,.ep-body .sub{font-size:12px;color:var(--muted);margin-bottom:8px}
.marker{margin:10px 0}.marker .mt{font-weight:bold;font-size:14px}
.marker .conf{font-size:11px;color:var(--muted);font-weight:normal}
.marker .ev{font-size:13px;color:#444;background:var(--soft);border-radius:8px;padding:7px 10px;margin-top:4px}
.marker.orphan .mt{color:#9a6a00}
.marker.orphan .ev{opacity:.7}
.orphan-tag{margin-left:8px;font-size:11px;font-weight:bold;color:#b06a00;background:#fff4e0;padding:1px 7px;border-radius:999px}
.orphan-note{font-size:12px;color:var(--muted);margin-top:4px;border-left:3px solid #f0c674;padding-left:8px}
.gap-an{border:2px solid #1a4480}
.gauge{display:flex;align-items:center;gap:12px;margin:4px 0 14px}
.gauge .bar{flex:1;height:12px;background:var(--soft);border-radius:99px;overflow:hidden}
.gauge .fill{height:100%;border-radius:99px;transition:none}
.gauge .pct{font-size:18px;font-weight:bold;white-space:nowrap}
.basis{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);background:var(--soft);border-radius:10px;padding:10px 12px;margin-bottom:14px}
.basis div{display:flex;align-items:center;gap:6px}
.basis b{color:var(--cta);letter-spacing:1px}
.gapblk{margin:12px 0}
.gapblk .gbh{font-weight:bold;font-size:14px;color:var(--ink);margin-bottom:4px}
.gapblk ul{margin:.2em 0;padding-left:1.2em}
.gapblk li{font-size:13.5px;color:#444;margin:3px 0}
.ft{display:flex;flex-wrap:wrap;gap:6px 10px;font-size:14px;background:var(--soft);border-radius:8px;padding:10px 12px}
.ft .ftx{color:#444}.ft .fta{color:var(--cta);font-weight:bold}
.nr{font-size:13px;color:var(--muted);margin-top:6px}
.numden{display:flex;align-items:baseline;gap:8px;font-weight:bold;margin:2px 0 8px}
.numden .nd-now{font-size:26px}.numden .nd-sep{font-size:20px;color:var(--muted)}.numden .nd-den{font-size:15px;color:var(--muted)}
.comp{margin:8px 0 14px}
.comp-t{font-size:13px;font-weight:bold;color:var(--ink);margin-bottom:6px}
.compbar{display:flex;height:26px;border-radius:8px;overflow:hidden;background:#e9edf2}
.cseg{position:relative;border-right:2px solid #fff}.cseg:last-child{border-right:0}
.cseg .cfill{position:absolute;left:0;top:0;bottom:0}
.complabs{display:flex;margin-top:6px}
.clab{padding:0 3px;text-align:center;min-width:0}
.clab .cl-n{display:block;font-size:11px;font-weight:bold;line-height:1.25;word-break:break-word}
.clab .cl-s{display:block;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.comp-cap{font-size:11px;color:var(--muted);margin:8px 0 2px}
.gnote{font-size:11px;color:var(--muted);margin-top:14px;padding-top:10px;border-top:1px solid var(--line)}
.realign{font-size:12px;color:#8a6d1a;background:#fdf6e9;border:1px solid #ecd9a8;border-radius:8px;padding:8px 10px;margin:8px 0}
.finalwait{display:inline-block;background:#fdf6e9;color:#8a6d1a;border:1px solid #ecd9a8;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:10px;margin-top:6px}
.growth{margin:10px 0 14px;display:flex;flex-direction:column;align-items:stretch;gap:0}
.gcircle{border-radius:20px;padding:14px 16px;border:2px solid var(--line);text-align:center}
.gcircle .gc-k{font-size:12px;font-weight:bold;margin-bottom:5px}
.gcircle .gc-n{display:inline-block;margin-left:8px;font-size:13px;font-weight:bold;padding:1px 9px;border-radius:99px;background:#fff;border:1.5px solid currentColor;vertical-align:middle}
.gcircle .gc-v{font-size:14px;line-height:1.55}
.gcircle.done{background:#f1faf3;border-color:#bfe3c8}.gcircle.done .gc-k{color:var(--ok)}
.gcircle.add{background:#fdf6e9;border-color:#ecd9a8}.gcircle.add .gc-k{color:#b8860b}
.gcircle.goal{background:#eef4fb;border-color:#cfe0f3}.gcircle.goal .gc-k{color:var(--cta)}.gcircle.goal .gc-v{font-weight:bold;color:var(--cta)}
.gc-arrow{text-align:center;color:var(--muted);font-size:18px;line-height:1.7}
.mirror{margin:10px 0}
.mrow{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}
.mdim{display:flex;align-items:center;gap:8px;font-weight:bold;font-size:14px;color:var(--ink)}
.mdim .mpts{font-size:12px;color:var(--muted);font-weight:normal}.mdim b{margin-left:auto;color:var(--cta);letter-spacing:1px}
.mrow .cells{margin-top:8px;display:flex;flex-direction:column;gap:8px}
.mnow,.mideal{font-size:13.5px;border-radius:8px;padding:8px 10px;line-height:1.5}
.mnow{background:var(--soft);color:#444}.mideal{background:#eef4fb;color:var(--cta);border:1px solid #d6e2f2}
.mnow .ml,.mideal .ml{display:inline-block;font-size:11px;font-weight:bold;opacity:.7;margin-right:6px}
@media(min-width:560px){.mrow .cells{display:grid;grid-template-columns:1fr 1fr;gap:10px}}
.tl-wrap{margin:10px 0 14px}
.tl-svg{width:100%;height:auto;display:block;overflow:visible}
.tl-svg .tl-num{font-size:12px;fill:#7a8794;text-anchor:middle}
.tl-svg .tl-mk{font-size:17px;text-anchor:middle}
.tl-dates{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:2px}
.tl-legend{font-size:11px;color:var(--muted);margin-top:8px}
.tl-legend .tl-lgi{margin-right:6px;white-space:nowrap}
.tl-legend .tl-lgi i{display:inline-block;width:9px;height:9px;border-radius:99px;margin:0 3px 0 8px;vertical-align:middle}
.smap-blk{margin:12px 0}
.smap-t{font-size:13px;font-weight:bold;color:var(--ink);margin-bottom:6px}
.spine{display:flex;flex-direction:column;gap:0}
.sp-node{border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.5;border:1px solid var(--line)}
.sp-node .sp-k{display:inline-block;font-size:11px;font-weight:bold;color:var(--muted);margin-right:8px}
.sp-node.start{background:var(--soft)}
.sp-node.now{background:#eef4fb;border-color:#d6e2f2;color:var(--cta);font-weight:bold}
.sp-node.not{background:#fff;border-style:dashed;color:var(--muted)}
.sp-arrow{text-align:center;color:var(--muted);font-size:14px;line-height:1.9}
.hub{text-align:center}
.hub-center{display:inline-block;background:var(--cta);color:#fff;font-weight:bold;font-size:14px;padding:8px 16px;border-radius:16px;margin-bottom:10px;max-width:100%;line-height:1.4;word-break:break-word;text-align:center}
.hub-branches{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.hub-chip{font-size:12.5px;padding:6px 12px;border-radius:14px;max-width:100%;line-height:1.4;word-break:break-word;text-align:center}
.hub-chip.linked{background:#eef4fb;color:var(--cta);border:1.5px solid var(--cta)}
.hub-chip.oppo{background:#fff;color:var(--muted);border:1.5px dashed var(--muted)}
.hub-legend{font-size:11px;color:var(--muted);margin-top:8px}
.finalize{border:2px solid var(--ok)}
.finalbtn{display:inline-block;background:var(--ok);color:#fff;text-decoration:none;font-size:15px;font-weight:bold;padding:11px 22px;border-radius:10px;margin-top:6px;border:none;cursor:pointer}
.finalask{margin-top:10px;text-align:left;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.finalask>p{margin:0 0 10px;font-size:13.5px;color:var(--ink)}
.finalask-btns{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.finalask-btns .finalbtn{margin-top:0}
.finalcancel{background:#fff;color:var(--muted);border:1.5px solid var(--line);font-size:14px;padding:10px 18px;border-radius:10px;cursor:pointer}
.finalized{border-color:var(--ok);background:#f1faf3}
.finalized .fz{font-size:16px;font-weight:bold;color:var(--ok)}
.unfinal{color:var(--muted);font-size:12px;text-decoration:underline}
.gap{text-align:center;color:var(--muted);font-size:12px;margin:14px 0}
.episode{border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}
.ep-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;background:var(--soft);padding:9px 14px;font-size:13px}
.ep-no{font-weight:bold;color:var(--cta)}.ep-time{color:#444}.ep-n{margin-left:auto;color:var(--muted);font-size:12px}
.ep-topic{font-weight:bold;color:var(--ink)}
.ep-role{font-size:11px;font-weight:bold;padding:1px 9px;border-radius:999px;white-space:nowrap}
.ep-role.seed{background:#e8edf5;color:#1a4480}
.ep-role.return{background:#e4f0e8;color:#2e7d46}
.ep-role.bridge{background:#efe7f7;color:#7a5cc0}
.ep-rhythm{padding:6px 14px 4px}
.mr-cap{display:block;font-size:10px;color:var(--muted);margin-bottom:3px}
.mr-svg{display:block;width:100%;height:22px;overflow:visible}
.mr-svg line,.mr-svg polyline{vector-effect:non-scaling-stroke}
.mr-focus{fill:none;stroke:#1a4480;stroke-width:1.6;stroke-opacity:.9;stroke-linejoin:round}
.mr-focusarea{fill:#1a4480;fill-opacity:.08;stroke:none}
.mr-turn{stroke:#e0a83e;stroke-width:1.6;stroke-opacity:.95}
.mr-turns{display:block;font-size:10px;color:#b06a00;margin-top:3px}
.mr-nofocus{display:block;font-size:10px;color:var(--muted);margin-top:3px;line-height:1.4}
.mr-cells{display:flex;gap:2px;margin-top:3px}
.mr-cell{flex:1;display:flex;justify-content:center;align-items:center;height:13px}
.mr-cell i{display:block;border-radius:50%;background:#1a4480}
.mr-cell i.d0{width:4px;height:4px;background:#d2d9e0}
.mr-cell i.d1{width:7px;height:7px;opacity:.55}
.mr-cell i.d2{width:11px;height:11px;opacity:.85}
.mr-cell i.dm{background:#7a5cc0}
.mr-emo{display:flex;gap:2px;margin-top:1px}
.mr-emocell{flex:1;text-align:center;font-size:13px;line-height:1.1;height:16px}
.mr-emocap{display:block;font-size:10px;color:var(--muted);margin-top:1px}
.rtype{display:inline-block;background:var(--soft);color:var(--cta);font-size:11px;font-weight:bold;padding:1px 7px;border-radius:6px;margin-bottom:4px}
.media.sticker-img{max-height:120px;width:auto;object-fit:contain}
.rec.sticker .rtext{color:#555}
.ep-summary{padding:6px 14px 0;font-size:12.5px;color:#555;line-height:1.5}
.ep-body{padding:6px 14px 12px}
.rec{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f0f3f7}
.rec:last-child{border-bottom:0}
.rec .rt{color:var(--muted);font-size:12px;flex:0 0 auto;padding-top:2px;font-variant-numeric:tabular-nums}
.rec .rc{flex:1;min-width:0}
.rec .rtext{font-size:14px;white-space:normal;word-break:break-word}
.rec .drop{flex:0 0 auto;align-self:flex-start;color:#b9404a;background:#fdeef0;text-decoration:none;font-size:11px;font-weight:bold;border-radius:6px;padding:3px 7px;white-space:nowrap}
.rec .drop:hover{background:#f7d7db}
.dropped{border-color:#e3c0c4;background:#fcf6f7}
.drow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f0e4e6;font-size:13px}
.drow:last-child{border-bottom:0}
.drow .dtx{flex:1;min-width:0;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drow .undrop{flex:0 0 auto;color:var(--cta);background:var(--soft);text-decoration:none;font-size:12px;font-weight:bold;border-radius:6px;padding:4px 9px}
.rec.ask .rc{background:#fff8e6;border-left:3px solid #e0a83e;border-radius:6px;padding:6px 10px}
.media{margin-top:8px;display:block;max-width:100%}
.media.img{border-radius:8px;cursor:zoom-in;max-height:340px;object-fit:cover}
.media.link{display:inline-block;background:var(--soft);color:var(--cta);text-decoration:none;font-size:13px;font-weight:bold;padding:7px 12px;border-radius:8px}
audio.media{width:100%}
video.media{border-radius:8px;max-height:360px}
.toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:flex-end;gap:8px;padding:10px 0}
.btn{background:var(--cta);color:#fff;border:0;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:bold;cursor:pointer}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out}
#lb img{max-width:96%;max-height:96%}
@media print{
  body{background:#fff}.wrap{max-width:none;padding:0}.toolbar{display:none}
  section,.episode{break-inside:avoid;border-color:#ccc}
  .cover{background:#1a4480 !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .media{max-height:none}
}
</style></head><body>
<div class="wrap">
  <div class="toolbar"><button class="btn" onclick="window.print()">🖨 列印 / 存成 PDF</button></div>
  ${body}
</div>
<div id="lb" onclick="this.style.display='none'"><img id="lbimg"></div>
<script>
function zoom(src){var lb=document.getElementById('lb');document.getElementById('lbimg').src=src;lb.style.display='flex';}
// 定案兩段式確認：展開/收合面板（取代原生 confirm 的長網址前綴），確定鈕按一次即鎖死防二次點選。
function askFinal(show){var s=document.getElementById('finalstart'),p=document.getElementById('finalask');if(p)p.style.display=show?'block':'none';if(s)s.style.display=show?'none':'inline-block';}
function goFinal(a){if(a.dataset.go)return false;a.dataset.go='1';a.textContent='封存中…';a.style.pointerEvents='none';a.style.opacity='.6';return true;}
</script>
</body></html>`;
}

/* ---- escape ---- */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr_(s) {
  return String(s == null ? '' : s).replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
}
