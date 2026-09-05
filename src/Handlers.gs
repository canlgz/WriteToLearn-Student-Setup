/**
 * Ingest handlers and command dispatch. Every handler reads/writes only within
 * its ctx.scope (per-chat folder). ctx is built by Router.gs from a LINE event.
 *
 * Ingest flow (text/image/audio/video/file):
 *   1. Persist raw media to scope's raw/ (if applicable)
 *   2. Use Gemini to produce a transcript / description
 *   3. Embed the transcript and append to scope's embeddings.jsonl
 *   4. Reply (text records are silent, except a once-per-idle「已記進脈絡」ack)
 */

const CAPTURE_ACK_IDLE_MS = 30 * 60 * 1000;  // re-acknowledge a note only after this much quiet

/** First plain note after a quiet stretch returns true (→ one-line capture ack);
 *  rapid follow-ups return false. The cache entry's own expiry IS the idle
 *  timer, so a burst of notes naturally collapses to a single ack. */
function captureWasIdle_(scope) {
  if (!scope || !scope.key) return false;
  const cache = CacheService.getScriptCache();
  const k = 'cap_seen_' + scope.key;
  const seen = cache.get(k);
  cache.put(k, '1', Math.ceil(CAPTURE_ACK_IDLE_MS / 1000));
  return !seen;
}

function handleText_(ctx, text) {
  const trimmed = (text || '').trim();
  // 手殘容錯：全形斜線 ／→ 半形 /、斜線後多打的空白收掉。
  // "/ me"、"／me"、"／ me"、"/  themes week" 都正規化成正規指令；一般筆記不受影響。
  const cmdText = trimmed.replace(/^／\s*/, '/').replace(/^\/\s+/, '/');
  if (cmdText.startsWith('/')) {
    // Slash command 也是 rename mode 的天然 escape —— 把狀態清掉再執行命令。
    const ask0 = loadAskDialog_(ctx.scope);
    if (ask0 && ask0.mode === 'rename') clearAskDialog_(ctx.scope);
    return handleCommand_(ctx, cmdText);
  }
  // Rename mode：下一句純文字 = 新主題名。先擋，免得當成 record ingest。
  const askR = loadAskDialog_(ctx.scope);
  if (askR && askR.mode === 'rename' && askR.contextId) {
    return handleContextRenameInput_(ctx, askR.contextId, trimmed);
  }
  // In conversational ask mode, plain text is a turn refining the question —
  // not a note. (Commands above still escape the mode; /exit ends it.)
  if (askDialogActive_(ctx.scope)) {
    // A quote-reply targets a specific past message — a different intent than
    // refining the current question. Leave the mode and fall through to normal
    // ingest, so the quote-supplement linkage is honored, not eaten as a turn.
    if (ctx.quotedMessageId) {
      handleAskExit_({ replyToken: ctx.replyToken }, ctx.scope);
    } else {
      return handleAskTurn_(ctx, trimmed);
    }
  }

  // Drive URL short-circuit: a message that's essentially a Google Drive link
  // is treated as an ingest intent, not a note — download (single file) or
  // show the folder file list (folder). Commentary-around-URL is left alone.
  if (tryHandleDriveLink_(ctx, trimmed)) return;

  // Resolve quote target. Only treat as a real supplement when we found
  // the target in our store — quote-replies on bot messages, postback
  // displayTexts, or pre-deploy records can't be linked, so we silently
  // fall back to normal text ingest (no echo, no fake linkage).
  const quotedRaw = ctx.quotedMessageId
    ? resolveQuotedTarget_(ctx.scope, ctx.quotedMessageId)
    : null;
  const quoted = quotedRaw && quotedRaw.found ? quotedRaw : null;
  if (quoted) {
    lineReply_(ctx.replyToken,
      `✅ 收到引述補充：\n${trimmed}\n\n↳ ${quoted.summary}`,
      null, ctx.quoteToken);
  }

  const id = newId_();
  const ts = new Date(ctx.timestamp || Date.now()).toISOString();
  const record = {
    id, ts, userId: ctx.userId, type: 'text', text: trimmed,
    quoteToken: ctx.quoteToken || null,
    lineMessageId: ctx.messageId || null,
    quotedLineMessageId: ctx.quotedMessageId || null,
    quotedRecordId: quoted && quoted.recordId,
    quotedSummary: quoted && quoted.summary
  };
  // 「裸連結貼上」flag（增量 4）：用「原始輸入」判，因為下面增豐會把標題/說明覆寫進
  // record.text。裸連結預設收藏、入庫時跳泡泡讓使用者選；附帶心得的連結則照常進歷程。
  record.linkBookmark = isBareLinkPaste_(trimmed);
  const mapsUrl = extractMapsUrl_(trimmed);
  if (mapsUrl) record.mapsUrl = mapsUrl;
  // 訊息形式：含外部網址（Drive 已於上方短路、地圖另存 mapsUrl 走地點語意）→ type:'link'，
  // 而非預設 'text'。link 在升格判準上**算一種獨立媒介**（CONTEXT_MEDIA_TYPES 含 link，
  // 故「連結＋寫文字」可滿足跨媒介≥2）；裸連結仍由 linkBookmark/收藏邏輯排除升格。
  if (!mapsUrl && /https?:\/\/\S/.test(trimmed)) record.type = 'link';
  // URL preview enrichment: 使用者貼網址（YouTube / 部落格 / 新聞…）光看 URL
  // embedding 沒有語意，clustering 抓不到。抓 og:title / og:description 串進 embed
  // 輸入，讓「連結 = 一段內容」而不是「一串字元」。原 record.text 保留 URL 不動。
  const urlPreview = fetchFirstUrlPreview_(trimmed);
  if (urlPreview) {
    record.urlPreview = urlPreview;
    // 把標題＋說明直接寫進 record.text 本體（原 URL 留在第一行）：之後 /recall
    // 卡上看到的是「URL + 標題 + 說明」，不再是只有一條看不懂的 URL。
    const lines = [trimmed];
    if (urlPreview.title) lines.push(`🔗 ${urlPreview.title}`);
    if (urlPreview.description) lines.push(urlPreview.description);
    record.text = lines.join('\n');
  }
  // Ingest is silent on success, but a genuine failure must be surfaced — a
  // note that silently vanishes is the worst kind of untrustworthy. We catch
  // here (rather than bubbling to Main.gs's generic error) to reply with a
  // specific, friendly warning that quotes the failed message. Lock contention
  // waits (60s) rather than failing, so this fires on real errors, not bursts.
  try {
    // Composite embedding input: weave in any extra context (URL preview,
    // quote-reply) so the record's vector carries the real semantic content.
    // The displayed `record.text` stays clean (just the user's input).
    let embedInput = trimmed;
    if (urlPreview) {
      const ptParts = [];
      if (urlPreview.title) ptParts.push(`[網頁標題] ${urlPreview.title}`);
      if (urlPreview.description) ptParts.push(`[網頁說明] ${urlPreview.description}`);
      if (ptParts.length) embedInput = `${trimmed}\n${ptParts.join('\n')}`;
    }
    if (quoted && quoted.summary) embedInput = `${quoted.summary}\n[補充] ${embedInput}`;
    // 儀式軸：進行中 lesson 期間，每筆繼承 explorationId（成員歸屬的單一真相）。
    const lesson = activeExploration_(ctx.scope);
    if (lesson) record.explorationId = lesson.id;
    record.embedding = geminiEmbed_(embedInput);
    appendEmbeddingRecord_(ctx.scope, record);
    try { trackThreadAmbiguity_(ctx.scope, record); } catch (e) { console.warn('trackThreadAmbiguity_ failed:', e && e.message); }
    saveTranscript_(ctx.scope, id, record.text, ts);
    // Capture ack：
    //   - 貼網址且有抓到 preview → 一律回，告知記下了什麼（網頁標題＋說明）
    //   - 貼網址但抓不到 preview（FB / IG / 需登入站、反爬）→ 也回一聲，承認收到，
    //     不要讓使用者以為訊息消失了
    //   - 一般文字 → 維持 once-per-idle 的輕量提示。
    const hasUrl = /https?:\/\/[^\s]+/.test(trimmed);
    const wasIdle = captureWasIdle_(ctx.scope);
    // 延遲告知：上次 lesson 自動關閉、或走開時背景默默處理的媒體 → 第一次傳訊息時前置（免費 reply）。
    const lateNotice = consumePendingExplorationNotice_(ctx.scope);
    const mediaNotice = consumePendingMediaNotice_(ctx.scope);
    const lessonHead = lesson ? `🎒 ${truncate_(lesson.label, 20)} 進行中\n` : '';
    const head = [lateNotice, mediaNotice].filter(Boolean).map(s => s + '\n').join('') + lessonHead;
    if (urlPreview && !quoted) {
      // 連結預覽卡：保留縮圖呈現（拿掉「學習素材/收藏」選擇，改成「開啟連結」）。
      lineReplyFlex_(ctx.replyToken, `🔗 已記下連結：${truncate_(urlPreview.title || urlPreview.url, 30)}`,
        buildLinkPreviewBubble_(urlPreview, (head || '').trim()));
    } else if (hasUrl && !quoted) {
      // FB/IG 等站對伺服器端不給預覽（正常，非錯誤）——記成外部連結即可，不顯示得像壞掉。
      lineReply_(ctx.replyToken,
        head + '🔗 已記下這個外部連結。\n' +
        '想讓 bot 抓到內容語意的話，可以再補一兩句說明這篇在講什麼。');
    } else if (!quoted && !hasUrl && maybeAskAttributionConfirm_(ctx, record)) {
      // A·記寫當下歸戶確認：認出剛寫的很可能屬於某條候選歷程 → 回確認卡，跳過一般 ack（無痕靜默的例外）。
    } else if (!quoted && (wasIdle || lateNotice)) {
      // wasIdle 維持原節流；lateNotice 強制觸發一次 ack——否則上面已消化卻沒顯示就丟了。
      lineReply_(ctx.replyToken, head + '✍️ 已記進你的脈絡（之後用 /recall、/ask 都找得到）');
    }
    try { appendToTimeline_(ctx.scope, record); }
    catch (e) { console.error('timeline append failed:', e && e.message); }
    // Fold this supplement into the target's vector, keyed on the quoted
    // LINE messageId (always present, even when resolveQuotedTarget_ said
    // found:false because the target was mid-processing). No-op if the
    // target isn't a record yet — processPendingMedia_ reconciles later.
    if (ctx.quotedMessageId) {
      try { reconcileSupplementsByLineMessageId_(ctx.scope, ctx.quotedMessageId); }
      catch (e) { console.error('reconcile supplements failed:', e && e.message); }
    }
    // 〔暫時·診斷〕即時回報本敘事片段語意密度變化（DENSITY_ECHO_DEBUG，預設關）。
    try { maybeEchoDensity_(ctx.scope, record); } catch (e) { console.warn('density echo failed:', e && e.message); }
    // 聚焦偵測已改「停筆 settle 後」推（backgroundSweep → maybePushFocusSettled_），寫當下不再出聲。
  } catch (e) {
    console.error('handleText_ ingest failed:', e && e.stack || e);
    lineReply_(ctx.replyToken, '⚠️ 這則可能沒記進脈絡（暫時性錯誤），請稍後再傳一次。', null, ctx.quoteToken);
  }
}

/** A·記寫當下「歸戶確認」：剛寫的這筆若與某條既有「候選歷程」群心很接近（cosine ≥ 門檻），
 *  就當場回一張輕確認「這段是不是『X』這條？」。回 true＝已回覆（caller 跳過一般 ack）。
 *  ⚠ 無痕靜默的例外：高門檻＋每條冷卻＋可永久關（returnInviteMuted）。機器提案、使用者拍板。 */
function maybeAskAttributionConfirm_(ctx, record) {
  if (!CONTINUITY_RT_ENABLED) return false;
  const scope = ctx.scope;
  if (!scope || scope.type !== 'user' || !scope.id) return false;
  if (!record || !record.embedding || record.embedding.length !== EMBED_DIM) return false;
  const contexts = loadContexts_(scope).filter(c => c.status === 'context');   // 只候選歷程
  if (!contexts.length) return false;
  const meta = loadChatMeta_(scope);
  const muted = meta.returnInviteMuted || {};
  const askedAt = meta.attrAskedAt || {};
  const isJourney = {}; loadJourneys_(scope).forEach(j => { if (j.status === 'journey') isJourney[j.contextId] = 1; });
  const recById = {}; loadEmbeddingRecords_(scope).forEach(r => { if (r && r.embedding) recById[r.id] = r; });
  let best = null, bestCos = 0;
  for (const c of contexts) {
    if (isJourney[c.id] || muted[c.id]) continue;
    if (Date.now() - (askedAt[c.id] || 0) < CONTINUITY_RT_COOLDOWN_MS) continue;
    if ((c.recordIds || []).indexOf(record.id) >= 0) continue;          // 已在這條，不問
    const embs = (c.recordIds || []).map(id => recById[id]).filter(Boolean).map(r => r.embedding);
    if (embs.length < 2) continue;
    const cos = cosineSim_(record.embedding, meanVector_(embs));
    if (cos > bestCos) { bestCos = cos; best = c; }
  }
  if (!best || bestCos < CONTINUITY_RT_COS_MIN) return false;
  try {
    lineReplyFlex_(ctx.replyToken,
      `這段像是「${truncate_(best.userTitle || best.label || '主題', 16)}」這條`,
      buildAttrConfirmBubble_(best, record.id));
  } catch (e) { console.warn('attr confirm failed:', e && e.message); return false; }
  updateChatMeta_(scope, m => { m.attrAskedAt = m.attrAskedAt || {}; m.attrAskedAt[best.id] = Date.now(); return m; });
  return true;
}

/** 歸戶確認卡：認出剛寫的屬於某條候選歷程，請使用者拍板（機器提案、你決定）。 */
function buildAttrConfirmBubble_(c, rid) {
  const title = c.userTitle || c.label || '主題';
  const btn = (label, data, primary) => ({
    type: 'box', layout: 'vertical', margin: 'sm',
    backgroundColor: primary ? THEME.cta : THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
    action: { type: 'postback', label: label, data: data, displayText: opEcho_(label, title) },
    contents: [{ type: 'text', text: label, size: 'sm', weight: 'bold', align: 'center', color: primary ? THEME.ctaText : THEME.cta }]
  });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🌿 認出一條既有的線', size: 'xs', color: THEME.ctaText },
        { type: 'text', text: truncate_(title, 22), size: 'lg', weight: 'bold', color: THEME.ctaText, wrap: true, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [
        { type: 'text', text: '剛寫的這段，看起來屬於這條「候選歷程」。要把它歸進去嗎？', size: 'sm', color: THEME.text, wrap: true },
        { type: 'text', text: '（歸進去後，這條重新整理也會把它留著；機器只是提案，你決定。）', size: 'xxs', color: THEME.muted, wrap: true }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [
        btn('✓ 是，歸進這條', `action=attr_confirm&cid=${c.id}&rid=${rid}`, true),
        btn('✗ 不是，獨立記', 'action=attr_no', false),
        btn('🔕 這條別再問', `action=return_invite_mute&cid=${c.id}`, false)
      ]
    }
  };
}

/**
 * 〔暫時·診斷〕即時回報「本敘事片段」的語意密度（群內平均 cosine）與這筆造成的變化。
 * 用來檢查為何某主題寫很多卻不達密度——密度＝這段彼此有多像，寫得雜會下降，量≠密度。
 * 計算涵蓋本段「所有」記錄（文字/連結/貼圖/已處理媒體），所以每寫一筆文字就能看到全段現況。
 * 1對1、只在有向量時。測完把 Config 的 DENSITY_ECHO_DEBUG 設 false（或移除上方呼叫）即可關閉。
 */
function maybeEchoDensity_(scope, record) {
  if (!DENSITY_ECHO_DEBUG) return;
  if (!scope || scope.type !== 'user' || !scope.id) return;
  if (!record || !record.embedding || record.embedding.length !== EMBED_DIM) return;
  const all = loadEmbeddingRecords_(scope)
    .filter(r => r && r.ts && r.embedding && r.embedding.length === EMBED_DIM);
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // 測試起點（/dreset 設）：有的話「本測試段」＝起點之後寫的；沒有就回退到最近敘事片段(30 分 gap)。
  const since = loadChatMeta_(scope).densityTestSince || 0;
  let burstRecs, label;
  if (since) {
    burstRecs = all.filter(r => Date.parse(r.ts) >= since);
    label = '本測試段';
  } else {
    const eps = groupByEpisode_(all, EPISODE_GAP_MS);
    burstRecs = eps.length ? eps[eps.length - 1].records : [];
    label = '本敘事片段';
  }
  const n = burstRecs.length;
  if (n < 2) {
    try { linePush_(scope.id, `🧪 語意密度診斷 · ${label} ${n} 筆\n（需 ≥2 筆才算得出群內相似度，繼續寫…）`); } catch (_) {}
    return;
  }
  const C = CONTEXT_CRITERIA;
  const after = avgPairwiseCosine_(burstRecs.map(r => r.embedding), 2000);
  const beforeEmbs = burstRecs.filter(r => r.id !== record.id).map(r => r.embedding);
  const before = beforeEmbs.length >= 2 ? avgPairwiseCosine_(beforeEmbs, 2000) : null;
  let deltaStr;
  if (before == null) deltaStr = `（這是${label}第 2 筆，才開始算得出）`;
  else { const d = after - before; deltaStr = d >= 0 ? `（+${d.toFixed(3)} ↑）` : `（${d.toFixed(3)} ↓）`; }
  const pass = after >= C.semanticDensityMin ? `✅ 達標（≥ ${C.semanticDensityMin}）` : `⬜ 未達（需 ≥ ${C.semanticDensityMin}）`;
  const msg = `🧪 語意密度診斷 · ${label} ${n} 筆\n` +
    `群內平均 cosine：${before != null ? before.toFixed(3) + ' → ' : ''}${after.toFixed(3)} ${deltaStr}\n` +
    `${pass}\n` +
    `（密度＝這段彼此有多像；寫得雜→下降，量多≠密度高）`;
  try { linePush_(scope.id, msg); } catch (e) { console.warn('density echo push failed:', e && e.message); }
}

/** 〔暫時·診斷〕重置語意密度測試起點：之後寫的當成「全新一段」算密度，免等 30 分敘事片段邊界。 */
function handleDensityReset_(ctx) {
  updateChatMeta_(ctx.scope, m => { m.densityTestSince = Date.now(); return m; });
  return lineReply_(ctx.replyToken,
    '🧪 已重置語意密度測試起點。\n接下來寫的會當成「全新一段」重新算密度（不必等 30 分鐘敘事片段邊界）。\n要再開新一輪就再打一次 /dreset。');
}

/* ===== 〔暫時·診斷〕測試模式：模式內的訊息不記錄、不進脈絡，只即時回報語意密度 ===== */

const TEST_BUF_PREFIX = 'dtest_';   // CacheService key 前綴（per scope）
const FOCUS_TEST_LOG_FILE = 'focus_test_log.jsonl';   // 〔暫時·診斷〕/test 過程逐筆寫進 chat 資料夾（自動複寫原檔），供 Claude 直接讀檔分析

/** 把一筆 /test 觀察 append 進 Drive 的 jsonl（同一檔、自動複寫不另開新檔）。 */
function appendTestLog_(scope, obj) {
  try {
    const file = chatJsonlFile_(scope, FOCUS_TEST_LOG_FILE);
    const prev = file.getBlob().getDataAsString();
    file.setContent((prev ? prev + '\n' : '') + JSON.stringify(obj));
    return file;
  } catch (e) { console.warn('appendTestLog_ failed:', e && e.message); return null; }
}

function testModeActive_(scope) {
  try { return !!(loadChatMeta_(scope) || {}).testMode; } catch (_) { return false; }
}

function handleTestEnter_(ctx) {
  updateChatMeta_(ctx.scope, m => { m.testMode = true; return m; });
  try { CacheService.getScriptCache().remove(TEST_BUF_PREFIX + ctx.scope.key); } catch (_) {}   // 自動重設語意狀態
  // 自動複寫記錄檔：truncate + 寫 start marker（含當前門檻），這次 session 從頭乾淨記錄。
  try {
    const file = chatJsonlFile_(ctx.scope, FOCUS_TEST_LOG_FILE);
    file.setContent(JSON.stringify({ event: 'start', t: new Date().toISOString(), thresholds: {
      densityGate: FOCUS_DENSITY_GATE, substMin: FOCUS_SUBSTANCE_MIN, nEffMin: FOCUS_NEFF_MIN, coreFrac: FOCUS_CORE_FRAC,
      recentK: FOCUS_RECENT_K, outlierK: FOCUS_OUTLIER_K, lenCap: FOCUS_LEN_CAP, fitFloor: FOCUS_FIT_FLOOR
    } }));
  } catch (e) { console.warn('test log reset failed:', e && e.message); }
  return lineReply_(ctx.replyToken,
    '🧪 已進入測試模式（語意已重設、過程開始記錄）。\n接下來打的文字「不記錄、不進脈絡」，只即時回報加權聚焦四指標。\n打 /test end 離開，然後回來跟我說一聲——我直接讀你 Drive 的記錄檔做完整分析（不必給連結）。');
}

function handleTestEnd_(ctx) {
  let n = 0;
  try {
    const raw = CacheService.getScriptCache().get(TEST_BUF_PREFIX + ctx.scope.key);
    if (raw) { try { const p = JSON.parse(raw); n = (p && p.n) || 0; } catch (_) {} }
    CacheService.getScriptCache().remove(TEST_BUF_PREFIX + ctx.scope.key);
  } catch (_) {}
  updateChatMeta_(ctx.scope, m => { delete m.testMode; return m; });
  appendTestLog_(ctx.scope, { event: 'end', t: new Date().toISOString(), n: n });
  return lineReply_(ctx.replyToken,
    `🧪 已離開測試模式。測試訊息（${n} 筆）全部丟棄、未進脈絡。\n📄 本次過程已寫入記錄檔——回來跟我說一聲，我直接讀檔分析（不必給連結）。`);
}

// 測試 buffer 數學：只存「正規化向量的累加和 s ＋ 筆數 n」（固定一個向量大小，不隨筆數成長、
// 永不爆 cache）。單位向量下：Σ_{i<j} v̂i·v̂j = (|s|²−n)/2，故群內平均 cosine = (|s|²−n)/(n(n−1))。
function testUnit_(v) {
  let mag = 0; for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag); if (!mag) return v.slice();
  const out = new Array(v.length); for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
  return out;
}
function testDot_(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function testDensFromSum_(s, n) {
  if (n < 2) return null;
  let sq = 0; for (let i = 0; i < s.length; i++) sq += s[i] * s[i];
  return (sq - n) / (n * (n - 1));
}
// 長度權重（飽和）：w=√min(字數,上限)。轉錄很長也不會獨吞焦點。
function focusWeight_(len) { return Math.sqrt(Math.min(Math.max(len || 0, 1), FOCUS_LEN_CAP)); }
// 加權群內平均 cosine：(|S_w|²−W2)/(W1²−W2)。S_w=Σw·v̂、W1=Σw、W2=Σw²。
function weightedDensity_(Sw, W1, W2) {
  const denom = W1 * W1 - W2;
  if (denom <= 1e-9) return null;
  let sq = 0; for (let i = 0; i < Sw.length; i++) sq += Sw[i] * Sw[i];
  return (sq - W2) / denom;
}
// 〔結構·參考〕cosine k-means（決定性：stride 初始化、固定迭代）。回傳每點群索引。
function testKmeans_(vecs, k, iters) {
  const n = vecs.length; if (n < k) return null;
  const D = vecs[0].length;
  const cent = []; for (let j = 0; j < k; j++) cent.push(vecs[Math.floor(j * n / k)].slice());
  const assign = new Array(n).fill(0);
  for (let it = 0; it < (iters || 6); it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bestS = -2;
      for (let j = 0; j < k; j++) { const s = testDot_(vecs[i], cent[j]); if (s > bestS) { bestS = s; best = j; } }
      assign[i] = best;
    }
    const sum = []; for (let j = 0; j < k; j++) sum.push(new Array(D).fill(0));
    const cnt = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { const a = assign[i]; cnt[a]++; const v = vecs[i]; for (let d = 0; d < D; d++) sum[a][d] += v[d]; }
    for (let j = 0; j < k; j++) if (cnt[j]) cent[j] = testUnit_(sum[j]);
  }
  return assign;
}
// 子集的加權平均 pairwise cosine。
function testWeightedPairwise_(vecs, ws, idx) {
  let num = 0, den = 0;
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const i = idx[a], j = idx[b], wij = ws[i] * ws[j];
    num += wij * testDot_(vecs[i], vecs[j]); den += wij;
  }
  return den > 0 ? num / den : null;
}
// 結構讀數：對 k=2,3 跑 k-means → 最大子群權重佔比 domFrac（1 主題≈1.0、3 等分≈0.33）
// ＋群內加權密度 within（明顯 > 全段密度 = 有子結構＝多主題）。
function testStructure_(vecs, ws) {
  const n = vecs.length;
  const all = []; for (let i = 0; i < n; i++) all.push(i);
  let W = 0; for (let i = 0; i < n; i++) W += ws[i];
  const out = { whole: testWeightedPairwise_(vecs, ws, all) };
  for (const k of [2, 3]) {
    if (n < k + 1) continue;
    const a = testKmeans_(vecs, k, 6); if (!a) continue;
    const cw = new Array(k).fill(0); const idx = []; for (let j = 0; j < k; j++) idx.push([]);
    for (let i = 0; i < n; i++) { cw[a[i]] += ws[i]; idx[a[i]].push(i); }
    let wsum = 0, wtot = 0, lines = 0;
    for (let j = 0; j < k; j++) if (idx[j].length >= 2) { lines++; const wp = testWeightedPairwise_(vecs, ws, idx[j]); if (wp != null) { wsum += wp * cw[j]; wtot += cw[j]; } }
    // 交織〔時序回返〕：a 已是時間序；某群被中斷後又出現＝一次回返/交織。
    let returns = 0; const seen = {};
    for (let i = 0; i < a.length; i++) { if (i > 0 && a[i] !== a[i - 1] && seen[a[i]]) returns++; seen[a[i]] = true; }
    // 交織〔語意橋接〕：算各群群心，某筆對「最近兩條群心」cosine 差 < FOCUS_BRIDGE_GAP ＝夾在兩線之間的整合句。
    const D = vecs[0].length;
    const cents = [];
    for (let j = 0; j < k; j++) { if (idx[j].length) { const s = new Array(D).fill(0); for (const i of idx[j]) { const v = vecs[i]; for (let d = 0; d < D; d++) s[d] += v[d]; } cents[j] = testUnit_(s); } else cents[j] = null; }
    let bridges = 0;
    for (let i = 0; i < n; i++) {
      const sims = []; for (let j = 0; j < k; j++) if (cents[j]) sims.push(testDot_(vecs[i], cents[j]));
      sims.sort((p, q) => q - p);
      if (sims.length >= 2 && (sims[0] - sims[1]) < FOCUS_BRIDGE_GAP) bridges++;
    }
    out['k' + k] = { domFrac: Math.max.apply(null, cw) / (W || 1), within: wtot > 0 ? wsum / wtot : null, lines: lines, returns: returns, bridges: bridges };
  }
  return out;
}

/** 測試模式收到一則文字：embed 後更新長度加權狀態（不寫語料），回報加權四指標。
 *  每筆權重 w=√min(字數,上限)：短碎句/雜訊權重低、長轉錄飽和不獨吞。
 *  聚焦度＝加權群內平均 cosine；實質量 W1=Σw；有效量 n_eff=W1²/W2；核心＝加權離群比例。
 *  貼合＝對最近 K 筆的「加權」平均 cosine；離群＝相對(z-score)、樣本不足退回絕對 floor。
 *  說明：圖片/檔案的轉錄結果走同一條公式（text＝轉錄、長度＝權重），自動納入混合段落。 */
function handleTestMessage_(ctx, text) {
  if (!text) return;
  let emb;
  try { emb = geminiEmbed_(text); }
  catch (e) { return lineReply_(ctx.replyToken, '🧪 測試模式：這則無法嵌入向量，略過（未記錄）。'); }
  const u = testUnit_(emb);
  const D = u.length;
  const len = text.trim().length;
  const w = focusWeight_(len);
  const cache = CacheService.getScriptCache();
  const key = TEST_BUF_PREFIX + ctx.scope.key;
  let st = { n: 0, Sw: new Array(D).fill(0), W1: 0, W2: 0, lowW: 0, sumLen: 0, fired: false, vecs: [], ws: [], sumFit: 0, sumFit2: 0, mFit: 0 };
  try {
    const raw = cache.get(key);
    if (raw) { const p = JSON.parse(raw); if (p && p.Sw && p.Sw.length === D) st = {
      n: p.n || 0, Sw: p.Sw, W1: p.W1 || 0, W2: p.W2 || 0, lowW: p.lowW || 0, sumLen: p.sumLen || 0, fired: !!p.fired,
      vecs: Array.isArray(p.vecs) ? p.vecs : [], ws: Array.isArray(p.ws) ? p.ws : [], sumFit: p.sumFit || 0, sumFit2: p.sumFit2 || 0, mFit: p.mFit || 0
    }; }
  } catch (_) {}

  // 1) 用「先前狀態」算：加本筆前的加權密度、近窗加權貼合（對最近 K 筆）、相對離群。
  const before = weightedDensity_(st.Sw, st.W1, st.W2);
  let fit = null;
  if (st.vecs.length) {
    const start = Math.max(0, st.vecs.length - FOCUS_RECENT_K);
    let acc = 0, wsum = 0;
    for (let i = start; i < st.vecs.length; i++) { acc += st.ws[i] * testDot_(u, st.vecs[i]); wsum += st.ws[i]; }
    fit = wsum > 0 ? acc / wsum : null;
  }
  let isOutlier = false;
  if (fit != null) {
    if (st.mFit >= 3) {
      const mean = st.sumFit / st.mFit;
      const sd = Math.sqrt(Math.max(0, st.sumFit2 / st.mFit - mean * mean));
      isOutlier = fit < (mean - FOCUS_OUTLIER_K * sd);
    } else {
      isOutlier = fit < FOCUS_FIT_FLOOR;
    }
  }

  // 2) 更新狀態（加權）。vecs 存「四捨五入 3 位的單位向量」供 k-means 結構分析（上限 14 筆控 cache）。
  for (let i = 0; i < D; i++) st.Sw[i] += w * u[i];
  st.W1 += w; st.W2 += w * w; st.n += 1; st.sumLen += len;
  if (isOutlier) st.lowW += w;                            // 離群以「權重」計（短岔題扣分小）
  if (fit != null) { st.sumFit += fit; st.sumFit2 += fit * fit; st.mFit += 1; }
  st.vecs.push(u.map(x => Math.round(x * 1000) / 1000)); st.ws.push(w);
  if (st.vecs.length > 14) { st.vecs = st.vecs.slice(-14); st.ws = st.ws.slice(-14); }

  // 3) 加權四指標（改當參考）＋ k-means 結構（線/回返/橋接）＝點線面判準。
  const density = weightedDensity_(st.Sw, st.W1, st.W2);
  const nEff = st.W2 > 0 ? (st.W1 * st.W1 / st.W2) : 0;
  const coreFrac = st.W1 > 0 ? (st.W1 - st.lowW) / st.W1 : 1;
  const subst = st.W1;
  const avgLen = st.sumLen / st.n;
  const struct = (st.vecs.length >= 3) ? testStructure_(st.vecs, st.ws) : null;
  // 點線面達標 = 量底線(W1) ＋ 線≥2 ＋ 橋接≥1。取 k=3（不足退 k=2）。橋接(夾在兩遠線群心間的整合句)＝真跨域
  // 整合的指紋；回返僅當參考（淺交織會把它刷高，見 Config FOCUS_BRIDGE_MIN 註）。
  const sg = struct ? (struct.k3 || struct.k2) : null;
  const linesN = sg ? (sg.lines || 0) : 0;
  const returnsN = sg ? (sg.returns || 0) : 0;
  const bridgesN = sg ? (sg.bridges || 0) : 0;
  const interweave = returnsN + bridgesN;
  const faceOk = (subst >= FOCUS_SUBSTANCE_MIN) && (linesN >= 2) && (bridgesN >= FOCUS_BRIDGE_MIN);
  // 舊四門檻只留作參考顯示，不再當達標。
  const dOk = density != null && density >= FOCUS_DENSITY_GATE;
  const sOk = subst >= FOCUS_SUBSTANCE_MIN;
  const eOk = nEff >= FOCUS_NEFF_MIN;
  const cOk = coreFrac >= FOCUS_CORE_FRAC;
  const justFired = !st.fired && faceOk;
  if (justFired) st.fired = true;
  try { cache.put(key, JSON.stringify(st), 6 * 3600); } catch (e) { console.warn('test buf put failed:', e && e.message); }

  // 〔暫時·診斷〕逐筆寫進 Drive 記錄檔（自動複寫原檔），供 Claude 直接讀檔分析、不必給連結。
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const sk = (o) => o ? { domFrac: r3(o.domFrac), within: r3(o.within), lines: o.lines, returns: o.returns, bridges: o.bridges } : null;
  const structLog = struct ? { whole: r3(struct.whole), k2: sk(struct.k2), k3: sk(struct.k3) } : null;
  appendTestLog_(ctx.scope, {
    t: new Date().toISOString(), n: st.n, text: text.trim(), len: len, w: r3(w),
    fit: r3(fit), outlier: isOutlier, densBefore: r3(before), density: r3(density),
    W1: r3(st.W1), W2: r3(st.W2), nEff: r3(nEff), coreFrac: r3(coreFrac), struct: structLog,
    face: { lines: linesN, bridges: bridgesN, returns: returnsN, interweave: interweave, substOk: sOk, ok: faceOk },
    gatesRef: { density: dOk, subst: sOk, nEff: eOk, core: cOk }, fired: justFired
  });

  const mk = (ok) => ok ? '✅' : '⬜';
  const lines = [
    `🧪 測試模式 · 第 ${st.n} 筆（不記錄）`,
    `本筆「${truncate_(text.trim(), 16)}」(${len}字·w${w.toFixed(1)})${fit != null ? '｜貼合 ' + fit.toFixed(2) + (isOutlier ? ' ⚠️' : '') : ''}`
  ];
  if (struct) {
    lines.push(`▸ 面判準：${linesN}線・橋接${bridgesN}（回返${returnsN}）${mk(faceOk)}（線≥2 且 橋接≥${FOCUS_BRIDGE_MIN}）`);
  } else {
    lines.push(`▸ 面判準：累積中（需 ≥3 筆才分得出線，現 ${st.n} 筆）`);
  }
  const dStr = (density == null) ? '—' : density.toFixed(2);
  lines.push(`〔參考〕實質量W1=${subst.toFixed(1)}${mk(sOk)}・聚焦${dStr}・n_eff${nEff.toFixed(1)}・核心${coreFrac.toFixed(2)}`);
  if (justFired) lines.push('🎯 首次達標：橋接接起兩線、跨主題整合成面');
  else if (st.fired) lines.push('（已達標）');
  return lineReply_(ctx.replyToken, lines.join('\n'));
}

/**
 * 〔Tier-1 即時聚焦偵測〕純向量、零 LLM。串流維護當前敘事片段的「單位向量累加和 S＋計數」
 * （固定一個向量大小、不爆 cache），每筆 O(768)：
 *   density  = (|S|²−n)/(n(n−1))     群內平均 cosine（聚焦）
 *   fit      = u·S_prev/n_prior       本筆對前文平均 cosine（< FIT_FLOOR 計為離群）
 *   coreFrac = (n−nLowFit)/n          不雜（多數筆非離群）
 *   avgLen   = sumLen/n               具體（濾電報式碎句）
 * 第一次同時跨 n/density/avgLen/coreFrac 四門檻 → 即時 push「這段夠聚焦、已記下」（fired 去重）。
 * 與背景「記寫回執」(maybePushWriteReceipt_，有 LLM 命名/歸類) 互補。
 */
function maybeFocusDetect_(scope, record) {
  if (!FOCUS_DETECT_ENABLED) return;
  if (!scope || scope.type !== 'user' || !scope.id) return;
  if (!record || !record.embedding || record.embedding.length !== EMBED_DIM) return;
  const cache = CacheService.getScriptCache();
  const key = 'focus_' + scope.key;
  const now = Date.parse(record.ts) || Date.now();
  let st = null;
  try { const raw = cache.get(key); if (raw) st = JSON.parse(raw); } catch (_) {}
  // 新段邊界：與上一筆間隔 > 敘事片段 gap、或狀態缺失/維度不符 → 重置一段。
  if (!st || !st.S || st.S.length !== EMBED_DIM || (now - (st.lastTs || 0)) > EPISODE_GAP_MS) {
    st = { n: 0, S: new Array(EMBED_DIM).fill(0), nLowFit: 0, sumLen: 0, startTs: now, lastTs: now, fired: false };
  }
  const u = testUnit_(record.embedding);
  const fit = st.n >= 1 ? (testDot_(u, st.S) / st.n) : null;   // 本筆對前文的平均 cosine
  const before = testDensFromSum_(st.S, st.n);                 // 加本筆前的密度
  for (let i = 0; i < u.length; i++) st.S[i] += u[i];
  st.n += 1;
  st.sumLen += ((record.text || '').trim().length);
  st.lastTs = now;
  if (fit != null && fit < FOCUS_FIT_FLOOR) st.nLowFit += 1;

  // 四項指標
  const density = testDensFromSum_(st.S, st.n);
  const coreFrac = (st.n - st.nLowFit) / st.n;
  const avgLen = st.sumLen / st.n;
  const nOk = st.n >= FOCUS_MIN_N;
  const dOk = density != null && density >= FOCUS_DENSITY_GATE;
  const lOk = avgLen >= FOCUS_LEN_FLOOR;
  const cOk = coreFrac >= FOCUS_CORE_FRAC;
  const justFired = !st.fired && nOk && dOk && lOk && cOk;
  if (justFired) st.fired = true;

  const range = `${Utilities.formatDate(new Date(st.startTs), TIME_ZONE, 'HH:mm')}–${Utilities.formatDate(new Date(now), TIME_ZONE, 'HH:mm')}`;
  if (FOCUS_OBSERVE) {
    // 〔暫時·觀察〕每筆都列四項指標＋各自門檻，方便校準。
    const mk = (ok) => ok ? '✅' : '⬜';
    const dStr = (density == null) ? '—' : (before != null ? `${before.toFixed(2)}→${density.toFixed(2)}` : density.toFixed(2));
    const lines = [
      `🔎 聚焦觀察 · 第 ${st.n} 筆（${range}）`,
      `本筆「${truncate_((record.text || '').trim(), 16)}」${fit != null ? '｜貼合前文 ' + fit.toFixed(2) : ''}`,
      `・聚焦度 ${dStr} ${mk(dOk)}（≥${FOCUS_DENSITY_GATE}）`,
      `・平均字數 ${Math.round(avgLen)} ${mk(lOk)}（≥${FOCUS_LEN_FLOOR}）`,
      `・核心 ${st.n - st.nLowFit}/${st.n}＝${coreFrac.toFixed(2)} ${mk(cOk)}（≥${FOCUS_CORE_FRAC}）`,
      `・筆數 ${st.n} ${mk(nOk)}（≥${FOCUS_MIN_N}）`
    ];
    if (justFired) lines.push('🎯 首次達標：這段已夠具體聚焦、已記下');
    else if (st.fired) lines.push('（已達標·背景歸類中）');
    try { linePush_(scope.id, lines.join('\n')); } catch (e) { console.warn('focus observe push failed:', e && e.message); }
  } else if (justFired) {
    // 正式模式：只在跨門檻當下推一次。
    const msg = `🎯 你剛寫的這段（${range}・${st.n} 筆）已經夠「具體聚焦」了\n` +
      `聚焦度 ${density.toFixed(2)}（核心 ${st.n - st.nLowFit}/${st.n}）・平均 ${Math.round(avgLen)} 字\n` +
      `→ 已記下；背景正在把它歸成一條脈絡，稍後給你完整歸類。`;
    try { linePush_(scope.id, msg); } catch (e) { console.warn('focus detect push failed:', e && e.message); }
  }
  try { cache.put(key, JSON.stringify(st), 6 * 3600); } catch (e) { console.warn('focus state put failed:', e && e.message); }
}

/**
 * Sticker ingest. LINE stickers carry descriptive keywords (happy,
 * thumbs up, etc.) which we use directly as the embedding text — no
 * Gemini call needed, no mode picker, silent like text. Treated as
 * emotional / reaction signals during the learning process.
 */
const STICKER_EMOTION_WINDOW_MS = 6 * 60 * 60 * 1000;   // 貼圖標到「最近一句內容」的時間窗（太舊不亂標）

/** 〔情緒層〕貼圖要掛到哪一句：引述優先，否則窗內最近一句「語意內容」訊息。回 recordId 或 null。 */
function resolveStickerEmotionTarget_(scope, quoted, ts) {
  if (quoted && quoted.recordId) return quoted.recordId;
  let recs;
  try { recs = loadEmbeddingRecords_(scope); } catch (_) { return null; }
  const now = Date.parse(ts) || Date.now();
  const cand = (recs || [])
    .filter(r => r && r.id && CONTEXT_MEDIA_TYPES[r.type] && (Date.parse(r.ts) || 0) <= now)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (!cand || now - Date.parse(cand.ts) > STICKER_EMOTION_WINDOW_MS) return null;
  return cand.id;
}

function handleSticker_(ctx, m) {
  const id = newId_();
  const ts = new Date(ctx.timestamp || Date.now()).toISOString();
  const rawKeywords = m.keywords || [];
  // Synthesize a clean Chinese emotional phrase so /search can find this
  // sticker by meaning ("興奮", "感謝") rather than English tags. Gemini
  // failure falls back to the raw keyword list so the sticker still gets
  // a record — just less searchable in Chinese.
  // emoji：純啟發式、零 LLM（stickerEmoji_ 已涵蓋大部分人類情緒）。phrase：每個 stickerId 只算一次
  // 的快取（給 /recall 搜尋用），之後零 LLM。
  const emoji = stickerEmoji_(rawKeywords);
  const phrase = (rawKeywords.length ? stickerPhraseCached_(m.stickerId, rawKeywords) : null) || (rawKeywords.join('、') || '貼圖');
  const text = `[貼圖] ${phrase}`;
  const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${m.stickerId}/iPhone/sticker.png`;

  // 〔情緒層 §A〕貼圖＝對某句的當下情緒：掛到目標（引述優先，否則窗內最近一句）的 reactions。
  // 不再把引述貼圖當「內容補充」（不設 quotedRecordId、不 reconcile 進 aggregatedEmbedding）——
  // 情緒詞不汙染內容語意；密度本就排除貼圖（§B）。貼圖自身仍留 timeline（emotionFor 標對象）。
  const quotedRaw = ctx.quotedMessageId ? resolveQuotedTarget_(ctx.scope, ctx.quotedMessageId) : null;
  const quoted = quotedRaw && quotedRaw.found ? quotedRaw : null;
  const targetId = resolveStickerEmotionTarget_(ctx.scope, quoted, ts);
  if (targetId) {
    try {
      updateRecord_(ctx.scope, targetId, (rec) => {
        rec.reactions = (rec.reactions || []).concat([{ emoji, summary: phrase, stickerUrl, stickerId: m.stickerId || null, ts }]);
        if (rec.reactions.length > 8) rec.reactions = rec.reactions.slice(-8);
        return rec;
      });
    } catch (e) { console.warn('attach sticker emotion failed:', e && e.message); }
  }
  // 引述貼圖仍回一句（使用者預期引述有回應）；一般貼圖維持靜默入庫。
  if (quoted) {
    lineReply_(ctx.replyToken, `${emoji} 心情已標到：\n↳ ${quoted.summary}`, null, ctx.quoteToken);
  }

  const record = {
    id, ts, userId: ctx.userId, type: 'sticker', text,
    stickerPackageId: m.packageId || null,
    stickerId: m.stickerId || null,
    stickerUrl,
    stickerKeywords: rawKeywords,
    stickerEmoji: emoji,           // 入庫時定下的代表 emoji（呈現一致、免每次重算）
    quoteToken: ctx.quoteToken || null,
    lineMessageId: ctx.messageId || null,
    emotionFor: targetId || null   // 情緒對象（非內容補充）
  };
  // Sticker ingest is silent like text; swallow transient failures so they
  // don't surface as scary toasts (see handleText_ for rationale).
  // 儀式軸：進行中 lesson 期間繼承 explorationId。
  { const al = activeExploration_(ctx.scope); if (al) record.explorationId = al.id; }
  try {
    record.embedding = geminiEmbed_(text);   // 純情緒詞 embedding（不混入目標內容）
    appendEmbeddingRecord_(ctx.scope, record);
    saveTranscript_(ctx.scope, id, text, ts);
    try { appendToTimeline_(ctx.scope, record); }
    catch (e) { console.error('timeline append failed:', e && e.message); }
  } catch (e) {
    console.error('handleSticker_ ingest failed:', e && e.stack || e);
    lineReply_(ctx.replyToken, '⚠️ 這個貼圖可能沒記進脈絡（暫時性錯誤），請稍後再傳一次。', null, ctx.quoteToken);
  }
}

/**
 * Location ingest. LINE delivers { title, address, latitude, longitude }
 * for shared locations. We store all four so the record can power both
 * semantic search ("台中 咖啡廳") and future geo queries ("半徑 1km 內
 * 我學過什麼"). Silent like text/sticker — the location alone is a
 * spatial anchor; users add learning context by quote-replying to it
 * with text.
 */
function handleLocation_(ctx, m) {
  const id = newId_();
  const ts = new Date(ctx.timestamp || Date.now()).toISOString();
  const title = (m.title || '').trim();
  const address = (m.address || '').trim();
  const lat = m.latitude;
  const lon = m.longitude;

  const parts = ['📍 位置'];
  if (title) parts.push(title);
  if (address) parts.push(address);
  const text = parts.join('\n');

  // Quote-reply support mirrors handleText_: a user could (in principle)
  // long-press an earlier message and then send a location as the reply.
  // LINE app doesn't currently expose this UX, but if the event arrives
  // with quotedMessageId we handle it consistently.
  const quotedRaw = ctx.quotedMessageId
    ? resolveQuotedTarget_(ctx.scope, ctx.quotedMessageId)
    : null;
  const quoted = quotedRaw && quotedRaw.found ? quotedRaw : null;
  if (quoted) {
    lineReply_(ctx.replyToken,
      `✅ 收到引述補充（位置）\n\n↳ ${quoted.summary}`,
      null, ctx.quoteToken);
  }

  const record = {
    id, ts, userId: ctx.userId, type: 'location', text,
    title: title || null,
    address: address || null,
    latitude: lat,
    longitude: lon,
    quoteToken: ctx.quoteToken || null,
    lineMessageId: ctx.messageId || null,
    quotedLineMessageId: ctx.quotedMessageId || null,
    quotedRecordId: quoted && quoted.recordId,
    quotedSummary: quoted && quoted.summary
  };
  // 儀式軸：進行中 lesson 期間繼承 explorationId。
  { const al = activeExploration_(ctx.scope); if (al) record.explorationId = al.id; }
  try {
    // Embed the human-readable bits (title + address). Coordinates as
    // numbers don't carry semantic signal, but they're on the record for
    // future geo features.
    const embedInput = [title, address].filter(Boolean).join(' ')
      || `位置 ${lat},${lon}`;
    record.embedding = geminiEmbed_(embedInput);
    appendEmbeddingRecord_(ctx.scope, record);
    saveTranscript_(ctx.scope, id, text, ts);
    try { appendToTimeline_(ctx.scope, record); }
    catch (e) { console.error('timeline append failed:', e && e.message); }
    if (ctx.quotedMessageId) {
      try { reconcileSupplementsByLineMessageId_(ctx.scope, ctx.quotedMessageId); }
      catch (e) { console.error('reconcile supplements failed:', e && e.message); }
    }
  } catch (e) {
    console.error('handleLocation_ ingest failed:', e && e.stack || e);
    lineReply_(ctx.replyToken, '⚠️ 這個位置可能沒記進脈絡（暫時性錯誤），請稍後再傳一次。', null, ctx.quoteToken);
  }
}

/**
 * Media ingest is two-step: save raw + ask user how to transcribe.
 *   1. Download blob, save into raw/, register a pending entry via
 *      PendingStore (ScriptProperties — atomic, lock-free, so a parallel
 *      burst of text events can't starve out the registration). The entry
 *      includes the LINE quoteToken so the reply can visually attach to
 *      the original media message.
 *   2. Reply with Quick Reply postback bubbles (詳細 / 摘要 / 幫我決定),
 *      quoting the user's media message so it's unambiguous which file
 *      the picker is for — solves the "which bubble belongs to which file"
 *      problem when several files are uploaded in quick succession.
 *   3. handlePostback_ resolves the pending entry by id and processes only
 *      that one, again quoting the original media in the result reply.
 */
function handleMedia_(ctx, type, defaultMime, defaultExt, originalName) {
  // Surface "bot is working" with LINE's typing indicator while we download
  // + save the file. 1-on-1 chats only; the API rejects group/room targets.
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  const blob = lineGetContent_(ctx.messageId);
  const mime = resolveMime_(blob.getContentType() || defaultMime, originalName);
  const id = newId_();
  const ts = new Date(ctx.timestamp || Date.now()).toISOString();
  const dateStr = Utilities.formatDate(new Date(ts), TIME_ZONE, 'yyyy-MM-dd');
  const fileName = originalName
    ? `${dateStr}_${id}_${originalName}`
    : `${dateStr}_${id}.${defaultExt}`;
  const driveFile = saveRawBlob_(ctx.scope, blob, fileName);

  const ext = extractExtensionLabel_({ fileName, mimeType: mime });
  const headLabel = type === 'file' && ext
    ? `${typeLabel_(type)}（${ext}）`
    : typeLabel_(type);

  if (isArchiveFile_(mime, fileName)) {
    lineReply_(ctx.replyToken,
      `📥 收到${headLabel}\n⚠️ 壓縮檔暫不支援自動轉譯。\n原檔已存到 Drive，請解壓後重新上傳每個檔案。`,
      null, ctx.quoteToken);
    return;
  }

  // Lock-free single-key write — a parallel burst of text events cannot
  // starve this out, so the raw file in Drive is always paired with an
  // entry that the picker and sweep can act on.
  addPending_(ctx.scope, {
    id, ts, type,
    userId: ctx.userId,
    fileId: driveFile.getId(),
    fileName,
    mimeType: mime,
    quoteToken: ctx.quoteToken || null,
    duration: ctx.duration || null,
    lineMessageId: ctx.messageId || null,
    // 儀式軸：以入站當下的進行中 lesson 為準（媒體走 pending→sweep，關閉後才處理也不歸錯）。
    explorationId: (activeExploration_(ctx.scope) || {}).id || null
  });

  // Supplement-candidate auto-attach: when the user just tapped 進行中脈絡 卡
  // 的「補一筆撐到候選歷程」, their next upload should immediately land in
  // that 脈絡 (skipping the mode picker) so the criteria — esp. 跨媒介 — can
  // be re-judged on the spot instead of waiting for the background sweep.
  const supSession = loadAskDialog_(ctx.scope);
  if (supSession && supSession.mode === 'supplement' && supSession.contextId) {
    const targetCtx = loadContexts_(ctx.scope).find(c => c.id === supSession.contextId);
    if (targetCtx && (targetCtx.status === 'candidate' || targetCtx.status === 'context')) {
      return handleSupplementMediaAttach_(ctx, id, supSession.contextId);
    }
  }

  const qr = transcribeModeQuickReply_(id);
  lineReply_(ctx.replyToken, `📥 收到${headLabel}\n選擇轉譯的處理方式：`, qr, ctx.quoteToken);
}

/**
 * Auto-process a supplement-mode upload and attach it to a 進行中脈絡 right
 * away, then re-judge the 三條件. Replaces the usual mode picker reply with
 * a single result reply that names the criteria status, so the user sees
 * "this image carried 跨媒介 over the line" immediately.
 */
function handleSupplementMediaAttach_(ctx, pendingId, contextId) {
  const pending = claimPending_(ctx.scope, pendingId);
  if (!pending) return lineReply_(ctx.replyToken, '⚠️ 上傳暫時失敗，請再試一次。');
  const before = loadContexts_(ctx.scope).find(c => c.id === contextId);
  const isContext = !!(before && before.status === 'context');
  let preview;
  try { preview = processPendingMedia_(ctx.scope, pending, 'auto'); }
  catch (e) {
    try { releasePending_(ctx.scope, pendingId); } catch (_) {}
    return lineReply_(ctx.replyToken, `⚠️ 處理失敗：${(e && e.message) || e}`);
  }
  finishPending_(ctx.scope, pendingId);
  const result = attachRecordToCandidate_(ctx.scope, contextId, pendingId);   // 入脈絡（候選脈絡補媒介；候選歷程也納為一筆）
  const name = truncate_((result && result.c && result.c.label) || '這條脈絡', 20);
  const previewShort = truncate_((preview || '').replace(/\s+/g, ' '), 30);
  const note = `[${typeLabel_(pending.type)}] ${previewShort || '已補上'}`;
  const s = loadAskDialog_(ctx.scope);

  // 〔關鍵〕不因媒體離開補充模式：候選脈絡把這筆當一個 turn 累積進凝聚卡、繼續補；只有按「離開」才退出。
  if (!isContext && s && s.mode === 'supplement' && s.contextId === contextId) {
    return askPushTurnAndRefine_(ctx, s, note);
  }
  if (isContext) {
    // 候選歷程：媒體入脈絡、但轉折要文字；留著 session 讓你接著寫一句話（不離開）。
    return lineReplyFlex_(ctx.replyToken, `補充結果 · ${name}`, buildSuppResultBubble_({
      tone: 'progress', icon: '🌀', topic: name, staying: true,
      headline: `✓ 已把這${typeLabel_(pending.type)}補進「${name}」（${previewShort || '已轉譯'}）`,
      hints: ['媒體不算轉折——升格成學習歷程要「一句話的轉折」（重述／整合／行動／反思），接著直接打一句即可。']
    }), suppModeQuickReply_());
  }
  // session 已不在（理論上少見）→ 退回單則回覆。
  if (result && result.report && result.report.met) {
    return lineReply_(ctx.replyToken, `🎉 三條件齊備、「${name}」升格成候選歷程！（${previewShort || '已轉譯'}）`);
  }
  const gapsText = (result && result.report && result.report.gaps && result.report.gaps.length) ? result.report.gaps.join('、') : '再多累積一點';
  return lineReply_(ctx.replyToken, `✓ 已歸進「${name}」（${previewShort || '已轉譯'}）\n還缺：${gapsText}`);
}

/** Archive formats Gemini does not accept. Detection is by mime or filename ext. */
function isArchiveFile_(mime, fileName) {
  const m = (mime || '').toLowerCase();
  if (m === 'application/zip' || m === 'application/x-zip-compressed'
      || m === 'application/x-rar-compressed' || m === 'application/vnd.rar'
      || m === 'application/x-7z-compressed'
      || m === 'application/x-tar' || m === 'application/gzip'
      || m === 'application/x-bzip2') return true;
  const ext = (fileName || '').match(/\.([A-Za-z0-9]{1,5})$/);
  if (!ext) return false;
  return ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].indexOf(ext[1].toLowerCase()) >= 0;
}

function transcribeModeQuickReply_(pendingId) {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '詳細', data: `mode=detailed&id=${pendingId}`, displayText: '▸ 看詳細版' } },
      { type: 'action', action: { type: 'postback', label: '摘要', data: `mode=summary&id=${pendingId}`,  displayText: '▸ 看摘要版' } },
      { type: 'action', action: { type: 'postback', label: '▸ 幫我決定', data: `mode=auto&id=${pendingId}`, displayText: '▸ 幫我決定' } }
    ]
  };
}

/** Postback dispatcher. Routes based on the action / mode key. */
function handlePostback_(ev, scope) {
  const data = (ev.postback && ev.postback.data) || '';
  const params = {};
  for (const pair of data.split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }

  if (params.action === 'detail' && params.id) {
    return replyRecordDetail_(ev, scope, params.id);
  }

  if (params.action === 'pending_list') {
    return replyPendingList_(ev, scope);
  }

  if (params.action === 'drive_import' && params.fid) {
    return importDriveFile_({ scope, replyToken: ev.replyToken }, params.fid);
  }
  if (params.action === 'drive_dup') {
    // The folder list flagged this file as already-imported; nothing else to do.
    return;
  }

  if (params.action === 'focus_run' && params.arg) {
    const ctx = { scope, replyToken: ev.replyToken };
    const page = parseInt(params.p || '0', 10);
    return replyFocusRun_(ctx, params.arg, isNaN(page) ? 0 : page);
  }

  // 儀式軸：過去課程列表的分頁器（params.q 已被 parser decode）。
  if ((params.action === 'explore_list' || params.action === 'lesson_list')) {
    const p = parseInt(params.p || '0', 10);
    return replyExplorationsList_({ scope, replyToken: ev.replyToken },
      { page: isNaN(p) ? 0 : p, query: params.q || null });
  }
  // 儀式軸：結束卡上「看本節課所有記寫」CTA。
  if ((params.action === 'explore_view' || params.action === 'lesson_view') && params.lid) {
    return replyExplorationView_(ev, scope, params.lid);
  }
  // 儀式軸：lesson-view 卡上的「看原始紀錄」CTA（lesson-scoped，不被同 30 分內 lesson 外
  // 的記錄拉走 startTs 邊界——day-scoped 預設在這條路徑下會找不到段）。
  if ((params.action === 'explore_raw' || params.action === 'lesson_raw') && params.lid && params.s) {
    const p = parseInt(params.p || '0', 10);
    return replyExplorationRaw_(ev, scope, params.lid, parseInt(params.s, 10), isNaN(p) ? 0 : p);
  }

  // /themes 立即整理：force classify + topic + upgrade，再重新渲染 L0。對「剛寫完想立刻看到」用。
  if (params.action === 'themes_refresh') {
    if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 30); } catch (_) {} }
    try { maybeClassifyCategories_(scope); } catch (e) { console.warn('themes_refresh classify failed:', e && e.message); }
    try { maybeAssignTopics_(scope); } catch (e) { console.warn('themes_refresh topic failed:', e && e.message); }
    try { maybeUpgradeContexts_(scope, true); } catch (e) { console.warn('themes_refresh upgrade failed:', e && e.message); }
    return replyThemeCategories_({ scope, replyToken: ev.replyToken });
  }
  // /themes 三層 UI（block 5）：大類總覽 ↔ 主題列表 ↔ 主題詳情。
  if (params.action === 'theme_home') {
    return replyThemeCategories_({ scope, replyToken: ev.replyToken });
  }
  if (params.action === 'theme_cat' && params.cat) {
    const page = parseInt(params.p || '0', 10);
    return replyThemeCategory_({ scope, replyToken: ev.replyToken }, params.cat, isNaN(page) ? 0 : page);
  }
  if (params.action === 'theme_singles' && params.cat) {
    const page = parseInt(params.p || '0', 10);
    return replyThemeCategorySingles_({ scope, replyToken: ev.replyToken }, params.cat, isNaN(page) ? 0 : page);
  }
  if (params.action === 'theme_topic' && params.cid) {
    return replyThemeTopic_({ scope, replyToken: ev.replyToken }, params.cid);
  }
  // 手動「歸到某主題」(must-link)：選主題 → 歸入並重分群。
  if (params.action === 'rec_pick_topic' && params.rid) {
    const page = parseInt(params.p || '0', 10);
    return replyRecordTopicPicker_(ev, scope, params.rid, isNaN(page) ? 0 : page);
  }
  if (params.action === 'rec_link_topic' && params.rid && params.cid) {
    return handleRecordLinkTopic_(ev, scope, params.rid, params.cid);
  }
  // 整段改歸：把一個敘事片段的所有記錄一起歸到某主題。
  if (params.action === 'ep_pick_topic' && params.mode && params.ek) {
    const page = parseInt(params.p || '0', 10);
    return replyEpisodeTopicPicker_(ev, scope, params.mode, params.ek, parseInt(params.s, 10), isNaN(page) ? 0 : page);
  }
  if (params.action === 'ep_link_topic' && params.mode && params.ek && params.cid) {
    return handleEpisodeLinkTopic_(ev, scope, params.mode, params.ek, parseInt(params.s, 10), params.cid);
  }

  if (params.action === 'episodes_day' && params.d) {
    const ctx = { scope, replyToken: ev.replyToken };
    return replyEpisodes_(ctx, params.d);
  }

  if (params.action === 'episodes_month' && params.m) {
    const ctx = { scope, replyToken: ev.replyToken };
    const mp = parseInt(params.p, 10);
    return replyEpisodeMonthDays_(ctx, params.m, isNaN(mp) ? 0 : mp);
  }

  if (params.action === 'episode_raw' && params.d && params.s) {
    const p = parseInt(params.p || '0', 10);
    return replyEpisodeRaw_(ev, scope, params.d, parseInt(params.s, 10), isNaN(p) ? 0 : p);
  }

  if (params.action === 'ctx_episodes' && params.cid) {
    const fromTs = params.from ? parseInt(params.from, 10) : null;
    const toTs   = params.to   ? parseInt(params.to,   10) : null;
    const page   = parseInt(params.p || '0', 10);
    const opts = { page: isNaN(page) ? 0 : page };
    if (fromTs && !isNaN(fromTs)) {
      opts.fromTs = fromTs;
      if (toTs && !isNaN(toTs)) opts.toTs = toTs;
    }
    return replyContextEpisodes_({ scope, replyToken: ev.replyToken }, params.cid, opts);
  }

  if (params.action === 'ctx_raw' && params.cid && params.s) {
    const p = parseInt(params.p || '0', 10);
    return replyContextRaw_(ev, scope, params.cid, parseInt(params.s, 10), isNaN(p) ? 0 : p);
  }

  if (params.action === 'ctx_supplement' && params.cid) {
    return handleContextSupplementEntry_(ev, scope, params.cid);
  }
  // 記寫延續提醒／歸戶確認的「別再提醒」：把這條靜音（其他條照常）。
  if (params.action === 'return_invite_mute' && params.cid) {
    updateChatMeta_(scope, m => { m.returnInviteMuted = m.returnInviteMuted || {}; m.returnInviteMuted[params.cid] = true; return m; });
    return lineReply_(ev.replyToken, '🔕 好，這條不再提醒了（其他條照常）。');
  }
  // A·歸戶確認「是」：把剛寫的歸進這條候選歷程＋下 must-link pin（背景重分群會留著、不被 cosine 拆走）。
  if (params.action === 'attr_confirm' && params.cid && params.rid) {
    const result = attachRecordToCandidate_(scope, params.cid, params.rid);
    updateChatMeta_(scope, m => {
      const p = m.recordPins || {};
      const c = loadContexts_(scope).find(x => x.id === params.cid);
      (c && c.recordIds || []).forEach(rid2 => { p[rid2] = 'm:' + params.cid; });
      m.recordPins = p; return m;
    });
    const name = truncate_((result && result.c && (result.c.userTitle || result.c.label)) || '這條', 16);
    return lineReply_(ev.replyToken, `✓ 已把剛剛這段歸進「${name}」，之後重新整理也會留在這條。`);
  }
  if (params.action === 'attr_no') {
    return lineReply_(ev.replyToken, '好，這段就獨立記著，背景會自己歸戶。');
  }

  // 曖昧輕提示的回應：拆成新一段（threadBreak + 清 topic 重歸）／維持同一段。
  if (params.action === 'thread_split' && params.rid) {
    return handleThreadSplit_(ev, scope, params.rid);
  }
  if (params.action === 'thread_keep') {
    return handleThreadKeep_(ev, scope, params.rid);
  }

  if (params.action === 'ctx_supp_cand' && params.cid) {
    return handleCandidateSupplementEntry_(ev, scope, params.cid);
  }

  if (params.action === 'cand_remind' && params.cid) {
    return handleCandidateRemind_(ev, scope, params.cid);
  }

  // 背景智慧合併通知卡上的「↩️ 取消這次合併」→ 還原成合併前狀態，並擋背景再自動併回同一歷程。
  if (params.action === 'merge_undo' && params.t) {
    return handleMergeUndo_(ev, scope, params.t);
  }

  // 背景主動提醒總開關（回執/轉折卡/新進展/合併/回返提醒全部）。v=0＝重開，其餘＝全關。
  if (params.action === 'proactive_mute') {
    const mute = params.v !== '0';
    updateChatMeta_(scope, m => { m.proactivePushMuted = mute; return m; });
    return lineReply_(ev.replyToken, mute
      ? '🔕 已關閉所有背景主動提醒（回執／轉折卡／新進展／合併／回返提醒）。要重開：輸入 /me 點「重開背景提醒」。'
      : '🔔 背景提醒已重新開啟——之後只在你停筆後、非夜間（22:00–08:00 靜默）時，每輪最多推一張。');
  }

  if (params.action === 'journey_story' && params.cid) {
    return replyJourneyStory_(ev, scope, params.cid, { jid: params.jid || null });
  }
  // 分享回執狀況：列這條歷程的回執名單（建立者入口；卡上 📩 行點進來）。
  if (params.action === 'journey_acks' && params.jid) {
    return replyJourneyAcks_(ev, scope, params.jid);
  }
  // /me 學習狀態卡的「📩 N 筆新回執」徽章 → 跨歷程列新回執（免費 pull）。
  if (params.action === 'ack_inbox') {
    return replyAckInbox_(ev, scope);
  }
  // 歷程現況瀏覽卡的頁面控制列：翻頁＝重繪該頁（不改任何資料）。
  if (params.action === 'story_browse_page' && params.cid) {
    return replyJourneyStory_(ev, scope, params.cid, { page: parseInt(params.p, 10) || 0, jid: params.jid || null });
  }

  // 瀏覽卡「✕」→ 先出確認泡泡（避免誤觸）。轉折關鍵記錄不可移除（脈絡生為歷程的依據）。
  if (params.action === 'story_drop_confirm' && params.cid && params.rid) {
    if (isJourneyKeyRecord_(scope, params.cid, params.rid)) {
      return lineReply_(ev.replyToken, '🔑 這是讓這條升格成學習歷程的關鍵轉折，不能移除。');
    }
    return replyStoryDropConfirm_(ev, scope, params.cid, params.rid);
  }
  if (params.action === 'story_drop_cancel') {
    return lineReply_(ev.replyToken, '已取消移除。');
  }
  // 確認後才真的移出該筆（must-not-link、留時間軸/搜尋）→ 重送輪播（落差分數因
  // context.updatedAt bump 而重算＝正當外力）。dropRecordFromContext_ 在 Report.gs。
  if (params.action === 'story_drop' && params.cid && params.rid) {
    if (isContextFinalized_(scope, params.cid)) {
      return lineReply_(ev.replyToken, '🔒 這條已定案封存、唯讀，無法移除片段。要修改請先到網頁「解除定案」。');
    }
    if (isJourneyKeyRecord_(scope, params.cid, params.rid)) {
      return lineReply_(ev.replyToken, '🔑 這是讓這條升格成學習歷程的關鍵轉折，不能移除。');
    }
    const jb = loadJourneys_(scope).find(j => j.status === 'journey' && j.contextId === params.cid);
    const beforeGap = (jb && jb.gapAnalysis) || null;   // 移除前的分數，給方向訊號比對
    if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 20); } catch (_) {} }
    try { dropRecordFromContext_(scope, params.cid, params.rid); } catch (_) {}   // 內含「即時找新家」LLM
    try { maybeUpgradeContexts_(scope, true); } catch (_) {}                      // 讓新家當下成形
    return replyJourneyStory_(ev, scope, params.cid, { beforeGap: beforeGap, justRemovedRid: params.rid });
  }
  // 放回剛移除的（方向訊號判斷失準時即時反悔）。
  if (params.action === 'story_undrop' && params.cid && params.rid) {
    try { undropRecordFromContext_(scope, params.cid, params.rid); } catch (_) {}
    return replyJourneyStory_(ev, scope, params.cid, { restoredNote: true });
  }

  if (params.action === 'journey_page') {
    const page = parseInt(params.p || '0', 10);
    return handleJourneyPage_(ev, scope, isNaN(page) ? 0 : page);
  }

  if (params.action === 'ctx_split' && params.cid) {
    return handleContextSplit_(ev, scope, params.cid);
  }

  if (params.action === 'link_learn' && params.rid) {
    return handleLinkIntent_(ev, scope, params.rid, 'learn');
  }
  if (params.action === 'link_keep' && params.rid) {
    return handleLinkIntent_(ev, scope, params.rid, 'keep');
  }

  if (params.action === 'ctx_rename' && params.cid) {
    return handleContextRenameEntry_(ev, scope, params.cid);
  }

  if (params.action === 'play' && params.id) {
    return replyAudioPlayback_(ev, scope, params.id);
  }

  if (params.action === 'search_page' && (params.qk || params.q)) {
    const page = parseInt(params.p || '0', 10);
    const threshold = params.min != null ? parseFloat(params.min) : undefined;
    const ctx = { scope, replyToken: ev.replyToken };
    const query = params.qk ? loadCachedQuery_(params.qk) : params.q;
    if (!query) return lineReply_(ev.replyToken, '這次查詢已過期，請重新 /recall。');
    return replySearch_(ctx, query, isNaN(page) ? 0 : page, threshold, { suppressAsk: params.na === '1', recordView: params.rv === '1' });
  }

  if (params.action === 'ask_confirm') {
    return handleAskConfirm_(ev, scope);
  }

  if (params.action === 'ask_exit') {
    return handleAskExit_(ev, scope);
  }

  // Cross-link: answer card → keep the inquiry going (one-shot /ask → ask mode).
  if (params.action === 'ask_more') {
    return enterAskMode_({ scope, replyToken: ev.replyToken });
  }

  if (params.action === 'ask_supplement' && params.k) {
    return handleSupplementEntry_(ev, scope, params.k);
  }

  // /themes cluster button → that 主題群組's 升格進度 (what it needs to become a 脈絡).
  if (params.action === 'journey_cluster' && params.k) {
    return handleJourneyCluster_(ev, scope, params.k);
  }

  // Cross-link: gap card → browse the related records as /recall episodes.
  if (params.action === 'recall_gap' && params.k) {
    let q = '';
    try { q = CacheService.getScriptCache().get('askgap_' + params.k) || ''; } catch (_) {}
    if (!q) return lineReply_(ev.replyToken, '這個提問已過期，請重新 /ask。');
    return replySearch_({ scope, replyToken: ev.replyToken }, q, 0, ASK_CLUE_MIN_SCORE, { suppressAsk: true, recordView: true });
  }

  if (params.action === 'del_record' && params.id) {
    return handleDeleteRecord_(ev, scope, params.id);
  }
  if (params.action === 'del_cancel') {
    return lineReply_(ev.replyToken, '已取消，未刪除。');
  }

  // Cross-link: /recall result → escalate the same query to a grounded /ask.
  if (params.action === 'ask_run' && (params.qk || params.q)) {
    const q = params.qk ? loadCachedQuery_(params.qk) : params.q;
    if (!q) return lineReply_(ev.replyToken, '這次查詢已過期，請重新 /recall。');
    return runAndReplyAsk_({ scope, replyToken: ev.replyToken }, q, false, null);
  }

  if (params.action === 'ask_supp_save') {
    return handleSuppSave_(ev, scope);
  }

  if (params.action === 'access_approve' && params.user) {
    return handleAccessApprove_(ev, scope, params.user, parseFloat(params.budget || '1'));
  }
  if (params.action === 'access_deny' && params.user) {
    return handleAccessDeny_(ev, scope, params.user);
  }
  if (params.action === 'access_revoke_confirm' && params.user) {
    return handleAccessRevokeConfirm_(ev, scope, params.user);
  }
  if (params.action === 'access_revoke' && params.user) {
    return handleAccessRevoke_(ev, scope, params.user);
  }
  if (params.action === 'access_restore' && params.user) {
    return handleAccessRestore_(ev, scope, params.user);
  }
  if (params.action === 'access_cancel') {
    return lineReply_(ev.replyToken, '已取消。');
  }

  if (!params.mode || !params.id) return;

  // Atomic claim: prevents the picker and the auto-sweep from both processing
  // the same file (which produced duplicate transcripts in earlier testing).
  const pending = claimPending_(scope, params.id);
  if (!pending) {
    // Most likely the pending was already auto-swept by a later event before
    // the user tapped this (now stale) picker. Look up the resulting record
    // and confirm with its preview so the user sees what they expected.
    let existing = null;
    try {
      const records = loadEmbeddingRecords_(scope);
      existing = records.find(r => r.id === params.id);
    } catch (_) {}
    if (existing) {
      const preview = truncate_((existing.text || '').replace(/\s+/g, ' '), 80);
      return lineReply_(ev.replyToken,
        `✓ 該${typeLabel_(existing.type)}已自動處理：\n${preview}`,
        null, existing.quoteToken);
    }
    return lineReply_(ev.replyToken,
      '🫩 太多檔案要處理了，先讓我喘口氣～\n稍後 /me 看一下，應該就有結果了。');
  }

  let preview;
  try { preview = processPendingMedia_(scope, pending, params.mode); }
  catch (e) {
    // Release the in-flight claim so a later sweep retries instead of the
    // file being stranded on processing failure.
    try { releasePending_(scope, params.id); } catch (_) {}
    return lineReply_(ev.replyToken, `⚠️ 處理失敗：${(e && e.message) || e}`, null, pending.quoteToken);
  }
  finishPending_(scope, params.id);

  // 轉錄結果卡（① Flex）：縮圖＋完整摘要＋LLM 判的相關記錄（丙）。re-load 拿完整 transcript。
  const rec = (function () { try { return loadEmbeddingRecords_(scope).find(r => r.id === pending.id); } catch (_) { return null; } })();
  if (rec) {
    lineReplyFlex_(ev.replyToken, `✓ ${modeLabel_(params.mode)}・${typeLabel_(pending.type)}`,
      buildMediaResultFlex_(scope, pending, params.mode, rec));
  } else {
    lineReply_(ev.replyToken, `✓ ${modeLabel_(params.mode)}・${typeLabel_(pending.type)}\n${preview}`, null, pending.quoteToken);
  }
}

/**
 * Run Gemini on one pending media item, save transcript / embedding /
 * timeline entry, and return a short 80-char preview (no LINE reply here —
 * caller composes the reply).
 */
function processPendingMedia_(scope, pending, mode) {
  // Idempotency guard: in-flight claims can be re-claimed after a timeout
  // (e.g. the prior doPost died), so a record for this id may already exist.
  // If so, the earlier run succeeded — don't transcribe (and double-charge)
  // again; just return its preview.
  try {
    const done = loadEmbeddingRecords_(scope).find(r => r.id === pending.id);
    if (done) return truncate_((done.text || '').replace(/\s+/g, ' '), 80);
  } catch (_) {}
  if (isArchiveFile_(pending.mimeType, pending.fileName)) {
    throw new Error('壓縮檔暫不支援自動轉譯，請解壓後重新上傳');
  }
  // Typing dots while Gemini runs (1-on-1 only; group/room don't support it).
  // Free — does not count against push quota. Stops automatically when our
  // reply finally lands or after 60 sec elapsed.
  if (scope && scope.type === 'user') {
    try { showLoadingAnimation_(scope.id, 60); } catch (_) {}
  }
  let file;
  try { file = DriveApp.getFileById(pending.fileId); }
  catch (_) { throw new Error('原檔案已不存在或無法存取'); }
  let blob = file.getBlob();
  let mime = pending.mimeType;

  // Gemini can't read Office formats directly; transparently convert
  // pptx/docx/xlsx → PDF via Drive. Original file in raw/ stays put.
  if (isOfficeMime_(mime)) {
    try {
      blob = convertOfficeToPdf_(blob, mime);
      mime = 'application/pdf';
    } catch (e) {
      throw new Error('Office → PDF 轉換失敗：' + (e && e.message || e));
    }
  }

  let prompt, maxTokens;
  if (mode === 'detailed') {
    prompt = buildFullPrompt_(pending.type, pending.fileName);
    maxTokens = 8192;
  } else if (mode === 'summary') {
    prompt = buildSummaryPrompt_(pending.type, pending.fileName);
    maxTokens = 400;
  } else {
    prompt = buildIngestPrompt_(pending.type, pending.fileName);
    maxTokens = 1500;
  }

  const parts = isTextMime_(mime)
    ? [{ text: `${prompt}\n\n--- 檔案內容開始 ---\n${blob.getDataAsString('UTF-8')}\n--- 檔案內容結束 ---` }]
    : [{ text: prompt }, inlineDataPart_(blob, mime)];
  const transcript = geminiGenerate_(parts, {
    systemInstruction: '你是學習歷程紀錄助理。請用繁體中文，可包含簡單 - 條列。不要使用 # 標題或 ** 粗體。直接給出內容，不要說「以下是」「好的」「這是一份」之類的開場白與結語。',
    temperature: 0.3,
    maxOutputTokens: maxTokens
  });

  saveTranscript_(scope, pending.id, transcript, pending.ts);
  const embedding = geminiEmbed_(transcript);
  const record = {
    id: pending.id, ts: pending.ts, userId: pending.userId, type: pending.type,
    fileId: pending.fileId,
    fileName: pending.fileName,
    mimeType: pending.mimeType,
    text: transcript,
    embedding,
    mode,
    quoteToken: pending.quoteToken || null,
    duration: pending.duration || null,
    lineMessageId: pending.lineMessageId || null,
    // 儀式軸：繼承入站當下記下的 explorationId（pending 帶過來）。
    explorationId: pending.explorationId || null,
    // Carry the Drive source id for dedup when imported via DriveImport.gs;
    // null for normal LINE uploads.
    sourceDriveFileId: pending.sourceDriveFileId || null
  };
  appendEmbeddingRecord_(scope, record);
  try { appendToTimeline_(scope, record); }
  catch (e) { console.error('timeline append failed:', e && e.message); }
  // Quote-replies that arrived while this was still pending wrote durable
  // supplement records pointing at pending.id (== this record's id). Now
  // that the record exists, fold them into its aggregated vector. Covers the
  // race where a sweep claimed the pending before the quote-reply could
  // attach — the supplement record persisted regardless.
  try { reconcileSupplements_(scope, pending.id); }
  catch (e) { console.error('reconcile supplements (post-process) failed:', e && e.message); }

  // Mode A — immediate integration: surface up to 2 prior records whose
  // embedding correlates with this one. Appended below the transcript so the
  // user feels "this just-uploaded thing is being woven into their history".
  // Pass type + transcript length so the threshold can adapt — long content
  // (files, long voice memos) tightens to 0.65 to filter out pan-topic noise.
  const integration = buildIntegrationLine_(scope, embedding, pending.id, {
    type: pending.type, textLength: (transcript || '').length
  });
  return truncate_(transcript.replace(/\s+/g, ' '), 80) + integration;
}

/**
 * Build "↳ 連結 MM/DD <snippet>、MM/DD <snippet>" footer line, or '' when
 * no past record exceeds the integration threshold. Self-excluded by id.
 * Threshold is now type-aware (see integrationThreshold_): file / long
 * transcripts use a stricter floor because their broad-topic embeddings
 * pick up too much tangential noise at the default 0.55.
 */
const INTEGRATION_MIN_SCORE = 0.55;   // default; raised for long content
const INTEGRATION_MIN_SCORE_LONG = 0.65;  // file & transcripts > 500 chars
const INTEGRATION_LONG_TEXT_CHARS = 500;
const INTEGRATION_TOP_K = 2;
const INTEGRATION_SNIPPET_CHARS = 14;

function integrationThreshold_(type, textLength) {
  // 長文本／檔的 transcript embedding 是「廣泛主題」的代表向量，會跟很多東西
  // 都拿到中等分；提高門檻避免泛關聯雜訊（譬如 PDF 講教育倫理就硬連到任何
  // 教育主題的舊筆記）。短轉譯（一句話的圖描述、簡短語音）保持原寬鬆值。
  if (type === 'file') return INTEGRATION_MIN_SCORE_LONG;
  if (textLength && textLength > INTEGRATION_LONG_TEXT_CHARS) return INTEGRATION_MIN_SCORE_LONG;
  return INTEGRATION_MIN_SCORE;
}

function buildIntegrationLine_(scope, embedding, excludeId, opts) {
  if (!embedding || !embedding.length) return '';
  const threshold = integrationThreshold_(opts && opts.type, opts && opts.textLength);
  const records = loadEmbeddingRecords_(scope);
  const scored = [];
  for (const r of records) {
    if (!r.embedding || r.id === excludeId) continue;
    const score = cosineSim_(embedding, r.embedding);
    if (score < threshold) continue;
    scored.push({ score, record: r });
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.score - a.score);
  const items = scored.slice(0, INTEGRATION_TOP_K).map(h => {
    const date = Utilities.formatDate(new Date(h.record.ts), TIME_ZONE, 'MM/dd');
    const snippet = truncate_((h.record.text || '').replace(/\s+/g, ' '), INTEGRATION_SNIPPET_CHARS);
    return `${date} ${snippet}`;
  });
  return `\n\n↳ 連結 ${items.join('、')}`;
}

/** 相關記錄（丙）：cosine 只當「候選產生器」，再用一次 LLM 判「真的同一件事/同一主題」
 *  （短中文 cosine 不可靠、會抓泛關聯雜訊 → 不當判準）。回相關記錄陣列（≤3）。 */
function relatedByLlm_(scope, rec) {
  if (!rec || !rec.embedding || !rec.embedding.length) return [];
  const scored = [];
  for (const r of loadEmbeddingRecords_(scope)) {
    if (!r || !r.embedding || r.id === rec.id) continue;
    const s = cosineSim_(rec.embedding, r.embedding);
    if (s >= 0.45) scored.push({ s: s, r: r });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.s - a.s);
  const cands = scored.slice(0, 6);
  const lines = cands.map((c, i) =>
    `${i + 1}. [${Utilities.formatDate(new Date(c.r.ts), TIME_ZONE, 'MM/dd')}] ${truncate_((c.r.text || '').replace(/\s+/g, ' '), 60)}`).join('\n');
  const sys = '你判斷相關性：給一份「新內容」與幾則「既有記錄」，挑出真的在講同一件事／同一主題的（嚴格、寧缺勿濫；只是同領域但不同事的不算）。只輸出 JSON {"related":[編號,...]}，都不相關回 []。';
  const prompt = `【新內容】\n${truncate_((rec.text || '').replace(/\s+/g, ' '), 240)}\n\n【既有記錄】\n${lines}`;
  let picked = null;
  try {
    const out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0, maxOutputTokens: 80 });
    const j = extractJson_(out || '');
    if (j && Array.isArray(j.related)) {
      picked = j.related.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= cands.length);
    }
  } catch (e) { console.warn('relatedByLlm_ failed:', e && e.message); }
  if (picked == null) return cands[0].s >= 0.6 ? [cands[0].r] : [];   // LLM 不可用 → 退最高 cos（且夠高）
  return picked.slice(0, 3).map(n => cands[n - 1].r);
}

/** 上傳轉錄結果卡（①）：縮圖 hero ＋「✓ 摘要・型別」＋ 完整摘要 ＋「🔗 相關記錄」逐列 ＋ 開原檔。 */
function buildMediaResultFlex_(scope, pending, mode, rec) {
  const transcript = (rec.text || '').trim() || '（無內容）';
  const body = [
    { type: 'text', text: `✓ ${modeLabel_(mode)}・${typeLabel_(pending.type)}`, size: 'sm', weight: 'bold', color: THEME.cta },
    { type: 'text', text: truncate_(transcript, 700), size: 'sm', color: THEME.text, wrap: true, margin: 'sm' }
  ];
  const related = relatedByLlm_(scope, rec);
  if (related.length) {
    body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'text', text: '🔗 相關記錄', size: 'xs', weight: 'bold', color: THEME.muted, margin: 'md' });
    related.forEach(r => {
      const icon = EPISODE_TYPE_ICON[r.type] || '·';
      const date = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd');
      const snip = truncate_((r.text || '').replace(/\s+/g, ' '), 40) || `（${typeLabel_(r.type)}）`;
      body.push({ type: 'text', text: `${icon} ${date}　${snip}`, size: 'xs', color: THEME.textBody, wrap: true, maxLines: 2, margin: 'sm' });
    });
  }
  const bubble = { type: 'bubble', size: 'mega', body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body } };
  if (pending.fileId && (pending.type === 'image' || pending.type === 'video' || pending.type === 'file')) {
    const hero = httpsImageUrl_(`https://drive.google.com/thumbnail?id=${pending.fileId}&sz=w1000`, '');
    if (hero) bubble.hero = { type: 'image', url: hero, size: 'full', aspectRatio: '20:13', aspectMode: 'cover',
      action: { type: 'uri', uri: `https://drive.google.com/file/d/${pending.fileId}/view` } };
  }
  if (pending.fileId) {
    bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [
      { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'uri', label: '開啟原檔', uri: `https://drive.google.com/file/d/${pending.fileId}/view` },
        contents: [{ type: 'text', text: '📎 開啟原檔', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }] }
    ] };
  }
  return bubble;
}

function modeLabel_(mode) {
  return { detailed: '詳細', summary: '摘要', auto: '自動' }[mode] || mode;
}

/** 自動處理媒體的結果回報，統一用同一張 Flex 卡（縮圖／摘要／相關記錄／開啟原檔，與前景點選同款）；
 *  載不到記錄才退回純文字。push=true → 走 push（背景、使用者已離開）；false → 走 reply buffer
 *  （搭便車、不耗推播額度）。 */
function replyAutoProcessedMedia_(scope, pending, preview, push) {
  let rec = null;
  try { rec = loadEmbeddingRecords_(scope).find(r => r.id === pending.id); } catch (_) {}
  const target = scope.id || pending.userId;
  if (rec) {
    const alt = `✓ ${modeLabel_('auto')}・${typeLabel_(pending.type)}`;
    const flex = buildMediaResultFlex_(scope, pending, 'auto', rec);
    if (push) { if (target) linePushFlex_(target, alt, flex); }
    else lineReplyFlex_(null, alt, flex);
    return;
  }
  const text = `🤖 自動處理・${typeLabel_(pending.type)}（${pending.fileName || ''}）\n${preview}`;
  if (push) { if (target) linePush_(target, text, pending.quoteToken || null); }
  else lineReply_(null, text, null, pending.quoteToken);
}

/** 〔選項 B〕取出「使用者走開時、背景默默自動處理過的媒體」延遲告知；順手清掉。caller 拿字串
 *  prepend 到下一個 ack（免費 reply）。null＝無事。對應 backgroundSweep 不 push、改記 pendingMediaNotices。 */
function consumePendingMediaNotice_(scope) {
  const meta = loadChatMeta_(scope);
  const list = (meta && meta.pendingMediaNotices) || [];
  if (!list.length) return null;
  updateChatMeta_(scope, m => { delete m.pendingMediaNotices; return m; });
  const comp = {};
  list.forEach(p => { comp[p.type] = (comp[p.type] || 0) + 1; });
  const parts = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${typeLabel_(t)} ${comp[t]}`).join('、');
  return `📋 你離開時，${list.length} 個上傳已自動處理（${parts}）——到 /recall 或主題卡看得到。`;
}

/**
 * Auto-process pendings created strictly before `beforeTimestamp` using
 * mode='auto'. Called at the end of each message / postback event so the
 * user's "next interaction" implicitly clears the backlog.
 *
 * Pendings from the current event are excluded by the strict `<` comparison
 * (newly created pendings share the event timestamp), so uploading media
 * does not trigger immediate sweeping of itself.
 */
const PENDING_AUTO_SWEEP_LIMIT = 3;
const PENDING_AUTO_SWEEP_GRACE_MS = 30 * 1000;  // pickers stay actionable for this long before auto-sweep kicks in

function sweepStalePendings_(scope, beforeTimestamp) {
  if (!scope || !beforeTimestamp) return;
  const cutoff = beforeTimestamp - PENDING_AUTO_SWEEP_GRACE_MS;

  // Pick the oldest stale candidates from a snapshot, then atomically claim
  // each one via claimPending_ (locked get-and-remove). Any other parallel
  // doPost — another sweep, or the user tapping a picker — that races for
  // the same id sees a null claim and skips, so processPendingMedia_ runs
  // at most once per file.
  const stale = listPendings_(scope)
    .filter(p => {
      const t = Date.parse(p.ts);
      return !isNaN(t) && t < cutoff;
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(0, PENDING_AUTO_SWEEP_LIMIT);
  if (!stale.length) return;

  const claimed = [];
  for (const p of stale) {
    const c = claimPending_(scope, p.id);
    if (c) claimed.push(c);
  }
  if (!claimed.length) return;

  for (const pending of claimed) {
    let preview;
    try { preview = processPendingMedia_(scope, pending, 'auto'); }
    catch (e) {
      console.error('sweepStalePendings: process failed', pending.id, e && e.message);
      // Release the claim so a later sweep retries instead of losing the file.
      try { releasePending_(scope, pending.id); } catch (_) {}
      continue;
    }
    finishPending_(scope, pending.id);
    // 結果統一走同一張 Flex 卡（載不到記錄才退純文字）；用 reply buffer 搭便車、不耗推播額度。
    replyAutoProcessedMedia_(scope, pending, preview, false);
  }
}

const BG_WALKAWAY_GRACE_MS = PENDING_AUTO_SWEEP_GRACE_MS;  // 決定窗＝30 秒：picker 出現後 30 秒沒決定就預設「幫我決定」。背景路徑默默處理＋記延遲告知（不 push）；實際觸發仍受 5 分鐘背景掃描節拍下限（見 Setup.gs），但因不 push、使用者無感，下次傳訊息才補一行說明。

/**
 * Background sweep — installed as a 5-minute time-driven trigger by
 * installBackgroundSweep() in Setup.gs. Catches pendings the per-event
 * sweep missed: typically because the user uploaded media and then never
 * sent another message (so no doPost ran sweepStalePendings_), but also
 * any other reason an entry was left behind.
 *
 * Silent: no LINE reply, because there is no inbound event to source a
 * replyToken from. The file still lands in the vector model — that's the
 * contract — and the user sees the new record next time they run /me.
 * Pushing a notification would cost LINE push quota; we don't.
 */
function backgroundSweep() {
  const all = PropertiesService.getScriptProperties().getProperties();
  // Enumerate every known scope from the folder cache — a superset of
  // scopes that have pendings, so the reconcile pass below also reaches
  // scopes whose only outstanding work is an unmaterialized supplement.
  const scopes = {};
  for (const k in all) {
    if (k.indexOf(FOLDER_CACHE_PREFIX) === 0) {
      const s = scopeFromKey_(k.slice(FOLDER_CACHE_PREFIX.length));
      if (s) scopes[s.key] = s;
    } else if (k.indexOf(PENDING_KEY_PREFIX) === 0) {
      const rest = k.slice(PENDING_KEY_PREFIX.length);
      const sep = rest.indexOf('::');
      if (sep < 0) continue;
      const sk = rest.slice(0, sep);
      if (!scopes[sk]) { const s = scopeFromKey_(sk); if (s) scopes[sk] = s; }
    }
  }

  // 〔trigger 根治〕全域時間預算：Apps Script 單次執行上限 6 分鐘，超過會被殺、且連續
  // timeout 會讓 Google **自動停用** time-trigger（這就是 sweep 老是停掉的根因）。所以每輪
  // 跑到 ~4.5 分就主動收手，剩的工作下一輪（5 分後）再做——sweep 永不 timeout，trigger 不
  // 被停。配合開頭 ensureBackgroundSweep_ 自我維持，背景從此自己活著、不需手動重裝。
  ensureBackgroundSweep_();   // sweep 還活著就自我確保 trigger 在（被停則重裝）
  const SWEEP_DEADLINE_MS = 4.5 * 60 * 1000;
  const sweepT0 = Date.now();
  const sweepOutOfTime = () => (Date.now() - sweepT0) > SWEEP_DEADLINE_MS;

  let processed = 0;
  let failed = 0;
  let reconciled = 0;
  for (const scopeKey in scopes) {
    if (sweepOutOfTime()) { console.log('backgroundSweep: 時間預算到，本輪先停，下輪續'); break; }
    const scope = scopes[scopeKey];
    if (!scope) continue;
    // 1) Drain pickers the user left undecided past the 5-min decision window
    //    (also reclaims crashed in-flight entries once their claim goes stale).
    //    Fresher pickers are left alone so the user still has time to choose.
    const walkawayCutoff = Date.now() - BG_WALKAWAY_GRACE_MS;
    const stale = listPendings_(scope)
      .filter(p => { const t = Date.parse(p.ts); return !isNaN(t) && t < walkawayCutoff; })
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .slice(0, PENDING_AUTO_SWEEP_LIMIT);
    for (const p of stale) {
      const claimed = claimPending_(scope, p.id);
      if (!claimed) continue;
      // Attribute Gemini cost back to the original uploader so /me budgets
      // stay accurate even when processing happens outside their session.
      setBillingUser_(claimed.userId || null);
      try {
        processPendingMedia_(scope, claimed, 'auto');
        finishPending_(scope, claimed.id);
        processed++;
        // 〔選項 B〕使用者已走開 → 不 push（省額度）、默默處理；記一筆延遲告知，
        // 下次他傳訊息、有免費 reply 額度時前置一行說明（consumePendingMediaNotice_）。
        try {
          updateChatMeta_(scope, m => {
            const list = m.pendingMediaNotices || [];
            list.push({ type: claimed.type, fileName: claimed.fileName || '', ts: Date.now() });
            m.pendingMediaNotices = list.slice(-20);
            return m;
          });
        } catch (ne) { console.warn('queue media notice failed:', ne && ne.message); }
      } catch (e) {
        console.error('backgroundSweep: process failed', claimed.id, e && e.message);
        try { releasePending_(scope, claimed.id); } catch (_) {}
        failed++;
      } finally {
        setBillingUser_(null);
      }
    }
    // 2) Materialize any supplement linkage the per-event reconcile missed
    //    (Gemini error, race). Idempotent — only re-embeds changed targets.
    //    Guard: skip chats whose Drive folder no longer exists, so an
    //    idempotent reconcile never RESURRECTS a folder the user deleted
    //    (loadEmbeddingRecords_ → chatFolder_ would otherwise recreate it).
    //    chatFolderExists_ also purges the stale folder-cache key, so a
    //    deleted chat drops out of allSweepScopes_ on the next pass.
    if (chatFolderExists_(scope)) {
      // 0) 開發端命令佇列（_cmd.txt → 白名單維運）——先跑，讓觸發後最快這輪生效。
      try { processCommandQueue_(scope); }
      catch (e) { console.error('backgroundSweep: cmd queue failed', scopeKey, e && e.message); }
      // 0.5) lesson 到期前提醒（每節最多一次 push；activeExploration_ 順手做惰性到期）。
      try { maybeWarnExplorationExpiring_(scope); }
      catch (e) { console.error('backgroundSweep: lesson warn failed', scopeKey, e && e.message); }
      try { reconciled += reconcileAllSupplements_(scope); }
      catch (e) { console.error('backgroundSweep: reconcile failed', scopeKey, e && e.message); }
      // 2.5) 大類歸戶（主題群組新模型 block 2）：把「還沒 category」的 record 按敘事片段
      //      成批判大類，存進 record.category（判一次、永不重判）。在脈絡升格之前跑，
      //      讓桶內分群能用到 category。受每日 LLM 上限保護。
      // 以下都是 LLM 重活——每步前檢查時間預算，到了就跳過（下一輪 sweep 再續），避免 timeout。
      if (!sweepOutOfTime()) {
        try { maybeClassifyCategories_(scope); }
        catch (e) { console.error('backgroundSweep: category classify failed', scopeKey, e && e.message); }
      }
      // 2.6) 桶內議題標籤（block 3a）。
      if (!sweepOutOfTime()) {
        try { maybeAssignTopics_(scope); }
        catch (e) { console.error('backgroundSweep: topic assign failed', scopeKey, e && e.message); }
      }
      // 2.65) 〔一次性〕舊貼圖回填情緒層（emoji/emotionFor/reactions）；跑過一次即落旗標、之後 no-op。零 LLM。
      try { backfillStickerEmotions_(scope); }
      catch (e) { console.error('backgroundSweep: sticker backfill failed', scopeKey, e && e.message); }
      // 2.7) 曖昧輕提示：曖昧併入且心流停了 → 推一則輕問（純 CPU、不打 LLM）。
      try { maybeAskThreadHint_(scope); }
      catch (e) { console.error('backgroundSweep: thread hint failed', scopeKey, e && e.message); }
      // 3) 脈絡升格 (層3→4) — throttled inside maybeUpgradeContexts_, so most
      //    sweeps no-op cheaply; only re-clusters when new messages have landed.
      let upgradedOrDetected = false;
      if (!sweepOutOfTime()) {
        try { if (maybeUpgradeContexts_(scope)) upgradedOrDetected = true; }
        catch (e) { console.error('backgroundSweep: context upgrade failed', scopeKey, e && e.message); }
      }
      // 4) 轉折偵測 (層4→5) — only calls the LLM for 脈絡 whose content changed
      //    since the last judgement, and is capped per day.
      if (!sweepOutOfTime()) {
        try { if (maybeDetectJourneys_(scope)) upgradedOrDetected = true; }
        catch (e) { console.error('backgroundSweep: journey detect failed', scopeKey, e && e.message); }
      }
      // 4.5) 後置合併重複歷程：k-means 偶爾把同一條學習線切成多群，各自升格成
      //      重複的歷程；merge 把高度重疊的歷程合成一條、用 must-link pin 守住
      //      下次 k-means 不再拆。
      try { mergeOverlappingJourneys_(scope); }
      catch (e) { console.error('backgroundSweep: journey merge failed', scopeKey, e && e.message); }
      // 4.6) 自動融入：新成形的進行中脈絡若跟某條既有歷程是同一條學習線，吸進那條
      //      歷程而非另開平行卡——實現「一條學習線持續累積」。
      try { absorbCandidatesIntoJourneys_(scope); }
      catch (e) { console.error('backgroundSweep: candidate absorb failed', scopeKey, e && e.message); }
      // 4.65) 背景智慧合併真的併了東西 → 主動推一張卡告知細節＋每筆「↩️ 取消這次合併」一鍵還原。
      try { notifyMergedJourneys_(scope); }
      catch (e) { console.error('backgroundSweep: merge notify failed', scopeKey, e && e.message); }
      // 4.66) 分享回執彙整推（省 push：N 筆回執 → 1 張卡，走合宜守門）。
      try { notifyPendingAcks_(scope); }
      catch (e) { console.error('backgroundSweep: ack notify failed', scopeKey, e && e.message); }
      // 5) Proactively report any newly-成形 脈絡 / 歷程 (1-on-1 push, de-duped).
      if (upgradedOrDetected) {
        try { notifyNewUpgrades_(scope); }
        catch (e) { console.error('backgroundSweep: notify failed', scopeKey, e && e.message); }
      }
      // 6) 記寫回執：最近一段若已 settle、夠量夠集中、且已歸入一條進行中脈絡 → 推一張
      //    「你剛寫的這段被怎麼處理了」卡（1對1、按 episode startTs 去重、保守、只報正面）。
      if (!sweepOutOfTime()) {
        try { maybePushWriteReceipt_(scope); }
        catch (e) { console.error('backgroundSweep: write receipt failed', scopeKey, e && e.message); }
      }
      // 6.5) 記寫延續提醒：回到一條非歷程的線、停筆 settle 後 → 輕推一則，ask 隨階段切（候選脈絡喊
      //      延續、候選歷程軟邀轉折、歷程不吵）。1對1、每脈絡每日一次＋全域節流、可永久關；FRESH
      //      上限只對剛剛的回返推。與回執共用「每段一次」去重（回執先 claim 就不重推）。
      if (!sweepOutOfTime()) {
        try { maybePushContinuityNudge_(scope); }
        catch (e) { console.error('backgroundSweep: continuity nudge failed', scopeKey, e && e.message); }
      }
      // 6.6) 聚焦偵測（停筆後推）：最近一段夠具體聚焦 → 推一則 🎯（零 LLM、停筆後才推、寫當下不出聲）。
      //      與回執/回返邀請共用「每段一次」去重（前兩者在 sweep 中先跑、先 claim 本段）。
      if (!sweepOutOfTime()) {
        try { maybePushFocusSettled_(scope); }
        catch (e) { console.error('backgroundSweep: focus settle failed', scopeKey, e && e.message); }
      }
    }
  }
  // 回返提醒 push（一次性 scan，不分 scope）— 使用者主動排的「之後再提醒回返」
  // （隨機時間、依回返間隔規則排程）到期就推一則通知。
  try { sweepDueReminders_(); }
  catch (e) { console.error('backgroundSweep: reminder sweep failed', e && e.message); }
  // 連結預覽縮圖（共同方法）會轉存 Drive thumb-cache，長期會累積——每天清一次舊檔（全域維運）。
  try { maybeCleanupThumbCache_(); }
  catch (e) { console.error('backgroundSweep: thumb cache cleanup failed', e && e.message); }
  if (processed || failed || reconciled) {
    console.log(`backgroundSweep: processed=${processed} failed=${failed} reconciled=${reconciled}`);
  }
}

/**
 * Reconcile every target that has supplements in this scope. The guarantee
 * layer for aggregatedEmbedding: even if every per-event reconcile failed,
 * this brings all targets up to date within one background cycle. Idempotent
 * (reconcileSupplements_ skips unchanged targets), so it only pays the Gemini
 * re-embed for targets whose supplement set actually changed. Returns the
 * number of targets updated.
 */
function reconcileAllSupplements_(scope) {
  const records = loadEmbeddingRecords_(scope);
  const idByMsgId = {};
  for (const r of records) if (r.lineMessageId) idByMsgId[r.lineMessageId] = r.id;
  const targetIds = {};
  for (const r of records) {
    const t = r.quotedRecordId || (r.quotedLineMessageId && idByMsgId[r.quotedLineMessageId]);
    if (t && t !== r.id) targetIds[t] = true;
  }
  let n = 0;
  for (const tid in targetIds) {
    try { if (reconcileSupplements_(scope, tid)) n++; }
    catch (e) { console.error('reconcileAllSupplements_:', tid, e && e.message); }
  }
  return n;
}

function buildSummaryPrompt_(type, originalName) {
  const noun = { image: '圖片', audio: '語音', video: '影片', file: '檔案' }[type] || '內容';
  const ref = type === 'file' ? `這份「${originalName || '未命名'}」` : `這個${noun}`;
  return `請用一句話（50 字內）說明${ref}的內容，繁體中文純文字，具體不空泛。`;
}

function typeLabel_(t) {
  return { text: '文字', link: '外部連結', image: '圖片', audio: '語音', video: '影片', file: '檔案', sticker: '貼圖', location: '地點' }[t] || t;
}

/**
 * For media records, return a short uppercase extension label like "PDF",
 * "JPG", "M4A" derived from fileName (preferred) or mimeType. Returns ''
 * when nothing useful can be extracted, so the caller can decide whether
 * to render a trailing label.
 */
function extractExtensionLabel_(record) {
  if (record.fileName) {
    const m = record.fileName.match(/\.([A-Za-z0-9]{1,6})$/);
    if (m) return m[1].toUpperCase();
  }
  if (record.mimeType) {
    const map = {
      'application/pdf': 'PDF',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
      'application/vnd.ms-powerpoint': 'PPT',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
      'application/msword': 'DOC',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
      'application/vnd.ms-excel': 'XLS',
      'text/markdown': 'MD',
      'text/plain': 'TXT',
      'text/csv': 'CSV',
      'application/json': 'JSON',
      'image/jpeg': 'JPG',
      'image/png': 'PNG',
      'audio/m4a': 'M4A',
      'audio/mp3': 'MP3',
      'video/mp4': 'MP4'
    };
    if (map[record.mimeType]) return map[record.mimeType];
    const m = record.mimeType.match(/\/([A-Za-z0-9]+)$/);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

function describeBlob_(blob, mime, type, originalName) {
  const prompt = buildIngestPrompt_(type, originalName);
  const parts = isTextMime_(mime)
    ? [{ text: `${prompt}\n\n--- 檔案內容開始 ---\n${blob.getDataAsString('UTF-8')}\n--- 檔案內容結束 ---` }]
    : [{ text: prompt }, inlineDataPart_(blob, mime)];
  return geminiGenerate_(parts, {
    systemInstruction: '你是學習歷程紀錄助理。請用繁體中文，可包含簡單 - 條列。不要使用 # 標題或 ** 粗體。直接給出內容，不要說「以下是」「好的」「這是一份」之類的開場白與結語。',
    temperature: 0.3,
    maxOutputTokens: 1500
  });
}

function resolveMime_(mime, fileName) {
  if (mime && mime !== 'application/octet-stream') return mime;
  const m = (fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return mime || 'application/octet-stream';
  const map = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
    json: 'application/json', html: 'text/html', xml: 'application/xml',
    py: 'text/x-python', js: 'text/javascript', ts: 'text/javascript',
    rtf: 'text/rtf', log: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel'
  };
  return map[m[1]] || mime || 'application/octet-stream';
}

function isTextMime_(mime) {
  return /^text\//.test(mime) || mime === 'application/json' || mime === 'application/xml';
}

const OFFICE_TO_GOOGLE_MIME = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
  'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
  'application/msword': 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.ms-excel': 'application/vnd.google-apps.spreadsheet'
};

function isOfficeMime_(mime) {
  return !!OFFICE_TO_GOOGLE_MIME[mime];
}

/**
 * Convert an Office blob (pptx/docx/xlsx/...) to a PDF blob by uploading
 * to Drive with conversion to the matching Google native format, exporting
 * as PDF, then deleting the temp file. Gemini accepts PDF directly.
 *
 * Requires the OAuth scope https://www.googleapis.com/auth/drive (already
 * declared in appsscript.json) and ScriptApp.getOAuthToken().
 */
function convertOfficeToPdf_(blob, sourceMime) {
  const googleMime = OFFICE_TO_GOOGLE_MIME[sourceMime];
  if (!googleMime) throw new Error('Unsupported Office MIME: ' + sourceMime);

  const token = ScriptApp.getOAuthToken();
  const boundary = '----tmp_' + Utilities.getUuid().slice(0, 12);
  const head =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: 'office-to-pdf-tmp', mimeType: googleMime }) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + sourceMime + '\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  const payload = [].concat(
    Utilities.newBlob(head).getBytes(),
    blob.getBytes(),
    Utilities.newBlob(tail).getBytes()
  );

  const uploadRes = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'post',
      contentType: 'multipart/related; boundary=' + boundary,
      headers: { Authorization: 'Bearer ' + token },
      payload: payload,
      muteHttpExceptions: true
    }
  );
  if (uploadRes.getResponseCode() >= 300) {
    throw new Error('Drive convert upload ' + uploadRes.getResponseCode() + ': ' + uploadRes.getContentText().slice(0, 400));
  }
  const tempId = JSON.parse(uploadRes.getContentText()).id;

  try {
    const exportRes = UrlFetchApp.fetch(
      `https://www.googleapis.com/drive/v3/files/${tempId}/export?mimeType=${encodeURIComponent('application/pdf')}`,
      {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      }
    );
    if (exportRes.getResponseCode() >= 300) {
      throw new Error('Drive export ' + exportRes.getResponseCode() + ': ' + exportRes.getContentText().slice(0, 400));
    }
    return exportRes.getBlob().setContentType('application/pdf');
  } finally {
    try {
      UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${tempId}`, {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
    } catch (_) { /* best-effort cleanup */ }
  }
}

function buildIngestPrompt_(type, originalName) {
  const quality = [
    '品質要求：',
    '- 具體：寫出實際的概念 / 名詞 / 數字 / 結論，不要「介紹了一些...」「討論了 XX」這種空話。',
    '- 清楚：每一點獨立成立，不必看原圖也能懂。',
    '- 有代表性：抓會被記住的關鍵點，不要列雞毛蒜皮。'
  ].join('\n');

  switch (type) {
    case 'image':
      return [
        '請描述這張圖片，繁體中文純文字，**總字數上限 200 字**：',
        '',
        '1. 若是學習材料（筆記 / 白板 / 投影片 / 課本 / 圖表 / 程式碼 / 文件）：',
        '   - 摘要：一句話主題（30 字內）',
        '   - 重點：條列 2-4 點，每點 ≤ 40 字',
        '2. 若不是學習材料（風景 / 人物 / 食物 / 商品 / 隨手照）：',
        '   一句話描述（30 字內），不要硬擠重點。',
        '',
        quality
      ].join('\n');

    case 'audio':
      return [
        '請整理這段語音，繁體中文，**總字數上限 250 字**：',
        '',
        '1. 若是學習相關（講座 / 課程 / 筆記口述 / 反思 / 提問）：',
        '   - 主題：一句話',
        '   - 重點：條列 2-4 點，每點 ≤ 40 字',
        '   不需要完整逐字稿。',
        '2. 若是日常對話 / 短訊：',
        '   一句話描述內容（30 字內）。',
        '',
        quality
      ].join('\n');

    case 'video':
      return [
        '請整理這段影片，繁體中文，**總字數上限 250 字**：',
        '',
        '1. 若是學習相關（教學 / 演講 / 操作示範 / 簡報）：',
        '   - 主題：一句話',
        '   - 重點：條列 2-4 點，每點 ≤ 40 字',
        '   不需要完整逐字稿。',
        '2. 若是生活片段 / 隨拍：',
        '   一句話描述（30 字內）。',
        '',
        quality
      ].join('\n');

    case 'file':
      return [
        `請摘要這份檔案「${originalName || '未命名'}」，繁體中文，**總字數上限 300 字**：`,
        '',
        '1. 若是學習相關（論文 / 教材 / 筆記 / 教學文章 / 報告）：',
        '   - 主題：一句話（30 字內）',
        '   - 核心要點：條列 3-5 點，每點 ≤ 50 字',
        '   - 關鍵詞 / 專有名詞：最多 5 個（逗號分隔）',
        '2. 若不是學習相關（雜記 / 表單 / 待辦 / 一般文件）：',
        '   一段話（80 字內）概述。',
        '',
        quality
      ].join('\n');

    default:
      return '請描述這段內容並列出重點，總字數上限 200 字，具體清楚且有代表性。';
  }
}

function newId_() {
  return Utilities.getUuid().slice(0, 8);
}

/**
 * Pluck a Google / Apple Maps share URL out of free text. Sharing a place
 * from Google Maps to LINE pastes as a plain text message like
 * "台中市政府\nhttps://maps.app.goo.gl/abc123" — no structured location
 * payload, so handleText_ ingests it as a normal note. Detecting the URL
 * lets us still surface a "open map" button without forcibly converting
 * the record type. Returns the first match or null.
 */
function extractMapsUrl_(text) {
  if (!text) return null;
  const re = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|www\.google\.com\/maps|maps\.apple\.com)\/\S+/i;
  const m = text.match(re);
  return m ? m[0] : null;
}

/**
 * URL preview: 抓訊息裡第一條 http(s) URL 的 og:title / og:description / title。
 *  - 跳過 Drive / Maps（各自有專屬 ingest 路徑，這裡不重複抓）
 *  - 24h ScriptCache 去重：同 URL 第二次貼來不重抓
 *  - 失敗（超時／404／無 meta）回 null，安靜地什麼都不做
 *  - 最多讀 50KB HTML，避免大頁面拖慢 ingest
 */
// 「裸連結貼上」：使用者只丟連結、幾乎沒寫自己的話。用「原始輸入」判（入庫後 record.text
// 會被增豐覆寫，故不能用它）。門檻沿用 COLLECTION_MIN_NOTE_CHARS（定義在 ContextUpgrade.gs）。
function isBareLinkPaste_(rawText) {
  const text = String(rawText || '');
  if (!/https?:\/\/\S+/.test(text)) return false;
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, '').length < COLLECTION_MIN_NOTE_CHARS;
}

// 裸連結入庫時的「學習素材 / 收藏」選擇泡泡（增量 4）。預覽（標題/說明/縮圖）來自增豐；
// 抓不到也照樣給按鈕（只顯示 URL）。兩顆按鈕用 postback 帶 record id 回 handleLinkIntent_。
function buildLinkChoiceBubble_(record, preview) {
  const title = (preview && preview.title) || truncate_((record.text || '').split('\n')[0] || '連結', 50);
  const desc = preview && preview.description ? truncate_(preview.description, 110) : '';
  const body = [
    { type: 'text', text: '🔗 這個連結要怎麼收？', size: 'sm', weight: 'bold', color: '#666666' },
    { type: 'text', text: truncate_(title, 60), size: 'md', weight: 'bold', wrap: true, margin: 'md' }
  ];
  if (desc) body.push({ type: 'text', text: desc, size: 'xs', color: '#999999', wrap: true, margin: 'sm' });
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: body },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', height: 'sm',
          action: { type: 'postback', label: '🔖 學習素材', data: `action=link_learn&rid=${record.id}`, displayText: '▸ 標記為學習素材' } },
        { type: 'button', style: 'secondary', height: 'sm',
          action: { type: 'postback', label: '🔖 收藏（日後看）', data: `action=link_keep&rid=${record.id}`, displayText: '▸ 收藏（日後看）' } },
        { type: 'text', text: '不選 = 預設收藏，不進學習歷程', size: 'xxs', color: '#aaaaaa', align: 'center', margin: 'sm' }
      ]
    }
  };
  if (preview && preview.thumbnail) {
    bubble.hero = { type: 'image', url: preview.thumbnail, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  }
  return bubble;
}

/** 連結預覽卡（保留縮圖）：hero 縮圖（可點開）＋標題＋說明＋「已併入語意」註＋「🔗 開啟連結」。
 *  取代舊的「學習素材/收藏」選擇泡泡——網址一律是學習素材，只呈現預覽、不再問。 */
function buildLinkPreviewBubble_(preview, headNote) {
  const title = (preview && preview.title) || (preview && preview.url) || '連結';
  const desc = preview && preview.description ? truncate_(preview.description, 110) : '';
  const body = [];
  if (headNote) body.push({ type: 'text', text: headNote, size: 'xxs', color: '#aaaaaa', wrap: true });
  body.push({ type: 'text', text: '🔗 已記下這個連結', size: 'xs', color: '#999999' });
  body.push({ type: 'text', text: truncate_(title, 60), size: 'md', weight: 'bold', wrap: true, margin: 'sm' });
  if (desc) body.push({ type: 'text', text: desc, size: 'xs', color: '#999999', wrap: true, margin: 'sm' });
  body.push({ type: 'text', text: '標題與說明已併入語意，之後 /recall、/ask 都找得到', size: 'xxs', color: '#aaaaaa', wrap: true, margin: 'md' });
  const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: body } };
  const heroUrl = preview ? httpsImageUrl_(preview.thumbnail, preview.url) : '';
  const pUri = preview ? safeActionUri_(preview.url) : null;
  if (heroUrl) {
    bubble.hero = { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
    if (pUri) bubble.hero.action = { type: 'uri', uri: pUri };
  }
  if (pUri) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '🔗 開啟連結', uri: pUri } }
    ] };
  }
  return bubble;
}

// 泡泡按鈕回呼：記錄使用者對該連結的意圖（meta.linkIntent[id]）。選「學習素材」會清掉
// lastContextUpgradeAt，讓下次背景 sweep 重新分群把它納入；選「收藏」維持排除。
function handleLinkIntent_(ev, scope, rid, intent) {
  updateChatMeta_(scope, m => {
    m.linkIntent = m.linkIntent || {};
    m.linkIntent[rid] = intent;
    if (intent === 'learn') m.lastContextUpgradeAt = null;
    return m;
  });
  lineReply_(ev.replyToken, intent === 'learn'
    ? '🔖 已設為學習素材——下次整理脈絡會把它納入，之後 /themes、/journey 看得到。'
    : '🔖 已收藏。不進學習歷程，但 /recall、/ask 仍找得到；日後想學它，針對它寫幾句心得就會自動納入。');
}

/** 把縮圖網址正規化成 LINE Flex hero 可用的 https 絕對網址：相對路徑對 baseUrl 的 origin 補齊、
 *  http→https、//host→https://host；補不出 https 就回 ''（呼叫端據此不放 hero，避免 LINE 400
 *  「invalid uri scheme /hero/url」）。 */
function httpsImageUrl_(raw, baseUrl) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return 'https:' + raw;
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:');
  const m = String(baseUrl || '').match(/^https?:\/\/[^/]+/i);
  if (!m) return '';                                   // 相對路徑但沒 base → 放棄
  const origin = m[0].replace(/^http:/i, 'https:');
  return raw.charAt(0) === '/' ? origin + raw : origin + '/' + raw.replace(/^\.?\//, '');
}

/** 從 FB 牆頁/4xx body 抽真正貼文網址（…/posts/… / permalink / story.php / canonical / og:url）。 */
function extractFbCanonical_(html, srcUrl) {
  if (!html) return '';
  const dec = s => decodeHtmlEntities_(String(s || '')).trim();
  const m = html.match(/https:\/\/(?:www\.|web\.|m\.)?facebook\.com\/[^"'\\\s<>]+\/posts\/[^"'\\\s<>]+/i)
         || html.match(/https:\/\/(?:www\.|web\.|m\.)?facebook\.com\/permalink\.php\?[^"'\\\s<>]*story_fbid=[^"'\\\s<>]+/i)
         || html.match(/https:\/\/(?:www\.|web\.|m\.)?facebook\.com\/story\.php\?[^"'\\\s<>]*story_fbid=[^"'\\\s<>]+/i);
  if (m) return dec(m[0]);
  const c = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1]
         || (html.match(/property=["']og:url["'][^>]*content=["']([^"']+)["']/i) || [])[1];
  if (c) { const u = dec(c); if (/facebook\.com/i.test(u) && !/\/(share|login)\b/i.test(u) && u !== srcUrl) return u; }
  return '';
}

/** 最後努力：從 FB 牆頁/4xx 抽 canonical 後遞迴抓一次（深度保護：alreadyResolved）。 */
function tryFbCanonicalRefetch_(html, url, alreadyResolved) {
  if (alreadyResolved || !/facebook\.com/i.test(url)) return null;
  const canon = extractFbCanonical_(html, url);
  if (canon && canon !== url) { try { return fetchFirstUrlPreview_(canon, true); } catch (_) {} }
  return null;
}

function fetchFirstUrlPreview_(text, _fbResolved) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  let url = m[0].replace(/[.,;:!?）)】」]+$/, '');             // 去結尾標點
  // 去掉行動端分享的追蹤參數：手機版 FB「複製連結」會帶 ?mibextid=... / fbclid 等，
  // 帶著它去抓會被導到 consent/redirect 版本——只回 og:title+og:description、**丟掉
  // og:image**（這就是「手機貼有文字無圖、電腦貼有圖」的真因）。先洗成乾淨 URL 再抓。
  url = url.replace(/([?&])(mibextid|fbclid|igsh|igshid|utm_[a-z]+)=[^&]*/gi, '$1')
           .replace(/[?&]+$/, '').replace(/([?&])&+/g, '$1');
  // FB 手機/分享連結 → 桌面公開貼文網址（爬蟲才抓得到 og 圖文；自動化使用者「先用瀏覽器開、
  // 再貼回」的解法）：m./web./mbasic → www；story.php?story_fbid=X&id=Y → www…/Y/posts/X。
  // （share/p/<opaque> 是不透明轉址 id，無法靜態組成，仍會落到登入牆。）
  url = url.replace(/^(https?:\/\/)(?:m|web|mbasic)\.facebook\.com/i, '$1www.facebook.com');
  if (/^https?:\/\/www\.facebook\.com\/story\.php\?/i.test(url)) {
    const sf = (url.match(/[?&]story_fbid=([^&]+)/i) || [])[1];
    const fid = (url.match(/[?&]id=([^&]+)/i) || [])[1];
    if (sf && fid) url = `https://www.facebook.com/${fid}/posts/${sf}`;
  }
  // 跳過已有專屬路徑的網址
  if (/drive\.google\.com|docs\.google\.com/i.test(url)) return null;
  if (/maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|maps\.apple\.com/i.test(url)) return null;

  // YouTube fast path: HTML 抓常被反爬／consent wall 卡住，用 oEmbed API 穩定取 title。
  if (/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) {
    return fetchYoutubeOembed_(url);
  }

  // TikTok fast path：抖音/TikTok 短鏈（vt./vm.）會轉址、頁面又反爬，一般 og 抓取多半空手
  // （就是「抖音的網址不能直接讀取」的真因）。比照 YouTube 改用官方 oEmbed：先把短鏈解轉址成
  // www.tiktok.com/@user/video/<id> 正規網址，再打 oEmbed 拿字幕（=語意內容）／作者／縮圖。
  if (/^https?:\/\/(?:www\.|m\.|vt\.|vm\.)?tiktok\.com\//i.test(url)) {
    return fetchTiktokOembed_(url);
  }

  // MSN news：SPA 的 og:title 常只回 "MSN"，但 URL slug 解碼後就是標題。**不再早退**（早退會
  // 漏掉真正的 og:description + og:image、縮圖就消失了）——照常抓頁拿完整 og，只在 og:title
  // 沒用（空或 "MSN"）時，改用下面這個 slug 標題覆蓋。
  // 例 …/news/living/%E5%BD%B1%E9%9F%B3-…/ar-AA24eNhQ → slug decode → 「影音-…」
  let msnSlugTitle = '';
  if (/msn\.com\/[a-z-]+\/[a-z]+\/[a-z-]+\//i.test(url)) {
    const mm = url.match(/\/[a-z]+\/[a-z-]+\/([^/]+)\/ar-/i);
    if (mm) { try { msnSlugTitle = decodeURIComponent(mm[1]).replace(/[-_]+/g, ' ').trim().slice(0, 200); } catch (_) {} }
  }

  const cache = CacheService.getScriptCache();
  // 版本前綴：升版號讓含舊壞預覽（無縮圖/null/登入牆日文等）的舊快取一次失效，不必等 24h 過期。
  // v3：登入牆偵測 + Accept-Language。v4：IG/FB 社群圖改走 Drive re-host。v5：Cloudflare 挑戰頁
  // 偵測（Dcard）。v6：縮圖多來源 extractOgImage_ + 掃 200KB。v7：MSN og:image 缺席→用文章 id 組圖。
  const cacheKey = 'urlpv7_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, url));
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      // facebookexternalhit 是社群預覽爬蟲，多數站會對它回完整 OG meta（比一般
      // Mozilla UA 容易取得 og:title／og:description）。Accept-Language 指定中文，
      // 避免登入牆等通用頁回成日文/他國語系（Google 伺服器抓、預設語系不可控）。
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
      }
    });
  } catch (e) {
    console.warn('urlPreview fetch failed:', url, e && e.message);
    return metadataApiFallback_(url, cacheKey, cache);       // 抓取失敗（站方擋 server）→ 通用 metadata 後備
  }
  if (res.getResponseCode() >= 400) {
    // 最後努力：FB share/p 常回 4xx，但 body 偶夾 canonical/og:url 指向真貼文 → 抽出再抓一次。
    const r4 = tryFbCanonicalRefetch_((function () { try { return res.getContentText() || ''; } catch (_) { return ''; } })(), url, _fbResolved);
    if (r4) return r4;
    return metadataApiFallback_(url, cacheKey, cache);       // 4xx（如 Dcard Cloudflare 擋機房 IP）→ 通用 metadata 後備
  }
  // 掃前 200KB（原 50KB）：MSN 等大型 SPA 的 <head> 很長，og:image 常在 50KB 之後。
  const html = (res.getContentText() || '').substring(0, 200000);
  let title = matchMetaContent_(html, ['og:title', 'twitter:title']) || matchTagText_(html, 'title');
  if (msnSlugTitle && (!title || /^msn$/i.test(String(title).trim()))) title = msnSlugTitle;  // MSN og:title 沒用→用 slug
  const description = matchMetaContent_(html, ['og:description', 'twitter:description', 'description']);
  const image = extractOgImage_(html);
  // 垃圾頁偵測：登入牆（FB/IG「請登入才能看」）或機器人挑戰頁（Cloudflare「Attention
  // Required」/「Just a moment」等，Dcard 就是這種）。把那段當內容/語意是垃圾，會污染向量
  // 又顯示假預覽 → 視為抓不到，退回「外部連結」乾淨處理。
  if (isJunkPreviewText_(title) || isJunkPreviewText_(description)) {
    // 最後努力：登入牆頁有時夾著真正貼文的 canonical/og:url/…/posts/… → 抽出來再抓一次。
    const rWall = tryFbCanonicalRefetch_(html, url, _fbResolved);
    if (rWall) return rWall;
    return metadataApiFallback_(url, cacheKey, cache);       // 登入牆/挑戰頁 → 試通用 metadata 後備
  }
  // title/description/image 任一抓到就算成功——FB/IG 常只回 og:image（無標題/說明），
  // 舊版 `!title && !description` 會把這種只有縮圖的預覽整個丟掉。
  if (!title && !description && !image) {
    return metadataApiFallback_(url, cacheKey, cache);       // 自家抓不到任何內容 → 通用 metadata 後備
  }
  const preview = {
    url,
    title: decodeHtmlEntities_(title || '').slice(0, 200),
    description: decodeHtmlEntities_(description || '').slice(0, 400),
    thumbnail: previewThumbnail_(image)
  };
  cache.put(cacheKey, JSON.stringify(preview), 86400);      // 24h
  return preview;
}

/** 預覽文字是不是「垃圾頁」：登入牆（FB/IG 未登入）或機器人挑戰頁（Cloudflare「Attention
 *  Required」/「Just a moment」/「請完成驗證」等）。這種頁的 title/description 不是真內容，
 *  拿來顯示或餵 embedding 都是污染 → 一律當成抓不到。我們自家抓取與 microlink 後備共用。 */
function isJunkPreviewText_(s) {
  s = String(s || '');
  return /(ログインまたは登録|ログインして|アカウントに登録|log ?in or sign ?up|log ?in to (see|view|continue)|sign ?up to (see|view)|see posts,? ?photos|登入或註冊|請先?登入|登录或注册|登录后查看|you must log ?in|content isn'?t available|attention required|just a moment|checking (your|if the site)|verify (you are|you'?re) (a )?human|enable javascript and cookies|請稍候|請完成驗證|安全性驗證|安全性檢查|cloudflare)/i.test(s);
}

/** B 層通用後備：我們自己抓不到預覽時（站方擋機房 IP/非瀏覽器抓取，如 Dcard 的 Cloudflare、
 *  FB 登入牆）統一打通用 metadata 服務當總後備，拿到就快取＋回、仍失敗快取 null＋回 null
 *  （乾淨退「外部連結」）。共用 fetchFirstUrlPreview_ 的快取鍵，所以只在第一次抓失敗時打一次。 */
function metadataApiFallback_(url, cacheKey, cache) {
  const p = fetchPreviewViaMetadataApi_(url);
  cache.put(cacheKey, p ? JSON.stringify(p) : 'null', p ? 86400 : 3600);
  return p;
}

/** 通用 metadata 服務（microlink）：從它們的機器抓頁、能繞過多數站對 server 端的封鎖，回
 *  標題/說明/圖。免費端點 api.microlink.io 以 IP 計額度（GAS 走 Google 共用 IP，可能被別人用掉）；
 *  設了 Script Property `MICROLINK_API_KEY` 就改走 pro.microlink.io（每把 key 自己的額度，較穩）。
 *  圖一律過 previewThumbnail_（Drive re-host），抓不到圖仍保留標題/說明（對 Dcard 而言文字才是
 *  語意主力）。 */
function fetchPreviewViaMetadataApi_(url) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('MICROLINK_API_KEY') || '';
    const endpoint = key ? 'https://pro.microlink.io' : 'https://api.microlink.io';
    const opts = { muteHttpExceptions: true, validateHttpsCertificates: false, headers: { 'Accept': 'application/json' } };
    if (key) opts.headers['x-api-key'] = key;
    const res = UrlFetchApp.fetch(endpoint + '/?url=' + encodeURIComponent(url), opts);
    if (res.getResponseCode() !== 200) { console.warn('microlink code', res.getResponseCode(), 'for', url.slice(0, 80)); return null; }
    const data = JSON.parse(res.getContentText() || '{}');
    if (!data || data.status !== 'success' || !data.data) return null;
    const d = data.data;
    const title = decodeHtmlEntities_(String(d.title || '')).slice(0, 200);
    const description = decodeHtmlEntities_(String(d.description || '')).slice(0, 400);
    const imageUrl = (d.image && d.image.url) || (d.logo && d.logo.url) || '';
    if (!title && !description && !imageUrl) return null;
    // microlink 也可能撞上 Cloudflare 挑戰頁（Dcard 實測就回「Attention Required! | Cloudflare」）
    // → 那不是真內容，丟掉、乾淨退「外部連結」，別顯示假預覽也別污染向量。
    if (isJunkPreviewText_(title) || isJunkPreviewText_(description)) return null;
    return { url, title, description, thumbnail: imageUrl ? previewThumbnail_(imageUrl) : '' };
  } catch (e) {
    console.warn('metadata API fallback failed:', e && e.message);
    return null;
  }
}

/** 連結預覽縮圖的**共同方法**（取代逐站判斷／逐站測試）：所有 og:image 一律經
 *  `rehostImageToDrive_`。理由：`drive.google.com/thumbnail` 會把任何來源圖正規化成 LINE Flex
 *  一定載得出的 JPEG（轉 WebP、限尺寸、走 Google CDN），而 GAS 用 crawler UA 又能抓到多數站
 *  的 og:image（凡是社群預覽顯示得出來的站＝爬蟲抓得到）。故 IG/FB/抖音/新聞/部落格…都同一條路，
 *  不必再為每個平台個別加 host 或實測。re-host 失敗（如登入牆站根本沒 og:image）回 ''、不放破圖。 */
function previewThumbnail_(image) {
  image = image ? decodeHtmlEntities_(image) : '';
  if (!image) return '';
  return rehostImageToDrive_(image) || '';
}

function fetchYoutubeOembed_(url) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ytpv_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, url));
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (_) {} }

  let preview = null;
  try {
    const res = UrlFetchApp.fetch(
      'https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json',
      { muteHttpExceptions: true, validateHttpsCertificates: false });
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      preview = {
        url,
        title: (data.title || '').slice(0, 200),
        description: data.author_name ? `頻道：${data.author_name}` : '',
        thumbnail: data.thumbnail_url || ''
      };
    }
  } catch (e) {
    console.warn('YT oEmbed failed:', e && e.message);
  }
  // 深化（增量2）：oEmbed 只給標題＋頻道，標題常是標題黨、抓不到影片在講什麼。再
  // best-effort 抓 watch 頁的 og:description（影片描述摘要）——YT 對 crawler UA 多半
  // 回完整 og meta。成功就用描述當 description（頻道併入），失敗維持 oEmbed 結果。
  try {
    const r2 = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: false,
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
    });
    if (r2.getResponseCode() < 400) {
      const html = (r2.getContentText() || '').substring(0, 80000);
      const ogDesc = decodeHtmlEntities_(matchMetaContent_(html, ['og:description', 'description']) || '').slice(0, 400);
      const ogTitle = decodeHtmlEntities_(matchMetaContent_(html, ['og:title', 'twitter:title']) || '').slice(0, 200);
      if (ogDesc) {
        const chan = preview && preview.description && preview.description.indexOf('頻道') === 0 ? preview.description : '';
        if (!preview) preview = { url, title: ogTitle, description: '' };
        if (!preview.title && ogTitle) preview.title = ogTitle;
        preview.description = chan ? `${ogDesc}（${chan}）` : ogDesc;
      }
    }
  } catch (e) {
    console.warn('YT og:description fetch failed:', e && e.message);
  }
  cache.put(cacheKey, preview ? JSON.stringify(preview) : 'null', preview ? 86400 : 3600);
  return preview;
}

/** 跟著 301/302 轉址（只看 header、不抓 body）最多 maxHops 跳，回最終網址。
 *  GAS 用 followRedirects:false 才讀得到 Location——這是把短鏈（vt.tiktok.com/…、
 *  fb 分享鏈…）還原成真正目的網址的關鍵步驟（「FB 做法」同源：先正規化成可抓的網址）。 */
function resolveRedirects_(url, maxHops) {
  let cur = url;
  for (let i = 0; i < (maxHops || 4); i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(cur, {
        method: 'get', muteHttpExceptions: true, followRedirects: false,
        validateHttpsCertificates: false,
        headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
      });
    } catch (_) { return cur; }
    const code = res.getResponseCode();
    if (code < 300 || code >= 400) return cur;              // 已非轉址 → 這就是最終網址
    const h = res.getHeaders() || {};
    const loc = h.Location || h.location || '';
    if (!loc) return cur;
    cur = /^https?:\/\//i.test(loc) ? loc : (httpsImageUrl_(loc, cur) || loc);  // 相對轉址補絕對
  }
  return cur;
}

/** Drive 縮圖快取資料夾（root 底下 thumb-cache，沒有就建）。 */
function thumbCacheFolder_() {
  const root = rootFolder_();
  const it = root.getFoldersByName('thumb-cache');
  return it.hasNext() ? it.next() : root.createFolder('thumb-cache');
}

/** Drive 公開檔的縮圖直圖網址：保證回 JPEG（Drive 會替任何圖產 JPEG 縮圖，連 WebP 也轉）、
 *  可限寬、走 Google CDN——正是 LINE Flex hero 載得出的形式。 */
function driveThumbUrl_(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w800';
}

/** 每天最多清一次 Drive thumb-cache：把超過 14 天沒更新的縮圖檔丟垃圾桶。縮圖只是 LINE 卡片
 *  hero 的快取（過期重抓即可，`rehostImageToDrive_` 會重建），且是 bot 自己建的、可安全清。
 *  CacheService 的 url→fileId 對應只留 6h，遠短於 14 天，故清掉不會撞到還在用的快取。 */
function maybeCleanupThumbCache_() {
  const DAY = 24 * 60 * 60 * 1000;
  const props = PropertiesService.getScriptProperties();
  if (Date.now() - Number(props.getProperty('lastThumbCacheCleanupAt') || 0) < DAY) return;  // 一天一次
  props.setProperty('lastThumbCacheCleanupAt', String(Date.now()));
  let folder;
  try { folder = thumbCacheFolder_(); } catch (_) { return; }
  const cutoff = Date.now() - 14 * DAY;
  const files = folder.getFiles();
  let trashed = 0;
  while (files.hasNext()) {
    const f = files.next();
    try { if (f.getLastUpdated().getTime() < cutoff) { f.setTrashed(true); trashed++; } } catch (_) {}
  }
  if (trashed) console.log('thumb-cache cleanup: trashed', trashed, 'old thumbnails');
}

/** 把外部圖片「下載→轉存 Drive→回 Drive 縮圖直圖」當 LINE Flex hero。為何要這麼重：TikTok 的
 *  og:image 是簽名 CDN 圖，CDN 只服務「認得的 crawler UA」（facebookexternalhit），第三方代理
 *  （weserv 等）抓會 403→LINE 載不出（這就是先前縮圖一直空白的真因）。GAS 用同一個 crawler UA
 *  抓得到（LINE 原生預覽能顯示＝證明 crawler 抓得到），抓下來存進 Drive、設公開，再用
 *  drive.google.com/thumbnail 當縮圖。以 og:image url 為 key 快取 fileId 復用，避免每次重抓重存。
 *  任何一步失敗回 ''（呼叫端據此不放 hero，至少不顯示破圖）。 */
function rehostImageToDrive_(imageUrl) {
  imageUrl = String(imageUrl || '').trim();
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return '';
  const cache = CacheService.getScriptCache();
  const key = 'ttimg_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, imageUrl));
  const hit = cache.get(key);
  if (hit) return hit === 'null' ? '' : driveThumbUrl_(hit);
  let fileId = '';
  try {
    const res = UrlFetchApp.fetch(imageUrl, {
      muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: false,
      // 用認得的 crawler UA；Accept 不宣告 webp，讓 CDN 盡量直接回 JPEG。
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'image/jpeg,image/png,image/*;q=0.8'
      }
    });
    const code = res.getResponseCode();
    const h = res.getHeaders() || {};
    const ct = String(h['Content-Type'] || h['content-type'] || '').toLowerCase();
    console.log('rehostImageToDrive_ fetch code=%s ct=%s for %s', code, ct, imageUrl.slice(0, 80));
    if (code >= 400 || ct.indexOf('image') < 0) { cache.put(key, 'null', 3600); return ''; }
    const ext = ct.indexOf('png') >= 0 ? 'png' : ct.indexOf('webp') >= 0 ? 'webp' : 'jpg';
    const blob = res.getBlob().setName('tt_' + key.slice(6, 24) + '.' + ext);
    const file = thumbCacheFolder_().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    fileId = file.getId();
  } catch (e) {
    console.warn('rehostImageToDrive_ failed:', e && e.message);
    cache.put(key, 'null', 3600);
    return '';
  }
  cache.put(key, fileId, 21600);   // 6h；Drive 檔留著，縮圖網址穩定
  return driveThumbUrl_(fileId);
}

/** TikTok/抖音：短鏈轉址＋頁面反爬讓伺服器端 og 抓取常空手，但官方 oEmbed 端點公開、免登入，
 *  回的 title 就是影片**字幕/說明**（語意內容）、author_name 是頻道、thumbnail_url 是縮圖——
 *  正好是要餵進 embedding 的東西。流程：短鏈（vt./vm.）或無 /video/ 的網址先解轉址成
 *  www.tiktok.com/@user/video/<id> 正規網址（oEmbed 吃不下短鏈），再打 oEmbed。oEmbed 失敗
 *  時退一步用 crawler UA 抓正規頁的 og meta（同「FB 做法」）；都失敗回 null，落到「外部連結」
 *  乾淨處理，不退步。 */
function fetchTiktokOembed_(url) {
  const cache = CacheService.getScriptCache();
  // 版本前綴 ttpv4：升版讓上一版「縮圖走 weserv 代理（被 TikTok CDN 擋 403）」的舊快取失效重抓。
  const cacheKey = 'ttpv4_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, url));
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (_) {} }

  // 短鏈或非 /video/ 網址先解轉址；oEmbed 需要 www.tiktok.com/@user/video/<id> 形式。
  let canon = url;
  if (/(?:vt|vm)\.tiktok\.com/i.test(url) || !/\/video\/\d+/i.test(url)) {
    canon = resolveRedirects_(url, 5);
  }
  canon = canon.replace(/[?#].*$/, '');                     // 去掉轉址帶上的追蹤參數，給 oEmbed 乾淨網址

  let preview = null;
  try {
    const res = UrlFetchApp.fetch(
      'https://www.tiktok.com/oembed?url=' + encodeURIComponent(canon),
      { muteHttpExceptions: true, validateHttpsCertificates: false,
        // 不帶 UA 時 TikTok oEmbed 常回 403（就是為何先前落到 og 後備、標題變「X on
        // TikTok」而非字幕）；帶瀏覽器 UA 才穩定回 200。
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        } });
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText() || '{}');
      const title = decodeHtmlEntities_(String(data.title || '')).trim();
      const author = decodeHtmlEntities_(String(data.author_name || '')).trim();
      if (title || author || data.thumbnail_url) {
        preview = {
          url: canon || url,
          title: (title || author || 'TikTok 影片').slice(0, 200),
          description: (title && author ? `作者：${author}` : '').slice(0, 400),
          // 縮圖下載後轉存 Drive 再用 Drive 縮圖直圖——TikTok CDN 只服務 crawler UA，
          // 直連/第三方代理 LINE 都載不出（見 rehostImageToDrive_）。
          thumbnail: rehostImageToDrive_(String(data.thumbnail_url || ''))
        };
      }
    }
  } catch (e) {
    console.warn('TikTok oEmbed failed:', e && e.message);
  }

  // oEmbed 空手（從 GAS/機房 IP 常被 TikTok 擋 403）→ 退一步比照「FB 做法」：crawler UA
  // 抓正規頁 og meta。guard 放寬到任何 tiktok 網址：就算 resolveRedirects_ 沒解開短鏈，
  // 這裡 followRedirects:true 也會自行跟到正規頁、抓得到 og。
  if (!preview && /tiktok\.com/i.test(canon)) {
    try {
      const r2 = UrlFetchApp.fetch(canon, {
        muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: false,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        }
      });
      if (r2.getResponseCode() < 400) {
        const html = (r2.getContentText() || '').substring(0, 200000);
        const title = decodeHtmlEntities_(matchMetaContent_(html, ['og:title', 'twitter:title']) || '').slice(0, 200);
        const desc = decodeHtmlEntities_(matchMetaContent_(html, ['og:description', 'twitter:description', 'description']) || '').slice(0, 400);
        const image = decodeHtmlEntities_(extractOgImage_(html) || '');
        // 只在抓到真實文字、且不是被擋下的通用頁（"TikTok - Make Your Day" / 登入牆）時才採用。
        const generic = /^(tiktok( - make your day)?)$/i.test(title.trim());
        const wall = /log ?in|sign ?up|登入|登录|content isn'?t available/i;
        if ((title || desc) && !generic && !wall.test(title) && !wall.test(desc)) {
          // 縮圖一樣下載後轉存 Drive 再用 Drive 縮圖直圖（TikTok CDN 只認 crawler UA）。
          preview = { url: canon || url, title, description: desc, thumbnail: rehostImageToDrive_(image) };
        }
      }
    } catch (e) {
      console.warn('TikTok og fetch failed:', e && e.message);
    }
  }

  cache.put(cacheKey, preview ? JSON.stringify(preview) : 'null', preview ? 86400 : 3600);
  return preview;
}

/** 〔開發暫用〕/urldiag（亦 /ttdiag）<任意連結>：直接在 LINE 裡診斷縮圖抓取（不用進 editor）。
 *  抖音/IG/FB/Dcard… 都能用。逐步回報 解轉址→抓頁→og:image→下載圖(code/CT/bytes)→Drive
 *  縮圖網址，看卡在哪一步，據此決定哪些站要加進 previewThumbnail_ 的 re-host 名單。 */
function replyTiktokDiag_(ctx, arg) {
  const m = (arg || '').match(/https?:\/\/\S+/);
  if (!m) return lineReply_(ctx.replyToken, '用法：/urldiag <連結>（抖音/IG/FB/Dcard 皆可）');
  const lines = [];
  try {
    const canon = resolveRedirects_(m[0], 5).replace(/[?#].*$/, '');
    lines.push('1) 解轉址：\n' + canon);
    const r = UrlFetchApp.fetch(canon, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
    const fullHtml = r.getContentText() || '';
    lines.push('2) 抓頁 code：' + r.getResponseCode() + '（HTML ' + fullHtml.length + ' 字，全文含 og:image 字串：' + (/og:image/i.test(fullHtml) ? '有' : '無') + '）');
    const html = fullHtml.substring(0, 200000);
    const img = decodeHtmlEntities_(extractOgImage_(html) || '');
    lines.push('3) 縮圖網址：' + (img ? (img.slice(0, 110) + (img.length > 110 ? '…' : '')) : '(無)'));
    if (img) {
      const ir = UrlFetchApp.fetch(img, { muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
                   'Accept': 'image/jpeg,image/png,image/*;q=0.8' } });
      const h = ir.getHeaders() || {};
      let bytes = '?'; try { bytes = ir.getContent().length; } catch (_) {}
      lines.push('4) 下載圖：code ' + ir.getResponseCode() + ' / ' +
        (h['Content-Type'] || h['content-type'] || '?') + ' / ' + bytes + ' bytes');
      lines.push('5) Drive 縮圖：\n' + (rehostImageToDrive_(img) || '(失敗)'));
    }
  } catch (e) {
    lines.push('✗ 例外：' + (e && e.message));
  }
  return lineReply_(ctx.replyToken, lines.join('\n'));
}

function matchMetaContent_(html, props) {
  for (const prop of props) {
    // <meta property="og:title" content="..."> 或 <meta name="..." content="..."> 兩種順序
    const re1 = new RegExp('<meta[^>]*(?:property|name)\\s*=\\s*["\']' + prop + '["\'][^>]*content\\s*=\\s*["\']([^"\']+)["\']', 'i');
    const m1 = html.match(re1);
    if (m1) return m1[1];
    const re2 = new RegExp('<meta[^>]*content\\s*=\\s*["\']([^"\']+)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + prop + '["\']', 'i');
    const m2 = html.match(re2);
    if (m2) return m2[1];
  }
  return null;
}

function matchTagText_(html, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = html.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** 從 HTML 找預覽縮圖網址，多來源擇一（不只 og:image）：og:image(:secure_url/:url)、
 *  twitter:image(:src)、<link rel="image_src">、JSON-LD 的 image（字串或 {url}）。MSN 之類
 *  的站 og:image 缺席或藏在 JSON-LD，多試幾個才抓得到。 */
function extractOgImage_(html) {
  html = String(html || '');
  return matchMetaContent_(html, ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'])
      || (html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i) || [])[1]
      || (html.match(/"image"\s*:\s*"(https?:\/\/[^"]+)"/i) || [])[1]
      || (html.match(/"image"\s*:\s*\{[^}]*?"url"\s*:\s*"(https?:\/\/[^"]+)"/i) || [])[1]
      || (html.match(/"thumbnailUrl"\s*:\s*"(https?:\/\/[^"]+)"/i) || [])[1]
      || null;
}

function decodeHtmlEntities_(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Rebuild a record's aggregated state from the durable supplement records
 * that point at it. A supplement is matched two ways:
 *   - quotedRecordId === targetId (set when the quote target resolved), OR
 *   - quotedLineMessageId === target.lineMessageId.
 * The second path is the safety net: if the user quote-replies during the
 * brief window where a sweep has claimed the target pending but hasn't
 * appended the record yet, resolveQuotedTarget_ returns found:false and
 * quotedRecordId is null — but quotedLineMessageId (the raw quoted msg id)
 * is always stored, so we can still link it back to the target.
 *
 * Idempotent: if the supplement set hasn't changed it skips the (Gemini)
 * re-embed and returns false. Safe to call redundantly. No-ops (false) when
 * the target record doesn't exist yet — a later call folds it in.
 */
function reconcileSupplements_(scope, targetId) {
  if (!targetId) return false;
  const records = loadEmbeddingRecords_(scope);
  const target = records.find(r => r.id === targetId);
  if (!target) return false;
  const targetMsgId = target.lineMessageId || null;
  const supps = records
    .filter(r => r.id !== targetId && (
      r.quotedRecordId === targetId ||
      (targetMsgId && r.quotedLineMessageId === targetMsgId)
    ))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const incomingIds = supps.map(s => s.id);
  const existingKey = (target.supplements || []).slice().sort().join(',');
  const incomingKey = incomingIds.slice().sort().join(',');
  if (existingKey === incomingKey) return false;  // nothing changed
  let agg = target.text || '';
  for (const s of supps) agg += `\n\n[補充] ${s.text || ''}`;
  // Embed outside the lock; updateRecord_ takes the lock for the write. A
  // concurrent supplement landing in between is caught by the next call.
  const aggEmb = supps.length ? geminiEmbed_(agg) : null;
  updateRecord_(scope, targetId, (rec) => {
    rec.supplements = incomingIds;
    rec.aggregatedText = supps.length ? agg : null;
    rec.aggregatedEmbedding = aggEmb;
    return rec;
  });
  return true;
}

/**
 * Reconcile a target identified by the LINE messageId the user quoted.
 * Used by the ingest handlers, which always have ctx.quotedMessageId even
 * when resolveQuotedTarget_ returned found:false (target mid-processing).
 * No-op if no record carries that lineMessageId yet — the target is still
 * pending and processPendingMedia_ will reconcile once it lands.
 */
function reconcileSupplementsByLineMessageId_(scope, lineMessageId) {
  if (!lineMessageId) return false;
  const records = loadEmbeddingRecords_(scope);
  const target = records.find(r => r.lineMessageId === lineMessageId);
  if (!target) return false;
  return reconcileSupplements_(scope, target.id);
}

/**
 * Count supplements per target record id, derived live from the record set
 * (independent of the materialized supplements[] field, so the count is
 * correct even before any reconcile has run). Each supplement is attributed
 * to its target via quotedRecordId, falling back to quotedLineMessageId.
 * Returns { targetRecordId: count }.
 */
function buildSupplementCounts_(records) {
  const idByMsgId = {};
  for (const r of records) {
    if (r.lineMessageId) idByMsgId[r.lineMessageId] = r.id;
  }
  const counts = {};
  for (const r of records) {
    const targetId = r.quotedRecordId
      || (r.quotedLineMessageId && idByMsgId[r.quotedLineMessageId])
      || null;
    if (targetId && targetId !== r.id) counts[targetId] = (counts[targetId] || 0) + 1;
  }
  return counts;
}

/**
 * Look up whatever the user quote-replied to and return both a display
 * string and the internal record id (if resolvable). Reused by the echo
 * reply and by record storage so the timeline can render the quote
 * context without re-walking embeddings.jsonl.
 *
 * Bot-sent replies have no lineMessageId in our store and fall to the
 * "not found" branch — for those, recordId is null but we still preserve
 * the raw messageId for forensics.
 */
function resolveQuotedTarget_(scope, lineMessageId) {
  if (!lineMessageId) return { recordId: null, summary: null, found: false };
  let record = null;
  try {
    const records = loadEmbeddingRecords_(scope);
    record = records.find(r => r.lineMessageId === lineMessageId) || null;
  } catch (_) {}
  if (record) {
    const when = Utilities.formatDate(new Date(record.ts), TIME_ZONE, 'MM/dd HH:mm');
    const preview = truncate_((record.text || '').replace(/\s+/g, ' '), 60);
    return {
      recordId: record.id,
      summary: `引述 ${when} 的 ${typeLabel_(record.type)}：「${preview}」`,
      found: true
    };
  }
  const pending = listPendings_(scope).find(p => p.lineMessageId === lineMessageId);
  if (pending) {
    const when = Utilities.formatDate(new Date(pending.ts), TIME_ZONE, 'MM/dd HH:mm');
    return {
      recordId: pending.id,
      summary: `引述 ${when} 的 ${typeLabel_(pending.type)}（處理中：${pending.fileName || ''}）`,
      found: true
    };
  }
  return {
    recordId: null,
    summary: `找不到對應紀錄（可能是 bot 回覆或部署前的舊訊息，messageId: ${lineMessageId}）`,
    found: false
  };
}

/* ---- record edit / delete: quote-reply a record, then /del or /edit <新內容> ---- */

/** Quote-reply + /del → show a confirm card (delete is irreversible for the 脈絡). */
function handleDeleteRequest_(ctx) {
  if (!ctx.quotedMessageId) {
    return lineReply_(ctx.replyToken, '請先「引述」要刪除的那則紀錄，再回覆 /del。');
  }
  const q = resolveQuotedTarget_(ctx.scope, ctx.quotedMessageId);
  if (!q.found) {
    return lineReply_(ctx.replyToken, '找不到對應的脈絡紀錄（可能是 bot 回覆或部署前的舊訊息），無法刪除。');
  }
  if (isRecordFinalized_(ctx.scope, q.recordId)) {
    return lineReply_(ctx.replyToken, '🔒 這則屬於已定案封存的學習歷程、唯讀，無法刪除。要修改請先到網頁「解除定案」。');
  }
  lineReplyFlex_(ctx.replyToken, '確認刪除', buildDeleteConfirmBubble_(q.recordId, q.summary));
}

function buildDeleteConfirmBubble_(recordId, summary) {
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [{ type: 'text', text: '🗑 確認刪除', size: 'sm', weight: 'bold', color: THEME.dangerSoft }]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm', contents: [
        { type: 'text', text: '要把這則從脈絡移除嗎？', size: 'sm', color: THEME.text, wrap: true },
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
          contents: [{ type: 'text', text: summary || '(該紀錄)', size: 'xs', color: THEME.textBody, wrap: true, maxLines: 3 }]
        },
        { type: 'text', text: '聊天室的訊息仍會留著，只是不再被搜尋 / 引用。', size: 'xxs', color: THEME.muted, wrap: true }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.dangerSoft, cornerRadius: 'md', paddingAll: 'sm',
          action: { type: 'postback', label: '確定刪除', data: `action=del_record&id=${recordId}`, displayText: '▸ 確定刪除這則' },
          contents: [{ type: 'text', text: '🗑 確定刪除', size: 'sm', color: THEME.onDark, align: 'center', weight: 'bold' }]
        },
        {
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
          action: { type: 'postback', label: '取消', data: 'action=del_cancel', displayText: '▸ 取消刪除' },
          contents: [{ type: 'text', text: '取消', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
        }
      ]
    }
  };
}

/** del_record postback → remove from embeddings + transcript. */
function handleDeleteRecord_(ev, scope, id) {
  const removed = deleteEmbeddingRecord_(scope, id);
  if (!removed) return lineReply_(ev.replyToken, '這則已不在脈絡裡（可能已刪除，或還在處理中）。');
  try { deleteTranscript_(scope, id); } catch (_) {}
  return lineReply_(ev.replyToken, '🗑 已從脈絡移除這則（聊天室訊息仍會留著）。');
}

/** Quote-reply + /edit <新內容> → correct the record. Display keeps provenance
 *  as「新內容（原：舊內容）」, but the embedding uses only the new content so the
 *  wrong old value stops surfacing in search. */
function handleEditRecord_(ctx, arg) {
  const text = (arg || '').trim();
  if (!ctx.quotedMessageId) {
    return lineReply_(ctx.replyToken, '請先「引述」要更正的那則紀錄，再回覆 /edit <新內容>。');
  }
  if (!text) {
    return lineReply_(ctx.replyToken, '用法：引述某則紀錄，回覆 /edit <新內容>。');
  }
  const q = resolveQuotedTarget_(ctx.scope, ctx.quotedMessageId);
  if (!q.found) {
    return lineReply_(ctx.replyToken, '找不到對應的脈絡紀錄，無法更正。');
  }
  let emb;
  try { emb = geminiEmbed_(text); }  // embed the correction only — old value no longer ranks
  catch (e) { console.warn('edit re-embed failed:', e && e.message); return lineReply_(ctx.replyToken, '⚠️ 重新嵌入失敗，稍後再試。'); }
  let displayText = text;
  const updated = updateRecord_(ctx.scope, q.recordId, (r) => {
    // Keep the very first original for provenance; don't nest on re-edit.
    if (!r.originalText) r.originalText = r.text;
    r.text = `${text}（原：${r.originalText}）`;
    r.embedding = emb;
    r.editedAt = new Date().toISOString();
    displayText = r.text;
    return r;
  });
  if (!updated) return lineReply_(ctx.replyToken, '更正失敗（找不到紀錄）。');
  try { deleteTranscript_(ctx.scope, q.recordId); saveTranscript_(ctx.scope, q.recordId, displayText, updated.ts); } catch (_) {}
  lineReply_(ctx.replyToken, `✏️ 已更正：\n${truncate_(displayText, 200)}`);
}

/**
 * Strip common markdown markers for plain-text LINE bubbles. The underlying
 * Gemini output (saved to .md and rendered to PDF) keeps its markdown
 * intact; this only sanitizes the short preview shown in the chat.
 */
function stripMarkdown_(s) {
  if (!s) return '';
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold**
    .replace(/\*([^*]+)\*/g, '$1')          // *italic*
    .replace(/__([^_]+)__/g, '$1')          // __bold__
    .replace(/(?<![\w_])_([^_]+)_(?![\w_])/g, '$1')  // _italic_ (avoid x_y)
    .replace(/`([^`]+)`/g, '$1')            // `code`
    .replace(/^\s*#{1,6}\s+/gm, '')         // # headings
    .replace(/^\s*[-*]\s+/gm, '')           // - bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // [label](url)
}

/** Pull one「## heading」section's body out of a markdown doc, returned as one
 *  plain (markdown-stripped, whitespace-collapsed) line. Matches a heading whose
 *  text contains `heading` (tolerant of minor LLM phrasing drift); stops at the
 *  next「## 」or end. Returns '' when the section is absent. */
function extractMarkdownSection_(markdown, heading) {
  if (!markdown) return '';
  const out = [];
  let inSec = false;
  for (const ln of String(markdown).split('\n')) {
    const m = ln.match(/^##\s+(.*)/);
    if (m) {
      if (inSec) break;                          // hit the next section → done
      inSec = m[1].indexOf(heading) >= 0;
      continue;
    }
    if (inSec) out.push(ln);
  }
  return stripMarkdown_(out.join('\n')).replace(/\s+/g, ' ').trim();
}

/* ---------------- Commands ---------------- */

function handleCommand_(ctx, text) {
  // 防禦性正規化（手殘容錯）：全形斜線、斜線後多餘空白；與 handleText_ 一致，
  // 確保任何呼叫端進來都先收乾淨再 split。
  text = text.replace(/^／\s*/, '/').replace(/^\/\s+/, '/');
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/help':     return replyHelp_(ctx);
    case '/info':     return replyInfo_(ctx);     // 再看一次新手引導（＝加入時的歡迎卡）
    case '/now':                                  // 目前記事（今天記寫的重點摘要＋心情・聚焦）
    case '/today':    return replySummary_(ctx, 1, '今日', '目前記事');  // /today：舊指令/舊卡相容別名
    case '/portfolio':                            // 學習歷程總冊
    case '/story':    return replyStory_(ctx);    // /story：舊指令相容別名
    case '/episodes':
    case '/ep':       return replyEpisodes_(ctx, arg);
    case '/recall':
    case '/search': {
      const lf = extractExplorationFilter_(ctx.scope, arg);
      if (lf.explorationLabel && !lf.explorationId) {
        return lineReply_(ctx.replyToken, `找不到課程「${lf.explorationLabel}」。用 /lesson list 看看過去開過哪些。`);
      }
      // 沒給關鍵字、只給 lesson:X → 直接開該節課的記寫 view（同結束卡 CTA 路徑）。
      if (lf.explorationId && !lf.query) {
        return replyExplorationView_({ replyToken: ctx.replyToken }, ctx.scope, lf.explorationId);
      }
      return replySearch_(ctx, lf.query, 0, null,
        lf.explorationId ? { explorationId: lf.explorationId, explorationLabel: lf.explorationLabel } : undefined);
    }
    case '/ask':      return replyAsk_(ctx, arg);
    case '/exit':
    case '/root':     return handleAskExit_({ replyToken: ctx.replyToken }, ctx.scope);
    case '/themes':   return replyFocus_(ctx, arg);
    case '/journey':
    case '/歷程':     return replyJourney_(ctx, arg);   // 層5 學習歷程（無參數=一覽）
    case '/explore':
    case '/探':
    case '/lesson':    // 舊指令、保留為 alias 不顯示 deprecation 提示
    case '/課':        // 舊指令、保留為 alias
      return handleExploreCommand_(ctx, arg);  // 探索敘事段：開始/結束/狀態/list
    case '/rebuild':
    case '/重算':     return replyRebuild_(ctx);          // 暫時：手動跑升格+轉折偵測並回報
    case '/串':
    case '/thread':   return replyDebugThreads_(ctx, arg);  // 〔開發暫用〕綁串檢視，校準完移除
    case '/ttdiag':
    case '/urldiag':  return replyTiktokDiag_(ctx, arg);    // 〔開發暫用〕在 LINE 裡診斷任意連結的縮圖抓取（抖音/IG/FB/Dcard…）
    // 〔已退場 2026-06-07〕/test 測試模式、/重置密度：聚焦偵測已移到正常記寫路徑（停筆後推），不再需要沙盒。
    // Quote-reply a record then /del or /edit <新內容> to remove / correct it.
    case '/del':
    case '/delete':   return handleDeleteRequest_(ctx);
    case '/edit':     return handleEditRecord_(ctx, arg);
    // /me dashboard absorbs the old /stats /usage /setup commands.
    case '/me':
    case '/stats':
    case '/usage':
    case '/setup':    return replyDashboard_(ctx, arg);
    case '/shares':   return replyShareOverview_({ scope: ctx.scope, replyToken: ctx.replyToken }, ctx.scope);
    // OWNER-only access management commands.
    case '/revoke':   return handleRevokeCommand_(ctx, arg);
    case '/topup':    return handleTopupCommand_(ctx, arg);
    default:          return lineReply_(ctx.replyToken, `未知指令：${cmd}\n輸入 /help 查看可用指令。`);
  }
}

/** 〔開發暫用〕/串：把最近 N 筆按「敘事片段 → 串」列出來，肉眼校準綁串鬆緊。
 *  純查詢、唯讀、你主動打才出現（不違反「無痕靜默」——不是記寫當下冒出來）。校準完移除。
 *  每列：時間 [大類/議題] 內容；「未」＝背景還沒判到。用法：/串（最近 3 個敘事片段）或 /串 5（最近 5 個）。 */
function replyDebugThreads_(ctx, arg) {
  const epN = Math.max(1, Math.min(10, parseInt(arg, 10) || 3));
  const all = loadEmbeddingRecords_(ctx.scope).filter(r => r && r.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!all.length) return lineReply_(ctx.replyToken, '還沒有可顯示的記錄。');
  const eps = groupByEpisode_(all, CATEGORY_EPISODE_GAP_MS);
  const shown = eps.slice(-epN).reverse();   // 最近 epN 段、從新到舊（最新在最上）；段內仍時間序
  const lines = [`🧪 綁串檢視（最近 ${shown.length} 個敘事片段／共 ${eps.length}・新→舊）`,
    '〔串X〕＝同一串；行首「～?」＝曖昧併入（機器沒把握、預設先歸同串，日後會在此輕問）'];
  shown.forEach((ep, k) => {
    lines.push(`\n— 片段 ${eps.length - k}/${eps.length}（${ep.records.length} 則）—`);
    const recs = ep.records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let ti = -1, prev = null, prevTs = 0;
    recs.forEach(r => {
      const t = Date.parse(r.ts);
      let amb = false;
      if (!prev) { ti++; lines.push(`〔串${String.fromCharCode(65 + (ti % 26))}〕`); }
      else {
        const conf = boundaryConfidence_(prev, r, t - prevTs);
        if (conf === 'split') { ti++; lines.push(`〔串${String.fromCharCode(65 + (ti % 26))}〕`); }
        else if (conf === 'ambiguous') amb = true;
      }
      const tm = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
      const tag = `${r.category || '未'}/${r.topicLabel || '未'}`;
      const body = ((r.aggregatedText || r.text) || `（${typeLabel_(r.type)}）`).replace(/\s+/g, ' ');
      lines.push(`${amb ? '～? ' : '   '}${tm} [${tag}] ${truncate_(body, 28)}`);
      prev = r; prevTs = t;
    });
  });
  let out = lines.join('\n');
  if (out.length > 4800) out = out.slice(0, 4800) + '\n…（截斷，用「/串 1」看更少）';
  return lineReply_(ctx.replyToken, out);
}

/* ── 曖昧輕提示（背景推播版 v1）───────────────────────────────────────
 * 記寫當下完全靜默；只有「曖昧併入」且「心流停了」(SETTLE 內沒再寫)，背景才推一次輕問。
 * 「拆開」＝threadBreak 釘住（重分群一律自成一串）+ 清 topic 重歸 + 避開前一段議題。
 */

/** 記寫後（handleText_ try 內呼叫、已包 try/catch）：判這則對前一則文字是否「曖昧併入」，
 *  更新 meta.pendingThreadHint。不碰 ack、不回訊息——純背景狀態。 */
function trackThreadAmbiguity_(scope, record) {
  if (!THREAD_HINT_ENABLED) return;
  if (!record || record.type !== 'text' || record.linkBookmark) return;
  const recs = loadEmbeddingRecords_(scope)
    .filter(r => r && r.ts && r.type === 'text' && !r.linkBookmark)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const idx = recs.findIndex(r => r.id === record.id);
  if (idx <= 0) return;                       // 沒有前一則文字 → 不判
  const prev = recs[idx - 1];
  const conf = boundaryConfidence_(prev, record, Date.parse(record.ts) - Date.parse(prev.ts));
  updateChatMeta_(scope, m => {
    const p = m.pendingThreadHint;
    if (conf === 'ambiguous') {
      m.pendingThreadHint = {
        rid: record.id, prevId: prev.id,
        text: truncate_((record.text || '').replace(/\s+/g, ' '), 40),
        prevText: truncate_((prev.text || '').replace(/\s+/g, ' '), 40),
        ts: record.ts, asked: false
      };
    } else if (conf === 'chain' && p && !p.asked && p.rid === prev.id) {
      delete m.pendingThreadHint;             // 連續確認了那個曖昧併入 → 不必再問
    }
    return m;
  });
}

/** 背景 sweep：有未問的曖昧、且心流停了（SETTLE 內沒再寫）→ 推一則輕問，標 asked 去重。 */
function maybeAskThreadHint_(scope) {
  if (!THREAD_HINT_ENABLED) return;
  const p = loadChatMeta_(scope).pendingThreadHint;
  if (!p || p.asked) return;
  if (Date.now() - (Date.parse(p.ts) || 0) < THREAD_HINT_SETTLE_MS) return;   // 心流還沒停
  if (!proactivePushAllowed_(scope)) return;   // 〔合宜〕靜默窗/總開關/全域冷卻 → 這輪先別推、別標 asked，下輪再評估
  const uid = scope.userId || (scope.type === 'user' ? scope.id : null);
  // 先標 asked（不論推播成敗，避免下輪狂推）。
  updateChatMeta_(scope, m => { if (m.pendingThreadHint) m.pendingThreadHint.asked = true; return m; });
  if (!uid) return;
  try { linePushFlex_(uid, '這是同一件事嗎？', buildThreadHintBubble_(p)); markProactivePush_(scope); }
  catch (e) { console.warn('thread hint push failed:', e && e.message); }
}

/** 輕問卡：前一段／這則 + 兩按鈕（新的一件事／同一件）。可無視——預設先當同一件。 */
function buildThreadHintBubble_(p) {
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [{ type: 'text', text: '🧵 這是同一件事嗎？', size: 'sm', weight: 'bold', color: THEME.onDark }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm', contents: [
      { type: 'text', text: '前一段', size: 'xxs', color: THEME.muted },
      { type: 'text', text: truncate_(p.prevText || '（前一段）', 40), size: 'sm', color: THEME.textBody, wrap: true },
      { type: 'text', text: '這則', size: 'xxs', color: THEME.muted, margin: 'md' },
      { type: 'text', text: truncate_(p.text || '（這則）', 40), size: 'sm', weight: 'bold', color: THEME.text, wrap: true },
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '這則是接著前面那串、還是新的一件事?', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' },
      { type: 'text', text: '按「同一件事」會把這段併進前一段；不理也沒關係——背景會自行歸戶。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' }
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'sm', contents: [
      { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '新的一件事', data: `action=thread_split&rid=${p.rid}`, displayText: '▸ 拆成新的一件事' },
        contents: [{ type: 'text', text: '↗ 新的一件事', size: 'sm', color: THEME.onDark, align: 'center', weight: 'bold' }] },
      { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '同一件事', data: `action=thread_keep&rid=${p.rid}`, displayText: '▸ 同一件事，併進前段' },
        contents: [{ type: 'text', text: '✓ 同一件事（併進前段）', size: 'sm', color: THEME.cta, align: 'center', weight: 'bold' }] }
    ] }
  };
}

/** 「同一件事」：把這則（及其所在敘事片段、從這則起的後段）併入「前一段」的 (大類, 議題)，
 *  topicLock 鎖住、立即重分群 → 後面那段真的歸進前段那條脈絡（對稱於「拆開」的主動行為，
 *  不再只是清提示不動作）。前一段還沒分類時退回單純維持。 */
function handleThreadKeep_(ev, scope, rid) {
  const p = loadChatMeta_(scope).pendingThreadHint;
  const all = loadEmbeddingRecords_(scope);
  let prevCat = '', prevTopic = '';
  if (p && p.prevId) {
    const prev = all.find(r => r.id === p.prevId);
    if (prev) { prevCat = prev.category || ''; prevTopic = prev.topicLabel || ''; }
  }
  // 前一段還沒有可併的 (大類,議題) → 退回單純「維持」，讓背景自行歸戶。
  if (!prevCat || !prevTopic) {
    updateChatMeta_(scope, m => { delete m.pendingThreadHint; return m; });
    return lineReply_(ev.replyToken, '好，維持同一段，背景會把它歸到一起。');
  }
  // 範圍＝這則所在敘事片段、從這則起（含）的後段；把它們全部併入前一段那條。
  const rec = rid && all.find(r => r.id === rid);
  let ids = rid ? [rid] : [];
  if (rec) {
    const sorted = all.filter(r => r && r.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const eps = groupByEpisode_(sorted, EPISODE_GAP_MS);
    const ep = eps.find(e => e.records.some(r => r.id === rid));
    if (ep) ids = ep.records.filter(r => Date.parse(r.ts) >= Date.parse(rec.ts)).map(r => r.id);
  }
  if (!ids.length) {
    updateChatMeta_(scope, m => { delete m.pendingThreadHint; return m; });
    return lineReply_(ev.replyToken, '好，維持同一段。');
  }
  const n = setRecordsCategoryTopic_(scope, ids, prevCat, prevTopic);   // 鎖到前一段議題（topicLock）
  updateChatMeta_(scope, m => {
    delete m.pendingThreadHint;
    if (m.recordExclude) ids.forEach(id => delete m.recordExclude[id]);   // 清掉之前可能下的排除
    m.lastContextUpgradeAt = null; m.lastClassifyAt = new Date().toISOString();  // 放行立即重分群
    return m;
  });
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 15); } catch (_) {} }
  try { maybeUpgradeContexts_(scope, true); } catch (e) { console.warn('thread_keep merge upgrade failed:', e && e.message); }
  return lineReply_(ev.replyToken, `好，已把這段（${n || ids.length} 筆）併入「${truncate_(prevTopic, 16)}」。`);
}

/** 「拆開」：把這則釘成自成一串（threadBreak）、清 topic 重歸、避開前一段的議題。 */
function handleThreadSplit_(ev, scope, rid) {
  const p = loadChatMeta_(scope).pendingThreadHint;
  let prevTopic = '', prevCat = '';
  if (p && p.prevId) {
    const prev = loadEmbeddingRecords_(scope).find(r => r.id === p.prevId);
    if (prev) { prevTopic = prev.topicLabel || ''; prevCat = prev.category || ''; }
  }
  markRecordThreadBreak_(scope, rid);          // threadBreak=true + 清 topicLabel/topicLocked
  updateChatMeta_(scope, m => {
    if (prevTopic) { const e = m.recordExclude || {}; e[rid] = { topic: prevTopic, category: prevCat }; m.recordExclude = e; }
    delete m.pendingThreadHint;
    m.lastClassifyAt = new Date().toISOString();   // 放行背景重判
    return m;
  });
  return lineReply_(ev.replyToken, '好,把這則拆成新的一段——背景會重新歸到別的議題。');
}

/** 在 embeddings.jsonl 標記某筆 threadBreak=true，並清掉 topicLabel/topicLocked（重歸用）。Lock 保護。 */
function markRecordThreadBreak_(scope, rid) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const text = file.getBlob().getDataAsString();
    if (!text) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim(); if (!s) continue;
      let r; try { r = JSON.parse(s); } catch (_) { continue; }
      if (r.id === rid) {
        r.threadBreak = true; delete r.topicLabel; delete r.topicLocked;
        lines[i] = JSON.stringify(r); file.setContent(lines.join('\n')); return;
      }
    }
  } finally { lock.releaseLock(); }
}

/* -------------------- Access management handlers -------------------- */

function isOwnerCtx_(ctx) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  return owner && ctx && ctx.userId === owner;
}

function handleAccessApprove_(ev, scope, userId, budgetUsd) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || ev.source.userId !== owner) {
    return lineReply_(ev.replyToken, '⚠️ 只有 OWNER 可以核准。');
  }
  if (!(budgetUsd > 0)) budgetUsd = 1;
  const m = approveMember_(userId, budgetUsd);
  // Reply to OWNER inline.
  lineReply_(ev.replyToken,
    `✓ 已核准 ${m.displayName || userId.slice(-8)}\n預算 $${(m.budgetUsd).toFixed(2)}`);
  // Push to the new member (1 push).
  try {
    linePush_(userId,
      `✓ 您的存取已核准，預算 $${budgetUsd.toFixed(2)} USD。\n開始傳訊息給 bot 試試！輸入 /help 看指令。`);
  } catch (e) {
    console.error('approve push failed:', e && e.message);
  }
}

function handleAccessDeny_(ev, scope, userId) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || ev.source.userId !== owner) {
    return lineReply_(ev.replyToken, '⚠️ 只有 OWNER 可以拒絕。');
  }
  const m = denyMember_(userId);
  lineReply_(ev.replyToken, `已拒絕 ${m.displayName || userId.slice(-8)}`);
  try {
    linePush_(userId, '您的存取請求被拒絕。');
  } catch (e) {
    console.error('deny push failed:', e && e.message);
  }
}

function handleAccessRevokeConfirm_(ev, scope, userId) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || ev.source.userId !== owner) {
    return lineReply_(ev.replyToken, '⚠️ 只有 OWNER 可以撤銷。');
  }
  const m = loadMember_(userId);
  if (!m) return lineReply_(ev.replyToken, '找不到該成員。');
  const name = m.displayName || `…${userId.slice(-8)}`;
  const qr = {
    items: [
      { type: 'action', action: { type: 'postback', label: '✓ 確定撤銷', data: `action=access_revoke&user=${userId}`, displayText: opEcho_('確定撤銷', name) } },
      { type: 'action', action: { type: 'postback', label: '取消', data: 'action=access_cancel', displayText: '▸ 取消撤銷' } }
    ]
  };
  lineReply_(ev.replyToken,
    `⚠️ 確定撤銷 ${name} 的存取權？\n撤銷後對方無法繼續使用，但日後可在 /me 復原。`,
    qr);
}

function handleAccessRevoke_(ev, scope, userId) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || ev.source.userId !== owner) {
    return lineReply_(ev.replyToken, '⚠️ 只有 OWNER 可以撤銷。');
  }
  const m = revokeMember_(userId);
  lineReply_(ev.replyToken, `🚫 已撤銷 ${m.displayName || userId.slice(-8)} 的存取權`);
  try {
    linePush_(userId, '您的存取權已被撤銷。');
  } catch (_) {}
}

function handleAccessRestore_(ev, scope, userId) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || ev.source.userId !== owner) {
    return lineReply_(ev.replyToken, '⚠️ 只有 OWNER 可以復原。');
  }
  const m = loadMember_(userId);
  if (!m) return lineReply_(ev.replyToken, '找不到該成員。');
  const restored = restoreMember_(userId);
  const name = restored.displayName || `…${userId.slice(-8)}`;
  const remaining = Math.max(0, (restored.budgetUsd || 0) - (restored.spentUsd || 0));
  lineReply_(ev.replyToken,
    `♻️ 已復原 ${name}\n可繼續使用 $${remaining.toFixed(4)}（預算 $${restored.budgetUsd.toFixed(4)}，已用 $${(restored.spentUsd || 0).toFixed(4)}）`);
  try {
    linePush_(userId,
      `♻️ 您的存取權已恢復，可繼續使用 $${remaining.toFixed(4)}。`);
  } catch (_) {}
}

function handleRevokeCommand_(ctx, arg) {
  if (!isOwnerCtx_(ctx)) return lineReply_(ctx.replyToken, '⚠️ 此指令僅 OWNER 可用。');
  const userId = (arg || '').trim();
  if (!userId) return lineReply_(ctx.replyToken, '用法：/revoke <userId>');
  const m = loadMember_(userId);
  if (!m) return lineReply_(ctx.replyToken, '找不到該成員。');
  const name = m.displayName || `…${userId.slice(-8)}`;
  const qr = {
    items: [
      { type: 'action', action: { type: 'postback', label: '✓ 確定撤銷', data: `action=access_revoke&user=${userId}`, displayText: opEcho_('確定撤銷', name) } },
      { type: 'action', action: { type: 'postback', label: '取消', data: 'action=access_cancel', displayText: '▸ 取消撤銷' } }
    ]
  };
  lineReply_(ctx.replyToken,
    `⚠️ 確定撤銷 ${name} 的存取權？`, qr);
}

function handleTopupCommand_(ctx, arg) {
  if (!isOwnerCtx_(ctx)) return lineReply_(ctx.replyToken, '⚠️ 此指令僅 OWNER 可用。');
  const parts = (arg || '').split(/\s+/);
  if (parts.length < 2) return lineReply_(ctx.replyToken, '用法：/topup <userId> <USD>');
  const userId = parts[0];
  const amount = parseFloat(parts[1]);
  if (!loadMember_(userId)) return lineReply_(ctx.replyToken, '找不到該成員。');
  if (!(amount > 0)) return lineReply_(ctx.replyToken, '金額需為正數。');
  const m = topupMember_(userId, amount);
  lineReply_(ctx.replyToken,
    `💰 已為 ${m.displayName || userId.slice(-8)} 加 $${amount.toFixed(2)}\n新預算 $${m.budgetUsd.toFixed(4)}（已用 $${(m.spentUsd || 0).toFixed(4)}）`);
  try { linePush_(userId, `💰 您的預算已加 $${amount.toFixed(2)}，目前總額 $${m.budgetUsd.toFixed(4)}。`); } catch (_) {}
}

/**
 * /help — a read-only command board. Commands are NOT tappable: several need
 * a typed argument (e.g. /recall <關鍵字>), so this is reference, not a
 * launcher. Each command sits in a coloured chip balanced against its
 * explanation (chip ~⅜ width, explanation the rest), grouped by purpose with
 * a coordinated blue/indigo palette so the whole board reads as one piece.
 */
function replyHelp_(ctx) {
  lineReplyFlex_(ctx.replyToken, '指令說明', buildHelpBoardBubble_());
}

/** /info — 再看一次加入時的新手引導（歡迎卡）。welcomeFlex_ 定義在 Router.gs。 */
function replyInfo_(ctx) {
  lineReplyFlex_(ctx.replyToken, '歡迎使用 WriteToLearn — 學習歷程 Bot', welcomeFlex_(ctx.scope, {}));
}

/**
 * /help — three small swipeable cards, one per stage of the spine
 * (① 寫訊息 / ② 查脈絡 / ③ 生歷程). Commands are NOT tappable (several need a
 * typed argument). Kept compact (kilo).
 */
function buildHelpBoardBubble_() {
  const CHIP = THEME.group;  // one hue per operation family

  const cmdRow = (cmd, desc, color) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', backgroundColor: color, cornerRadius: 'md', paddingAll: 'xs', flex: 4,
        contents: [{ type: 'text', text: cmd, size: 'xxs', color: THEME.onDark, weight: 'bold', align: 'center', wrap: true }]
      },
      { type: 'text', text: desc, size: 'xxs', color: THEME.textBody, wrap: true, flex: 7, gravity: 'center' }
    ]
  });
  const groupLabel = (t) => ({ type: 'text', text: t, size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' });
  const line = (t) => ({ type: 'text', text: t, size: 'xs', color: THEME.text, wrap: true, margin: 'sm' });

  const stageCard = (title, headerBg, bodyContents, crumb) => ({
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: headerBg, paddingAll: 'md',
      contents: (crumb ? [breadcrumbKicker_(crumb, THEME.depth.l1)] : []).concat([
        { type: 'text', text: title, size: 'sm', weight: 'bold', color: THEME.onDark }])
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: bodyContents }
  });

  const card1 = stageCard('① 隨手寫訊息', THEME.cta, [
    line('📝 文字 → 筆記'),
    line('🖼️ 🎤 🎬 📄 → 跳泡泡選處理'),
    line('😀 貼圖 → 情緒訊號'),
    line('💬 引述某則 → 補充到那則'),
    { type: 'separator', margin: 'md' },
    cmdRow('/edit', '引述 → 更正（原文保留）', CHIP.context),
    cmdRow('/del', '引述 → 刪除（會確認）', CHIP.context),
    groupLabel('探索敘事段（選用）'),
    cmdRow('/explore <名> [分]', '開一段探索（課/工作坊/讀書會...沒給時長 = 45 分）', CHIP.context),
    cmdRow('/explore end', '手動結束（也會到時自動關）', CHIP.context),
    cmdRow('/explore list [字]', '過去的探索清單（可加關鍵字篩 label）', CHIP.context)
  ], ['／help', '指令說明']);

  const card2 = stageCard('② 隨身查脈絡', THEME.depth.l1.accent, [
    groupLabel('回頭看'),
    cmdRow('/now', '目前記事：今天記寫的重點摘要＋心情・聚焦', CHIP.context),
    cmdRow('/portfolio', '學習歷程總冊：把歷程合成一份可列印／存檔 PDF', CHIP.context),
    cmdRow('/episodes', '敘事片段（今日＋按月）', CHIP.context),
    groupLabel('探索'),
    cmdRow('/recall', '語意回想（關鍵字或一句話）', CHIP.explore),
    cmdRow('/ask', '有來源的答案；單打進提問模式', CHIP.explore),
    cmdRow('/themes', '主題群組：大類 → 主題（點主題直接看敘事片段＋記錄）', CHIP.explore)
  ]);

  const card3 = stageCard('③ 脈絡生歷程', CHIP.context, [
    line('🌱 進行中脈絡 →〔過三條件〕🌿 候選歷程 →〔出現轉折〕🌳 學習歷程'),
    { type: 'text', text: '三條件：語意密度／意向回返／跨媒介　·　轉折：概念重述／跨主題整合／行動指向／後設反思', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' },
    { type: 'text', text: '卡片上可「補一筆」顧條件、「補一個轉折」、改名、改歸主題；缺回返可排「之後提醒回來寫」。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' },
    { type: 'separator', margin: 'md' },
    cmdRow('/journey', '我的學習歷程；點進看「歷程現況」', CHIP.context),
    cmdRow('/shares', '分享回執總覽（誰看了你分享的歷程）', CHIP.context),
    groupLabel('帳號 / 說明'),
    cmdRow('/me', '學習儀表板', CHIP.account),
    cmdRow('/info', '再看一次新手引導', CHIP.account)
  ]);

  return { type: 'carousel', contents: [card1, card2, card3] };
}

function replyDashboard_(ctx, arg) {
  if ((arg || '').toLowerCase() === 'reset') {
    const removed = resetUsage_();
    return lineReply_(ctx.replyToken,
      `🧹 已歸零 Gemini 用量統計（清除 ${removed} 筆計數）\n` +
      '從現在起的呼叫會重新累計。');
  }
  refreshChatFolderName_(ctx.scope);
  // /me 也順手跑一次升級（純 CPU、繞 3h 節流，同 /themes 入口）：把剛寫、已分類的記錄折進脈絡，
  // 數字（進行中脈絡／候選歷程／處理中）當下就同步——修「要先進 /themes 才會同步」的 lag。
  if (ctx.scope && ctx.scope.type === 'user') { try { showLoadingAnimation_(ctx.scope.id, 15); } catch (_) {} }
  try { maybeUpgradeContexts_(ctx.scope, true); } catch (e) { console.warn('me upgrade failed:', e && e.message); }
  const stats = gatherDashboardStats_(ctx.scope);
  const bubble = buildDashboardBubble_(ctx.scope, stats);
  lineReplyFlex_(ctx.replyToken, 'Write to Learn 儀表板', bubble);
}

function replySummary_(ctx, days, label, displayName) {
  // label：時間窗框名（給 LLM 提示／記寫時間分布 strip／檔名，維持「今日」語意不變）。
  // displayName：卡片／PDF 標題的對外顯示名（/now＝「目前記事」）；未給時退回舊式「<label>總結」。
  displayName = displayName || `${label}總結`;
  const summary = summarizeRecentDays_(ctx.scope, days, label);
  if (!summary) return lineReply_(ctx.replyToken, `${label}沒有資料。`);
  const now = new Date();
  const dateStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  // 產出檔案的時間點（年月日時分）：卡片與 PDF 都標這個「這份記事是何時生成的」。
  const genStamp = Utilities.formatDate(now, TIME_ZONE, 'yyyy/MM/dd HH:mm');
  const baseName = `${dateStr}_${label}_${days}d`;
  const count = bumpSummaryCount_(ctx.scope, baseName);
  const title = `${displayName}（第 ${count} 次）`;

  // 這次總結窗內的記錄：給 PDF meta（範圍/筆數/媒介組成）＋卡片的記寫時間分布 strip 用。
  const { startMs, endMs } = summaryWindowMs_(days);
  const winRecs = recordsInRange_(ctx.scope, startMs, endMs);
  const comp = {};
  winRecs.forEach(r => { comp[r.type] = (comp[r.type] || 0) + 1; });
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join(' ');
  const rangeText = (days === 1)
    ? `今天 ${Utilities.formatDate(new Date(startMs), TIME_ZONE, 'MM/dd HH:mm')}–${Utilities.formatDate(new Date(endMs), TIME_ZONE, 'HH:mm')}`
    : `最近 ${days} 天（${formatClusterRange_(startMs, endMs)}）`;
  const metaLine = `${rangeText}｜共 ${winRecs.length} 筆記寫${compStr ? '｜' + compStr : ''}`;

  // 〔情緒層〕今日心情：(a) Gemini 從語感讀出的「心情・聚焦」一句（凸顯態度與聚焦程度），
  // (b) 貼圖情緒的時序弧線（整個心情軌跡）。兩者都上卡、也寫進 PDF。
  const creator = ownerDisplayName_(ctx.scope);
  const moodFocus = extractMarkdownSection_(summary, '今日心情・聚焦');
  const moodArc = journeyEmotionArc_(winRecs);

  // PDF：標題 + meta callout（建立者／範圍／產出時間／心情軌跡）+ Gemini 的五區塊 markdown
  // （第五塊「今日心情・聚焦」已含在 summary 裡，會自然成為 PDF 的一個段落）。
  const markdown = `# ${displayName}\n`
    + (creator ? `> 建立者：${creator}\n` : '')
    + `> ${metaLine}\n`
    + `> 產出時間：${genStamp}（第 ${count} 次）\n`
    + (moodArc ? `> 心情軌跡：${moodArc.chain}（${moodArc.n} 次）\n` : '')
    + `\n${summary}\n`;
  saveSummary_(ctx.scope, `${baseName}.md`, markdown);
  const pdf = saveSummaryPdf_(ctx.scope, baseName, `${displayName} · ${dateStr}`, markdown);

  const strip = (winRecs.length && endMs > startMs) ? episodeTimelineStrip_({
    startTs: startMs, endTs: endMs, records: [], otherRecords: winRecs,  // 無焦點 → 全部中性 ● 顯示密度
    headText: `${label}記寫時間分布 · ${formatClusterRange_(startMs, endMs)}`
  }) : null;
  // 心情軌跡疊在密度條正下方（同 12 格、同視窗對齊）：哪格寫了、那格落了什麼情緒，一眼可見。
  if (strip) {
    const moodRow = emotionCellsRow_(winRecs, startMs, endMs);
    if (moodRow) strip.contents.push(moodRow);
  }
  const preview = truncate_(stripMarkdown_(summary).replace(/\s+/g, ' '), 150);
  const bubble = buildSummaryBubble_({
    crumb: ['／now', displayName],
    title, subtitle: metaLine, eyebrow: '📝 重點摘要',
    preview, pdfFile: pdf, strip,
    moodFocus, moodArc, genStamp, genCount: count
  });
  lineReplyFlex_(ctx.replyToken, `${title}・${dateStr}`, bubble);
}

/**
 * /portfolio（舊 /story）— 學習歷程總冊：把（已定案優先的）學習歷程合成一份可匯出/列印的 PDF，
 * 供存檔/繳交，與 per-journey 的「歷程現況」報告刻意區隔（那是單條、可分享/定案；
 * 這是跨歷程的一本總冊）。優先收錄已定案歷程（鎖定最終版）；若還沒任何定案，就先收
 * 目前所有歷程的「現況」並標明未定案、提示去定案。首次自足：若還沒偵測到歷程，跑一次
 * 有界轉折偵測。
 */
function replyStory_(ctx) {
  const scope = ctx.scope;
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 60); } catch (_) {} }

  // Ensure 脈絡 exist so the first /story isn't empty (cheap — no LLM).
  if (!loadContexts_(scope).length) {
    try { upgradeContexts_(scope); } catch (e) { console.warn('story: upgrade failed', e && e.message); }
  }
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });

  // 確保有脈絡（cheap、no LLM）；若還沒任何歷程，跑一次有界轉折偵測，讓首次 /story 不空。
  if (!loadContexts_(scope).length) {
    try { upgradeContexts_(scope); } catch (e) { console.warn('story: upgrade failed', e && e.message); }
  }
  let journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  if (!journeys.length) {
    try { detectJourneys_(scope, Math.min(6, journeyDetectBudgetLeft_())); }
    catch (e) { console.warn('story: journey detect failed', e && e.message); }
    journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  }
  if (!journeys.length) {
    return lineReply_(ctx.replyToken,
      '📚 還生不出總冊：尚未浮現任何學習歷程（脈絡還沒出現轉折，或資料太少）。\n先用 /themes 看主題群組、/journey 看歷程進度，多寫一些再回來。');
  }
  const ctxById = {};
  loadContexts_(scope).forEach(c => { ctxById[c.id] = c; });

  // 收錄哪些：優先「已定案」歷程（鎖定的最終版＝可存檔/繳交）；若還沒任何定案，先收目前所有
  // 歷程的「現況」、標明未定案。定案在前依定案時間新→舊，其餘依活動時間新→舊。
  const jTime = j => { const c = ctxById[j.contextId]; return c && c.lastTs ? Date.parse(c.lastTs) : 0; };
  const finalized = journeys.filter(j => j.finalized);
  const isDraft = !finalized.length;
  const useJourneys = (finalized.length ? finalized : journeys).slice().sort((a, b) => {
    if (a.finalized && b.finalized) return Date.parse(b.finalizedAt || 0) - Date.parse(a.finalizedAt || 0);
    return jTime(b) - jTime(a);
  });

  // 內文＝每條歷程一個「學習單元」（轉折種類／before→after／學到什麼／下一步），一次 Gemini。
  let body = '';
  try { body = summarizeJourneyStory_(useJourneys, ctxById, recById); }
  catch (e) { console.error('compendium story failed:', e && e.message); }
  if (!body) return lineReply_(ctx.replyToken, '⚠️ 總冊生成失敗，請稍後再試。');

  const now = new Date();
  const dateStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const genStamp = Utilities.formatDate(now, TIME_ZONE, 'yyyy/MM/dd HH:mm');
  const creator = ownerDisplayName_(scope);
  const allRecs = collectJourneyRecords_(useJourneys, ctxById, recById);
  const m = storyRecordsMeta_(allRecs, `${useJourneys.length} 條歷程`, '歷程記寫時間分布');
  // 收錄篇章：總冊封面卡的「目次」＋ PDF 的收錄目錄共用同一份。
  const toc = useJourneys.map((j, i) => {
    const c = ctxById[j.contextId];
    const label = (c ? journeyTitleParts_(c, j).main : '') || j.title || j.label || '學習歷程';
    return {
      idx: i + 1, label, finalized: !!j.finalized,
      when: (j.finalized && j.finalizedAt) ? Utilities.formatDate(new Date(j.finalizedAt), TIME_ZONE, 'MM/dd') : '',
      whenFull: (j.finalized && j.finalizedAt) ? Utilities.formatDate(new Date(j.finalizedAt), TIME_ZONE, 'yyyy/MM/dd') : ''
    };
  });
  const tocLines = toc.map(t =>
    `- ${t.idx}. ${t.label}（${t.finalized ? '✅ 已定案' + (t.whenFull ? ' ' + t.whenFull : '') : '🌳 現況（未定案）'}）`
  ).join('\n');

  const md = `# 學習歷程總冊\n`
    + (creator ? `> 建立者：${creator}\n` : '')
    + `> ${m.subtitle}\n`
    + `> 收錄 ${useJourneys.length} 條學習歷程${finalized.length ? `（${finalized.length} 條已定案）` : ''}\n`
    + `> 產出時間：${genStamp}\n`
    + (isDraft ? '> 〔尚無已定案歷程，以下為目前現況；到「歷程現況」按「定案封存」可鎖定最終版〕\n' : '')
    + `\n## 收錄目錄\n${tocLines}\n\n${body}\n`;
  const baseName = `${dateStr}_學習歷程總冊`;
  saveSummary_(scope, `${baseName}.md`, md);
  const pdf = saveSummaryPdf_(scope, baseName, `學習歷程總冊 · ${dateStr}`, md);

  const bubbles = buildPortfolioBubble_({
    title: isDraft ? '學習歷程總冊（現況）' : '學習歷程總冊',
    coverSub: `共 ${useJourneys.length} 篇學習歷程${finalized.length ? ` · ${finalized.length} 篇已定案` : ' · 尚無定案'}`,
    toc, strip: m.strip, subtitle: m.subtitle, genStamp,
    pdfUrl: pdf.getUrl(),
    webUrl: (function () { try { return compendiumReportUrl_(scope); } catch (_) { return ''; } })(),
    hero: journeyHeroFromRecord_(pickJourneyHeroRecord_(allRecs))
  });
  lineReplyFlex_(ctx.replyToken, `學習歷程總冊・${dateStr}`, { type: 'carousel', contents: bubbles });
}

/** /portfolio 入口：拆成「裝幀總冊」輪播兩卡（太長了→分卡）：
 *  ① 導覽卡＝深皮革書封 header（📚＋書名＋篇數）＋封面照＋一行現況＋兩鈕（瀏覽總冊／PDF）；
 *  ② 瀏覽卡＝收錄篇章目次（每篇 ✅已定案／🌳現況）＋記寫時間分布條。
 *  回傳 [導覽卡, 瀏覽卡]。刻意與 /now 海軍藍導航卡區隔，給總冊／作品集意象。 */
function buildPortfolioBubble_(o) {
  const COVER = '#4a3b2a', TITLE = '#f3e7d3', SUB = '#cbb99c';   // 裝幀皮革色：與 /now 海軍藍明顯區隔
  const webBtn = o.webUrl ? {
    type: 'box', layout: 'vertical', backgroundColor: COVER, cornerRadius: 'md', paddingAll: 'sm',
    action: { type: 'uri', label: '瀏覽總冊', uri: o.webUrl },
    contents: [{ type: 'text', text: '🌐 瀏覽總冊（完整版）', size: 'sm', color: TITLE, align: 'center', weight: 'bold' }]
  } : null;
  const pdfBtn = {
    type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', borderWidth: '1px', borderColor: COVER,
    action: { type: 'uri', label: '開啟總冊 PDF', uri: o.pdfUrl },
    contents: [{ type: 'text', text: '📖 文字精華版 PDF', size: 'sm', color: COVER, align: 'center', weight: 'bold' }]
  };

  // ① 導覽卡（封面）
  const navBody = [];
  if (o.subtitle) navBody.push({ type: 'text', text: o.subtitle, size: 'xxs', color: THEME.muted, wrap: true });
  if (o.genStamp) navBody.push({ type: 'text', text: `🕒 產出 ${o.genStamp}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true });
  navBody.push({ type: 'text', text: '👉 右滑看「收錄篇章」', size: 'xxs', color: THEME.muted, margin: 'sm', wrap: true });
  const nav = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COVER, paddingAll: 'xl', spacing: 'sm',
      contents: [
        { type: 'text', text: '／portfolio · 學習歷程總冊', size: 'xxs', color: SUB },
        { type: 'text', text: '📚', size: 'xxl', align: 'center' },
        { type: 'text', text: o.title, size: 'xl', weight: 'bold', color: TITLE, align: 'center', wrap: true },
        { type: 'text', text: o.coverSub, size: 'xs', color: SUB, align: 'center', wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'xs', contents: navBody },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: (webBtn ? [webBtn, pdfBtn] : [pdfBtn]) }
  };
  if (o.hero) nav.hero = o.hero;

  // ② 瀏覽卡（收錄篇章 ＋ 時間分布）
  const browseBody = [];
  (o.toc || []).slice(0, 10).forEach(t => {
    browseBody.push({
      type: 'box', layout: 'baseline', spacing: 'sm', margin: 'xs',
      contents: [
        { type: 'text', text: t.finalized ? '✅' : '🌳', size: 'sm', flex: 0 },
        { type: 'text', text: `${t.idx}. ${t.label}`, size: 'sm', color: THEME.textBody, wrap: true, flex: 1 },
        { type: 'text', text: t.finalized ? (t.when ? '定案 ' + t.when : '已定案') : '現況', size: 'xxs', color: THEME.muted, flex: 0, align: 'end' }
      ]
    });
  });
  if ((o.toc || []).length > 10) browseBody.push({ type: 'text', text: `…另 ${o.toc.length - 10} 篇見完整版`, size: 'xxs', color: THEME.muted, margin: 'xs' });
  if (o.strip) { browseBody.push({ type: 'separator', margin: 'md' }); browseBody.push(o.strip); }
  const browse = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COVER, paddingAll: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: '／portfolio · 學習歷程總冊', size: 'xxs', color: SUB },
        { type: 'text', text: `📖 收錄篇章 · ${(o.toc || []).length} 篇`, size: 'md', weight: 'bold', color: TITLE }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm', contents: browseBody },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [webBtn || pdfBtn] }
  };

  return [nav, browse];
}

/** /story 用：彙整一批歷程(其 context)的去重記錄。 */
function collectJourneyRecords_(journeys, ctxById, recById) {
  const out = [], seen = {};
  (journeys || []).forEach(j => {
    const c = ctxById[j.contextId];
    if (!c) return;
    (c.recordIds || []).forEach(id => {
      const r = recById[id];
      if (r && r.ts && !seen[id]) { seen[id] = 1; out.push(r); }
    });
  });
  return out;
}

/** /story 卡：由記錄陣列算「訊息現況」(筆數＋媒介組成) subtitle ＋記寫時間分布 strip
 *  （導覽性質、無焦點 → 全部以中性 ● 顯示密度）。空集合回 strip:null。 */
function storyRecordsMeta_(records, headLabel, stripCaption) {
  const recs = (records || []).filter(r => r && r.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const comp = {};
  recs.forEach(r => { comp[r.type] = (comp[r.type] || 0) + 1; });
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join(' ');
  const subtitle = `${headLabel}・${recs.length} 筆記寫${compStr ? '｜' + compStr : ''}`;
  let strip = null;
  if (recs.length) {
    const start = Date.parse(recs[0].ts), end = Date.parse(recs[recs.length - 1].ts);
    if (end > start) strip = episodeTimelineStrip_({
      startTs: start, endTs: end, records: [], otherRecords: recs,
      headText: `${stripCaption} · ${formatClusterRange_(start, end)}`
    });
  }
  return { subtitle, strip };
}

/**
 * Manual split correction (must-not-link). When k-means fused distinct topics
 * into one 脈絡 (embedding put them too close), the user taps 分開: we sub-cluster
 * its records into groups and PIN each group, so every future re-cluster keeps
 * them apart (see upgradeContexts_'s pin handling). Then re-cluster now.
 */
function handleContextSplit_(ev, scope, cid) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 30); } catch (_) {} }
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!context) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /themes 後再試。');
  if (context.finalized) return lineReply_(ev.replyToken, '🔒 這條已定案封存、唯讀，無法分開。要修改請先到網頁「解除定案」。');
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const recs = (context.recordIds || [])
    .map(id => recById[id])
    .filter(r => r && r.embedding && r.embedding.length === EMBED_DIM);
  if (recs.length < 4) return lineReply_(ev.replyToken, '這條紀錄太少，不需要再分。');
  let sub = kmeansCluster_(recs, 2).filter(g => g.length > 0);
  if (sub.length < 2) return lineReply_(ev.replyToken, '這條內容很集中，系統看不出可以分開的兩塊。可多寫一些再試。');

  // 大的當「核心」（保留原名、原 id），小的當「分出」並**自動改名**（避免兩條同名分不出）。
  sub.sort((a, b) => b.length - a.length);
  const core = sub[0], spun = sub[1];
  const coreIds = core.map(r => r.id), spunIds = spun.map(r => r.id);
  const cat = context.category || (spun.find(r => r.category) || {}).category || '';
  let newLabel = truncate_(representativeLabel_(spun, meanVector_(spun.map(r => r.embedding))), 14);
  if (!newLabel || newLabel === (context.label || '')) newLabel = (context.label || '主題') + '·分支';

  // 1) 分出的自動改名（setRecordsCategoryTopic_ 會清掉它們的舊 pin，故必須在設新 pin 之前做）。
  try { setRecordsCategoryTopic_(scope, spunIds, cat, newLabel); }
  catch (e) { console.warn('split rename spun failed:', e && e.message); }
  // 2) 〔根治·只釘分出的、核心不釘〕只把「分出去的那群」釘 must-not-link 保證不回來；**核心不釘**
  //    ——核心靠相同標籤自然成群、保持開放，新記錄／改歸／補轉折升格才能再併進（釘核心會變封閉群、
  //    長殘留，實測 bug）。分出的已改名+鎖標籤，pin 只是再保險。
  const pins = loadChatMeta_(scope).recordPins || {};
  const spunG = newId_();
  spunIds.forEach(id => { pins[id] = spunG; });
  updateChatMeta_(scope, m => { m.recordPins = pins; m.lastContextUpgradeAt = null; return m; });
  // 3) 重新分群。
  try { upgradeContexts_(scope); } catch (e) { console.warn('split re-upgrade failed:', e && e.message); }

  // 帶路：找出重整後的核心 / 分出兩條（用 recordIds 重疊最高者匹配）。
  const after = loadContexts_(scope);
  const bestMatch = (ids) => {
    const set = {}; ids.forEach(id => { set[id] = true; });
    let best = null, bestN = 0;
    after.forEach(c => { const n = (c.recordIds || []).filter(id => set[id]).length; if (n > bestN) { bestN = n; best = c; } });
    return best;
  };
  const coreCtx = bestMatch(coreIds), spunCtx = bestMatch(spunIds);
  const statusLabel = (c) => (c && c.status === 'journey') ? '🌳 學習歷程'
    : (c && c.status === 'context') ? '🌿 候選歷程' : '🌱 進行中脈絡';
  const coreName = (coreCtx && coreCtx.label) || context.label || '核心';
  const spunName = (spunCtx && spunCtx.label) || newLabel;

  const body = [
    { type: 'text', text: `已把「${truncate_(context.label || '這條脈絡', 16)}」分成兩條`, size: 'sm', weight: 'bold', color: THEME.text, wrap: true },
    { type: 'text', text: `${statusLabel(coreCtx)}　核心「${truncate_(coreName, 14)}」${core.length} 筆`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' },
    { type: 'text', text: `${statusLabel(spunCtx)}　分出「${truncate_(spunName, 14)}」${spun.length} 筆 ← 剛在拉低密度的`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'sm' }
  ];
  spun.slice(0, 3).forEach(r => body.push({ type: 'text', text: `· ${truncate_(recText_(r), 24)}`, size: 'xxs', color: THEME.muted, wrap: true, maxLines: 1, margin: 'xs' }));
  body.push({ type: 'text', text: '已記住要分開，重新分群不會再湊回去。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' });

  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.stage.supplement, paddingAll: 'md',
      contents: [{ type: 'text', text: '🔀 已分開（分出的已自動改名）', size: 'sm', weight: 'bold', color: THEME.onDark, wrap: true }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body }
  };
  if (spunCtx) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '看分出的主題', data: `action=theme_topic&cid=${spunCtx.id}`, displayText: opEcho_('看分出的主題', spunName) },
        contents: [{ type: 'text', text: `👀 看分出的「${truncate_(spunName, 12)}」`, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
      }]
    };
  }
  return lineReplyFlex_(ev.replyToken, `已分開「${truncate_(context.label || '脈絡', 16)}」`, bubble);
}

/**
 * /themes 卡上「改名」入口：把這次脈絡 id 暫存在 askDialog（mode='rename'），
 * 下一句純文字就會被當作新主題名套上去。沒寫東西、TTL 過期、或打任何 / 命令都會
 * 自動取消，不影響後續寫筆記。
 */
function handleContextRenameEntry_(ev, scope, cid) {
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!context) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /themes 後再試。');
  const cur = context.userTitle || context.label || '';
  saveAskDialog_(scope, { mode: 'rename', contextId: cid, startedAt: Date.now() });
  lineReply_(ev.replyToken,
    `✎ 改名：直接打字輸入新的主題名稱（建議 ≤ 24 字）。\n目前：「${truncate_(cur, 24)}」\n（要放棄改名就傳任何 / 命令或不理它，10 分鐘自動退出。）`);
}

function handleContextRenameInput_(ctx, cid, text) {
  clearAskDialog_(ctx.scope);
  const newTitle = (text || '').trim().slice(0, 40);
  if (!newTitle) return lineReply_(ctx.replyToken, '主題名稱不能空白，已取消改名。');
  const contexts = loadContexts_(ctx.scope);
  const c = contexts.find(x => x.id === cid);
  if (!c) return lineReply_(ctx.replyToken, '這條脈絡已更新，未能套用改名，請重新 /themes。');
  const before = c.userTitle || c.label || '';
  c.userTitle = newTitle;
  c.label = newTitle;                        // label 也對齊，顯示來源（userTitle/label）一致
  c.updatedAt = new Date().toISOString();
  saveContexts_(ctx.scope, contexts);
  // 〔同步逐筆歸類〕把成員 record 的 topicLabel 一起改成新名（topicLock 保持同群、卡片「📂 大類｜議題」
  // 顯示一致）。category 維持不變。分類器看「現有議題清單」會沿用新名，未來同主題新筆也歸回這條、不分家。
  let renamed = 0;
  let cat = c.category || '';
  if (!cat) {
    const recById = {}; loadEmbeddingRecords_(ctx.scope).forEach(r => { recById[r.id] = r; });
    for (const id of (c.recordIds || [])) { const r = recById[id]; if (r && r.category) { cat = r.category; break; } }
  }
  if (cat && c.recordIds && c.recordIds.length) {
    try { renamed = setRecordsCategoryTopic_(ctx.scope, c.recordIds, cat, newTitle); }
    catch (e) { console.warn('rename propagate to records failed:', e && e.message); }
  }
  lineReply_(ctx.replyToken,
    `✏️ 已改名為「${truncate_(newTitle, 24)}」（原：「${truncate_(before, 24)}」）`
    + (renamed ? `，${renamed} 筆紀錄的歸類一起更新了` : '') + '。');
}

/** 〔分享回執·省 push〕背景彙整推：把自上次以來的回執攢成一張卡推一次，走合宜守門
 *  （proactivePushAllowed_：夜間不推/一輪一張/可全關）。推完清佇列。掛 backgroundSweep。 */
function notifyPendingAcks_(scope) {
  if (!scope || scope.type !== 'user' || !scope.id) return;
  const q = (loadChatMeta_(scope).pendingAckNotices || []);
  if (!q.length) return;
  if (!proactivePushAllowed_(scope)) return;   // 被擋（夜間/冷卻/全關）→ 留佇列、下輪再評估，不丟失
  const show = q.slice(-6);
  const lines = show.map(a => `· ${a.name}「${a.title}」${a.note ? '：' + a.note : ''}`);
  const more = q.length > show.length ? `\n…等共 ${q.length} 筆` : '';
  try {
    linePush_(scope.id, `🔔 背景自動整理\n📩 你的學習歷程收到 ${q.length} 筆新回執：\n${lines.join('\n')}${more}\n（/me 或歷程卡 📩 看完整名單）`);
    markProactivePush_(scope);
    updateChatMeta_(scope, m => { m.pendingAckNotices = []; return m; });
  } catch (e) { console.warn('notifyPendingAcks_ push failed:', e && e.message); }
}

/** 〔分享回執〕回執名單 Flex 卡（共用：per-journey 與跨歷程匯總）。acks＝{name,ts,note,title?}，
 *  新→舊。recentLine＝狀態＋最近回執相對時間。opts.showTitle＝每列標歷程名（跨歷程匯總用）。 */
function buildAcksBubble_(headerTitle, recentLine, acks, opts) {
  opts = opts || {};
  const body = [];
  if (recentLine) body.push({ type: 'text', text: recentLine, size: 'xxs', color: THEME.muted, wrap: true });
  body.push({ type: 'separator', margin: 'md' });
  if (!acks.length) {
    body.push({ type: 'text', text: '尚無回執。把網頁分享區的連結傳給對方，對方看完填名字送出就會出現在這裡。', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' });
  }
  acks.slice(0, 12).forEach((a, i) => {
    const when = a.ts ? `${relativeAgoText_(a.ts)}・${Utilities.formatDate(new Date(a.ts), TIME_ZONE, 'MM/dd HH:mm')}` : '';
    const rows = [{
      type: 'box', layout: 'baseline', spacing: 'sm', contents: [
        { type: 'text', text: `📩 ${truncate_(a.name || '匿名', 12)}`, size: 'sm', weight: 'bold', color: THEME.ink, flex: 0 },
        { type: 'text', text: when, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', wrap: true }
      ]
    }];
    if (opts.showTitle && a.title) rows.push({ type: 'text', text: `↳「${truncate_(a.title, 18)}」`, size: 'xxs', color: THEME.depth.l2.accent, wrap: true });
    if (a.note) rows.push({ type: 'text', text: `💬 ${a.note}`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' });
    body.push({ type: 'box', layout: 'vertical', margin: i ? 'md' : 'sm', spacing: 'xs', contents: rows });
  });
  if (acks.length > 12) body.push({ type: 'text', text: `…另有 ${acks.length - 12} 筆（網頁分享區看完整）`, size: 'xxs', color: THEME.muted, margin: 'md' });
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📩 分享回執', size: 'xxs', color: THEME.depth.l2.headerSub },
        { type: 'text', text: headerTitle, size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body }
  };
  if (opts.footer) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{ type: 'text', text: opts.footer, size: 'xxs', color: THEME.muted, wrap: true }] };
  return bubble;
}

/** 〔分享回執·/me 徽章入口〕跨歷程列「新回執」（免費 pull），看完清佇列。 */
function replyAckInbox_(ev, scope) {
  const q = (loadChatMeta_(scope).pendingAckNotices || []).slice().reverse();
  if (!q.length) return lineReply_(ev.replyToken, '📩 目前沒有新回執。各歷程的完整回執名單，可從 /journey 卡上的「📩 …回執」點進去看。');
  const recent = `最近回執 ${relativeAgoText_(q[0].ts)}`;
  try { updateChatMeta_(scope, m => { m.pendingAckNotices = []; return m; }); } catch (_) {}   // 看過＝清新回執
  return lineReplyFlex_(ev.replyToken, `新回執（${q.length} 筆）`,
    buildAcksBubble_(`新回執（${q.length} 筆）`, recent, q, { showTitle: true, footer: '各歷程完整名單見 /journey 卡上「📩 …回執」；分享總覽打 /shares。' }));
}

/** 〔分享回執〕建立者入口：列這條歷程的回執狀況（誰、何時、留言；新→舊；最近回執時間）。 */
function replyJourneyAcks_(ev, scope, jid) {
  const j = loadJourneys_(scope).find(x => x.id === jid);
  if (!j) return lineReply_(ev.replyToken, '這條歷程已更新，請重新 /journey 後再看。');
  const ctx = loadContexts_(scope).find(c => c.id === j.contextId);
  const title = truncate_(journeyTitleParts_(ctx || {}, j).main || '這條歷程', 18);
  const acks = (j.acks || []).slice().reverse();
  const state = j.shareToken ? '🔗 分享開放中' : '⏸ 未開放分享';
  const recent = acks.length ? `${state}・最近回執 ${relativeAgoText_(acks[0].ts)}` : `${state}・尚無回執`;
  return lineReplyFlex_(ev.replyToken, `回執狀況 · ${title}（${acks.length} 人）`,
    buildAcksBubble_(`${title}（${acks.length} 人）`, recent, acks, { footer: '完整名單也在網頁「歷程現況」的分享區。' }));
}

/** 〔分享回執·管理員一覽〕/shares：跨所有歷程的分享/回執總覽——哪些開放分享、各幾人回執、
 *  最近回執時間（log）。建立者管理用。 */
function replyShareOverview_(ev, scope) {
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  const ctxById = {}; loadContexts_(scope).forEach(c => { ctxById[c.id] = c; });
  // 有 shareToken 或曾有 acks 的才列，依「最近回執時間」新→舊（沒回執的排後）。
  const rows = journeys
    .filter(j => j.shareToken || (j.acks || []).length)
    .map(j => {
      const acks = j.acks || [];
      const lastTs = acks.length ? Math.max.apply(null, acks.map(a => Date.parse(a.ts) || 0)) : 0;
      return { j, acks, lastTs, title: journeyTitleParts_(ctxById[j.contextId] || {}, j).main || '未命名' };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
  const totalShared = journeys.filter(j => j.shareToken).length;
  const totalAcks = rows.reduce((n, r) => n + r.acks.length, 0);
  const newN = (loadChatMeta_(scope).pendingAckNotices || []).length;

  const body = [
    { type: 'text', text: `開放分享 ${totalShared} 條・累計 ${totalAcks} 人回執${newN ? `・🔴 ${newN} 筆新` : ''}`, size: 'xxs', color: THEME.muted, wrap: true }
  ];
  if (!rows.length) {
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: '還沒有分享過任何歷程。到一條已定案歷程的網頁「歷程現況」分享區，按「開放分享回執」即可。', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' });
  }
  rows.slice(0, 10).forEach((r, i) => {
    body.push({ type: 'separator', margin: 'md' });
    const sub = `${r.j.shareToken ? '🔗 開放中' : '⏸ 已停止'}・${r.acks.length} 人回執${r.lastTs ? '・最近 ' + relativeAgoText_(r.lastTs) : ''}`;
    body.push({
      type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
      action: { type: 'postback', label: '看回執', data: `action=journey_acks&jid=${r.j.id}`, displayText: opEcho_('回執狀況', r.title) },
      contents: [
        { type: 'text', text: `📩 ${truncate_(r.title, 20)} ›`, size: 'sm', weight: 'bold', color: THEME.ink, wrap: true },
        { type: 'text', text: sub, size: 'xxs', color: THEME.muted, wrap: true }
      ]
    });
  });
  if (rows.length > 10) body.push({ type: 'text', text: `…另有 ${rows.length - 10} 條`, size: 'xxs', color: THEME.muted, margin: 'md' });
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📩 分享回執總覽', size: 'sm', weight: 'bold', color: THEME.onDark },
        { type: 'text', text: '你分享出去的學習歷程·誰回執了', size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{ type: 'text', text: '點任一條看完整回執名單；分享/停止分享在網頁「歷程現況」分享區。', size: 'xxs', color: THEME.muted, wrap: true }] }
  };
  return lineReplyFlex_(ev.replyToken, '分享回執總覽', bubble);
}

/**
 * Per-journey 歷程說明：回一張卡，帶往互動式 HTML 報告（Report.gs / doGet）。
 * 報告即時渲染（零 LLM）：發生節奏、訊息流、內嵌媒體、升格判準、轉折；瀏覽器
 * 列印即存 PDF。舊的伺服器端產 PDF 路徑（summarize* + saveSummaryPdf_）已退役，
 * 但函式留著供 /story 全語料雙版敘事使用。
 */
function replyJourneyStory_(ev, scope, contextId, opts) {
  opts = opts || {};
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 25); } catch (_) {} }
  const journeys = loadJourneys_(scope);
  // 以**穩定的 journey id（opts.jid）**解析優先：contextId 會因背景重分群 re-link 而變動
  // （ContextUpgrade.gs 把 j.contextId 改指到重疊最高的新脈絡），舊通知/舊卡帶的 cid 會過期、
  // 指到已搬空的舊脈絡 → 出現「明明 21 則卻說內容太少」。jid 找得到就用它的**當前** contextId；
  // 沒有 jid（舊按鈕）才退回用 cid 找。
  const journey = (opts.jid && journeys.find(j => j.status === 'journey' && j.id === opts.jid))
               || journeys.find(j => j.status === 'journey' && j.contextId === contextId);
  const context = journey && loadContexts_(scope).find(c => c.id === journey.contextId);
  if (!journey || !context) {
    return lineReply_(ev.replyToken, '這條歷程已更新，請重新 /journey 後再進入。');
  }
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (context.recordIds || []).map(id => recById[id]).filter(Boolean)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  let url = '';
  try { url = journeyReportUrl_(scope, journey.id); } catch (e) { console.error('journey report url failed:', e && e.message); }

  // 落差分析（與網頁共用、同內容必同分；移除片段後 version 變 → 自動重算）。
  const finalized = !!(journey.finalized || context.finalized);
  const gap = getOrComputeJourneyGap_(scope, journey, context, records);

  // 方向訊號：剛移除/放回時，比對前後分數＋哪一格翻了，放導覽卡頂；移除可即時「放回」。
  let topNote = null;
  if (opts.beforeGap !== undefined) topNote = storyDeltaLine_(opts.beforeGap, gap, context.id, opts.justRemovedRid);
  else if (opts.restoredNote) topNote = { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', contents: [{ type: 'text', text: '↩ 已放回，回到移除前。', size: 'sm', weight: 'bold', color: THEME.cta, wrap: true }] };

  const nav = buildStoryNavBubble_(journey, context, records, gap, url, finalized, topNote);

  // 瀏覽卡：一段敘事片段內，記錄逐筆可「✕ 移除」（已定案＝唯讀，不放 ✕）。
  // 〔卡高上限〕不是看「筆數」而是看**實際內容量（估計卡高）**：有的筆很長、有的很短，所以
  // 用 chunkStoryRecords_ 依每則估計行數累加切卡——一張卡可放很多短則、或少數幾則長則，
  // 但各卡高度大致一致。同段切多卡時標「· 第p/共n頁」。
  const episodes = groupByEpisode_(records, SESSION_GAP_MINUTES * 60 * 1000);
  // 不在卡上呈現機器數據(貼合度/貢獻度)——回歸學習者自己逐則細讀判斷。keySet 僅供保護轉折關鍵。
  const keySet = journeyKeySet_(journey, records);
  const browse = [];
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const chunks = chunkStoryRecords_(ep.records || [], keySet);   // 依內容量估高度切，不是固定筆數
    for (let p = 0; p < chunks.length; p++) {
      browse.push(buildStoryBrowseBubble_(
        { startTs: ep.startTs, endTs: ep.endTs, records: chunks[p] },
        i + 1, episodes.length, context.id, records, finalized, keySet,
        chunks.length > 1 ? { page: p + 1, pages: chunks.length } : null));
    }
  }
  const title = journeyTitleParts_(context, journey).main;

  // 〔頁面控制列〕真實使用片段可能 >12 張卡（carousel 上限），故分頁。導覽卡為第 0 張、
  // 只在第 1 頁出現（同 /journey、/recall 作法）；paginateFlexCards_ 依張數＋JSON 位元組
  // 動態決定每頁卡數，頁碼列（buildPaginationBubble_）另發一則訊息接在輪播下方。
  const allCards = [nav].concat(browse);
  const pg = paginateFlexCards_(allCards, opts.page || 0);
  const page = pg.page, totalPages = pg.totalPages, pageCards = pg.pageCards;
  const resultContents = pageCards.length === 1 ? pageCards[0] : { type: 'carousel', contents: pageCards };
  const altText = totalPages > 1
    ? `歷程現況 · ${truncate_(title, 16)}（第 ${page + 1}/${totalPages} 頁）`
    : `歷程現況 · ${truncate_(title, 20)}`;
  if (totalPages <= 1) return lineReplyFlex_(ev.replyToken, altText, resultContents);
  lineReplyMessages_(ev.replyToken, [
    { type: 'flex', altText: altText, contents: resultContents },
    { type: 'flex', altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(`👉 歷程現況（${totalPages} 頁）`, page, totalPages,
        p => `action=story_browse_page&cid=${context.id}&jid=${journey.id}&p=${p}`) }
  ]);
}

/** 小工具：●○ 等級點、區塊量尺。 */
function storyDots_(n, max) { n = n || 0; let s = ''; for (let i = 0; i < max; i++) s += (i < n ? '●' : '○'); return s; }
function storyScoreBlock_(pct) {
  pct = Math.max(0, Math.min(100, pct | 0));
  const filled = Math.round(pct / 10);
  const color = pct < 40 ? (THEME.warning || '#e0a83e') : (pct < 70 ? THEME.cta : THEME.success);
  return [
    { type: 'text', text: `佔「有意義學習歷程」約 ${pct}%`, size: 'sm', weight: 'bold', color: color, wrap: true },
    { type: 'text', text: '▰'.repeat(filled) + '▱'.repeat(10 - filled), size: 'sm', color: color }
  ];
}

/** 方向訊號：剛移除/放回後，前後分數差＋哪一格翻了＋「↩ 放回」即時反悔。before 可為 null。 */
function storyDeltaLine_(before, after, cid, rid) {
  const haveDelta = !!before;
  const bScore = before ? before.score : 0;
  const aScore = after ? after.score : 0;
  const d = aScore - bScore;
  const arrow = d > 0 ? '↗' : (d < 0 ? '↘' : '＝');
  const sign = d > 0 ? `+${d}%` : (d < 0 ? `${d}%` : '不變');
  const color = !haveDelta ? THEME.muted : (d > 0 ? THEME.success : (d < 0 ? (THEME.warning || '#e0a83e') : THEME.muted));
  const head = !haveDelta ? '剛移除一則' : (after ? `${arrow} 剛移除：${sign}` : `${arrow} 剛移除（內容已不足以評分）`);
  const contents = [{ type: 'text', text: head, size: 'sm', weight: 'bold', color: color, wrap: true }];
  if (haveDelta && after) {
    const names = { conceptDepth: '概念', crossTopic: '跨主題', actionOrient: '行動', metaReflection: '後設' };
    const bl = before.levels || {}, al = after.levels || {};
    const d4 = f => Math.round(Math.max(0, Math.min(1, f || 0)) * 4);   // 連續 0~1 → 4 格
    const chg = [];
    for (const k in names) if (d4(bl[k]) !== d4(al[k])) chg.push(`${names[k]} ${storyDots_(d4(bl[k]), 4)}→${storyDots_(d4(al[k]), 4)}`);
    if (chg.length) contents.push({ type: 'text', text: '（' + chg.join('、') + '）', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
    const note = d > 0 ? '這筆在稀釋，移掉對了' : (d < 0 ? '這筆其實有貢獻——要不要放回？' : '這筆對評估沒影響');
    contents.push({ type: 'text', text: note, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
  }
  if (rid) contents.push({
    type: 'box', layout: 'vertical', backgroundColor: '#ffffff', cornerRadius: 'md', paddingAll: 'xs', margin: 'sm', borderWidth: '1px', borderColor: THEME.cta,
    action: { type: 'postback', data: `action=story_undrop&cid=${cid}&rid=${rid}`, displayText: '▸ 復原剛移除的片段' },
    contents: [{ type: 'text', text: '↩ 放回剛移除的這則', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
  });
  return { type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', contents: contents };
}

/** 導覽卡（輪播第 0 張）：標題＋分析成績＋「📖 瀏覽歷程現況」連網頁完整版。 */
function buildStoryNavBubble_(journey, context, records, gap, url, finalized, topNote) {
  const tp = journeyTitleParts_(context, journey);
  const kw = journey.keywords || {};
  const kwStr = [kw.category].concat(kw.tags || []).filter(Boolean).join('｜');
  const body = [
    { type: 'text', text: truncate_(tp.main, 24), size: 'md', weight: 'bold', color: THEME.text, wrap: true }
  ];
  if (tp.sub) body.push({ type: 'text', text: `依現況內容：${truncate_(tp.sub, 26)}`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
  if (kwStr) body.push({ type: 'text', text: kwStr, size: 'xxs', color: THEME.depth.l2.accent, wrap: true, margin: 'xs' });
  body.push({ type: 'text', text: `源於 ${(context.recordIds || []).length} 則・橫跨 ${context.firstTs ? spanLabel_(context.firstTs, context.lastTs) : '—'}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true });
  // 〔情緒層 §C〕心情軌跡：這條歷程沿途的貼圖情緒弧線（時序、連續同情緒收合）——學習的情感歷程一眼可見。
  {
    const arc = journeyEmotionArc_(records);
    if (arc) body.push({
      type: 'text', wrap: true, size: 'xxs', margin: 'xs',
      contents: [
        { type: 'span', text: '心情軌跡　', color: THEME.muted },
        { type: 'span', text: arc.chain, color: THEME.text },
        { type: 'span', text: `（${arc.n} 次）`, color: THEME.muted }
      ],
      text: `心情軌跡 ${arc.chain}（${arc.n} 次）`
    });
  }

  if (gap) {
    // 評估面板：把「佔有意義學習歷程 %＋四轉折發展度＋還缺」收進一個 surface 區塊，
    // 視覺上一眼讀成「一組評估」（編排優化、元素不變）。
    const lv = gap.levels || {};
    const d4 = f => storyDots_(Math.round(Math.max(0, Math.min(1, f || 0)) * 4), 4);
    const panel = storyScoreBlock_(gap.score).slice();
    // 四轉折發展度排成 2×2 格（概念｜跨主題 / 行動｜後設），避免單行折行把「行動」跟它的點拆開。
    // label 用全形空白補到等寬（4 格），讓同欄的點起點對齊（跨主題3字 vs 後設2字 也對齊）。
    const dimCell = (label, frac) => {
      const lead = label + '　'.repeat(Math.max(1, 4 - label.length));
      return {
        type: 'text', size: 'xxs', flex: 1, wrap: false, text: `${lead}${d4(frac)}`,
        contents: [{ type: 'span', text: lead, color: THEME.muted }, { type: 'span', text: d4(frac), color: THEME.textBody }]
      };
    };
    panel.push({
      type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'md', contents: [dimCell('概念', lv.conceptDepth), dimCell('跨主題', lv.crossTopic)] },
        { type: 'box', layout: 'horizontal', spacing: 'md', contents: [dimCell('行動', lv.actionOrient), dimCell('後設', lv.metaReflection)] }
      ]
    });
    panel.push({ type: 'text', text: '●＝發展程度（四種學習轉折，算出上面的 %）', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
    if (gap.missing && gap.missing.length) {
      panel.push({ type: 'separator', margin: 'sm' });
      panel.push({ type: 'text', text: '⬜ 還缺：' + truncate_(gap.missing[0], 30), size: 'xxs', color: THEME.textBody, wrap: true, margin: 'sm' });
    }
    body.push({ type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'md', margin: 'md', spacing: 'xs', contents: panel });
    body.push({ type: 'text', text: '※ 初步評估、非成績。分數由固定公式算出，移除片段才會變。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
  } else {
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: '（內容還太少，暫時無法評估落差）', size: 'xxs', color: THEME.muted, margin: 'sm' });
  }
  body.push({ type: 'text',
    text: finalized ? '🔒 已定案・唯讀：內容鎖定，不能再移除或改歸片段。' : '👉 滑右邊逐段檢視；不屬於這條的，逐則「✕」移除，分數會跟著更新。',
    size: 'xxs', color: finalized ? THEME.success : THEME.muted, wrap: true, margin: 'md' });

  if (topNote) body.unshift(topNote);

  const card = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: finalized ? THEME.success : THEME.cta, paddingAll: 'md',
      contents: [
        breadcrumbTrail_(['／journey', truncate_(tp.main, 14)], finalized ? '✅ 已定案（唯讀）' : '🧭 歷程現況',
          { headerSub: finalized ? THEME.onDark : THEME.depth.l2.headerSub, headerText: THEME.onDark }),
        { type: 'text', text: '🌳 學習歷程現況', size: 'sm', weight: 'bold', color: THEME.onDark, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm', contents: body }
  };
  // 〔2026-06-03 取消觀看門檻〕不再用「分數沒到就鎖」（把鏡子變考卷）。但若移除到
  // gap=null＝內容已不足以評分，網頁完整版沒有有意義的現況可看 → 按鈕變灰、不可點
  // （這是「沒東西可看」，不是「及格才給看」，philosophy 一致；卡身已說明內容不足）。
  if (url) {
    const enabled = !!gap;
    const btn = {
      type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'md',
      backgroundColor: enabled ? THEME.cta : (THEME.surfaceSoft || '#e6e6e6'),
      contents: [{ type: 'text', text: '📖 瀏覽歷程現況', size: 'sm', align: 'center', weight: 'bold',
        color: enabled ? THEME.onDark : (THEME.faint || '#9aa0a6') }]
    };
    if (enabled) btn.action = { type: 'uri', label: '瀏覽歷程現況', uri: url };  // 不足以評分時不掛 action＝不可點
    card.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [btn] };
  }
  return card;
}

// 瀏覽卡逐則的內容截斷上限（字）。chunkStoryRecords_ 估高度與 buildStoryBrowseBubble_ 顯示
// 都用這個值——兩者必須一致，卡高上限才算得準。
const STORY_ROW_TEXT_MAX = 160;

/** 估計一則記錄在瀏覽卡上佔的「行數」(≈高度)：時間列 1 行 + 內容折行數(內容截到上限才估)
 *  + 轉折關鍵標籤 1 行。用來依「實際內容量」而非固定筆數切卡，讓各卡高度大致一致。 */
function storyRowLines_(r, keySet) {
  const CHARS_PER_LINE = 16;   // kilo 泡泡 sm 字級，CJK 一行約這麼多（保守，Latin 會高估行數）
  let text = (r.text || '').trim();
  const kt = (keySet && keySet[r.id]) || null;
  const isKey = !!(kt && kt.length);
  if (isKey) {
    const mm = text.match(/💡\s*([\s\S]+)$/);
    if (mm && /^\s*🔍\s*探問/.test(text)) text = mm[1].trim();
  }
  const shown = Math.min(text.length || 0, STORY_ROW_TEXT_MAX) || 6;   // 媒體無文字也佔一行
  return 1 /*時間列*/ + Math.max(1, Math.ceil(shown / CHARS_PER_LINE)) + (isKey ? 1 : 0);
}

/** 依估計卡高把一段的記錄 greedy 切成多張卡：累加 storyRowLines_ 到 STORY_MAX_LINES 就換卡。
 *  每卡至少 1 則（單則超長也自成一卡，高度由 STORY_ROW_TEXT_MAX 截斷封頂）。 */
function chunkStoryRecords_(records, keySet) {
  const STORY_MAX_LINES = 12;
  const chunks = [];
  let cur = [], curLines = 0;
  for (const r of (records || [])) {
    const cost = storyRowLines_(r, keySet);
    if (cur.length && curLines + cost > STORY_MAX_LINES) { chunks.push(cur); cur = []; curLines = 0; }
    cur.push(r); curLines += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks.length ? chunks : [[]];   // 空段也回一張空卡（顯示「此段已無記錄」）
}

/* ===== 貼圖情緒層（歷程現況呈現）=====
 * 貼圖＝當下情緒，不該以「一則內容」平鋪在敘事裡。這組 helper 讓歷程現況：
 * 段落折疊（B·貼圖跟著它回應的那句）、心情軌跡弧線（C·導覽卡）、節奏條對齊情緒列（D）。 */

/** 貼圖記錄的情緒片語（去掉「[貼圖] 」前綴）。 */
function stickerPhrase_(r) {
  return ((r && r.text) || '').replace(/^\[貼圖\]\s*/, '').trim() || '貼圖';
}

/** 心情軌跡：依時間序把貼圖轉成 emoji 弧線（連續同 emoji 收合、上限 8）。回 {chain,n} 或 null。 */
function journeyEmotionArc_(records) {
  const sts = (records || []).filter(r => r && r.type === 'sticker' && r.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!sts.length) return null;
  const emojis = [];
  sts.forEach(r => {
    const e = recordEmoji_(r);
    if (emojis[emojis.length - 1] !== e) emojis.push(e);
  });
  return { chain: emojis.slice(0, 8).join(' → ') + (emojis.length > 8 ? ' …' : ''), n: sts.length };
}

/** 節奏條對齊情緒列：與 episodeTimelineStrip_ 同一套 bucket 數學（kilo=12 格、flex:1 cell），
 *  貼圖落在哪格、該格就顯示其 emoji（同格多張取最後一張）、否則 '·'。橫軸＝allRecords 全跨度，
 *  或由呼叫端傳入明確 winStart/winEnd（要疊在某條 strip 正下方對齊時用同一視窗）。無貼圖回 null。 */
function emotionCellsRow_(allRecords, winStart, winEnd) {
  let startTs = winStart, endTs = winEnd;
  if (startTs == null || endTs == null) {
    const tsList = (allRecords || []).map(r => Date.parse(r && r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
    if (tsList.length < 2) return null;
    startTs = tsList[0]; endTs = tsList[tsList.length - 1];
  }
  const span = endTs - startTs;
  const B = 12;
  const cells = new Array(B).fill(null);
  let any = false;
  (allRecords || []).forEach(r => {
    if (!r || r.type !== 'sticker') return;
    const t = Date.parse(r.ts);
    if (isNaN(t)) return;
    let b = span <= 0 ? 0 : Math.floor((t - startTs) / span * B);
    if (b < 0) b = 0; if (b >= B) b = B - 1;
    cells[b] = recordEmoji_(r);
    any = true;
  });
  if (!any) return null;
  return {
    type: 'box', layout: 'horizontal', margin: 'xs',
    contents: cells.map(e => ({ type: 'text', text: e || '·', size: 'xs', flex: 1, align: 'center', gravity: 'center', color: e ? THEME.text : THEME.faint }))
  };
}

/** 瀏覽卡：一段敘事片段，hero 縮圖＋卡內逐筆（✕ 固定右欄、媒體開啟）＋整段記寫時間分布條。
 *  journeyRecords＝整條現況的所有記錄，給時間分布條把這段定位在整條跨度裡。 */
function buildStoryBrowseBubble_(ep, idx, total, cid, journeyRecords, finalized, keySet, pageInfo) {
  const start = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'MM/dd HH:mm');
  const sameDay = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'yyyy-MM-dd')
              === Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, 'yyyy-MM-dd');
  const end = Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, sameDay ? 'HH:mm' : 'MM/dd HH:mm');
  const range = ep.startTs === ep.endTs ? start : `${start}–${end}`;
  const hero = journeyHeroFromRecord_(pickJourneyHeroRecord_(ep.records));

  // 每則一列：左＝時間/內容（flex 1），右＝固定欄（媒體開啟 + ✕，✕ 永遠在右上同位置）。
  // 卡高已由外層 chunkStoryRecords_（依估計行數）控制，這裡只需把每則內容截到同一上限，
  // 避免單一則超長（如貼整篇文章）把卡撐爆——完整內容仍可在 /recall 或網頁版看。
  const ROW_TEXT_MAX = STORY_ROW_TEXT_MAX;
  const rows = [];
  // 〔情緒層 §B〕貼圖折進它對應的那句（emotionFor 優先、否則前一句）——敘事段落自帶當下心情，
  // 貼圖不再像一則內容平鋪。最前頭無宿主的貼圖（少見）仍自成一列。
  const items = [];
  const itemIdxById = {};
  for (const rr of ep.records) {
    if (rr && rr.type === 'sticker') {
      const emo = { emoji: recordEmoji_(rr), phrase: stickerPhrase_(rr) };
      let host = null;
      if (rr.emotionFor && itemIdxById[rr.emotionFor] != null) host = items[itemIdxById[rr.emotionFor]];
      else if (items.length) host = items[items.length - 1];
      if (host) { (host.emotions = host.emotions || []).push(emo); continue; }
    }
    if (rr && rr.id) itemIdxById[rr.id] = items.length;
    items.push({ rec: rr });
  }
  for (let k = 0; k < items.length; k++) {
    const r = items[k].rec;
    const emos = items[k].emotions || [];
    if (k > 0) rows.push({ type: 'separator', margin: 'sm' });
    const t = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'HH:mm');
    const icon = EPISODE_TYPE_ICON[r.type] || '·';
    const kt = (keySet && keySet[r.id]) || null;   // 此筆承載的轉折型別陣列（關鍵記錄才有）
    const isKey = !!(kt && kt.length);
    // 關鍵記錄＝補一個轉折寫的：去掉「🔍 探問：…💡 」鷹架前綴，只留你寫的轉折內容。
    let full = truncate_((r.text || '').trim(), ROW_TEXT_MAX) || `（${typeLabel_(r.type)}）`;
    if (isKey) {
      const mm = (r.text || '').match(/💡\s*([\s\S]+)$/);
      if (mm && /^\s*🔍\s*探問/.test(r.text || '')) full = truncate_(mm[1].trim(), ROW_TEXT_MAX);
    }
    const right = [];   // 已定案＝唯讀，不放 ✕ 移除；媒體開啟仍保留。
    if (r.fileId && r.type !== 'image') {
      right.push({
        type: 'box', layout: 'vertical', width: '30px', height: '30px', cornerRadius: 'md', backgroundColor: THEME.surfaceSoft, justifyContent: 'center',
        action: { type: 'uri', label: '開啟', uri: `https://drive.google.com/file/d/${r.fileId}/view` },
        contents: [{ type: 'text', text: r.type === 'audio' ? '▶' : '📎', size: 'sm', align: 'center', color: THEME.cta }]
      });
    }
    if (isKey) {
      // 轉折關鍵：不給 ✕（脈絡生為歷程的依據，不可移除），改顯示 🔒。
      right.push({
        type: 'box', layout: 'vertical', width: '30px', height: '30px', cornerRadius: 'md', backgroundColor: THEME.surfaceSoft, justifyContent: 'center',
        contents: [{ type: 'text', text: '🔒', size: 'sm', align: 'center' }]
      });
    } else if (!finalized) {
      right.push({
        type: 'box', layout: 'vertical', width: '30px', height: '30px', cornerRadius: 'md', backgroundColor: '#fdeef0', justifyContent: 'center',
        action: { type: 'postback', data: `action=story_drop_confirm&cid=${cid}&rid=${r.id}`, displayText: opEcho_('移除片段', full) },
        contents: [{ type: 'text', text: '✕', size: 'sm', weight: 'bold', color: '#b9404a', align: 'center' }]
      });
    }
    const leftContents = [{ type: 'text', text: `${t} ${icon}`, size: 'xxs', color: THEME.muted }];
    if (isKey) {
      // 標出它「實際是哪一種轉折」——不再泛稱探問。
      const lbl = kt.map(ty => ((JOURNEY_MARKER_STYLE[ty] || {}).icon || '🔑') + ' ' + ty).join('・');
      leftContents.push({ type: 'text', text: `🔑 轉折關鍵・${lbl}（不可移除）`, size: 'xxs', color: THEME.success, weight: 'bold', wrap: true });
    }
    leftContents.push({ type: 'text', text: full, size: 'sm', color: THEME.textBody, wrap: true });
    // 〔情緒層 §B〕這句收到的貼圖情緒：折在句子下方一行（emoji＋情緒詞），不另佔一列。
    emos.forEach(e => leftContents.push({
      type: 'text', text: `${e.emoji} 當下心情：${truncate_(e.phrase, 18)}`, size: 'xxs', color: THEME.muted, wrap: true
    }));
    const rowContents = [{ type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: leftContents }];
    if (right.length) rowContents.push({ type: 'box', layout: 'horizontal', flex: 0, spacing: 'xs', contents: right });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: rowContents });
  }
  if (!rows.length) rows.push({ type: 'text', text: '（此段已無記錄）', size: 'xs', color: THEME.muted });

  // 記寫時間分布條：把這段的記錄定位在整條現況的跨度裡（✓ 本段 / ● 其他段）。
  const strip = corpusTimelineStrip_(ep.records, journeyRecords);
  if (strip) {
    rows.push({ type: 'separator', margin: 'md' });
    rows.push(strip);
    // 〔情緒層 §D〕節奏條正下方、同 12 格對齊的情緒列：貼圖落在哪格、emoji 就在哪格——
    // 情緒疊在節奏上（橫軸同上＝整條歷程跨度）。
    const emoRow = emotionCellsRow_(journeyRecords);
    if (emoRow) {
      rows.push(emoRow);
      rows.push({ type: 'text', text: '↑ 心情落點（整條歷程）', size: 'xxs', color: THEME.faint, align: 'center' });
    }
  }

  // 不在卡上呈現機器數據——讓學習者專注讀每一則內容、自己判斷。
  const bodyContents = rows;

  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l2.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbTrail_(['歷程現況'], `敘事片段 ${idx}/${total}` + (pageInfo ? `　· 第${pageInfo.page}/共${pageInfo.pages}頁` : ''),
          { headerSub: THEME.depth.l2.headerSub, headerText: THEME.depth.l2.headerText }),
        { type: 'text', text: range, size: 'sm', weight: 'bold', color: THEME.depth.l2.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'none', contents: bodyContents }
  };
  if (hero) bubble.hero = hero;
  return bubble;
}

/** 這條歷程的「轉折關鍵」記錄 → 它承載的轉折型別陣列。＝已存 keyRecordIds（新升格記下，
 *  無對應型別時給全部 marker 型別）∪ 用 markers 的 (type,evidence) 回頭比對到的記錄。
 *  回傳 { recordId: ['後設反思', ...] }；非關鍵記錄不在其中。新舊歷程都適用，免遷移。 */
function journeyKeySet_(journey, records) {
  const out = {};
  const markers = (journey && journey.markers) || [];
  const norm = s => String(s || '').replace(/\s+/g, '');
  const allTypes = markers.map(m => m.type).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i);
  (records || []).forEach(r => {
    const rt = norm(r.text);
    if (!rt) return;
    const head = rt.slice(0, 40);
    const types = [];
    markers.forEach(m => {
      const e = norm(m.evidence);
      if (e.length >= 8 && (rt.indexOf(e.slice(0, 40)) >= 0 || e.indexOf(head) >= 0)) {
        if (m.type && types.indexOf(m.type) < 0) types.push(m.type);
      }
    });
    if (types.length) out[r.id] = types;
  });
  ((journey && journey.keyRecordIds) || []).forEach(id => {
    if (id && !out[id]) out[id] = allTypes.length ? allTypes.slice() : ['轉折'];
  });
  return out;
}

/** 哪些「轉折種類」目前對得上**本脈絡現存**記錄（沿用 journeyKeySet_ 的歸戶判定，與 ✕ 守門同一套）。
 *  回 { type: true }。用來認出「孤兒轉折」——引用的記錄已不在本脈絡（被移除或背景重新分群移走）。
 *  注意：只認落在現存 records 上的歸戶；keyRecordIds 指到已不在脈絡的記錄不算數（否則孤兒會被誤判為仍成立）。 */
function groundedMarkerTypes_(journey, records) {
  const present = {}; (records || []).forEach(r => { if (r && r.id) present[r.id] = true; });
  const ks = journeyKeySet_(journey, records);
  const s = {};
  Object.keys(ks).forEach(rid => { if (present[rid]) (ks[rid] || []).forEach(t => { s[t] = true; }); });
  return s;
}

/** 這筆是否為某條歷程的「轉折關鍵」記錄（脈絡生為歷程的依據，不可移除）。 */
function isJourneyKeyRecord_(scope, cid, rid) {
  const j = loadJourneys_(scope).find(x => x.status === 'journey' && x.contextId === cid);
  if (!j) return false;
  if ((j.keyRecordIds || []).indexOf(rid) >= 0) return true;
  const recById = {}; loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const ctx = loadContexts_(scope).find(c => c.id === cid);
  const recs = ((ctx && ctx.recordIds) || []).map(id => recById[id]).filter(Boolean);
  return !!journeyKeySet_(j, recs)[rid];
}

/** ✕ 的確認泡泡：確定移除才真的 drop（避免誤觸）。 */
/** 試算「移除這筆後」脈絡三條件（語意密度／意向回返／跨媒介）有沒有從『達標』掉成『不達標』，
 *  回每條被破壞的**具體理由**（含投影值＋門檻）。只在「本來達標、移除後不達標」時提醒——從沒
 *  達標的不算你破壞的。**不退格**（升格只進不退是刻意設計，退了背景也會復活；轉折鎖住、這條
 *  仍合法是歷程）——純誠實提醒，讓使用者知情後自己決定。回 string[]（空＝沒破壞任何條件）。 */
function previewRemovalImpact_(scope, cid, rid) {
  try {
    const ctx = loadContexts_(scope).find(c => c.id === cid);
    if (!ctx) return [];
    const curIds = (ctx.recordIds || []).filter(Boolean);
    if (curIds.indexOf(rid) < 0) return [];
    const byId = {};
    const all = loadEmbeddingRecords_(scope);
    all.forEach(r => { byId[r.id] = r; });
    const recsAll = curIds.map(id => byId[id]).filter(r => r && r.embedding);
    const recsRemain = curIds.filter(x => x !== rid).map(id => byId[id]).filter(r => r && r.embedding);
    if (recsAll.length < 2 || !recsRemain.length) return [];   // 算不出有意義差異
    const corpusMedia = all.filter(r => r.embedding && CONTEXT_MEDIA_TYPES[r.type] && r.type !== 'text');
    const evalSet = recs => evaluateContextCriteria_(recs, [meanVector_(recs.map(r => r.embedding))], 0, corpusMedia);
    const C = CONTEXT_CRITERIA;
    const before = evalSet(recsAll), after = evalSet(recsRemain);
    const warns = [];
    if (densityConditionMet_(before) && !densityConditionMet_(after)) {
      warns.push(`語意密度將降到 ${after.semanticDensity.toFixed(2)}（需 ≥${C.semanticDensityMin}，或聚焦補償）`);
    }
    const okBefore = before.returnVisits >= C.returnVisitsMin && before.returnSpanHours >= C.returnSpanHoursMin;
    const okAfter = after.returnVisits >= C.returnVisitsMin && after.returnSpanHours >= C.returnSpanHoursMin;
    if (okBefore && !okAfter) {
      if (after.returnVisits < C.returnVisitsMin) warns.push(`意向回返將剩 ${after.returnVisits} 次（需 ≥${C.returnVisitsMin}）`);
      else warns.push(`回返首末跨度將剩 ${after.returnSpanHours.toFixed(1)} 小時（需 ≥${C.returnSpanHoursMin}）`);
    }
    if (before.mediaKinds >= C.mediaKindsMin && after.mediaKinds < C.mediaKindsMin) {
      warns.push(`跨媒介將剩 ${after.mediaKinds} 種媒介（需 ≥${C.mediaKindsMin}）`);
    }
    return warns;
  } catch (e) {
    console.warn('previewRemovalImpact_ failed:', e && e.message);
    return [];
  }
}

function replyStoryDropConfirm_(ev, scope, cid, rid) {
  const rec = loadEmbeddingRecords_(scope).find(r => r.id === rid);
  const snippet = rec ? (truncate_((rec.text || '').replace(/\s+/g, ' '), 60) || `（${typeLabel_(rec.type)}）`) : '（找不到該則）';
  const warns = previewRemovalImpact_(scope, cid, rid);
  const body = [
    { type: 'text', text: `「${snippet}」`, size: 'sm', color: THEME.text, wrap: true },
    { type: 'text', text: '移除後它退成零散片段、不再回到這條現況（仍留在時間軸與搜尋，沒有刪除）。分數會重新計算。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' }
  ];
  if (warns.length) {
    const box = [{ type: 'text', text: '⚠️ 移除會破壞當初成形的條件：', size: 'xxs', weight: 'bold', color: '#9a6a00', wrap: true }];
    warns.forEach(w => box.push({ type: 'text', text: '・' + w, size: 'xxs', color: '#9a6a00', wrap: true, margin: 'xs' }));
    box.push({ type: 'text', text: '仍以「轉折」成立為學習歷程、不會退格——只是讓你知道動到了什麼。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
    body.push({ type: 'box', layout: 'vertical', backgroundColor: '#fff6e5', cornerRadius: 'md', paddingAll: 'sm', margin: 'md', contents: box });
  }
  lineReplyFlex_(ev.replyToken, '移除確認', {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#b9404a', paddingAll: 'md',
      contents: [{ type: 'text', text: '移除這則片段？', size: 'sm', weight: 'bold', color: '#ffffff' }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'sm', contents: [
      { type: 'box', layout: 'vertical', flex: 1, backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', data: 'action=story_drop_cancel', displayText: '▸ 取消移除' },
        contents: [{ type: 'text', text: '取消', size: 'sm', align: 'center', color: THEME.cta, weight: 'bold' }] },
      { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#b9404a', cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', data: `action=story_drop&cid=${cid}&rid=${rid}`, displayText: '▸ 確定移除片段' },
        contents: [{ type: 'text', text: '✕ 確定移除', size: 'sm', align: 'center', color: '#ffffff', weight: 'bold' }] }
    ]}
  });
}

/**
 * Per-(scope, baseName) counter for how many times this exact summary has
 * been requested. baseName starts with the YYYY-MM-DD prefix, so counters
 * naturally roll over at midnight and don't bleed across days.
 */
function bumpSummaryCount_(scope, baseName) {
  const key = `summary_count:${scope.key}:${baseName}`;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return 1;
  try {
    const props = PropertiesService.getScriptProperties();
    const next = parseInt(props.getProperty(key) || '0', 10) + 1;
    props.setProperty(key, String(next));
    return next;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Shared summary-style Flex bubble for /now /story.
 *   header  — title (white on navy)
 *   body    — preview text (stripped of markdown) + subtitle
 *   footer  — primary button that opens the PDF (URL hidden in action)
 */
function buildSummaryBubble_(opts) {
  const { title, subtitle, preview, pdfFile, strip, eyebrow, moodFocus, moodArc, genStamp, genCount } = opts;
  const pdfUrl = pdfFile.getUrl();

  const bodyContents = [];
  if (preview) {
    if (eyebrow) bodyContents.push({ type: 'text', text: eyebrow, size: 'xxs', color: THEME.muted, weight: 'bold' });
    bodyContents.push({ type: 'text', text: preview, size: 'sm', color: THEME.textBody, wrap: true, maxLines: 6, margin: eyebrow ? 'xs' : 'none' });
  }
  // 〔情緒層〕心情・聚焦凸顯面板：Gemini 從語感讀出的態度＋聚焦程度（凸顯），底下接整個心情軌跡弧線。
  // 兩者皆 optional（/story 不傳，不會渲染）。用 surface 底色框起來＝視覺上「凸顯」這段。
  if (moodFocus || moodArc) {
    const panel = [{ type: 'text', text: '🎭 今日心情・聚焦', size: 'xs', weight: 'bold', color: THEME.depth.l2.accent }];
    if (moodFocus) panel.push({ type: 'text', text: moodFocus, size: 'sm', color: THEME.textBody, wrap: true, margin: 'xs' });
    if (moodArc) panel.push({ type: 'text', text: `心情軌跡　${moodArc.chain}（${moodArc.n} 次）`, size: 'xs', color: THEME.textDim, wrap: true, margin: 'xs' });
    bodyContents.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, cornerRadius: 'md', paddingAll: 'md', margin: 'md',
      contents: panel
    });
  }
  if (strip) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push(strip);
  }
  if (subtitle) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: subtitle, size: 'xxs', color: THEME.muted, margin: 'sm', wrap: true });
  }
  // 產出檔案的時間點（年月日時分）——讓使用者一眼知道這份總結是何時生成的。
  if (genStamp) {
    bodyContents.push({ type: 'text', text: `🕒 產出時間 ${genStamp}${genCount ? `（第 ${genCount} 次）` : ''}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true });
  }

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: THEME.cta, paddingAll: 'lg',
      contents: (opts.crumb ? [breadcrumbKicker_(opts.crumb, THEME.depth.l1)] : []).concat([
        { type: 'text', text: title, weight: 'bold', size: 'lg', color: THEME.onDark, wrap: true, margin: opts.crumb ? 'xs' : 'none' }
      ])
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', spacing: 'sm',
      contents: bodyContents.length ? bodyContents : [
        { type: 'text', text: ' ', size: 'xxs', color: THEME.onDark }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'uri', label: '開啟完整 PDF', uri: pdfUrl },
        contents: [{ type: 'text', text: '📄 開啟完整 PDF', size: 'sm', color: THEME.ctaText, align: 'center', weight: 'bold' }]
      }]
    }
  };
}

/** Prompt builder for the "give me everything" path (the 詳細 mode). */
function buildFullPrompt_(type, originalName) {
  switch (type) {
    case 'image':
      return [
        '請完整描述這張圖片，繁體中文：',
        '- 完整列出圖中可辨識的所有文字（OCR）',
        '- 描述視覺元素 / 圖示 / 結構 / 排版',
        '- 若是學習材料，逐項列出所有可見的重點，不省略',
        '不限字數，保留所有細節。'
      ].join('\n');
    case 'audio':
      return [
        '請完整逐字轉錄這段語音，繁體中文：',
        '- 完整逐字稿，保留說話者語氣、停頓、重複',
        '- 若有多位說話者，標記 [A] [B] 等',
        '- 不要摘要、不要省略',
        '- 末尾可附 1-3 句重點總結'
      ].join('\n');
    case 'video':
      return [
        '請完整處理這段影片，繁體中文：',
        '- 完整語音逐字稿',
        '- 視覺場景描述（畫面切換、人物、文字）',
        '- 若是學習材料，逐項列出所有重點',
        '不限字數。'
      ].join('\n');
    case 'file':
      return [
        `請完整摘錄這份檔案「${originalName || '未命名'}」，繁體中文：`,
        '- 章節結構',
        '- 每個段落的重點',
        '- 所有關鍵詞 / 專有名詞 / 數據',
        '- 結論',
        '不限字數，保留所有細節。'
      ].join('\n');
    default:
      return '請完整描述這段內容，不限字數，保留所有細節。';
  }
}

const EPISODE_GAP_MS = SESSION_GAP_MINUTES * 60 * 1000;  // same 30-min boundary as sessions
const EPISODE_MAX_CARDS = 10;                            // LINE carousel allows 12
const EPISODE_NARRATIVE_BUDGET = 6;                      // max fresh Gemini syntheses per view (bounds latency)
const EPISODE_TYPE_ICON = { text: '📝', link: '🔗', image: '🖼️', audio: '🎤', video: '🎬', file: '📄', sticker: '😀', location: '📍' };

/**
 * Breadcrumb kicker — the small navigation-trail line at the top of a card
 * header (e.g. 回想「X」 › 片段). Because LINE stacks every drill-down below
 * the previous one, this trail + the depth-tinted header band let you read
 * where each card came from and how deep it sits. `tier` is a THEME.depth
 * entry; `parts` is the trail, joined with " › ".
 */
function breadcrumbKicker_(parts, tier) {
  return { type: 'text', text: parts.join('  ›  '), size: 'xxs', color: tier.headerSub, wrap: true };
}

// 類檔案路徑的麵包屑：`根 › L1 › … ›` 灰字、最後一段（目前位置）粗體＋亮色（§0.6.5）。
// tier 給 header 底色對應的字色（深底＝headerSub/headerText 白；淺底傳 {headerSub:muted, headerText:ink}）。
// 補在最深的卡（/journey 卡、歷程現況導覽/瀏覽、主題詳情）讓「我在哪、怎麼回去」永遠看得到。
function breadcrumbTrail_(parts, currentLabel, tier) {
  const t = tier || THEME.depth.l1;
  const sub = t.headerSub || THEME.muted;
  const cur = t.headerText || t.title || THEME.ink;
  const spans = (parts || []).map(p => ({ type: 'span', text: p + '  ›  ', color: sub }));
  spans.push({ type: 'span', text: currentLabel, color: cur, weight: 'bold' });
  return { type: 'text', contents: spans, size: 'xxs', wrap: true };
}

/**
 * 敘事片段 (inquiry episodes): the natural unit of 記寫脈絡. Records are
 * clustered by temporal proximity (a gap > EPISODE_GAP_MS starts a new
 * episode), so a single text or a burst of image+audio+text from one
 * moment of inquiry each form one episode. v1 = group + show the signal
 * composition and the records in time order; no Gemini synthesis yet.
 *
 * Navigation (scales to long histories — every card stays short):
 *   - no arg → index: today as its own day row + earlier months collapsed
 *     into month rows (replyEpisodeIndex_)
 *   - YYYY-MM (or a month-row tap) → that month's day index (replyEpisodeMonthDays_)
 *   - today / YYYY-MM-DD (or a day-row tap) → that day's episode carousel
 */
/** 敘事片段輪播的 index-0 導覽卡：與 /journey、/themes、/recall 等一致——每組瀏覽卡第一頁
 *  先給一張總覽(麵包屑命令正名 + 標題 + 段數/筆數 + 提示)，避免一進來就是片段、不知身在何處。 */
function buildSegmentsIntroCard_(crumbs, title, statLine, hint, headerTitle, size, summary, strip) {
  const tier = THEME.depth.l1;
  // size 必須與同輪播的內容卡一致——LINE 不允許 carousel 內混不同 bubble size（如原始紀錄卡是 micro）。
  const body = [{ type: 'text', text: truncate_(title, 30), size: 'sm', weight: 'bold', color: THEME.text, wrap: true }];
  if (summary) body.push({ type: 'text', text: truncate_(summary, 70), size: 'xxs', color: THEME.textBody, margin: 'sm', wrap: true });
  if (statLine) body.push({ type: 'text', text: statLine, size: 'xxs', color: THEME.muted, margin: 'sm', wrap: true });
  if (hint) body.push({ type: 'text', text: hint, size: 'xxs', color: THEME.muted, margin: 'md', wrap: true });
  if (strip) body.push(strip);   // 記寫時間分布 strip 統一放 body 最末（同 /themes 詳情卡、/recall 等）
  return {
    type: 'bubble', size: size || 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [breadcrumbKicker_(crumbs, tier),
        { type: 'text', text: headerTitle || '📜 敘事片段', size: 'sm', weight: 'bold', color: tier.headerText, margin: 'xs' }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'none', contents: body }
  };
}

function replyEpisodes_(ctx, arg) {
  const a = (arg || '').trim().toLowerCase();
  let dayStr = null;
  if (a === 'today' || a === '今日') dayStr = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) dayStr = a;
  else if (/^\d{4}-\d{2}$/.test(a)) return replyEpisodeMonthDays_(ctx, a);  // 月份 → 該月日期索引
  if (!dayStr) return replyEpisodeIndex_(ctx);  // 無參數 → 今日列 + 月份索引

  let records = loadEmbeddingRecords_(ctx.scope).filter(r =>
    r && r.ts && Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd') === dayStr);
  if (!records.length) return lineReply_(ctx.replyToken, `${dayStr} 沒有紀錄。`);

  records.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const episodes = groupByEpisode_(records, EPISODE_GAP_MS);
  const recent = episodes.slice().reverse().slice(0, EPISODE_MAX_CARDS);  // newest first

  // Cross-modal synthesis can take a couple of seconds per episode; show the
  // typing indicator (1-on-1 only) while we build the carousel.
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  // Generate narratives, but cap fresh (uncached) Gemini calls per request to
  // bound latency. Cards beyond the cap fall back to the inline record list
  // and get their narrative on a later view (cache fills incrementally).
  // X 軸＝該日全部段的範圍（首段 start..末段 end），每張 episode 卡標出自己 ✓ 相對於同日他段 ●
  // 的位置——回應「卡片若有時間區段就把分布示意出來」。
  const dayStartMs = recent.length ? Math.min.apply(null, episodes.map(e => e.startTs)) : 0;
  const dayEndMs   = recent.length ? Math.max.apply(null, episodes.map(e => e.endTs))   : 0;
  const dayAllRecs = episodes.reduce((acc, e) => acc.concat(e.records || []), []);
  let freshBudget = EPISODE_NARRATIVE_BUDGET;
  const bubbles = recent.map(ep => {
    let narrative = episodeNarrativeCached_(ep);
    if (!narrative && ep.records.length >= 2 && freshBudget > 0) {
      narrative = episodeNarrativeGenerate_(ep);
      freshBudget--;
    }
    let strip = null;
    if (dayEndMs > dayStartMs) {
      const epIds = {}; ep.records.forEach(r => { epIds[r.id] = 1; });
      strip = episodeTimelineStrip_({
        startTs: dayStartMs, endTs: dayEndMs,
        records: ep.records,
        otherRecords: dayAllRecs.filter(r => !epIds[r.id]),
        subLabel: `當日 ${formatClusterRange_(dayStartMs, dayEndMs)}`,
        headPrefix: '所選敘事片段'
      });
    }
    return buildEpisodeBubble_(ep, narrative, dayStr, {
      strip,
      explorationLine: explorationLineForEpisode_(ctx.scope, ep.records)
    });
  });
  const capped = episodes.length > recent.length ? `，顯示最近 ${recent.length}` : '';
  const introCard = buildSegmentsIntroCard_(['／episodes', dayStr], `${dayStr} 的敘事片段`,
    `${episodes.length} 段 · ${records.length} 筆${episodes.length > recent.length ? `（顯示最近 ${recent.length} 段）` : ''}`,
    '滑右逐段看；每段可點「看原始紀錄」展開逐則', null, null, null,
    (dayEndMs > dayStartMs) ? episodeTimelineStrip_({
      startTs: dayStartMs, endTs: dayEndMs, records: [], otherRecords: dayAllRecs,  // 導覽卡無焦點 → 全部以 ● 中性顯示密度（非 ✓ 命中）
      headText: `本日記寫時間分布 · ${formatClusterRange_(dayStartMs, dayEndMs)}`
    }) : null);
  const allCards = [introCard].concat(bubbles);
  const contents = allCards.length === 1 ? allCards[0] : { type: 'carousel', contents: allCards };
  lineReplyFlex_(ctx.replyToken, `${dayStr} 敘事片段（${episodes.length} 段${capped}）`, contents);
}

/**
 * 敘事片段 carousel scoped to one 脈絡 (context) — reached from a 候選歷程/watch
 * card. Groups the context's OWN records (not a calendar day) into episodes, so
 * what you see is exactly that 脈絡's content. Raw drill-down stays context-scoped
 * via replyContextRaw_.
 */
/**
 * Episode view for a persistent context. Default: all of the context's records
 * (the whole life of the 脈絡). When `opts.fromTs` is set, records are filtered
 * to that time window before grouping — used by /themes「看主題的敘事片段」 so
 * the result corresponds to what's visible on the cluster card, instead of
 * dumping the context's entire history.
 */
function replyContextEpisodes_(ctx, cid, opts) {
  const context = loadContexts_(ctx.scope).find(c => c.id === cid);
  if (!context) return lineReply_(ctx.replyToken, '這條脈絡已更新，請重新 /journey 後再看。');
  const idSet = {}; (context.recordIds || []).forEach(id => idSet[id] = true);
  const fromTs = opts && opts.fromTs ? opts.fromTs : null;
  const toTs   = opts && opts.toTs   ? opts.toTs   : null;
  const windowed = !!fromTs;
  const allCtxRecords = loadEmbeddingRecords_(ctx.scope)
    .filter(r => r && r.ts && idSet[r.id]);          // 全脈絡記錄（不分視窗）→ 導覽卡 strip 用
  let records = allCtxRecords.slice();
  if (windowed) {
    records = records.filter(r => {
      const t = Date.parse(r.ts);
      if (isNaN(t)) return false;
      if (t < fromTs) return false;
      if (toTs && t > toTs) return false;
      return true;
    });
  }
  records = records.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  if (!records.length) {
    return lineReply_(ctx.replyToken,
      windowed ? '此視窗內這條脈絡沒有紀錄。' : '這條脈絡目前沒有可顯示的紀錄。');
  }

  const episodes = groupByEpisode_(records, EPISODE_GAP_MS);
  // newest 段 first；不再截斷成 EPISODE_MAX_CARDS（會造成「主題卡 53 筆」對不上輪播可見筆數），
  // 改成分頁顯示，翻完總和 = 主題卡的 records.length。
  const ordered = episodes.slice().reverse();
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  const journey = pickJourneyForContext_(loadJourneys_(ctx.scope), cid);
  const label = context.userTitle || (journey && journey.title) || context.label || '主題';
  // 麵包屑＝大類 > 主題名（不再用「脈絡 > 代表句」）。
  const crumbs = [themeNormCategory_(context.category), truncate_(label, 14)];
  // strip X 軸＝此主題全生命期；每段標出自己的位置（✓）相對其他段（●）——回應「敘事片段需要記寫時間分布」。
  const allTs = records.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  const ctxStart = allTs.length ? allTs[0] : null, ctxEnd = allTs.length ? allTs[allTs.length - 1] : null;
  // 每頁的 narrative 預算各自獨立（fresh 6 calls per page）；快取會跨頁累積，翻第二次就快。
  let freshBudget = EPISODE_NARRATIVE_BUDGET;
  const allCards = ordered.map(ep => {
    let narrative = episodeNarrativeCached_(ep);
    if (!narrative && ep.records.length >= 2 && freshBudget > 0) {
      narrative = episodeNarrativeGenerate_(ep);
      freshBudget--;
    }
    const dayStr = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'yyyy-MM-dd');
    let strip = null;
    if (ctxStart != null && ctxEnd > ctxStart) {
      const epIds = {}; ep.records.forEach(r => { epIds[r.id] = 1; });
      strip = episodeTimelineStrip_({
        startTs: ctxStart, endTs: ctxEnd,
        records: ep.records,
        otherRecords: records.filter(r => !epIds[r.id]),
        subLabel: `主題 ${formatClusterRange_(ctxStart, ctxEnd)}`,
        headPrefix: '所選主題'
      });
    }
    return buildEpisodeBubble_(ep, narrative, dayStr, {
      crumbs, strip,
      rawData: `action=ctx_raw&cid=${cid}&s=${ep.startTs}`,
      explorationLine: explorationLineForEpisode_(ctx.scope, ep.records)
    });
  });
  const page = (opts && opts.page) || 0;
  // index-0 導覽卡 = 使用者點『全部敘事片段』的那張「主題詳情」卡本身（buildContextCard_），
  // 不再另造一張 plain 敘事片段導覽卡——回應「這張直接作為導覽卡」。範圍跟著本次視窗：windowed
  // 帶 {startMs,endMs}（卡上標『本視窗 N 筆』），否則 whole（標『共 N 筆』）。kilo，與 episode 卡同尺寸。
  const navRange = windowed ? { startMs: fromTs, endMs: toTs, asNav: true } : { whole: true, asNav: true };
  const introCard = buildContextCard_(
    { context, journey, recsInWindow: records, windowCount: records.length, allContextRecords: allCtxRecords },
    0, navRange, ctx.scope, null);
  const pager = paginateFlexCards_([introCard].concat(allCards), page);
  const pageCards = pager.pageCards;
  const totalPages = pager.totalPages;
  const curPage = pager.page;
  const contents = pageCards.length === 1 ? pageCards[0] : { type: 'carousel', contents: pageCards };
  const headBits = `${ordered.length} 段・${records.length} 筆`;
  const altText = totalPages > 1
    ? `「${truncate_(label, 16)}」${windowed ? '主題視窗' : '主題'}敘事片段（${headBits}・第 ${curPage + 1}/${totalPages} 頁）`
    : `「${truncate_(label, 16)}」${windowed ? '主題視窗' : '主題'}敘事片段（${headBits}）`;
  if (totalPages <= 1) {
    return lineReplyFlex_(ctx.replyToken, altText, contents);
  }
  const pagerTitle = `👉 ${truncate_(label, 16)}・敘事片段（${headBits} / ${totalPages} 頁）`;
  const fromArg = (opts && opts.fromTs) ? `&from=${opts.fromTs}` : '';
  const toArg   = (opts && opts.toTs)   ? `&to=${opts.toTs}`     : '';
  lineReplyMessages_(ctx.replyToken, [
    { type: 'flex', altText: altText, contents: contents },
    { type: 'flex', altText: `分頁（第 ${curPage + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(pagerTitle, curPage, totalPages, p => `action=ctx_episodes&cid=${cid}${fromArg}${toArg}&p=${p}`) }
  ]);
}

/** One tappable day row (date + episode count + signal composition). */
function episodeDayRow_(d, recs, labelOverride) {
  const sorted = recs.slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const epCount = groupByEpisode_(sorted, EPISODE_GAP_MS).length;
  const comp = {};
  for (const r of sorted) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join(' ');
  return {
    type: 'box', layout: 'vertical', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: d, data: `action=episodes_day&d=${d}`, displayText: `▸ 敘事片段 · ${d}` },
    contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: labelOverride || d.slice(5), size: 'sm', weight: 'bold', color: THEME.depth.l1.title, flex: 3 },
        { type: 'text', text: `${epCount} 段 ›`, size: 'sm', color: THEME.depth.l1.accent, align: 'end', flex: 2 }
      ]},
      { type: 'text', text: `${compStr} · ${sorted.length} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true }
    ]
  };
}

/** One tappable month row (month + day/episode counts + composition). */
function episodeMonthRow_(m, recs) {
  const byDay = {}, comp = {};
  for (const r of recs) {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
    (byDay[d] = byDay[d] || []).push(r);
    comp[r.type] = (comp[r.type] || 0) + 1;
  }
  let epCount = 0;
  for (const d in byDay) {
    epCount += groupByEpisode_(byDay[d].slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts)), EPISODE_GAP_MS).length;
  }
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join(' ');
  return {
    type: 'box', layout: 'vertical', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: m, data: `action=episodes_month&m=${m}`, displayText: `▸ 敘事片段 · ${m}` },
    contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: `📅 ${m.replace('-', '/')}`, size: 'sm', weight: 'bold', color: THEME.depth.l1.title, flex: 4 },
        { type: 'text', text: `${Object.keys(byDay).length} 天・${epCount} 段 ›`, size: 'sm', color: THEME.depth.l1.accent, align: 'end', flex: 5 }
      ]},
      { type: 'text', text: `${compStr} · ${recs.length} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true }
    ]
  };
}

/**
 * Index (no arg): today as its own day row (one tap away), everything earlier
 * collapsed into month rows. Tapping a month → that month's day index
 * (replyEpisodeMonthDays_). Stays one short card no matter how long the history.
 */
function replyEpisodeIndex_(ctx) {
  const records = loadEmbeddingRecords_(ctx.scope).filter(r => r && r.ts);
  if (!records.length) {
    return lineReply_(ctx.replyToken, '目前沒有紀錄。先傳一些訊息，再來看敘事片段。');
  }
  const todayStr = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const todayRecs = [];
  const byMonth = {};
  const totalComp = {};
  for (const r of records) {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
    if (d === todayStr) todayRecs.push(r);
    else { const m = d.slice(0, 7); (byMonth[m] = byMonth[m] || []).push(r); }
    totalComp[r.type] = (totalComp[r.type] || 0) + 1;
  }
  const months = Object.keys(byMonth).sort().reverse();

  // 整輯總段數（今日 + 各月）
  let totalEps = 0;
  if (todayRecs.length) {
    totalEps += groupByEpisode_(todayRecs.slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts)), EPISODE_GAP_MS).length;
  }
  months.forEach(m => {
    const byDay = {};
    byMonth[m].forEach(r => {
      const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
      (byDay[d] = byDay[d] || []).push(r);
    });
    for (const d in byDay) {
      totalEps += groupByEpisode_(byDay[d].slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts)), EPISODE_GAP_MS).length;
    }
  });

  // 一卡一單位：intro(index=0) + 今日 + 各月。卡尺寸 kilo 一致。
  const totalExpN = distinctExplorationCount_(records);
  const cards = [buildEpisodeIndexIntroCard_(records.length, totalEps, todayRecs.length > 0, months.length, totalComp, totalExpN)];
  if (todayRecs.length) cards.push(buildEpisodeDayCard_(todayStr, todayRecs, true));
  months.forEach(m => cards.push(buildEpisodeMonthCard_(m, byMonth[m])));

  // LINE carousel 12 上限：intro(1) + 今日(1) + 月(N)；若月>10 用 paginateFlexCards_ 切。
  const pager = paginateFlexCards_(cards, 0);
  const contents = pager.pageCards.length === 1 ? pager.pageCards[0] : { type: 'carousel', contents: pager.pageCards };
  lineReplyFlex_(ctx.replyToken, `敘事片段 · 索引（${totalEps} 段·${records.length} 筆）`, contents);
}

/** /episodes index 輪播 index=0：總段/筆數 + 媒介組成 + 導航。 */
function buildEpisodeIndexIntroCard_(recordN, epN, hasToday, monthN, totalComp, totalExpN) {
  const compStr = Object.keys(totalComp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${totalComp[t]}`).join('  ');
  const navBits = [];
  if (hasToday) navBits.push('今日');
  if (monthN) navBits.push(`${monthN} 個月`);
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: String(epN), size: '3xl', weight: 'bold', color: THEME.cta, flex: 0 },
      { type: 'text', text: '段', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' },
      { type: 'text', text: `／ ${recordN} 筆`, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', gravity: 'bottom' }
    ]}
  ];
  if (totalExpN > 0) body.push({ type: 'text', text: `🎒 ${totalExpN} 探索`, size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs' });
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: '媒介組成', size: 'xxs', color: THEME.muted, margin: 'md' });
  body.push({ type: 'text', text: compStr || '—', size: 'sm', weight: 'bold', color: THEME.depth.l1.accent, wrap: true, margin: 'xs' });
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: navBits.length ? `現有 ${navBits.join(' + ')}` : '', size: 'xxs', color: THEME.muted, margin: 'md' });
  body.push({ type: 'text', text: '👉 滑右邊 → 點月份/今日', size: 'xs', color: THEME.textBody, wrap: true, margin: 'sm' });
  body.push({ type: 'text', text: '→ 看當月各日 → 看當日各段', size: 'xs', color: THEME.textBody, wrap: true });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📜', size: 'xxl', color: THEME.depth.l1.headerText, align: 'center' },
        { type: 'text', text: '敘事片段 · 索引', size: 'md', weight: 'bold', color: THEME.depth.l1.headerText, align: 'center', margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

/** 今日 / 某日 day card。tap → 進該日段視圖。 */
function buildEpisodeDayCard_(dayStr, recs, isToday) {
  const sorted = recs.slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const epCount = groupByEpisode_(sorted, EPISODE_GAP_MS).length;
  const comp = {};
  for (const r of sorted) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ');
  const headerTitle = isToday ? `📅 今日 ${dayStr.slice(5)}` : `📅 ${dayStr.slice(5)}`;
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📜 敘事片段', size: 'xxs', color: THEME.depth.l1.headerSub },
        { type: 'text', text: headerTitle, size: 'md', weight: 'bold', color: THEME.depth.l1.headerText, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: (function () {
      const cs = [
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: String(epCount), size: 'xxl', weight: 'bold', color: THEME.cta, flex: 0 },
          { type: 'text', text: '段', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' },
          { type: 'text', text: `／ ${sorted.length} 筆`, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', gravity: 'bottom' }
        ]}
      ];
      const expN = distinctExplorationCount_(sorted);
      if (expN > 0) cs.push({ type: 'text', text: `🎒 ${expN} 探索`, size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs' });
      cs.push({ type: 'separator', margin: 'md' });
      cs.push({ type: 'text', text: '媒介組成', size: 'xxs', color: THEME.muted, margin: 'md' });
      cs.push({ type: 'text', text: compStr || '—', size: 'sm', weight: 'bold', color: THEME.depth.l1.accent, wrap: true, margin: 'xs' });
      return cs;
    })()},
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
      action: { type: 'postback', label: dayStr, data: `action=episodes_day&d=${dayStr}`, displayText: `▸ 敘事片段 · ${dayStr}` },
      contents: [{ type: 'text', text: '📂 看當日各段 ›', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
    }]}
  };
}

/** 月份 card：天數 / 段數 / 媒介組成 / tap → 進該月各日。 */
function buildEpisodeMonthCard_(month, recs) {
  const byDay = {}, comp = {};
  for (const r of recs) {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
    (byDay[d] = byDay[d] || []).push(r);
    comp[r.type] = (comp[r.type] || 0) + 1;
  }
  let epCount = 0;
  for (const d in byDay) {
    epCount += groupByEpisode_(byDay[d].slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts)), EPISODE_GAP_MS).length;
  }
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ');
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📜 敘事片段', size: 'xxs', color: THEME.depth.l1.headerSub },
        { type: 'text', text: `📅 ${month.replace('-', '/')}`, size: 'md', weight: 'bold', color: THEME.depth.l1.headerText, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: (function () {
      const cs = [
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: String(Object.keys(byDay).length), size: 'xxl', weight: 'bold', color: THEME.cta, flex: 0 },
          { type: 'text', text: '天', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' },
          { type: 'text', text: `／ ${epCount} 段 · ${recs.length} 筆`, size: 'xxs', color: THEME.muted, flex: 1, align: 'end', gravity: 'bottom' }
        ]}
      ];
      const expN = distinctExplorationCount_(recs);
      if (expN > 0) cs.push({ type: 'text', text: `🎒 ${expN} 探索`, size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs' });
      cs.push({ type: 'separator', margin: 'md' });
      cs.push({ type: 'text', text: '媒介組成', size: 'xxs', color: THEME.muted, margin: 'md' });
      cs.push({ type: 'text', text: compStr || '—', size: 'sm', weight: 'bold', color: THEME.depth.l1.accent, wrap: true, margin: 'xs' });
      return cs;
    })()},
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
      action: { type: 'postback', label: month, data: `action=episodes_month&m=${month}`, displayText: `▸ 敘事片段 · ${month}` },
      contents: [{ type: 'text', text: '📂 看當月各日 ›', size: 'xs', color: THEME.onDark, align: 'center', weight: 'bold' }]
    }]}
  };
}

/** A single month's day index (each day in that month, newest first). */
function replyEpisodeMonthDays_(ctx, month, page) {
  page = page || 0;
  const records = loadEmbeddingRecords_(ctx.scope).filter(r =>
    r && r.ts && Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd').slice(0, 7) === month);
  if (!records.length) return lineReply_(ctx.replyToken, `${month} 沒有紀錄。`);
  const byDay = {};
  for (const r of records) {
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
    (byDay[d] = byDay[d] || []).push(r);
  }
  const days = Object.keys(byDay).sort().reverse();  // newest day first

  // Count-based paging on day descriptors (day cards are small & uniform, so the
  // byte-aware paginate isn't needed; this lets us generate narratives ONLY for
  // the visible page instead of all days). Page size scales 4/6/10 by day count.
  const pageSize = searchPageSize_(days.length);
  const totalPages = Math.max(1, Math.ceil(days.length / pageSize));
  const p = Math.max(0, Math.min(totalPages - 1, parseInt(page, 10) || 0));
  const pageDays = days.slice(p * pageSize, (p + 1) * pageSize);

  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 30); } catch (_) {}
  }
  // One LLM per day card, but bounded per request — cards beyond the budget show
  // the media/count skeleton and fill their 大類｜主題 label on a later view
  // (cache fills incrementally). Cached days cost nothing.
  let freshBudget = EPISODE_NARRATIVE_BUDGET;
  const cards = pageDays.map(d => {
    const recs = byDay[d];
    let narrative = dayNarrativeCached_(d, recs);
    if (!narrative && recs.length >= 2 && freshBudget > 0) {
      narrative = dayNarrativeGenerate_(d, recs);
      freshBudget--;
    }
    return buildDayCard_(month, d, recs, narrative);
  });

  // index-0 導覽卡：第一頁先給當月總覽（每組瀏覽卡一致），附本月記寫時間分布 strip。
  const monthTsList = records.map(r => Date.parse(r.ts)).filter(t => !isNaN(t));
  const monthStart = monthTsList.length ? Math.min.apply(null, monthTsList) : 0;
  const monthEnd = monthTsList.length ? Math.max.apply(null, monthTsList) : 0;
  const navCard = p === 0
    ? buildSegmentsIntroCard_(['／episodes', month.replace('-', '/')], `${month.replace('-', '/')} 各日`,
        `${days.length} 天 · ${records.length} 筆`, '點某天 →「看當日各段」', '🗓 看當月各日', null, null,
        (monthEnd > monthStart) ? episodeTimelineStrip_({
          startTs: monthStart, endTs: monthEnd, records: [], otherRecords: records,  // 導覽卡無焦點 → 全部以 ● 中性顯示密度
          headText: `本月記寫時間分布 · ${formatClusterRange_(monthStart, monthEnd)}`
        }) : null)
    : null;
  const allCards = navCard ? [navCard].concat(cards) : cards;
  const contents = allCards.length === 1 ? allCards[0] : { type: 'carousel', contents: allCards };
  const altText = `敘事片段 · ${month}（${days.length} 天）`;
  const msgs = [{ type: 'flex', altText: altText, contents: contents }];
  if (totalPages > 1) {
    msgs.push({
      type: 'flex', altText: '分頁',
      contents: buildPaginationBubble_(`敘事片段 · ${month.replace('-', '/')}`, p, totalPages,
        pp => `action=episodes_month&m=${month}&p=${pp}`)
    });
  }
  lineReplyMessages_(ctx.replyToken, msgs);
}

/**
 * One day card for the L1 month view (一天一張卡). Header: month breadcrumb +
 * MM/dd. Body: media composition + 段數·筆數, then the whole-day 大類｜主題1+主題2
 * synthesis (skeleton line when not generated yet). Footer: tap → that day's
 * per-segment carousel (L2, replyEpisodes_).
 */
function buildDayCard_(month, dayStr, recs, narrative) {
  const sorted = recs.slice().sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const epCount = groupByEpisode_(sorted, EPISODE_GAP_MS).length;
  const comp = {};
  for (const r of sorted) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ') || '—';

  const body = [
    { type: 'text', text: compStr, size: 'sm', weight: 'bold', color: THEME.depth.l1.accent },
    { type: 'text', text: `${epCount} 段 · ${sorted.length} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs' }
  ];
  const expN = distinctExplorationCount_(sorted);
  if (expN > 0) body.push({ type: 'text', text: `🎒 ${expN} 探索`, size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs' });
  body.push({ type: 'separator', margin: 'sm' });
  if (narrative) {
    // 標題只顯示「片段重點」（narrative.title），不前綴 narrative.category——避免與卡上
    // 逐筆的「📂 目前歸類」大類混淆（前者整段語氣、後者每筆歸戶，量不同尺度）。
    const titleLine = narrative.title || '敘事片段';
    body.push({ type: 'text', text: titleLine, size: 'md', weight: 'bold', color: THEME.depth.l1.title, wrap: true, margin: 'md' });
    if (narrative.summary) {
      body.push({ type: 'text', text: narrative.summary, size: 'sm', color: THEME.textBody, wrap: true, margin: 'sm' });
    }
  } else if (sorted.length < 2) {
    // Single-record day: show the record's own snippet (no synthesis).
    const r = sorted[0];
    const prev = truncate_(((r && (r.aggregatedText || r.text)) || '').replace(/\s+/g, ' '), 40) || '(無內容)';
    body.push({ type: 'text', text: prev, size: 'sm', color: THEME.textBody, wrap: true, margin: 'md' });
  } else {
    body.push({ type: 'text', text: '（主題標籤整理中，稍後再看即顯示）', size: 'xs', color: THEME.muted, wrap: true, margin: 'md' });
  }

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l1.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['敘事片段', month.replace('-', '/')], THEME.depth.l1),
        { type: 'text', text: dayStr.slice(5).replace('-', '/'), size: 'md', weight: 'bold', color: THEME.depth.l1.headerText, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
      action: { type: 'postback', label: '看當日各段', data: `action=episodes_day&d=${dayStr}`, displayText: `▸ 敘事片段 · ${dayStr}` },
      contents: [{ type: 'text', text: `📂 看當日各段（${epCount} 段）`, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
    }
  };
}

/**
 * A mini time-distribution strip for an episode / 脈絡 / record card. Twelve
 * fixed-width cells span [startTs, endTs] edge-to-edge in the card. Three
 * states per bucket:
 *   ◯  baseline (no records in this slot for either set)
 *   ●  "other" records here — either this context's records OUTSIDE the
 *      user's selected window (when `highlight` is given), or records from
 *      other cards in the corpus (when `otherRecords` is given).
 *   ✓  this card's records here — the in-window subset under `highlight`,
 *      or every record in `records` when no highlight is set.
 * `highlight` and `otherRecords` are independent and can coexist; both
 * contribute to ●. ✓ count matches the card's "本視窗 N 筆" / "this card's
 * records" promise. Marks are position cues — multiple records in the same
 * bucket collapse to one glyph.
 *
 * Why 12 cells at size 'lg': 24 cells at smaller sizes squashed every glyph
 * on LINE Desktop to an indistinguishable dot. 12 cells gives each glyph
 * ~24px of horizontal room (on a ~290px card body), enough for a bold lg
 * glyph to render legibly on both mobile and desktop while still spanning
 * the full card width via flex:1. ◯ is dropped to 'sm' so the baseline
 * recedes and ✓/● visually pop.
 */
function episodeTimelineStrip_(ep) {
  // Bucket count scales with card size — micro bubbles (~200px wide) only
  // have room for 8 cells at ~25px each; 12 cells either squashed every
  // glyph back to dots (cell-based) or overran the bubble width and got
  // truncated with "…" (span-based). 8 buckets give each glyph enough room
  // to render legibly on both mobile and desktop. Kilo/mega keep 12.
  const isMicro = ep.cardSize === 'micro';
  const B = isMicro ? 8 : 12;
  const span = ep.endTs - ep.startTs;
  const bucketOf = (t) => {
    if (span <= 0) return 0;
    let b = Math.floor((t - ep.startTs) / span * B);
    if (b < 0) b = 0; if (b >= B) b = B - 1;
    return b;
  };
  const hi = ep.highlight;
  const hasWin = !!(hi && hi.fromTs != null && hi.toTs != null);
  const inWin = (t) => t >= hi.fromTs && t <= hi.toTs;
  const mineIn = new Array(B).fill(0);
  const mineOut = new Array(B).fill(0);
  for (const r of (ep.records || [])) {
    const t = Date.parse(r.ts);
    if (isNaN(t)) continue;
    const b = bucketOf(t);
    if (!hasWin || inWin(t)) mineIn[b]++;
    else mineOut[b]++;
  }
  const others = new Array(B).fill(0);
  for (const r of (ep.otherRecords || [])) {
    const t = Date.parse(r.ts);
    if (isNaN(t)) continue;
    if (t < ep.startTs || t > ep.endTs) continue;
    others[bucketOf(t)]++;
  }

  // One cell per bucket, flex:1 so the strip spans the card edge-to-edge.
  // Marker glyphs (✓/●) bigger than the baseline (◯) so data points pop.
  // Each bucket shows ONE glyph by priority ✓ > ● > ◯ (a position cue, not a
  // count): ✓ = this card's matched records sit here (green, the only colour
  // so it pops); ● = some other record sits here (grey — this card's
  // out-of-window record for /themes, or another record in the corpus);
  // ◯ = nothing was written in this slot at all. No hiding — other records
  // always render as ●, so an empty ◯ honestly means "wrote nothing here",
  // never "data suppressed".
  const sizeMark = isMicro ? 'md' : 'lg';
  const sizeBase = isMicro ? 'xs' : 'sm';
  const cells = Array.from({ length: B }, (_, i) => {
    let text, color, size;
    if (mineIn[i] > 0)                          { text = '✓'; color = THEME.success; size = sizeMark; }
    else if (mineOut[i] > 0 || others[i] > 0)   { text = '●'; color = THEME.muted;   size = sizeMark; }
    else                                         { text = '◯'; color = THEME.faint;   size = sizeBase; }
    return { type: 'text', text, size, flex: 1, align: 'center', gravity: 'center', color, weight: 'bold' };
  });

  const prefix = ep.headPrefix || '所選主題群組';
  const headText = ep.headText                              // 呼叫端可給完整 caption（覆蓋預設模板）
    || (ep.subLabel ? `${prefix} ┃ ${ep.subLabel} 的記寫時間分布` : '記寫時間分布');
  return {
    type: 'box', layout: 'vertical', margin: 'sm', contents: [
      { type: 'text', text: headText, size: 'xxs', color: THEME.muted, wrap: true },
      { type: 'box', layout: 'horizontal', margin: 'xs', contents: cells }
    ]
  };
}

/**
 * Strip helper for cards whose X-axis is the corpus span (not this card's
 * own lifetime). Used by /recall, /ask citations, /episode raw — anywhere a
 * card represents records that belong to a slice of the user's broader
 * timeline. Computes corpus bounds + otherRecords from allRecords and
 * delegates to episodeTimelineStrip_ with the right framing.
 */
function corpusTimelineStrip_(myRecords, allRecords) {
  if (!allRecords || !allRecords.length) return null;
  const tsList = allRecords.map(r => Date.parse(r && r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (tsList.length < 2) return null;
  const corpusStart = tsList[0];
  const corpusEnd = tsList[tsList.length - 1];
  const mineIds = {};
  (myRecords || []).forEach(r => { if (r && r.id) mineIds[r.id] = true; });
  const otherRecords = allRecords.filter(r => r && r.id && !mineIds[r.id]);
  // caption 講清楚：這排刻度的「橫軸」＝你全部記寫(05/12–今)，✓ 標的是本筆/這幾筆的「位置」，
  // 不是說這些紀錄橫跨那段日期（卡頭已各自標真正的記錄時間）。避免「依據3筆卻顯示5/12–6/5」的誤讀。
  // 三符號圖例直接附在 caption：● 其他記寫、◯ 該時段沒寫——不藏資料，空圈就老實代表沒寫。
  const who = ((myRecords || []).length === 1) ? '本筆' : '這幾筆';
  return episodeTimelineStrip_({
    startTs: corpusStart,
    endTs: corpusEnd,
    records: myRecords || [],
    otherRecords: otherRecords,
    headText: `✓ ${who}在「全部記寫 ${formatClusterRange_(corpusStart, corpusEnd)}」中的位置（● 其他記寫、◯ 該時段沒寫）`,
    headPrefix: '所選紀錄',
    cardSize: 'micro'
  });
}

function buildEpisodeBubble_(ep, narrative, dayStr, opts) {
  opts = opts || {};
  const start = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'MM/dd HH:mm');
  const sameDay = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'yyyy-MM-dd')
                === Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, 'yyyy-MM-dd');
  const end = Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, sameDay ? 'HH:mm' : 'MM/dd HH:mm');
  const range = ep.startTs === ep.endTs ? start : `${start}–${end}`;

  const comp = {};
  for (const r of ep.records) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ') || '—';
  const durMin = Math.max(0, Math.round((ep.endTs - ep.startTs) / 60000));

  // Body: composition → duration·count → separator → title+summary (or
  // inline list when there's no synthesis). 敘事片段不顯密度條——session 內節奏
  // 在 raw record 列表自然可見，strip 冗餘（密度條只在脈絡層級才有意義：對應的
  // 是「主題全生命期內的鋪排」）。
  const bodyContents = [
    { type: 'text', text: compStr, size: 'sm', weight: 'bold', color: THEME.depth.l2.accent },
    { type: 'text', text: `${durMin} 分鐘 · ${ep.records.length} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs' }
  ];
  // 〔情緒層〕這段的心情軌跡（貼圖時序弧線）——段落導覽卡一眼看到情感走向。
  {
    const arc = journeyEmotionArc_(ep.records);
    if (arc) bodyContents.push({ type: 'text', text: `心情軌跡　${arc.chain}（${arc.n} 次）`, size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  }
  // 儀式軸來源：caller 用 explorationLineForEpisode_ 算好整行文字（已含 🎒 prefix；單一/兩個探索
  // 列名、3+ 顯示數量、無閾值）。/explore-view 路徑不傳（label 已在 breadcrumb，body 不重複）。
  if (opts.explorationLine) {
    bodyContents.push({
      type: 'text', text: truncate_(opts.explorationLine, 40),
      size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs', wrap: true
    });
  }
  bodyContents.push({ type: 'separator', margin: 'sm' });
  if (narrative) {
    // 「大類｜關鍵字1+關鍵字2」統一格式；舊快取沒有 category 時退回單寫 title。
    // 標題只顯示「片段重點」（narrative.title），不前綴 narrative.category——避免與卡上
    // 逐筆的「📂 目前歸類」大類混淆（前者整段語氣、後者每筆歸戶，量不同尺度）。
    const titleLine = narrative.title || '敘事片段';
    bodyContents.push({ type: 'text', text: titleLine, size: 'md', weight: 'bold', color: THEME.depth.l2.title, wrap: true, margin: 'md' });
    if (narrative.summary) {
      bodyContents.push({ type: 'text', text: narrative.summary, size: 'sm', color: THEME.textBody, wrap: true, margin: 'sm' });
    }
  } else {
    // No synthesis (single-record episode, or not generated yet) → inline
    // record list, time-ordered. 〔2026-06-07〕內容長度自適應：carousel 會把每張卡拉到
    // 最高卡的高度，筆數少的卡若硬截短就一堆留白。故筆數越少、每筆顯示越完整（單筆＝近全文），
    // 讓被拉高的稀疏卡也填得滿、看得到完整內容。
    const shown = ep.records.slice(0, 8);
    const perLen   = shown.length === 1 ? 600 : shown.length <= 3 ? 160 : shown.length <= 5 ? 80 : 36;
    const perLines = shown.length === 1 ? 16  : shown.length <= 3 ? 6   : shown.length <= 5 ? 3  : 2;
    shown.forEach(r => {
      const t = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'HH:mm');
      const icon = EPISODE_TYPE_ICON[r.type] || '·';
      const prev = truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), perLen) || '(無內容)';
      bodyContents.push({ type: 'text', text: `${t} ${icon} ${prev}`, size: 'xs', color: THEME.textBody, wrap: true, maxLines: perLines, margin: 'sm' });
    });
    const more = ep.records.length - shown.length;
    if (more > 0) bodyContents.push({ type: 'text', text: `…還有 ${more} 筆`, size: 'xxs', color: THEME.muted, margin: 'sm' });
  }
  // 記寫時間分布 strip（脈絡/主題層級才有意義：對應主題全生命期內的鋪排）。由呼叫端算好傳入。
  if (opts.strip) { bodyContents.push({ type: 'separator', margin: 'sm' }); bodyContents.push(opts.strip); }

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l2.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(opts.crumbs || ['敘事片段', dayStr.slice(5)], THEME.depth.l2),
        { type: 'text', text: range, size: 'md', weight: 'bold', color: THEME.depth.l2.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: bodyContents },
    // Fixed bottom button — always present, opens the raw records carousel.
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', margin: 'none',
      action: { type: 'postback', label: '看原始紀錄', data: opts.rawData || `action=episode_raw&d=${dayStr}&s=${ep.startTs}`, displayText: `▸ 看原始紀錄 · ${range}` },
      contents: [{ type: 'text', text: `📂 看原始紀錄（${ep.records.length} 筆）`, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
    }
  };
  // Representative thumbnail at the top (hero) so 看當日各段 cards are scannable
  // by image. Covers image/video/PDF/Office (Drive thumbnail) + YouTube/網頁
  // (urlPreview.thumbnail). null when the 段 is text-only.
  const hero = episodeHeroFragment_(ep.records);
  if (hero) bubble.hero = hero;
  return bubble;
}

/**
 * Pick a representative thumbnail for an episode → a Flex `hero` image fragment
 * (4:3 cover, tappable → original), or null when none applies. Priority (newest
 * first within each kind): image → video → file (PDF/Office; Drive renders a
 * page thumbnail) → any record carrying urlPreview.thumbnail (YouTube oembed /
 * og:image / 網頁縮圖). Same Drive thumbnail endpoint as /journey & /recall heroes.
 */
function episodeHeroFragment_(records) {
  const byTime = (records || []).filter(Boolean).slice()
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));   // newest first
  const driveHero = (rec) => ({
    type: 'image', url: `https://drive.google.com/thumbnail?id=${rec.fileId}&sz=w600`,
    size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
    action: { type: 'uri', label: '原檔', uri: `https://drive.google.com/file/d/${rec.fileId}/view` }
  });
  for (const r of byTime) if (r.type === 'image' && r.fileId) return driveHero(r);
  for (const r of byTime) if (r.type === 'video' && r.fileId) return driveHero(r);
  for (const r of byTime) if (r.type === 'file'  && r.fileId) return driveHero(r);
  for (const r of byTime) {
    const uri = safeActionUri_((r.urlPreview && r.urlPreview.url) || null);
    const thumb = r.urlPreview && httpsImageUrl_(r.urlPreview.thumbnail, (r.urlPreview && r.urlPreview.url) || null);
    if (!thumb) continue;
    const frag = { type: 'image', url: thumb, size: 'full', aspectRatio: '4:3', aspectMode: 'cover' };
    if (uri) frag.action = { type: 'uri', label: '原連結', uri: uri };
    return frag;
  }
  return null;
}

/**
 * Stable id for an episode = MD5 of its sorted record ids. Changes only when
 * the episode's record set changes, so a cached narrative stays valid until
 * a record is added/removed from that cluster.
 */
function episodeHash_(ep) {
  const ids = ep.records.map(r => r.id).sort().join(',');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, ids);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 16);
}

/**
 * Index all records into episodes for cross-cutting lookups. Groups records
 * by calendar day, then by 30-min session within each day (matching the
 * /episodes view). Returns { episodesByKey, keyByRecord } where the key is
 * `<day>|<startTs>` — also the identity used by the episode_raw postback.
 * Each episode is stamped with `_day` for convenience.
 */
function indexEpisodes_(records) {
  const byDay = {};
  for (const r of records) {
    if (!r || !r.ts) continue;
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd');
    (byDay[d] = byDay[d] || []).push(r);
  }
  const episodesByKey = {};
  const keyByRecord = {};
  for (const d in byDay) {
    const recs = byDay[d].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (const ep of groupByEpisode_(recs, EPISODE_GAP_MS)) {
      ep._day = d;
      const key = `${d}|${ep.startTs}`;
      episodesByKey[key] = ep;
      for (const r of ep.records) keyByRecord[r.id] = key;
    }
  }
  return { episodesByKey, keyByRecord };
}

/**
 * Search result card for an episode: the moment that matched, with the
 * matched records' snippets ("why it matched") and a tap-through to the
 * raw records. Uses a cached narrative title when available but never
 * generates one (keeps search fast/cheap).
 */
function buildEpisodeSearchBubble_(ep, score, idx, matchedHits, dayStr, query) {
  const start = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'MM/dd HH:mm');
  const sameDay = Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'yyyy-MM-dd')
                === Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, 'yyyy-MM-dd');
  const end = Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, sameDay ? 'HH:mm' : 'MM/dd HH:mm');
  const range = ep.startTs === ep.endTs ? start : `${start}–${end}`;
  const comp = {};
  for (const r of ep.records) comp[r.type] = (comp[r.type] || 0) + 1;
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ');
  const narr = episodeNarrativeCached_(ep);

  const body = [
    { type: 'text', text: range, size: 'sm', weight: 'bold', color: THEME.depth.l2.title },
    { type: 'text', text: `${compStr} · ${ep.records.length} 筆`, size: 'xxs', color: THEME.muted, margin: 'xs' },
    { type: 'separator', margin: 'sm' }
  ];
  if (narr && narr.title) {
    // 「大類｜關鍵字1+關鍵字2」統一格式；舊快取沒有 category 時退回單寫 title。
    const titleLine = narr.category ? `${narr.category}｜${narr.title}` : narr.title;
    body.push({ type: 'text', text: titleLine, size: 'sm', weight: 'bold', color: THEME.depth.l2.title, wrap: true, margin: 'sm' });
  }
  // 命中筆「目前被歸到的主題群組」(新模型 大類｜議題)——一眼看出有沒有被歸錯，決定要不要進去改歸。
  const _topicSet = {};
  (matchedHits || []).forEach(h => {
    const rr = h && h.record; if (!rr) return;
    if (rr.category || rr.topicLabel) _topicSet[`${rr.category || '?'}｜${rr.topicLabel || '未細分'}`] = true;
  });
  const _topicKeys = Object.keys(_topicSet);
  if (_topicKeys.length) {
    const shown = _topicKeys.slice(0, 2).join('、') + (_topicKeys.length > 2 ? ` …+${_topicKeys.length - 2}` : '');
    body.push({ type: 'text', text: `📂 目前歸類：${shown}`, size: 'xxs', color: THEME.depth.l2.accent, wrap: true, margin: 'md' });
  }
  // 命中訊號彙總：這段命中的 N 筆裡，多少字詞命中、多少純語意（🔤/🧠 同步原始記錄卡的語彙）。
  let _litN = 0, _semN = 0;
  matchedHits.forEach(h => { matchSnippet_(h.record && h.record.text, query).matched ? _litN++ : _semN++; });
  const _hitMeta = `命中 ${matchedHits.length} 筆` + (_litN ? ` · 🔤字詞 ${_litN}` : '') + (_semN ? ` · 🧠語意 ${_semN}` : '');
  body.push({ type: 'text', text: _hitMeta, size: 'xxs', color: THEME.muted, margin: 'md', wrap: true });
  // 焦點命中：挑「最高分那筆」當焦點、給較長高亮片段；其餘命中依時間序收合成「前面/後面還有 N 筆」。
  // 讓一眼看到「最相關那筆寫了什麼」與它在這段命中序列的位置，取代舊版任意時間序前 3 筆。
  if (matchedHits.length) {
    const sortedByTime = matchedHits.slice().sort((a, b) => Date.parse(a.record.ts) - Date.parse(b.record.ts));
    const anchor = matchedHits.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const ai = sortedByTime.indexOf(anchor);
    const before = ai, after = matchedHits.length - 1 - ai;
    if (before > 0) body.push({ type: 'text', text: `┄ 前面還有 ${before} 筆命中 ┄`, size: 'xxs', color: THEME.muted, align: 'center', margin: 'md' });
    const am = matchSnippet_(anchor.record && anchor.record.text, query, 60);
    body.push(snippetComponentFromMatch_(am, { size: 'sm', color: THEME.text, maxLines: 3, margin: 'sm', icon: '🎯', iconColor: THEME.cta }));
    if (after > 0) body.push({ type: 'text', text: `┄ 後面還有 ${after} 筆命中 ┄`, size: 'xxs', color: THEME.muted, align: 'center', margin: 'sm' });
  }
  // Episode-span strip: which record(s) inside this 敘事片段 triggered the hit.
  // X-axis = the episode's own start..end, so ✓ lands at the matched records'
  // positions among the episode's records (parallels /themes' 本視窗/視窗外
  // semantics: ✓ = focus inside this card, ● = same-card-but-not-focus).
  if (ep.records && ep.records.length && ep.endTs > ep.startTs) {
    const matchedIds = {};
    (matchedHits || []).forEach(h => { if (h && h.record && h.record.id) matchedIds[h.record.id] = true; });
    const matchedRecs = ep.records.filter(r => r && r.id && matchedIds[r.id]);
    const nonMatchedRecs = ep.records.filter(r => r && r.id && !matchedIds[r.id]);
    body.push({ type: 'separator', margin: 'sm' });
    body.push(episodeTimelineStrip_({
      startTs: ep.startTs,
      endTs: ep.endTs,
      records: matchedRecs,
      otherRecords: nonMatchedRecs,
      subLabel: formatClusterRange_(ep.startTs, ep.endTs),
      headPrefix: '所選敘事片段'
    }));
  }

  const qShort = query ? (query.length > 14 ? query.slice(0, 14) + '…' : query) : null;
  const trail = qShort ? [`🔍 回想「${qShort}」`, '敘事片段'] : ['回想', '敘事片段'];
  const _relEp = relevanceLabel_(score);
  const scoreStr = typeof score === 'number'
    ? ` · 相似度 ${score.toFixed(2)}${_relEp ? ' · ' + _relEp.text : ''}` : '';
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l2.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(trail, THEME.depth.l2),
        { type: 'text', text: `No.${idx}${scoreStr}`, weight: 'bold', size: 'md', color: THEME.depth.l2.headerText, margin: 'xs', wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
      action: { type: 'postback', label: '看原始紀錄', data: `action=episode_raw&d=${dayStr}&s=${ep.startTs}`, displayText: `▸ 看原始紀錄 · ${range}` },
      contents: [{ type: 'text', text: `📂 看原始紀錄（${ep.records.length} 筆）`, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
    }
  };
}

/** Cache-only lookup for an episode's { title, summary }. null on miss. */
function episodeNarrativeCached_(ep) {
  if (!ep.records || ep.records.length < 2) return null;
  const v = CacheService.getScriptCache().get('epnarr_' + episodeHash_(ep));
  if (!v) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/**
 * Cross-modal synthesis for one episode → { category, title, summary }:
 *   - category: one preset 大類 from JOURNEY_KEYWORD_CATEGORIES (same vocab
 *     /themes 卡 uses) — picks the closest fit even when content is mixed
 *   - title: 0-2 specific 關鍵字主題 joined by 與, ≤14 chars total
 *   - summary: 20–50 char objective temporal-context note
 * Display format on /recall card: `{title}` only — narrative.category 不前綴，避免與
 * 卡上逐筆「📂 目前歸類」大類混淆（前者整段語氣、後者每筆歸戶，量不同尺度）。
 * Objective voice. Single-record episodes return null (the record is the
 * content). Cached as JSON in CacheService by episodeHash_ (6h); the hash
 * changes only when the cluster's records change.
 */
/**
 * Shared 大類｜主題 synthesizer: one Gemini call over a pre-built record block →
 * { category, title, summary } (or null). `introLine` frames the scope (one
 * episode vs a whole day). Caching is the caller's job. Used by L1 day cards
 * (dayNarrativeGenerate_); episode-scope synthesis keeps its own inline copy.
 */
function synthNarrativeFromBlock_(range, block, introLine) {
  if (!block) return null;
  const sys = [
    introLine,
    '請「只根據實際內容」輸出三行，務必照「大類：」「標題：」「脈絡：」格式：',
    `大類：必須從以下擇一最貼近的：${JOURNEY_KEYWORD_CATEGORIES.join('／')}。內容再雜也要挑一個最接近的，不可輸出其他詞。`,
    '標題：0-2 個具體的關鍵字主題、用「+」直接連接（例如「國科會計畫+人工意識」），整行 ≤14 字、不要動詞、不要與大類重複、不要套「學習」「分享」「探索」這類空話。',
    '脈絡：20-50 字，客觀說明這段實際記錄了什麼。',
    '規則：嚴格依實際內容、不腦補；內容無明顯關連時標題給最具體關鍵字或「零散筆記」；用詞樸實、不誇飾；繁體中文、不用「你」「學習者」、不要開場白結語。'
  ].join('\n');
  let out;
  try {
    out = geminiGenerate_([{ text: `時間：${range}\n紀錄（依時間）：\n${block}` }], {
      systemInstruction: sys, temperature: 0.2, maxOutputTokens: 240
    });
  } catch (e) { console.warn('synthNarrativeFromBlock_ failed:', e && e.message); return null; }
  out = (out || '').trim();
  if (!out) return null;
  const catM = out.match(/大類[：:]\s*([^\n]+)/);
  const titleM = out.match(/標題[：:]\s*([^\n]+)/);
  const ctxM = out.match(/脈絡[：:]\s*([\s\S]+)/);
  const rawCat = catM ? catM[1].trim() : '';
  let category = '';
  for (const c of JOURNEY_KEYWORD_CATEGORIES) { if (rawCat.indexOf(c) >= 0) { category = c; break; } }
  const title = titleM ? titleM[1].trim().slice(0, 20) : '敘事片段';
  const summary = (ctxM ? ctxM[1] : out).trim().replace(/\s+/g, ' ').slice(0, 80);
  return { category, title, summary };
}

/** Stable hash over a whole day's records (id + text length), namespaced by the
 *  day string, so the L1 day-card cache key flips only when that day changes. */
function dayHash_(dayStr, dayRecords) {
  const parts = (dayRecords || []).map(r => `${r.id}:${(r.text || '').length}`);
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, dayStr + '|' + parts.join('|')));
}

/** Cache-only lookup for a day's { category, title, summary }. null on miss. */
function dayNarrativeCached_(dayStr, dayRecords) {
  if (!dayRecords || dayRecords.length < 2) return null;
  const v = CacheService.getScriptCache().get('epnarr_day_' + dayHash_(dayStr, dayRecords));
  if (!v) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/** Whole-day cross-segment synthesis → { category, title, summary }, cached 6h
 *  by day + day-records hash. Used by L1 day cards. ≥2 records required. */
function dayNarrativeGenerate_(dayStr, dayRecords) {
  if (!dayRecords || dayRecords.length < 2) return null;
  const sorted = dayRecords.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(0, 60);
  const block = sorted.map(r => {
    const t = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'HH:mm');
    const icon = EPISODE_TYPE_ICON[r.type] || '·';
    const txt = ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
    return `${icon} ${t} ${truncate_(txt, 100)}`;
  }).join('\n');
  const result = synthNarrativeFromBlock_(dayStr, block,
    '以下是同一天內、分多個時段陸續記錄的訊號（文字/圖片/語音/影片/檔案/位置/貼圖）。請彙總這一整天。');
  if (!result) return null;
  try {
    CacheService.getScriptCache().put('epnarr_day_' + dayHash_(dayStr, dayRecords), JSON.stringify(result), 6 * 3600);
  } catch (_) {}
  return result;
}

function episodeNarrativeGenerate_(ep) {
  if (!ep.records || ep.records.length < 2) return null;
  const { range, block } = episodeInputBlock_(ep);
  const sys = [
    '以下是一段連續時間內陸續記錄的訊號（文字/圖片/語音/影片/檔案/位置/貼圖）。',
    '請「只根據實際內容」輸出三行，務必照「大類：」「標題：」「脈絡：」格式：',
    `大類：必須從以下擇一最貼近的：${JOURNEY_KEYWORD_CATEGORIES.join('／')}。內容再雜也要挑一個最接近的，不可輸出其他詞。`,
    '標題：0-2 個具體的關鍵字主題、用「+」直接連接（例如「國科會計畫+人工意識」、「東京大學演講」，「+」前後不要加空白），整行 ≤14 字、不要動詞、不要與大類重複、不要套「學習」「分享」「探索」這類空話。',
    '脈絡：20-50 字，客觀說明這段實際記錄了什麼。',
    '規則：',
    '- 嚴格依實際內容，不要腦補、不要編造訊號之間的關連或意義。',
    '- 若內容之間沒有明顯關連，標題就只給一個最具體的關鍵字、或寫「零散筆記」。',
    '- 用詞樸實，不要包裝、不要誇飾、不要評價、不要套用學習術語。',
    '- 繁體中文；不要用「你」「學習者」稱呼；不要開場白與結語。'
  ].join('\n');
  let out;
  try {
    out = geminiGenerate_([{ text: `時間：${range}\n紀錄（依時間）：\n${block}` }], {
      systemInstruction: sys, temperature: 0.2, maxOutputTokens: 240
    });
  } catch (e) { console.warn('episodeNarrativeGenerate_ failed:', e && e.message); return null; }
  out = (out || '').trim();
  if (!out) return null;
  const catM = out.match(/大類[：:]\s*([^\n]+)/);
  const titleM = out.match(/標題[：:]\s*([^\n]+)/);
  const ctxM = out.match(/脈絡[：:]\s*([\s\S]+)/);
  // Clamp category to the preset vocab — LLM occasionally returns a near-miss
  // or extra punctuation; pick the first preset that appears in the response.
  const rawCat = catM ? catM[1].trim() : '';
  let category = '';
  for (const c of JOURNEY_KEYWORD_CATEGORIES) { if (rawCat.indexOf(c) >= 0) { category = c; break; } }
  const title = titleM ? titleM[1].trim().slice(0, 20) : '敘事片段';
  const summary = (ctxM ? ctxM[1] : out).trim().replace(/\s+/g, ' ').slice(0, 80);
  const result = { category, title, summary };
  try { CacheService.getScriptCache().put('epnarr_' + episodeHash_(ep), JSON.stringify(result), 21600); } catch (_) {}
  return result;
}

/**
 * The exact synthesis prompt input for an episode: { range, block }. Shared
 * by episodeNarrativeGenerate_ and debugEpisodeNarratives so what you
 * eyeball-validate is byte-for-byte what production feeds the model.
 */
function episodeInputBlock_(ep) {
  const range = `${Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'MM/dd HH:mm')}–${Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, 'HH:mm')}`;
  const block = ep.records.map(r => {
    const t = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'HH:mm');
    return `[${t}][${typeLabel_(r.type)}] ${truncate_((r.text || '').replace(/\s+/g, ' '), 300)}`;
  }).join('\n');
  return { range, block };
}

/**
 * DEV — eyeball-validate episode narrative quality on REAL data. Run from the
 * Apps Script editor:
 *
 *   debugEpisodeNarratives('2026-05-22');   // a day
 *   debugEpisodeNarratives();               // today
 *
 * For each episode that day it logs the exact synthesis input block and the
 * resulting 標題 / 脈絡 (cache when present, else a fresh generation), so you
 * can judge each segment: 真 / 掰（硬湊假關連）/ 該分未分（邊界誤併）. Reads the
 * OWNER's records, logs only — sends no messages, changes no online behaviour.
 * Note: episodes without a cached narrative cost one Gemini call each (and
 * warm the cache, exactly as opening /episodes would).
 */
function debugEpisodeNarratives(dayStr) {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  dayStr = dayStr || Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');

  const records = loadEmbeddingRecords_(scope)
    .filter(r => r && r.ts && Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd') === dayStr)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!records.length) { console.log(`[${dayStr}] 沒有紀錄。`); return; }

  const episodes = groupByEpisode_(records, EPISODE_GAP_MS);
  console.log(`[${dayStr}] ${records.length} 筆 → ${episodes.length} 個敘事片段（30 分鐘分段）\n`);

  episodes.forEach((ep, i) => {
    const { range, block } = episodeInputBlock_(ep);
    console.log(`──────── 片段 ${i + 1}/${episodes.length} · ${range} · ${ep.records.length} 筆 ────────`);
    console.log('【input】\n' + block);
    if (ep.records.length < 2) {
      console.log('【synthesis】單筆 — 不合成（記錄本身即內容）\n');
      return;
    }
    const cached = episodeNarrativeCached_(ep);
    const narr = cached || episodeNarrativeGenerate_(ep);
    if (narr) {
      console.log(`【synthesis】${cached ? 'cache' : 'fresh'}\n標題：${narr.title}\n脈絡：${narr.summary}\n`);
    } else {
      console.log('【synthesis】無（生成失敗或被略過）\n');
    }
  });
  console.log('完成。逐段判讀：真 / 掰（硬湊假關連）/ 該分未分（30 分鐘邊界誤併）。');
}

/** Expand one episode's raw records (the "看原始紀錄" button target) as a
 *  paginated Flex carousel, reusing the /search bubble so the cards carry
 *  the same affordances (看完整內容 / 試聽 / 開啟地圖 / 引述縮圖 / 補充 badge). */
function replyEpisodeRaw_(ev, scope, dayStr, startTs, page) {
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts);
  const dayRecs = all
    .filter(r => Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'yyyy-MM-dd') === dayStr)
    .sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const ep = groupByEpisode_(dayRecs, EPISODE_GAP_MS).find(e => e.startTs === startTs);
  if (!ep) return lineReply_(ev.replyToken, '找不到該敘事片段（紀錄可能已變動）。');
  renderEpisodeRaw_(ev, all, ep, page || 0, p => `action=episode_raw&d=${dayStr}&s=${startTs}&p=${p}`,
    `mode=day&ek=${encodeURIComponent(dayStr)}&s=${startTs}`, scope);
}

/**
 * Raw records of one 敘事片段 belonging to a 脈絡 (context). Groups the context's
 * OWN records (not a calendar day) so the episode + drill-down stay scoped to
 * that 脈絡 — see replyContextEpisodes_.
 */
function replyContextRaw_(ev, scope, cid, startTs, page) {
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts);
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!context) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /journey 後再看。');
  const idSet = {}; (context.recordIds || []).forEach(id => idSet[id] = true);
  const ctxRecs = all.filter(r => idSet[r.id]).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const ep = groupByEpisode_(ctxRecs, EPISODE_GAP_MS).find(e => e.startTs === startTs);
  if (!ep) return lineReply_(ev.replyToken, '找不到該敘事片段（紀錄可能已變動）。');
  renderEpisodeRaw_(ev, all, ep, page || 0, p => `action=ctx_raw&cid=${cid}&s=${startTs}&p=${p}`,
    `mode=ctx&ek=${encodeURIComponent(cid)}&s=${startTs}`, scope);
}

/** 〔情緒層·記錄清單折疊〕把貼圖折進它對應的那則內容（emotionFor 優先、否則前一則內容）：貼圖
 *  不再自成一張卡，改成宿主卡上的「心情」＋型別標「＋貼圖」。回過濾後清單；宿主物件掛 _emotions
 *  （display-only、per-request）。找不到宿主的貼圖（清單最前）仍保留為獨立一則、不丟失。 */
function foldStickersForDisplay_(records) {
  const idSet = {}; (records || []).forEach(r => { if (r && r.id) idSet[r.id] = true; });
  const out = [], byId = {};
  for (const r of (records || [])) {
    if (r && r.type === 'sticker') {
      let host = (r.emotionFor && idSet[r.emotionFor] && byId[r.emotionFor]) ? byId[r.emotionFor] : null;
      if (!host) { for (let i = out.length - 1; i >= 0; i--) { if (out[i].type !== 'sticker') { host = out[i]; break; } } }
      if (host) { (host._emotions = host._emotions || []).push({ emoji: recordEmoji_(r), phrase: stickerPhrase_(r), stickerUrl: r.stickerUrl || null }); continue; }
    }
    out.push(r);
    if (r && r.id) byId[r.id] = r;
  }
  return out;
}

/** 〔一次性回填·零 LLM〕舊貼圖補情緒層：掃所有 sticker record，(a) 補 stickerEmoji（啟發式）、
 *  (b) 無 emotionFor 者依「6h 窗內最近一則內容」補上、(c) 對目標掛 reactions（心情列）。
 *  跑完落 meta.stickerEmotionBackfillAt，之後 backgroundSweep 直接略過（單次）。冪等：reactions
 *  以 src(貼圖 id) 去重，重跑不重複掛。整檔單次鎖寫。回填筆數。 */
function backfillStickerEmotions_(scope) {
  if (!scope || !scope.key) return 0;
  if (loadChatMeta_(scope).stickerEmotionBackfillAt) return 0;
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // 時間序單趟：算每張貼圖的 emoji / 目標（emotionFor 沿用、否則窗內最近一則內容）。
  const stickerPatch = {};            // stickerId(record) → {emoji, target}
  const reactByTarget = {};           // targetRecordId → [reaction]
  let lastContent = null;
  for (const r of all) {
    if (r.type !== 'sticker') { if (CONTEXT_MEDIA_TYPES[r.type]) lastContent = r; continue; }
    const emoji = r.stickerEmoji || stickerEmoji_(r.stickerKeywords);
    let target = r.emotionFor || null;
    if (!target && lastContent && (Date.parse(r.ts) - Date.parse(lastContent.ts)) <= STICKER_EMOTION_WINDOW_MS) {
      target = lastContent.id;
    }
    if (!r.stickerEmoji || (!r.emotionFor && target)) stickerPatch[r.id] = { emoji, target: target || r.emotionFor || null };
    // 已有 emotionFor＝捕捉時就掛過情緒 → 不再重掛（否則 reactions 重複、心情列出現重複描述）。
    if (target && !r.emotionFor) {
      (reactByTarget[target] = reactByTarget[target] || []).push({
        emoji, summary: stickerPhrase_(r), stickerUrl: r.stickerUrl || null, stickerId: r.stickerId || null, ts: r.ts, src: r.id
      });
    }
  }
  let n = 0;
  if (Object.keys(stickerPatch).length || Object.keys(reactByTarget).length) {
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
          let r; try { r = JSON.parse(s); } catch (_) { continue; }
          let dirty = false;
          const p = stickerPatch[r.id];
          if (p) {
            if (!r.stickerEmoji) { r.stickerEmoji = p.emoji; dirty = true; }
            if (!r.emotionFor && p.target) { r.emotionFor = p.target; dirty = true; }
          }
          const rx = reactByTarget[r.id];
          if (rx) {
            const have = {}; (r.reactions || []).forEach(e => { if (e && e.src) have[e.src] = true; });
            const add = rx.filter(e => !have[e.src]);
            if (add.length) { r.reactions = (r.reactions || []).concat(add).slice(-8); dirty = true; }
          }
          if (dirty) { lines[i] = JSON.stringify(r); n++; }
        }
        if (n) file.setContent(lines.join('\n'));
      }
    } finally { lock.releaseLock(); }
  }
  updateChatMeta_(scope, m => { m.stickerEmotionBackfillAt = Date.now(); return m; });
  if (n) console.log(`backfillStickerEmotions_: 回填 ${n} 筆（${scope.key}）`);
  return n;
}

/** Shared raw-records renderer for one episode. pageDataFn(p) → postback data.
 *  epRef（如 `mode=day&ek=2026-05-30&s=<ts>`）非空時，掛一顆「整段改歸主題」quick reply。
 *  scope（選填）：傳入後讓每張卡可標「🎒 來自：<lesson 名>」（儀式軸來源）。 */
function renderEpisodeRaw_(ev, all, ep, page, pageDataFn, epRef, scope) {
  const suppCounts = buildSupplementCounts_(all);
  const byId = {}, byMsgId = {};
  for (const r of all) { byId[r.id] = r; if (r.lineMessageId) byMsgId[r.lineMessageId] = r; }
  const resolveQuoted = (rec) =>
    (rec.quotedRecordId && byId[rec.quotedRecordId]) ||
    (rec.quotedLineMessageId && byMsgId[rec.quotedLineMessageId]) || null;

  // 〔情緒層〕貼圖折進對應內容、不自成一卡（宿主卡標「＋貼圖」＋心情）。
  const displayRecs = foldStickersForDisplay_(ep.records);
  const total = displayRecs.length;
  const pageSize = searchPageSize_(total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  const pageRecs = displayRecs.slice(page * pageSize, (page + 1) * pageSize);

  // 看原始紀錄: each card is one record of `ep`. Strip's X-axis = the
  // episode's start..end, so ✓ shows this record's position among its
  // ~episode-sized siblings (● = other records in same episode).
  const epStart = ep.startTs, epEnd = ep.endTs;
  const stripFor = (r) => (epEnd > epStart) ? episodeTimelineStrip_({
    startTs: epStart, endTs: epEnd,
    records: [r],
    otherRecords: displayRecs.filter(x => x && x.id !== r.id),
    subLabel: `敘事片段 ${formatClusterRange_(epStart, epEnd)}`,
    headPrefix: '所選紀錄',
    cardSize: 'micro'
  }) : null;
  const bubbles = pageRecs.map((r, i) =>
    buildSearchBubble_(r, null, page * pageSize + i + 1, suppCounts[r.id] || 0, resolveQuoted(r), stripFor(r), { reclassify: true, scope: scope }));
  const range = `${Utilities.formatDate(new Date(ep.startTs), TIME_ZONE, 'MM/dd HH:mm')}–${Utilities.formatDate(new Date(ep.endTs), TIME_ZONE, 'HH:mm')}`;
  // index-0 導覽卡：每組瀏覽卡第一頁先給總覽（與 /recall、敘事片段等一致）。第一頁才放（不佔後頁版位）。
  // 標題/摘要沿用該敘事片段的既算 narrative（如「新聞+Dcard」），讓使用者知道在看哪一段的原始紀錄。
  const narr = episodeNarrativeCached_(ep);
  // 〔情緒層〕入口卡帶這段的心情軌跡（接在摘要後）。
  const _arc = journeyEmotionArc_(ep.records);
  const _summary = [(narr && narr.summary) || '', _arc ? `心情軌跡　${_arc.chain}（${_arc.n} 次）` : ''].filter(Boolean).join('\n');
  const navCard = page === 0
    ? buildSegmentsIntroCard_(['敘事片段', '原始紀錄'], (narr && narr.title) || range, `${range} · ${total} 筆`,
        '逐則細看；每則可「改歸主題」或「看完整內容」', '📂 原始紀錄', 'micro', _summary || null,   // 與 buildSearchBubble_ 同為 micro
        (ep.endTs > ep.startTs) ? episodeTimelineStrip_({
          startTs: ep.startTs, endTs: ep.endTs, records: [], otherRecords: ep.records, cardSize: 'micro',  // 導覽卡無焦點 → 全部以 ● 中性顯示密度
          headText: `本段記寫時間分布 · ${range}`
        }) : null)
    : null;
  const pageBubbles = navCard ? [navCard].concat(bubbles) : bubbles;
  const contents = pageBubbles.length === 1 ? pageBubbles[0] : { type: 'carousel', contents: pageBubbles };
  const altText = `敘事片段原始記錄 · ${range}（${total} 筆）`;

  const messages = [{ type: 'flex', altText, contents }];
  if (totalPages > 1) {
    const title = `📂 ${range}（共 ${total} 筆 / ${totalPages} 頁）`;
    messages.push({
      type: 'flex',
      altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(title, page, totalPages, pageDataFn)
    });
  }
  // 「整段改歸主題」quick reply 掛在「最後一則」——LINE 只在最後一則顯示 quick reply；有分頁時
  // pager 是最後一則，原本掛 firstMsg 會被吃掉（修「一出現頁面控制就沒有整段改歸泡泡」）。
  if (epRef) {
    messages[messages.length - 1].quickReply = { items: [{ type: 'action', action: { type: 'postback', label: '📌 整段改歸主題', data: `action=ep_pick_topic&${epRef}`, displayText: '▸ 整段改歸主題' } }] };
  }
  lineReplyMessages_(ev.replyToken, messages);
}

const ASK_TOP_K = 12;          // records retrieved as candidate context
const ASK_MIN_SCORE = 0.45;    // relevance floor — below this we decline rather than guess
const ASK_CONTEXT_MAX = 10;    // records actually fed to the model
const ASK_CLUE_MIN_SCORE = 0.35;  // related-but-not-enough: surfaced as 線索 on the gap card

/**
 * /ask — RAG question answering over the user's own records. Retrieves the
 * most relevant records (same semantic search as /recall), then has Gemini
 * answer STRICTLY from them and decline when they don't cover the question
 * (no falling back to world knowledge). The answer card links to its source
 * records via 看依據.
 */
function replyAsk_(ctx, query) {
  query = (query || '').trim();
  if (!query) return enterAskMode_(ctx);          // no arg → conversational ask mode
  return runAndReplyAsk_(ctx, query, false, null);
}

/**
 * Run one RAG ask for `query`: retrieve, generate a grounded answer, reply with
 * the answer card. When `record` is true the Q&A is also written into the
 * user's records (self-exploration → 脈絡). `quickReply` rides on the reply
 * (used in ask mode to keep 結束 reachable).
 */
function runAndReplyAsk_(ctx, query, record, quickReply) {
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 20); } catch (_) {}
  }

  const rawHits = topKByQuery_(ctx.scope, query, ASK_TOP_K);
  // 信心/門檻一律用**純 cosine**（semScore），不是 topKByQuery_ 為了排序加了 +0.3 關鍵字命中
  // 的 boosted score——否則「紀錄裡有 query 字面」會把分數灌過 1.0、把信心/閘門灌成假高（門檻
  // ASK_SCORE_* 是 cosine 校準的）。keyword boost 只保留給排序(topKByQuery_ 內的 sort)。
  const top1Score = (rawHits[0] && (rawHits[0].semScore != null ? rawHits[0].semScore : rawHits[0].score)) || 0;
  // Score-gated mode：用 top1 cosine 客觀分數驅動三檔信心 prompt，避免 LLM 自由發揮信心。
  // 校準與閾值見 Config.gs。flag off 走舊路徑（單一 prompt + LLM 自判）。
  let mode = null;
  if (ASK_USE_SCORE_GATE) {
    if (top1Score >= ASK_SCORE_HIGH) mode = 'high';
    else if (top1Score >= ASK_SCORE_LOW) mode = 'hedged';
    else mode = 'low';
  }

  // 〔原始筆記優先〕把舊「探問」Q&A 記錄（recordAskQA_ 寫回語料、text 以「🔍 探問：」開頭）的
  // **排序分**打折，讓餵進去的脈絡與依據傾向原始筆記、減少「答案的答案」漂移。信心閘門(top1Score)
  // 仍用未降權的 rawHits[0].semScore，不被影響——只調「選哪幾筆當依據」、不調「敢不敢答」。
  const ranked = rawHits.map(h =>
    (h.record && /^🔍 探問[：:]/.test(h.record.text || ''))
      ? Object.assign({}, h, { score: (h.score || 0) * ASK_QA_RECORD_PENALTY })
      : h
  ).sort((a, b) => (b.score || 0) - (a.score || 0));

  const hits = ranked
    .filter(h => Math.round(h.score * 100) / 100 >= ASK_MIN_SCORE)
    .slice(0, ASK_CONTEXT_MAX);
  // Related-but-not-enough records → shown as 線索 on the gap card so a "no
  // answer" still points at where to look / what to supplement.
  const clues = ranked.filter(h => Math.round(h.score * 100) / 100 >= ASK_CLUE_MIN_SCORE).slice(0, 4);

  // LOW 檔：top1 < 0.50，直接不答結論，改走 annotated clues（LLM 註解線索 + 下一步關鍵字）。
  // 即使 hits 內有東西（ASK_MIN_SCORE=0.45 < ASK_SCORE_LOW），仍視為信心不足、不硬答。
  if (mode === 'low') return replyAskCluesAnnotated_(ctx, query, quickReply, clues, top1Score);

  if (!hits.length) return replyAskGap_(ctx, query, quickReply, clues);

  const block = hits.map((h, i) => {
    const r = h.record;
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
    const body = truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), 400);
    return `[${i + 1}][${d}][${typeLabel_(r.type)}] ${body || '(無文字內容)'}`;
  }).join('\n');

  const sysLines = [
    '你是學習歷程助理。只能根據「以下編號紀錄」回答使用者的問題，繁體中文、簡短（2–4 句）。',
    '規則：',
    '- 嚴格依紀錄內容，不要用你自己的世界知識補充、不要編造、不要腦補關連。',
    '- 凡是「紀錄沒直接寫、靠你推論／連結／推斷」的內容，務必用「推測：」前綴標出；不確定處加「（不確定）」。紀錄裡直接看到的不必加。',
    '- 紀錄不足以回答時，直接說「現有紀錄不足以回答」並簡述缺什麼，不要硬湊答案。',
    '- 答案中每個結論「緊接」用方括號標出依據的紀錄編號（可多個），例如：未受尊重[1]，後來建立人脈[3]。只標真正依據的，沒依據的句子不要硬標。',
    '- 另起一行用「引用：」列出你實際依據的全部編號（逗號分隔，例如 引用：1,3）；若沒有可依據的紀錄，寫「引用：無」。',
    '- 再另起一行用「追問：」給 1–2 個使用者可能接著想問、且現有紀錄有機會回答的完整問句（用｜分隔、各 ≤18 字）；想不到寫「追問：無」。',
    '- 不要寒暄、不要開場白與結語。'
  ];
  // 「推測：」標記已移到上面共用規則（不再中信心限定）——高信心答案若仍有推論成分一樣會標、
  // 一樣以琥珀 🔎 呈現。各檔只補一句客觀分數說明。
  if (mode === 'high') {
    sysLines.push('', `top1 cosine = ${top1Score.toFixed(2)}（高相關，可直接答）；但若答案裡仍有推論成分，照規則標「推測：」。`);
  } else if (mode === 'hedged') {
    sysLines.push(
      '',
      `top1 cosine = ${top1Score.toFixed(2)}（中等相關，Gemini 中文 cosine 0.50-0.65 為窄帶，可能語意相近也可能巧合）——推論成分通常偏多，務必確實標「推測：」。`,
      '- 不要因為被要求審慎就過度保留：紀錄有的就答、沒有就明說。'
    );
  }
  const sys = sysLines.join('\n');
  const prompt = `問題：${query}\n\n可用編號紀錄（依相關度，越前面越相關）：\n${block}`;

  let raw;
  try {
    raw = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.2, maxOutputTokens: 1024 });
  } catch (e) {
    console.warn('runAndReplyAsk_ generate failed:', e && e.message);
    return lineReply_(ctx.replyToken, '⚠️ 回答生成失敗，稍後再試，或用 /recall 直接看相關紀錄。', quickReply || null);
  }
  raw = (raw || '').trim();

  // 拆出「引用：」(哪些被依據) 與「追問：」(順著問)；兩行從答案移除，行內「[n]」保留供渲染引用 chip。
  const citeMatch = raw.match(/引用[：:]\s*([^\n]*)/);
  const followMatch = raw.match(/追問[：:]\s*([^\n]*)/);
  const answer = raw.replace(/\n?引用[：:][^\n]*/g, '').replace(/\n?追問[：:][^\n]*/g, '').trim() || '現有紀錄不足以回答。';

  // Gap: the model declined, or explicitly cited nothing.
  // 即使 score 在 HIGH 檔(top1 高)，只要 LLM 自評不足以答（常見於 query phrasing 太具體、
  // records 提到主題但沒列細節的情境），仍走新 replyAskCluesAnnotated_——比舊 gap card
  // 多給 LLM 註解「這條跟問題哪部分有關 / 為何沒答出」+ 下一步關鍵字。
  const citedNothing = citeMatch && /無/.test(citeMatch[1]) && !/\d/.test(citeMatch[1]);
  if (citedNothing || answer.indexOf('不足以回答') >= 0 || answer.indexOf('沒有提及') >= 0) {
    return replyAskCluesAnnotated_(ctx, query, quickReply, clues, top1Score);
  }

  // 依據集合：以「引用：」為準（in-range）；模型整行漏了才退回全部 fed hits。
  let citeNums;
  if (citeMatch) {
    citeNums = (citeMatch[1].match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= hits.length);
    if (!citeNums.length) return replyAskGap_(ctx, query, quickReply, clues);
  } else {
    citeNums = hits.map((_, i) => i + 1);
  }
  // 依「行內 [n] 首次出現順序」排依據（依出現序重排）；引用了但沒在內文標的接在後面。
  const inlineOrder = [];
  (answer.match(/\[(\d+)\]/g) || []).forEach(tok => {
    const n = Number(tok.replace(/[^\d]/g, ''));
    if (citeNums.indexOf(n) >= 0 && inlineOrder.indexOf(n) < 0) inlineOrder.push(n);
  });
  const orderedNums = inlineOrder.concat(citeNums.filter(n => inlineOrder.indexOf(n) < 0));
  const cited = orderedNums.map(n => hits[n - 1]).filter(Boolean);
  if (!cited.length) return replyAskGap_(ctx, query, quickReply, clues);
  // 模型紀錄編號 → 依據序號（1-based）：行內 chip 與依據卡共用同一序號。
  const ordByNum = {};
  orderedNums.forEach((n, i) => { ordByNum[n] = i + 1; });
  // 順著問（成功答案的下一步）。
  const followups = followMatch
    ? followMatch[1].split(/[｜|]/).map(s => s.trim()).filter(s => s && !/^無$/.test(s)).slice(0, 2)
    : [];

  if (record) {
    // 寫回語料的問答用「乾淨答案」（去掉行內 [n] 標記），避免標記污染未來檢索/呈現。
    try {
      const qaId = recordAskQA_(ctx, query, answer.replace(/\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim());
      // 〔歸戶·跟著線索群〕答案是「根據 cited 線索群」推出來的，自動寫回的問答也應跟著歸到線索群
      // 最相符的 (大類,議題標籤)＋鎖定，而不是讓分類器把「🔍探問…💡…」這種泛語感文字獨立判進隨想、
      // 再被時間相近的別題併成一條（同補充強化的理由）。線索群尚無標籤才退回背景自行歸戶。
      const home = dominantTopicOfHits_(cited);
      if (qaId && home && home.topicLabel) {
        try { setRecordsCategoryTopic_(ctx.scope, [qaId], home.category || '', home.topicLabel); }
        catch (e2) { console.warn('ask QA 歸戶 failed:', e2 && e2.message); }
      }
    } catch (e) { console.warn('recordAskQA_ failed:', e && e.message); }
  }

  // Answer bubble (with a 補充強化 entry — an answer can still be clue-level),
  // then the cited sources as individual search-style cards.
  const suppKey = newId_();
  try { CacheService.getScriptCache().put('askgap_' + suppKey, query, 21600); } catch (_) {}
  // 〔補充·歸戶〕記住這次答案依據的「線索群主題」：補充強化時把補充記錄直接歸到此 (大類,議題標籤)，
  // 不丟背景獨立重判（修「補充被判成隨想、再被時間相近的別題併在一起」）。
  try { const home = dominantTopicOfHits_(cited); if (home) CacheService.getScriptCache().put('askhome_' + suppKey, JSON.stringify(home), 21600); } catch (_) {}
  const all = loadEmbeddingRecords_(ctx.scope);
  // 答案卡上方加一條 corpus-span strip：把所有 cited records 在全紀錄的位置 ✓ 標出來。
  const answerStrip = corpusTimelineStrip_(cited.map(h => h.record), all);
  // 答案卡＝整條輪播的 index-0 導覽卡，引用卡接在後面（整併成一則訊息、一個輪播）。
  const answerCard = buildAskBubble_(query, answer, cited.length, suppKey, !record, answerStrip, mode, top1Score, ordByNum, followups);
  const suppCounts = buildSupplementCounts_(all);
  const byId = {}, byMsgId = {};
  for (const r of all) { byId[r.id] = r; if (r.lineMessageId) byMsgId[r.lineMessageId] = r; }
  const resolveQuoted = (rec) =>
    (rec.quotedRecordId && byId[rec.quotedRecordId]) ||
    (rec.quotedLineMessageId && byMsgId[rec.quotedLineMessageId]) || null;
  // /ask 依據卡：暖紙「證物」身分（evidenceMode → 💬 問答 ▸ 依據①、無 cosine），片段對問題置中高亮
  // （帶 query）。與 recall 命中卡刻意不同樣。Strip 標這筆在全紀錄的時間位置（● 其他、◯ 沒寫）。
  const cards = cited.map((h, i) =>
    buildSearchBubble_(h.record, (h.semScore != null ? h.semScore : h.score), i + 1, suppCounts[h.record.id] || 0, resolveQuoted(h.record),
      corpusTimelineStrip_([h.record], all),
      { scope: ctx.scope, size: 'kilo', query: query, evidenceMode: true, evidenceOrdinal: circledNum_(i + 1) }));
  // 答案卡＋依據卡整併成「一條輪播」，左到右連續滑、不斷成兩則。答案卡＝index-0 主角（暖紫），
  // 依據卡（暖紙）接在後面；兩者皆 size kilo 才能同輪播對齊。
  const allCards = [answerCard].concat(cards);
  const msg = {
    type: 'flex', altText: `問答：${truncate_(query, 40)}（依據 ${cited.length} 筆）`,
    contents: allCards.length === 1 ? allCards[0] : { type: 'carousel', contents: allCards }
  };
  if (quickReply) msg.quickReply = quickReply;
  lineReplyMessages_(ctx.replyToken, [msg]);
}

/** 帶圈數字（依據序號用）。超出表退回 (n)。 */
function circledNum_(n) {
  const c = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];
  return c[n] || `(${n})`;
}

/** 把答案一行切成 Flex spans：行內「[n]」引用標記 → 重映成 ①②③ 彩色 chip（對齊依據卡）；
 *  推測行整行琥珀＋🔎。ordByNum: 模型紀錄編號 → 依據序號（1-based）。 */
function answerLineSpans_(line, isSpec, ordByNum) {
  ordByNum = ordByNum || {};
  const baseColor = isSpec ? THEME.warning : THEME.text;
  const spans = [];
  if (isSpec) spans.push({ type: 'span', text: '🔎 ', color: THEME.warning });
  String(line).split(/(\[\d+\])/).forEach(p => {
    if (!p) return;
    const m = p.match(/^\[(\d+)\]$/);
    if (m) {
      const ord = ordByNum[Number(m[1])];
      if (ord) spans.push({ type: 'span', text: circledNum_(ord), color: THEME.ask.answerBg, weight: 'bold' });
      return;   // 未列入依據的標記 → 丟棄不顯示
    }
    const sp = { type: 'span', text: p, color: baseColor };
    if (isSpec) sp.weight = 'bold';
    spans.push(sp);
  });
  return spans.length ? spans : [{ type: 'span', text: String(line), color: baseColor }];
}

/** 把答案切段、標出信任梯度＋行內引用 chip：「推測：／（不確定）」行用琥珀＋🔎、其餘正常墨色；
 *  行內「[n]」重映成 ①②③ chip。回 Flex text 元件陣列。HIGH 通常無推測行。 */
function askAnswerSegments_(answer, ordByNum) {
  const text = String(answer || '').trim();
  if (!text) return [{ type: 'text', text: '（現有紀錄不足以回答）', size: 'sm', color: THEME.text, wrap: true }];
  // 確保每個「推測：」獨立成段，便於分層上色（模型可能把推測接在句中）。
  const normalized = text.replace(/\s*推測\s*[：:]/g, '\n推測：');
  const lines = normalized.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.map(ln => {
    const isSpec = /^推測[：:]/.test(ln) || /（不確定）|\(不確定\)/.test(ln);
    return { type: 'text', wrap: true, size: 'sm', contents: answerLineSpans_(ln, isSpec, ordByNum), text: ln.replace(/\[\d+\]/g, '') };
  });
}

/** Answer bubble — the synthesized answer is the hero (暖紫「助理」身分，與 recall 藍記錄卡區隔)；
 *  信心橫幅顯眼一行（綠＝可直接答／琥珀＝含推測），答案本體分層標出推測 vs 依據。引用卡另起一則。
 *  When `oneShot` (not in a live 提問模式 session) it also offers 再問一題. */
function buildAskBubble_(query, answer, sourceCount, suppKey, oneShot, strip, mode, top1Score, ordByNum, followups) {
  const A = THEME.ask;
  // 信心橫幅：把 🎯/🤔 從小麵包屑提升為顯眼一行（LOW 不走這條路徑）。
  // 整段都是推測（沒有任何紮實依據句）→ 誠實降為「多為推測」，不顯示「可直接回答」（避免自相矛盾）。
  const _lines = String(answer || '').replace(/\s*推測\s*[：:]/g, '\n推測：').split('\n').map(s => s.trim()).filter(Boolean);
  const _specN = _lines.filter(ln => /^推測[：:]/.test(ln) || /（不確定）|\(不確定\)/.test(ln)).length;
  const _allSpec = _lines.length > 0 && _specN === _lines.length;
  const conf = _allSpec
    ? { emoji: '🔎', label: '多為推測', color: THEME.warning, note: `相似度 ${(top1Score || 0).toFixed(2)}` }
    : mode === 'hedged'
      ? { emoji: '🤔', label: '部分為推測', color: THEME.warning, note: `中等相關 ${(top1Score || 0).toFixed(2)}` }
      : { emoji: '🎯', label: '可直接回答', color: THEME.success, note: `依據紮實 ${(top1Score || 0).toFixed(2)}` };
  const body = [{
    type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceWarm, cornerRadius: 'md', paddingAll: 'sm',
    contents: [{
      type: 'text', size: 'sm', weight: 'bold', wrap: true,
      contents: [
        { type: 'span', text: `${conf.emoji} ${conf.label}`, color: conf.color },
        { type: 'span', text: `　·　${conf.note}`, color: THEME.muted }
      ],
      text: `${conf.emoji} ${conf.label} · ${conf.note}`
    }]
  }];
  // 答案本體（信任梯度分層上色＋行內 ①② 引用 chip）。
  askAnswerSegments_(answer, ordByNum).forEach((seg, i) => { seg.margin = i === 0 ? 'md' : 'sm'; body.push(seg); });
  if (sourceCount) {
    body.push({ type: 'text', text: `依據 ${sourceCount} 筆（內文 ①②③ ↔ 右滑依據卡）👇`, size: 'xxs', color: THEME.muted, margin: 'md', wrap: true });
  }
  // corpus-span strip：把依據的這幾筆在全部記寫的時間位置標出，呈現「依現有資料的真實覆蓋」。
  if (strip) { body.push({ type: 'separator', margin: 'sm' }); body.push(strip); }
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: A.answerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: '💬 問答', size: 'xxs', color: A.answerSub, weight: 'bold' },
        { type: 'text', text: truncate_(query, 60), size: 'md', weight: 'bold', color: A.answerText, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body }
  };
  const footerContents = [];
  // 順著問：成功答案也給下一步（模型生成的延伸問句，點了直接再 /ask）。
  const fups = (followups || []).filter(Boolean);
  if (fups.length) {
    footerContents.push({ type: 'text', text: '💬 順著問', size: 'xxs', color: THEME.muted, wrap: true });
    fups.forEach(q => footerContents.push({
      type: 'box', layout: 'horizontal', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm', spacing: 'sm',
      action: { type: 'message', label: truncate_(q, 18), text: '/ask ' + q },
      contents: [
        { type: 'text', text: '💬', size: 'xs', flex: 0, gravity: 'center' },
        { type: 'text', text: truncate_(q, 22), size: 'xs', color: A.answerBg, weight: 'bold', flex: 1, wrap: true, gravity: 'center' },
        { type: 'text', text: '›', size: 'sm', color: A.answerBg, flex: 0, gravity: 'center' }
      ]
    }));
    footerContents.push({ type: 'separator', margin: 'md' });
  }
  footerContents.push({ type: 'text', text: '覺得這還只是線索、不夠完整？', size: 'xxs', color: THEME.muted, wrap: true });
  footerContents.push({
    type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: '補充強化', data: `action=ask_supplement&k=${suppKey}`, displayText: '▸ 補充強化' },
    contents: [{ type: 'text', text: '✏️ 補充強化', size: 'xs', color: A.answerBg, align: 'center', weight: 'bold' }]
  });
  // 沒有具體順著問時，oneShot 才補通用「再問一題」（有順著問就不重複）。
  if (oneShot && !fups.length) {
    footerContents.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
      action: { type: 'postback', label: '再問一題', data: 'action=ask_more', displayText: '▸ 再問一題' },
      contents: [{ type: 'text', text: '💬 再問一題', size: 'xs', color: A.answerBg, align: 'center', weight: 'bold' }]
    });
  }
  bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'md', contents: footerContents };
  return bubble;
}

/* ===================== Conversational ask mode ===================== *
 * `/ask` with no argument enters a stateful session: each plain-text message
 * is a turn that Gemini focuses into one clear question; tapping 確認發問 runs
 * the RAG ask AND records the Q&A (self-exploration → 脈絡). The session
 * auto-expires after idle, and /exit (or the 結束 button) leaves it.
 */
const ASK_DIALOG_PREFIX = 'ask_session:';
const ASK_DIALOG_TTL_MS = 10 * 60 * 1000;   // idle auto-exit
const ASK_DIALOG_MAX_TURNS = 12;

function askDialogKey_(scope) { return ASK_DIALOG_PREFIX + scope.key; }

function loadAskDialog_(scope) {
  if (!scope || !scope.key) return null;
  const raw = PropertiesService.getScriptProperties().getProperty(askDialogKey_(scope));
  if (!raw) return null;
  let s; try { s = JSON.parse(raw); } catch (_) { return null; }
  if (!s || (Date.now() - (s.lastAt || 0)) > ASK_DIALOG_TTL_MS) { clearAskDialog_(scope); return null; }
  return s;
}

function saveAskDialog_(scope, s) {
  s.lastAt = Date.now();
  PropertiesService.getScriptProperties().setProperty(askDialogKey_(scope), JSON.stringify(s));
}

function clearAskDialog_(scope) {
  try { PropertiesService.getScriptProperties().deleteProperty(askDialogKey_(scope)); } catch (_) {}
}

function askDialogActive_(scope) { return !!loadAskDialog_(scope); }

/** Persistent quick reply so 結束 is always one tap away while in ask mode. */
function askModeQuickReply_() {
  return { items: [{ type: 'action', action: { type: 'postback', label: '離開/ask模式', data: 'action=ask_exit', displayText: '▸ 離開提問模式' } }] };
}

/** 改名模式的離開鈕——標籤要對應當下模式（不是「離開/ask模式」）。 */
function renameModeQuickReply_() {
  return { items: [{ type: 'action', action: { type: 'postback', label: '放棄改名', data: 'action=ask_exit', displayText: '▸ 放棄改名' } }] };
}

/** The leave quick reply for whichever session is active (ask / supplement /
 *  rename), or null when not in a session. Used to keep a way out on every reply
 *  while a mode is open — even on generic cards (e.g. a clue's 看完整) that don't
 *  know they were reached mid-mode. 標籤一律對應當下模式，避免「改名時卻顯示離開/ask模式」。 */
function dialogLeaveQuickReply_(scope) {
  const s = loadAskDialog_(scope);
  if (!s) return null;
  if (s.mode === 'supplement') return suppModeQuickReply_();
  if (s.mode === 'rename') return renameModeQuickReply_();
  return askModeQuickReply_();
}

function enterAskMode_(ctx) {
  saveAskDialog_(ctx.scope, { turns: [], question: '', startedAt: Date.now() });
  lineReplyFlex_(ctx.replyToken, '提問模式：把想法聊成一個問題', buildAskIntroBubble_(), askModeQuickReply_());
}

/** Entry card — illustrates what ask mode is: chat → focus → grounded answer. */
/** In-card leave affordance for mode cards. LINE hides the quick-reply pills
 *  while the keyboard is open (i.e. most of the time you're in a mode), so the
 *  card itself carries an always-visible way out. */
function exitModeFooter_(label) {
  return {
    type: 'box', layout: 'vertical', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label: label, data: 'action=ask_exit', displayText: opEcho_(label) },
    contents: [{ type: 'text', text: `✕ ${label}`, size: 'xxs', color: THEME.muted, align: 'center' }]
  };
}

function buildAskIntroBubble_() {
  const accent = THEME.stage.ask;
  const step = (icon, label) => ({ type: 'text', text: `${icon} ${label}`, size: 'sm', color: THEME.text, wrap: true });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: '✍️ 提問模式', size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: '把零散的想法，聊成一個問題', size: 'xxs', color: THEME.muted, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', contents: [
        step('💬', '你邊打邊聊想問的'),
        { type: 'text', text: '⋁⋁', size: 'md', color: accent, margin: 'sm' },
        step('🎯', '我幫你聚焦成一個問題'),
        { type: 'text', text: '⋁⋁', size: 'md', color: accent, margin: 'sm' },
        step('💡', '從你的紀錄找有依據的答案'),
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '直接打字開始；貼圖可給方向。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' }
      ]
    },
    footer: exitModeFooter_('離開提問模式')
  };
}

/** A plain-text message while a session is active = a turn refining the
 *  question (ask) or the supplement (supplement mode). */
function handleAskTurn_(ctx, text) {
  const s = loadAskDialog_(ctx.scope);
  if (!s) return;  // expired between the active-check and here
  askPushTurnAndRefine_(ctx, s, text);
}

/** Append a turn, re-synthesize the mode's crystal (question / supplement),
 *  and show the convergence card. */
function askPushTurnAndRefine_(ctx, s, turnText) {
  // turnText=null：不加新段落，只用目前 s.turns 重新凝聚＋刷新卡（貼圖把 emoji 併入對應段落後用）。
  if (turnText != null) {
    if (s.pendingEmoji) { turnText = `${turnText} ${s.pendingEmoji}`; delete s.pendingEmoji; }
    s.turns.push(turnText);
    if (s.turns.length > ASK_DIALOG_MAX_TURNS) s.turns = s.turns.slice(-ASK_DIALOG_MAX_TURNS);
  }

  if (s.mode === 'supplement') {
    // 指定脈絡的補充:跳過 synthesize、直接用原話串(原話才是評鑒/歸戶的真實對象);
    // general /ask gap-fill(無 contextId)仍走 synthesize(整理零碎成可檢索知識、不判轉折)。
    const hasContext = !!s.contextId;
    const targetCtx = hasContext ? loadContexts_(ctx.scope).find(c => c.id === s.contextId) : null;
    // 〔關鍵分流〕只有「候選歷程(context·差轉折)」才跑 4 種轉折評鑒（轉折形成卡）；
    // 「進行中脈絡(candidate·三缺一)」只是補一筆撐三條件（脈絡補充卡），不評轉折、補了就能送。
    const isTurnStage = !!(targetCtx && targetCtx.status === 'context');
    let draft;
    let recs = [];   // 本脈絡成員（hoist 給下方密度 delta 用）
    if (isTurnStage) {
      // 候選歷程補轉折:原話才是轉折評鑒/歸戶的真實對象,不可改寫(轉折要是使用者真的寫的)。
      draft = s.turns.join('；');
    } else if (hasContext) {
      // 進行中脈絡補密度:凝聚＝忠實保留使用者「這次自己寫的」原文（單則原樣、多則只接成一段），
      // 不再拿既有記錄重組（那會讓凝聚被前面記寫訊息淹沒、看不出原話——使用者回報）。recs 仍載入，
      // 但只給下面的 suppTurnFocus_ 算聚焦度（B/C 回饋與防灌水），不進凝聚內容。
      try {
        const recById = {}; loadEmbeddingRecords_(ctx.scope).forEach(r => { recById[r.id] = r; });
        recs = (targetCtx.recordIds || []).map(id => recById[id]).filter(Boolean);
      } catch (e) { console.warn('load candidate records for density draft failed:', e && e.message); }
      // 〔補密度 ABC〕量化「剛補這則」的聚焦程度(focus×novelty),增量只算新的一則、跟 s.turns 尾端對齊。
      // turnText=null（貼圖只併 emoji、沒新段落）時不新增聚焦項。
      if (SUPP_FOCUS_WEIGHT_ENABLED && turnText != null) {
        try {
          const ft = suppTurnFocus_(recs, turnText);
          s.suppPerTurn = (s.suppPerTurn || []).concat([ft]);
          if (s.suppPerTurn.length > s.turns.length) s.suppPerTurn = s.suppPerTurn.slice(-s.turns.length);
        } catch (e) { console.warn('suppTurnFocus_ failed:', e && e.message); }
      }
      // 〔A〕把每則的聚焦程度當權重餵進凝聚(扣核心主導、偏離次要)。
      const focusArr = (s.suppPerTurn || []).map(p => p && p.focus);
      try { draft = synthesizeDensityDraft_(recs, s.turns, s.gap, focusArr); }
      catch (e) { console.warn('synthesizeDensityDraft_ failed:', e && e.message); draft = s.turns.join('；'); }
    } else {
      try { draft = synthesizeSupplementDraft_(s.gap, s.turns); }
      catch (e) { console.warn('synthesizeSupplementDraft_ failed:', e && e.message); draft = s.turns.join('；'); }
    }
    s.draft = draft;

    // Phase 3:只有候選歷程跑「4 種轉折一次性評鑒」(進行中脈絡與 general gap-fill 不跑)。
    let evalData = null;
    if (isTurnStage) {
      const evalInput = s.contextDigest ? (s.contextDigest + '；' + draft) : draft;
      try { evalData = evaluateTransitionDraft_(evalInput, s.contextSummary || s.gap); }
      catch (e) { console.warn('evaluateTransitionDraft_ failed:', e && e.message); }
    }
    s.eval = evalData;

    // canSave:候選歷程要任一轉折達門檻才送;進行中脈絡(無 evalData)補一筆即可送(撐三條件、不評轉折)。
    const canSave = !evalData || evalData.topScore >= SUPPLEMENT_EVAL_THRESHOLD;

    // 〔Phase 3-B〕天花板鷹架:只在候選歷程評轉折、卡關時才出（進行中脈絡不評轉折、不需要）。
    let scaffoldHint = '';
    if (isTurnStage && evalData && !canSave) {
      const hist = (s.scoreHistory || []).concat([evalData.topScore]);
      s.scoreHistory = hist.slice(-5);
      const recent = s.scoreHistory.slice(-3);
      const stuck = recent.length >= 3
        && recent.every(v => v >= 0.40 && v < SUPPLEMENT_EVAL_THRESHOLD)
        && (evalData.topScore - Math.max.apply(null, s.scoreHistory.slice(0, -1)) < 0.05);
      if (stuck) {
        try { scaffoldHint = generateScaffoldHint_(draft, evalData.topType, s.contextSummary || s.gap); }
        catch (e) { console.warn('generateScaffoldHint_ failed:', e && e.message); }
      }
    } else if (isTurnStage && evalData) {
      s.scoreHistory = (s.scoreHistory || []).concat([evalData.topScore]).slice(-5);
    }
    // 〔補密度 B〕聚焦趨勢:聚合各則 → 卡上即時回饋「越補越扣核心↑/發散↓」,並存 s.suppFocus
    // 供 handleSuppSave_ 拿去做 C 防灌水閘(只候選歷程·補密度時算;轉折/歸戶不算)。
    let focusNote = null;
    if (SUPP_FOCUS_WEIGHT_ENABLED && hasContext && !isTurnStage) {
      const agg = suppFocusAgg_(s.suppPerTurn);
      s.suppFocus = agg;   // 留給 handleSuppSave_ 的防灌水閘
      // §A 真·語意密度 delta：補這 draft 後密度往哪走（criterion 密度，不只聚焦%）——使用者要看的就是這個。
      try {
        const memberEmbs = recs.filter(r => r && CONTEXT_MEDIA_TYPES[r.type] && r.embedding && r.embedding.length === EMBED_DIM).map(r => r.embedding);
        const dPrev = avgPairwiseCosine_(memberEmbs, 2000);
        const dNew = avgPairwiseCosine_(memberEmbs.concat([geminiEmbed_(draft)]), 2000);
        const min = CONTEXT_CRITERIA.semanticDensityMin, d = dNew - dPrev;
        const tone = dNew >= min ? 'good' : (d > 0.005 ? 'good' : (d < -0.005 ? 'warn' : 'neutral'));
        const tail = dNew >= min ? '已過門檻 ✅' : (d > 0.005 ? '往上 ↑' : (d < -0.005 ? '發散 ↓・扣回同一件事' : '持平'));
        focusNote = { tone, text: `語意密度 ${dPrev.toFixed(2)} → ${dNew.toFixed(2)} / ${min.toFixed(2)}　${tail}` };
      } catch (e) { console.warn('density preview failed:', e && e.message); }
      if (!focusNote && agg) {   // 密度算不出來才退回聚焦%
        const fpct = Math.round(agg.meanFocus * 100);
        if (agg.trend === 'up') focusNote = { tone: 'good', text: `越補越扣核心 ↑（聚焦 ${fpct}%）` };
        else if (agg.trend === 'down') focusNote = { tone: 'warn', text: `有點發散 ↓（聚焦 ${fpct}%）試著扣回同一件事` };
        else focusNote = { tone: 'neutral', text: `聚焦 ${fpct}%・穩定` };
      }
    }
    saveAskDialog_(ctx.scope, s);

    // 〔專屬文案·三路〕凝聚卡依補充對象給專屬標題/標籤，不共用：
    //   候選歷程補轉折＝「補一個轉折（成歷程）」；進行中脈絡補密度＝「補一筆撐三條件」；
    //   /ask 答案補充強化（無 contextId）＝「補充強化這個答案」——沒有三條件/升格那回事，
    //   目標是「整理成一段知識、下次 /ask 查得到」（與補充模式 intro 卡的三步驟同語彙）。
    const isAskFill = !hasContext;
    lineReplyFlex_(ctx.replyToken, `補充凝聚：${truncate_(draft, 40)}`, buildConvergeBubble_({
      headerTitle: isTurnStage ? '🌀 補一個轉折（成歷程）'
        : isAskFill ? '💬 補充強化這個答案'
        : '🌱 補一筆撐三條件（成候選歷程）',
      headerSub: `已收 ${s.turns.length} 則`, accent: THEME.stage.supplement, exitLabel: '離開補充模式',
      topNote: `${isAskFill ? '針對問題' : '針對'}：${truncate_(s.gap, 28)}`, fragsLabel: '你補的',
      crystal: draft,
      convergeLabel: isTurnStage ? '你寫的' : (isAskFill ? '整理成一段知識' : '凝聚成'),
      focusNote: focusNote,
      confirmLabel: isAskFill ? '補進脈絡（下次查得到）' : '補進脈絡',
      confirmAction: 'action=ask_supp_save', turns: s.turns,
      evalData: evalData, canSave: canSave, scaffoldHint: scaffoldHint, suggestType: s.suggestType
    }), suppModeQuickReply_());
  } else {
    let question;
    try { question = synthesizeAskQuestion_(s.turns); }
    catch (e) { console.warn('synthesizeAskQuestion_ failed:', e && e.message); question = s.turns.join('；'); }
    s.question = question;
    saveAskDialog_(ctx.scope, s);
    lineReplyFlex_(ctx.replyToken, `提問聚焦：${truncate_(question, 40)}`, buildConvergeBubble_({
      headerTitle: '✍️ 提問聚焦中', headerSub: `已收 ${s.turns.length} 則 · 邊打邊聚焦`, accent: THEME.stage.ask, exitLabel: '離開提問模式',
      fragsLabel: '你說的', crystal: question, convergeLabel: '聚焦成', confirmLabel: '就問這個',
      confirmAction: 'action=ask_confirm', turns: s.turns
    }), askModeQuickReply_());
  }
}

/** Focus the accumulated turns into one clear, retrievable question. */
function synthesizeAskQuestion_(turns) {
  const sys = '你是協助使用者把零散想法聚焦成「一個清晰、具體、可檢索的問題」的助理。只輸出那一個問題本身（繁體中文，一句話；不要解釋、不要引號、不要開場白）。若對話已是清楚的問題，精煉後原樣輸出。';
  const prompt = '以下是使用者陸續輸入的片段，請聚焦成一個問題：\n' + turns.map((t, i) => `(${i + 1}) ${t}`).join('\n');
  const out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.3, maxOutputTokens: 256 });
  const q = (out || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, '').slice(0, 300);
  return q || turns.join('；');
}

/** Shared convergence card — scattered turns (train-of-thought stops) ⋁⋁ a
 *  crystallized result with a left accent bar. Used by ask (question) and
 *  supplement (knowledge). */
function buildConvergeBubble_(opts) {
  const accent = opts.accent || THEME.depth.l1.accent;   // per-stage tint (ask/supplement)
  const turns = opts.turns || [];
  const recent = turns.slice(-4);
  const earlier = turns.length - recent.length;

  const body = [];
  if (opts.topNote) body.push({ type: 'text', text: opts.topNote, size: 'xxs', color: THEME.textMuted, wrap: true });
  body.push({ type: 'text', text: opts.fragsLabel, size: 'xxs', color: THEME.muted, weight: 'bold', margin: opts.topNote ? 'md' : 'none' });
  // Train-of-thought: earlier stops collapsed at the top, then each stop, the
  // latest highlighted as "where you are now".
  if (earlier > 0) body.push({ type: 'text', text: `⋮ 更早 ${earlier} 則`, size: 'xxs', color: THEME.faint, margin: 'sm' });
  recent.forEach((t, i) => {
    const latest = i === recent.length - 1;
    body.push({
      type: 'text', text: `${latest ? '●' : '・'} ${truncate_(t, 38)}`,
      size: 'xs', wrap: true, maxLines: 2, margin: 'sm',
      color: latest ? accent : THEME.textBody, weight: latest ? 'bold' : 'regular'
    });
  });

  // Convergence — left-aligned to match everything else.
  body.push({ type: 'text', text: '⋁⋁', size: 'lg', color: accent, margin: 'lg' });
  body.push({ type: 'text', text: opts.convergeLabel || '凝聚成', size: 'xxs', color: THEME.muted, margin: 'xs' });
  body.push({
    type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'md', contents: [
      { type: 'box', layout: 'vertical', width: '5px', backgroundColor: accent, cornerRadius: 'sm', contents: [{ type: 'filler' }] },
      { type: 'text', text: opts.crystal, size: 'md', weight: 'bold', color: THEME.text, wrap: true, flex: 1 }
    ]
  });

  // 〔補密度 B〕聚焦趨勢回饋:這幾則越補越扣核心(↑綠)/發散(↓橘)/穩定(灰),讓使用者當下自己拉回。
  if (opts.focusNote) {
    const fn = opts.focusNote;
    const fc = fn.tone === 'good' ? THEME.success : (fn.tone === 'warn' ? THEME.warning : THEME.muted);
    body.push({ type: 'text', text: `🎯 ${fn.text}`, size: 'xxs', color: fc, wrap: true, margin: 'sm' });
  }

  // Phase 3:即時評鑒(只在 context-targeted 轉折模式下顯示)——4 種轉折全部評,
  // 任一達門檻即可送。視覺保持固定順序(避免每次重新排序、使用者眼睛跟不上),
  // top1 加 accent / 達標加綠 ✓。
  if (opts.evalData) {
    const ed = opts.evalData;
    const thrPct = Math.round(SUPPLEMENT_EVAL_THRESHOLD * 100);
    body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'text', text: `🎯 即時評鑒 · 達 ${thrPct}% 任一條即可送`, size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' });
    const TYPES = [
      { icon: '🔁', name: '概念重述' },
      { icon: '🧩', name: '跨主題整合' },
      { icon: '🎯', name: '行動指向' },
      { icon: '🔭', name: '後設反思' }
    ];
    TYPES.forEach(t => {
      const score = ed.scores[t.name] || 0;
      const isTop = t.name === ed.topType;
      const passed = score >= SUPPLEMENT_EVAL_THRESHOLD;
      const color = passed ? THEME.success : (isTop ? accent : THEME.muted);
      const weight = (passed || isTop) ? 'bold' : 'regular';
      body.push({
        type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: `${t.icon} ${t.name}`, size: 'xs', color: color, weight: weight, flex: 5 },
          { type: 'text', text: gapBar_(score), size: 'xs', color: color, weight: weight, flex: 4 },
          { type: 'text', text: `${Math.round(score * 100)}%${passed ? ' ✓' : ''}`, size: 'xs', color: color, weight: weight, align: 'end', flex: 3 }
        ]
      });
    });
    // 累積豐度:4 種平均的百分比(資訊用,不影響 canSave)
    const avgPct = Math.round((ed.sum / 4) * 100);
    body.push({ type: 'text', text: `累積豐度 ${avgPct}%(4 種平均)`, size: 'xxs', color: THEME.muted, align: 'end', margin: 'sm' });
    // 〔融合〕對照建議方向:你寫的最高項 vs 主卡融合建議的起點。
    if (opts.suggestType) {
      const hit = ed.topType === opts.suggestType;
      body.push({ type: 'text',
        text: hit ? `🧭 正中建議方向(${opts.suggestType})` : `🧭 你往「${ed.topType}」寫,原建議是「${opts.suggestType}」——都可以`,
        size: 'xxs', color: hit ? THEME.success : THEME.muted, wrap: true, margin: 'sm' });
    }
    // missingHint 只在沒達標時顯示,引導使用者再寫
    if (!opts.canSave && ed.missingHint) {
      body.push({ type: 'text', text: `${ed.topType} 還缺:${ed.missingHint}`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
    }
  }

  // 〔Phase 3-B〕天花板鷹架:寫了幾輪還卡關時,給可直接套用的句型骨架幫突破。
  // 醒目方塊(THEME.stage.gap 配色)+ 左色條,跟一般 missingHint 區隔。
  if (opts.scaffoldHint) {
    body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'text', text: '💡 卡住了?試試這個句型', size: 'xxs', color: THEME.stage.gap, weight: 'bold', margin: 'md' });
    body.push({
      type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'md',
      backgroundColor: THEME.surface, cornerRadius: 'sm', paddingAll: 'sm', contents: [
        { type: 'box', layout: 'vertical', width: '5px', backgroundColor: THEME.stage.gap, cornerRadius: 'sm', contents: [{ type: 'filler' }] },
        { type: 'text', text: opts.scaffoldHint, size: 'sm', color: THEME.text, wrap: true, flex: 1 }
      ]
    });
  }

  // 〔說明在算什麼〕context-targeted 補充且達標時,先講清楚按下「補進脈絡」會做什麼計算。
  if (opts.suggestType && opts.canSave) {
    body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'text', text: '達標了!按「補進脈絡」會:把這段併入脈絡 → 重判整條的轉折 → 生成歷程標題與故事 → 當場升格。', size: 'xxs', color: THEME.success, wrap: true, margin: 'md' });
  }

  // Footer:confirm 按鈕,canSave===false 時改成停用樣式(不掛 action,使用者按不到)
  const confirmActive = opts.canSave !== false;
  const confirmRow = confirmActive
    ? {
        type: 'box', layout: 'vertical', backgroundColor: accent, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: opts.confirmLabel, data: opts.confirmAction, displayText: opEcho_(opts.confirmLabel) },
        contents: [{ type: 'text', text: `✅ ${opts.confirmLabel}`, size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
      }
    : {
        type: 'box', layout: 'vertical', backgroundColor: THEME.faint, cornerRadius: 'md', paddingAll: 'sm',
        contents: [{ type: 'text', text: `🔒 ${opts.confirmLabel}(分數未達)`, size: 'sm', color: THEME.muted, align: 'center', weight: 'bold' }]
      };

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: opts.headerTitle, size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: opts.headerSub, size: 'xxs', color: THEME.muted, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md', contents: [
        confirmRow,
        exitModeFooter_(opts.exitLabel || '離開模式')
      ]
    }
  };
}

/** 確認發問 → answer the focused question, record the Q&A, keep the session open. */
function handleAskConfirm_(ev, scope) {
  const s = loadAskDialog_(scope);
  if (!s || !s.question) {
    return lineReply_(ev.replyToken, '提問已逾時或還沒組好，請重新打字或 /ask 重新開始。');
  }
  const ctx = { scope, replyToken: ev.replyToken, userId: scope.userId };
  runAndReplyAsk_(ctx, s.question, true, askModeQuickReply_());
  // Start the next question fresh; stay in ask mode.
  s.turns = []; s.question = '';
  saveAskDialog_(scope, s);
}

function handleAskExit_(ev, scope) {
  const s = loadAskDialog_(scope);
  clearAskDialog_(scope);
  if (!s) return lineReply_(ev.replyToken, '目前不在任何模式。');
  const msg = s.mode === 'supplement' ? '已離開補充模式，回到記筆記。'
            : s.mode === 'rename'     ? '已取消改名，回到記筆記。'
            :                            '已離開提問模式，回到記筆記。';
  lineReply_(ev.replyToken, msg);
}

/** Sticker while in ask mode: a focus / emotional steer (not a note). Fold its
 *  emotion into the turns and re-focus the question — ask stays text-centred,
 *  the sticker just nudges the direction. */
function handleAskStickerTurn_(ctx, m) {
  const s = loadAskDialog_(ctx.scope);
  if (!s) return handleSticker_(ctx, m);  // expired between checks → normal capture
  const kw = m.keywords || [];
  let phrase = '';
  try { phrase = kw.length ? geminiStickerSummary_(kw) : ''; } catch (_) {}
  phrase = phrase || kw.join('、') || '貼圖';
  askPushTurnAndRefine_(ctx, s, `（情緒/方向訊號：${phrase}）`);
}

/** 貼圖 → 代表情緒 emoji。優先用入庫時 LLM 存的 record.stickerEmoji（完整細膩）；否則用啟發式
 *  對映表（涵蓋大部分人類情緒，covers 基本六情緒＋社會/認知/身體情緒）。 */
function recordEmoji_(r) {
  return (r && r.stickerEmoji) || stickerEmoji_(r && r.stickerKeywords);
}

/** 啟發式：貼圖關鍵字（英文標籤／中文摘要）→ 一個情緒 emoji。盡量羅列人類情緒（按優先序由具體到
 *  概括，先匹配先回）。無 LLM、決定性。涵蓋：喜悅族／愛感謝／驕傲自信／期待希望／放鬆／悲傷族／
 *  孤獨受傷／焦慮恐懼／壓力／憤怒族／厭惡／驚訝震驚／困惑好奇／無聊疲累／尷尬羞愧／決心努力／祝賀。 */
function stickerEmoji_(keywords) {
  const kw = (Array.isArray(keywords) ? keywords.join(' ') : String(keywords || '')).toLowerCase();
  const map = [
    // 愛・感謝・祝賀
    [/love|heart|adore|kiss|喜歡|愛你?|親親/, '❤️'],
    [/thank|grateful|bless|appreciate|感謝|謝謝|感恩/, '🙏'],
    [/congrat|celebrat|cheers|party|恭喜|慶祝|乾杯/, '🎉'],
    [/gift|present|禮物/, '🎁'],
    // 喜悅族
    [/laugh|lol|hilarious|哈哈|大笑|爆笑/, '😂'],
    [/happy|smile|joy|glad|delight|cheer|開心|高興|快樂|愉快|歡喜|笑/, '😄'],
    [/excited|thrilled|yay|woohoo|興奮|超讚|好耶|期待/, '🤩'],
    [/playful|wink|cheeky|naughty|tease|調皮|俏皮|頑皮|眨眼/, '😜'],
    [/cute|sweet|可愛|萌/, '🥰'],
    // 驕傲・自信・決心
    [/proud|confident|cool|swag|驕傲|自信|得意|帥/, '😎'],
    [/determined|fighting|effort|hardwork|努力|加油|衝|拼|決心|堅持/, '💪'],
    [/strong|power|fire|熱血|火力|powerful/, '🔥'],
    // 期待・希望・放鬆・滿足
    [/hope|wish|希望|期盼|盼望/, '🌟'],
    [/relax|calm|chill|peace|放鬆|平靜|安心|淡定|療癒/, '😌'],
    [/relief|phew|鬆一口氣|終於|釋懷/, '😮‍💨'],
    [/satisfied|content|滿足|滿意|值得/, '😊'],
    // 同意・讚許
    [/ok|okay|agree|fine|沒問題|同意|讚同|好的|了解/, '👌'],
    [/good|great|nice|awesome|讚|棒|厲害|不錯|好主意|thumbs?\s*up/, '👍'],
    [/clap|bravo|拍手|鼓掌|佩服/, '👏'],
    // 悲傷族
    [/sob|wail|bawl|痛哭|嚎/, '😭'],
    [/cry|sad|unhappy|sorrow|難過|傷心|哭|悲傷|失落|沮喪|難受/, '😢'],
    [/disappoint|let.?down|失望|遺憾|可惜/, '😞'],
    [/lonely|alone|寂寞|孤單|孤獨/, '🥺'],
    [/heartbroken|hurt|broken|心碎|受傷|心痛/, '💔'],
    // 焦慮・恐懼・壓力
    [/scared|fear|afraid|terrified|害怕|恐懼|恐慌|嚇/, '😨'],
    [/anxious|worried|nervous|uneasy|焦慮|擔心|擔憂|緊張|不安/, '😰'],
    [/stress|overwhelm|pressure|壓力|崩潰|喘不過/, '😣'],
    [/awkward|embarrass|shy|尷尬|害羞|不好意思/, '😳'],
    // 憤怒族
    [/furious|rage|憤怒|火大|抓狂/, '😡'],
    [/angry|mad|annoyed|生氣|怒|不爽|惱/, '😠'],
    [/frustrat|grr|挫折|無奈|受不了|煩躁/, '😤'],
    [/disdain|whatever|unamused|無言|翻白眼|哼|不屑/, '🙄'],
    // 厭惡・無聊・疲累
    [/disgust|gross|yuck|噁|噁心|厭惡|嫌棄/, '🤢'],
    [/bored|meh|無聊|乏味|沒勁/, '😑'],
    [/tired|exhausted|sleepy|累|睏|疲憊|想睡/, '😴'],
    // 驚訝・震驚
    [/shock|omg|unbelievable|震驚|不敢相信|傻眼/, '😱'],
    [/surprise|wow|whoa|驚訝|意外|哇/, '😮'],
    // 困惑・好奇・思考
    [/confused|puzzled|huh|困惑|疑惑|不解|搞不懂/, '😕'],
    [/curious|wonder|hmm|好奇|想知道/, '🧐'],
    [/think|ponder|思考|沉思|明白|理解|懂|想/, '🤔'],
    // 道歉・難為情
    [/sorry|apolog|抱歉|對不起|歉/, '🙇'],
    [/guilty|ashamed|愧|羞愧|自責/, '😔'],
    // 哭笑不得・複雜
    [/speechless|複雜|哭笑不得|五味雜陳/, '😅']
  ];
  for (let i = 0; i < map.length; i++) if (map[i][0].test(kw)) return map[i][1];
  return '💭';
}

/** 補充模式收到貼圖：〔§C·情緒併入凝聚〕貼圖＝情緒，不另外回覆「收到情緒」，也不當內容 turn——
 *  改把「對應 emoji」併入最近一段你寫的尾端，重新凝聚＋刷新凝聚卡（維持持續累積）。還沒寫任何
 *  段落時，暫存 emoji，等第一段文字一起併入。補密度凝聚卡與補轉折成形卡共用。 */
function handleSuppStickerTurn_(ctx, m) {
  const s = loadAskDialog_(ctx.scope);
  if (!s || s.mode !== 'supplement') return handleSticker_(ctx, m);  // 過期/非補充 → 一般捕捉
  const emoji = stickerEmoji_(m.keywords);
  if (s.turns && s.turns.length) {
    s.turns[s.turns.length - 1] = `${s.turns[s.turns.length - 1] || ''} ${emoji}`.trim();
    return askPushTurnAndRefine_(ctx, s, null);   // 不加新 turn、只把 emoji 併入對應段落 → 重新凝聚刷新卡
  }
  // 還沒有任何段落 → 暫存，待第一段文字一起併入（不回覆、不顯示卡）。
  s.pendingEmoji = `${s.pendingEmoji || ''}${emoji}`;
  saveAskDialog_(ctx.scope, s);
}

/** Non-text, non-sticker while in ask mode: ask is for thinking in words, so an
 *  image / file / location doesn't belong — leave the session (first line),
 *  fire the question honed so far, then capture the item as usual (sent last so
 *  a media picker's quick reply survives). */
function handleAskInterrupt_(ctx, m) {
  const s = loadAskDialog_(ctx.scope);
  const mode = s && s.mode;
  const question = s && s.question;
  clearAskDialog_(ctx.scope);
  if (mode === 'supplement') {
    lineReply_(ctx.replyToken, '🚪 已離開補充模式（補充只用文字與貼圖）。這則已另記為筆記。');
  } else if (question) {
    lineReply_(ctx.replyToken, '🚪 已離開提問模式（提問只用文字與貼圖構思）。先把剛才聚焦的問題直接發問：');
    runAndReplyAsk_(ctx, question, true, null);
  } else {
    lineReply_(ctx.replyToken, '🚪 已離開提問模式（提問只用文字與貼圖構思）。這則已另記為筆記。');
  }
  dispatchNonText_(ctx, m);
}

/** 線索群的主導主題：在一組 /ask 命中（hit{record}）裡，對成員的 (大類, 議題標籤) 投票，
 *  回出現最多的那組（平手取排序較前＝相關度較高者）。供「補充強化」把補充記錄直接歸到答案
 *  依據的線索群主題用。成員都還沒判 topicLabel → 回 null（退回背景自行歸戶）。 */
function dominantTopicOfHits_(hits) {
  const votes = {}, meta = {};
  (hits || []).forEach((h, i) => {
    const r = h && h.record;
    if (!r || !r.topicLabel) return;
    const key = (r.category || '未分類') + ' ' + r.topicLabel;
    votes[key] = (votes[key] || 0) + 1;
    if (!meta[key]) meta[key] = { category: r.category || '', topicLabel: r.topicLabel, firstIdx: i };
  });
  let best = null;
  for (const k in votes) {
    if (!best ||
        votes[k] > votes[best] ||
        (votes[k] === votes[best] && meta[k].firstIdx < meta[best].firstIdx)) best = k;
  }
  return best ? { category: meta[best].category, topicLabel: meta[best].topicLabel } : null;
}

/** Write a confirmed Q&A into the user's records — self-exploration is脈絡 too.
 *  Declines / empty answers are not persisted: a "現有紀錄不足以回答" would just
 *  become retrieval noise (surfacing as a clue / theme later). */
function recordAskQA_(ctx, question, answer) {
  answer = (answer || '').trim();
  if (!answer || /不足以回答|沒有提及|無法回答/.test(answer)) return null;
  const id = newId_();
  const ts = new Date().toISOString();
  const text = `🔍 探問：${question}\n💡 ${answer}`;
  const record = {
    id, ts,
    userId: ctx.userId || (ctx.scope && ctx.scope.userId) || null,
    type: 'text', text, lineMessageId: null
  };
  record.embedding = geminiEmbed_(text);
  appendEmbeddingRecord_(ctx.scope, record);
  saveTranscript_(ctx.scope, id, text, ts);
  try { appendToTimeline_(ctx.scope, record); } catch (e) { console.error('ask QA timeline append failed:', e && e.message); }
  return id;
}

/* ---- gap card + supplement mode: fill a knowledge gap /ask couldn't answer ---- */

/** Shown when /ask has nothing to answer from — turns the dead-end into an
 *  invitation to 補充. The gap question is cached under a short key (postback
 *  data caps at 300 chars, too small for a long question). */
/**
 * Score-gated LOW mode：top1 < ASK_SCORE_LOW 時不答結論，改讓 LLM 對每條線索做一句註解
 * 「跟問題哪部分有關 / 為何相關度有限」，並建議 1-3 個下一步可試的關鍵字。直接對應使用者
 * 「線索給了不知道下一步」的痛點。LLM 失敗 / 無 clues 時降級為既有 replyAskGap_。
 */
function replyAskCluesAnnotated_(ctx, query, quickReply, clues, top1Score) {
  if (!clues || !clues.length) return replyAskGap_(ctx, query, quickReply, clues);
  if (ctx.scope && ctx.scope.type === 'user') {
    try { showLoadingAnimation_(ctx.scope.id, 15); } catch (_) {}
  }
  // 給 LLM 看的線索區塊：id + score + 日期 + 大類｜議題 + 內文片段。
  // 顯式餵 score 讓 LLM 知道哪條最相關，後面 prompt 規則才能要求「下一步關鍵字優先從高分取」。
  const block = clues.map((h, i) => {
    const r = h.record;
    const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd');
    const txt = truncate_(((r.aggregatedText || r.text) || '').replace(/\s+/g, ' '), 200);
    const topic = (r.category && r.topicLabel) ? `[${r.category}｜${r.topicLabel}]` : '';
    return `${i + 1}. score=${h.score.toFixed(2)} id=${r.id} ${d} ${topic}\n${txt || '(無文字內容)'}`;
  }).join('\n\n');

  // Prompt 適配兩種觸發場景：
  //   (a) top1 < 0.50（低相關）：語料根本沒寫過這主題，請對線索說明「為何相關度有限」
  //   (b) top1 ≥ 0.65 但 LLM 自評不足答（query phrasing 太具體、records 提主題沒列細節）：
  //       請對線索說明「跟問題哪部分有關、但為何不足以直接答」
  const scoreStr = (top1Score || 0).toFixed(2);
  const scenarioNote = (top1Score || 0) >= ASK_SCORE_LOW
    ? `top1 相似度 ${scoreStr}（相關度其實不低），但無法直接綜合出答案——可能是 records 提到主題卻沒列細節、或問題太具體、或答案分散在多處。`
    : `top1 相似度 ${scoreStr} < ${ASK_SCORE_LOW.toFixed(2)}（語料中似乎沒寫過這主題）。`;
  const sys = [
    '你是學習歷程助理。使用者問了一個問題，但無法給出直接答案。',
    scenarioNote,
    '線索已按 score（向量相似度）由高到低排列。**請優先以 score 較高的線索為基礎**:它們是語料中最貼近問題的位置。',
    '任務:對每筆線索做註解,並為使用者準備兩種「下一步」選項(問句 / 關鍵字),用途不同要明確分開:',
    '1) annotations: 每筆線索用一句話（≤30 字）說明「這條跟問題哪部分相關 / 為什麼還不足以直接答」。高分聚焦、低分簡述為何相關度有限。',
    '2) next_questions: 1-2 個「換句話再問的完整問句」(每句 ≤25 字),這是使用者點下去要**重新跑一次 /ask** 的選項,所以:',
    '   - **必須是完整問句**(問號結尾或開放疑問),不要名詞片段',
    '   - **不要重複使用者原問法**(那樣原地踏步)',
    '   - 基於高分線索實際內容重構:把原問題中「語料沒寫到的詞」替換成「語料實際出現的詞」',
    '     例:原問「西班牙訪學」、records 都是「瑞典訪學」→ 「瑞典訪學的經驗如何?」「訪談學者學到什麼?」',
    '3) next_recalls: 1-3 個「搜這些關鍵字看實際 records」的短詞(每個 ≤8 字),這是使用者點下去要**跑 /recall** 列出原始記錄的選項,所以:',
    '   - **只給名詞/短詞**,不要問句',
    '   - 優先從高分線索的 topicLabel／大類抽取(那是 records 自己的標籤,搜得到對的東西)',
    '純 JSON 輸出,不要 markdown 包圍、不要解釋。schema:',
    '{"annotations":[{"id":"<record-id>","relation":"<一句話>"}],"next_questions":["<完整問句1>",...],"next_recalls":["<關鍵字1>",...]}',
    '不要寒暄、不要開場白與結語。'
  ].join('\n');

  let parsed = null;
  try {
    const raw = geminiGenerate_([{ text: `使用者的問題：${query}\n\n線索紀錄：\n${block}\n\nJSON：` }], {
      systemInstruction: sys, temperature: 0.3, maxOutputTokens: 600
    });
    const m = (raw || '').match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (e) {
    console.warn('replyAskCluesAnnotated_ generate failed:', e && e.message);
  }
  // LLM 失敗 → 降級為純 clue 卡（無註解）；至少不卡住使用者。
  if (!parsed || !parsed.annotations) return replyAskGap_(ctx, query, quickReply, clues);

  const annById = {};
  (parsed.annotations || []).forEach(a => { if (a && a.id) annById[a.id] = (a.relation || '').toString().slice(0, 60); });
  const questions = (parsed.next_questions || []).filter(q => q && typeof q === 'string').slice(0, 2);
  const recalls = (parsed.next_recalls || []).filter(k => k && typeof k === 'string').slice(0, 3);

  const key = newId_();
  try { CacheService.getScriptCache().put('askgap_' + key, query, 21600); } catch (_) {}
  // 〔補充·歸戶〕線索群主題：補充強化時把補充記錄歸到這些線索的 (大類,議題標籤)。
  try { const home = dominantTopicOfHits_(clues); if (home) CacheService.getScriptCache().put('askhome_' + key, JSON.stringify(home), 21600); } catch (_) {}
  const accent = THEME.depth.l1.accent;
  let allForStrip = [];
  try { allForStrip = loadEmbeddingRecords_(ctx.scope); } catch (_) {}

  // Overview 卡：問題 + top1 分數 + 線索張數導引 + 補充鈕
  // 文案分兩種：低相關（< LOW）→「沒找到相關記錄」；高相關但 LLM 無法綜合 → 誠實說「找到高相關
  // 但無法直接綜合」，避免「top1 0.88 卻說沒找到」的誤導。
  const _s = (top1Score || 0);
  const overviewHint = _s >= ASK_SCORE_HIGH
    ? `top1 相似度 ${_s.toFixed(2)}（高相關），但無法直接綜合出答案`
    : _s >= ASK_SCORE_LOW
      ? `top1 相似度 ${_s.toFixed(2)}（中等相關·中文短語 cos 0.5–0.65 為窄帶，可能只是巧合）`
      : `top1 相似度 ${_s.toFixed(2)}，語料裡似乎沒寫過這主題`;
  const body = [
    { type: 'text', text: `你問：${query}`, size: 'sm', color: THEME.text, wrap: true },
    { type: 'text', text: overviewHint, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
  ];
  if (allForStrip.length) {
    const strip = corpusTimelineStrip_(clues.map(h => h.record), allForStrip);
    if (strip) { body.push({ type: 'separator', margin: 'sm' }); body.push(strip); }
  }
  body.push({ type: 'text', text: `${clues.length} 條線索（→ 右滑看每條跟問題的關係）`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' });
  // 下一步分兩列：💬 換句話再問(整列 /ask 完整問句)、🔍 搜這些關鍵字(/recall 名詞片段)。
  // 兩種動作明確分開,使用者一眼看出「重新問」vs「列原始記錄」是不同事。
  if (questions.length) {
    body.push({ type: 'text', text: '💬 換句話再問一次（/ask）', size: 'xxs', color: THEME.muted, margin: 'md' });
    questions.forEach(q => {
      body.push({
        type: 'box', layout: 'horizontal', backgroundColor: THEME.surfaceSoft,
        cornerRadius: 'md', paddingAll: 'sm', margin: 'sm', spacing: 'sm',
        action: { type: 'message', label: truncate_(q, 18), text: '/ask ' + q },
        contents: [
          { type: 'text', text: '💬', size: 'xs', flex: 0, gravity: 'center' },
          { type: 'text', text: truncate_(q, 26), size: 'xs', color: THEME.cta, weight: 'bold', flex: 1, wrap: true, gravity: 'center' },
          { type: 'text', text: '›', size: 'sm', color: THEME.cta, flex: 0, gravity: 'center' }
        ]
      });
    });
  }
  if (recalls.length) {
    body.push({ type: 'text', text: '🔍 搜原始記錄（/recall）', size: 'xxs', color: THEME.muted, margin: 'md' });
    body.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
      contents: recalls.map(k => ({
        type: 'box', layout: 'vertical', cornerRadius: 'md', paddingAll: 'sm', flex: 1,
        backgroundColor: THEME.surface,
        action: { type: 'message', label: truncate_(k, 12), text: '/recall ' + k },
        contents: [{ type: 'text', text: truncate_(k, 8), size: 'xxs', align: 'center', weight: 'bold', color: THEME.depth.l1.accent, wrap: true }]
      }))
    });
  }

  const footerContents = [{
    type: 'box', layout: 'vertical', backgroundColor: accent, cornerRadius: 'md', paddingAll: 'sm',
    action: { type: 'postback', label: '補充這題', data: `action=ask_supplement&k=${key}`, displayText: '▸ 補充這題' },
    contents: [{ type: 'text', text: '✏️ 補充這題', size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
  }];
  const sess = loadAskDialog_(ctx.scope);
  if (sess) footerContents.push(exitModeFooter_(sess.mode === 'supplement' ? '離開補充模式' : '離開提問模式'));

  const overviewTitle = (top1Score || 0) >= ASK_SCORE_HIGH
    ? '💡 找到相關線索，但答案還沒成形'   // top1 高、LLM 無法綜合
    : (top1Score || 0) >= ASK_SCORE_LOW
      ? '💡 可能沾到邊，但未必是你要的'    // 中等相關·窄帶可能巧合
      : '💡 找不到直接答案';              // top1 低、語料根本沒寫過
  const overview = {
    type: 'bubble', size: 'micro',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [{ type: 'text', text: overviewTitle, size: 'sm', weight: 'bold', color: THEME.stage.gap }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: footerContents }
  };

  // 線索卡：每張帶 LLM 給的 askAnnotation 一行（透過 buildSearchBubble_ opts 注入）
  const clueCards = [];
  if (allForStrip.length) {
    const suppCounts = buildSupplementCounts_(allForStrip);
    const byId = {}, byMsgId = {};
    for (const r of allForStrip) { byId[r.id] = r; if (r.lineMessageId) byMsgId[r.lineMessageId] = r; }
    const resolveQuoted = (rec) =>
      (rec.quotedRecordId && byId[rec.quotedRecordId]) ||
      (rec.quotedLineMessageId && byMsgId[rec.quotedLineMessageId]) || null;
    clues.forEach((h, i) => {
      clueCards.push(buildSearchBubble_(
        h.record, (h.semScore != null ? h.semScore : h.score), i + 1, suppCounts[h.record.id] || 0, resolveQuoted(h.record),
        corpusTimelineStrip_([h.record], allForStrip),
        // 暖紙「證物」身分，但標「線索」(未成答案)；帶 query 置中高亮、附 LLM 的 ✦ 為何相關。
        { scope: ctx.scope, askAnnotation: annById[h.record.id] || '', query: query, evidenceMode: true, evidenceLabel: '線索', evidenceOrdinal: circledNum_(i + 1) }
      ));
    });
  }

  // 關鍵字 chip 已塞進 overview 卡 body(見上方),quick reply 不再重複帶；只透傳 caller QR(若有)。
  const finalBubbles = [overview].concat(clueCards);
  const contents = finalBubbles.length === 1 ? finalBubbles[0] : { type: 'carousel', contents: finalBubbles };
  lineReplyFlex_(ctx.replyToken, `找不到答案：${truncate_(query, 30)}`, contents, quickReply || null);
}

function replyAskGap_(ctx, query, quickReply, clues) {
  const key = newId_();
  try { CacheService.getScriptCache().put('askgap_' + key, query, 21600); } catch (_) {}
  // 〔補充·歸戶〕線索群主題：補充這題時把補充記錄歸到這些線索的 (大類,議題標籤)。
  try { const home = dominantTopicOfHits_(clues); if (home) CacheService.getScriptCache().put('askhome_' + key, JSON.stringify(home), 21600); } catch (_) {}
  const accent = THEME.depth.l1.accent;
  clues = clues || [];

  // Overview 卡（index=0）：上半顯示問題＋corpus-span strip 標示線索位置、下半 footer 是
  // 補充這題鈕。線索本身改為輪播後續每張一卡（不再內嵌列表 + 「看相關記錄」按鈕，
  // 直接在輪播裡看見全文＋看完整內容）。
  const body = [{ type: 'text', text: `你問：${query}`, size: 'sm', color: THEME.text, wrap: true }];
  const allForStrip = clues.length ? (() => { try { return loadEmbeddingRecords_(ctx.scope); } catch (_) { return []; } })() : [];
  if (clues.length) {
    const stripBox = allForStrip.length ? corpusTimelineStrip_(clues.map(h => h.record), allForStrip) : null;
    if (stripBox) {
      body.push({ type: 'separator', margin: 'sm' });
      body.push(stripBox);
    }
    body.push({ type: 'text', text: `找到 ${clues.length} 筆相關線索，但不足以成為答案：`, size: 'xs', color: THEME.muted, wrap: true, margin: 'md' });
    body.push({ type: 'text', text: '線索卡在右邊 →　把線索之間補起來，下次就查得到 👇', size: 'xs', color: THEME.textBody, wrap: true, margin: 'sm' });
  } else {
    body.push({ type: 'text', text: '你的紀錄裡還沒有相關內容。', size: 'xs', color: THEME.muted, wrap: true, margin: 'md' });
    body.push({ type: 'text', text: '補上這塊，下次就查得到 👇', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' });
  }

  const footerContents = [{
    type: 'box', layout: 'vertical', backgroundColor: accent, cornerRadius: 'md', paddingAll: 'sm',
    action: { type: 'postback', label: '補充這題', data: `action=ask_supplement&k=${key}`, displayText: '▸ 補充這題' },
    contents: [{ type: 'text', text: '✏️ 補充這題', size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
  }];
  // 「看相關記錄」按鈕已移除——線索本身就以後續卡片呈現，不必再特別點。
  const sess = loadAskDialog_(ctx.scope);
  if (sess) footerContents.push(exitModeFooter_(sess.mode === 'supplement' ? '離開補充模式' : '離開提問模式'));
  const overview = {
    type: 'bubble', size: 'micro',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [{ type: 'text', text: '🧩 還沒有好的答案', size: 'sm', weight: 'bold', color: THEME.stage.gap }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: footerContents }
  };

  // 線索逐筆成卡（複用 buildSearchBubble_：含「📂 大類｜議題」目前歸類 + 看完整內容鈕）。
  // 每張帶 corpus-span strip 顯示自己的位置。
  const clueCards = [];
  if (clues.length && allForStrip.length) {
    const suppCounts = buildSupplementCounts_(allForStrip);
    const byId = {}, byMsgId = {};
    for (const r of allForStrip) { byId[r.id] = r; if (r.lineMessageId) byMsgId[r.lineMessageId] = r; }
    const resolveQuoted = (rec) =>
      (rec.quotedRecordId && byId[rec.quotedRecordId]) ||
      (rec.quotedLineMessageId && byMsgId[rec.quotedLineMessageId]) || null;
    clues.forEach((h, i) => {
      clueCards.push(buildSearchBubble_(
        h.record, (h.semScore != null ? h.semScore : h.score), i + 1, suppCounts[h.record.id] || 0, resolveQuoted(h.record),
        corpusTimelineStrip_([h.record], allForStrip),
        // 暖紙「線索」身分、帶 query 置中高亮（與 recall 記錄卡區隔）。
        { scope: ctx.scope, query: query, evidenceMode: true, evidenceLabel: '線索', evidenceOrdinal: circledNum_(i + 1) }
      ));
    });
  }

  const finalBubbles = [overview].concat(clueCards);
  const contents = finalBubbles.length === 1 ? finalBubbles[0] : { type: 'carousel', contents: finalBubbles };
  lineReplyFlex_(ctx.replyToken, `還沒有好的答案：${truncate_(query, 30)}`, contents, quickReply || null);
}

function suppModeQuickReply_() {
  return { items: [{ type: 'action', action: { type: 'postback', label: '離開/補充模式', data: 'action=ask_exit', displayText: '▸ 離開補充模式' } }] };
}

/** 補充這題 → enter supplement mode anchored to the gap (read from cache). */
function handleSupplementEntry_(ev, scope, key) {
  let gap = '';
  try { gap = CacheService.getScriptCache().get('askgap_' + key) || ''; } catch (_) {}
  if (!gap) return lineReply_(ev.replyToken, '這個缺口已過期，請重新 /ask 後再補充。');
  // 〔歸戶·跟著線索群〕/ask 補充＝補強這個答案；答案依據的線索群有明確主題時，把它帶進補充狀態，
  // 存檔時直接把補充記錄歸到線索群的 (大類,議題標籤)，不必丟背景獨立重判（見 handleSuppSave_）。
  let askHome = null;
  try { const raw = CacheService.getScriptCache().get('askhome_' + key); if (raw) askHome = JSON.parse(raw); } catch (_) {}
  saveAskDialog_(scope, { mode: 'supplement', gap, askHome, turns: [], draft: '', startedAt: Date.now() });
  lineReplyFlex_(ev.replyToken, `補充模式：${truncate_(gap, 30)}`, buildSuppIntroBubble_(gap), suppModeQuickReply_());
}

/**
 * Enter 補充模式 from a 候選歷程 (watch) card. The 脈絡 already meets the three
 * conditions; what's missing is a 轉折. So instead of the gap-filling intro we
 * prompt for one of the four transition kinds. The committed supplement becomes
 * a text record (recordAskQA_) that the next sweep can fold into this 脈絡 and
 * re-judge for a 轉折 → 升格.
 */
function handleContextSupplementEntry_(ev, scope, cid) {
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!context) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /journey 後再補充。');
  const topic = context.userTitle || context.label || '這條脈絡';
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (context.recordIds || []).map(id => recById[id]).filter(Boolean);

  // Phase 3〔融合〕:CPU markerGap(脈絡特徵)+ LLM 診斷(看內容)兩種判斷融合。
  const journey = pickJourneyForContext_(loadJourneys_(scope), cid);
  const markerGap = (journey && journey.markerGap) || null;
  const cpuSuggest = markerGap && markerGap.type;          // CPU 特徵推薦的起點
  const contextSummary = (journey && journey.summary) || topic;

  let diag = null;
  try { diag = diagnoseContextTransitions_(context, records, cpuSuggest); }
  catch (e) { console.warn('diagnoseContextTransitions_ failed:', e && e.message); }
  const llmSuggest = diag && diag.suggest;                 // LLM 看內容建議的起點
  const llmHint = diag ? diag.prompt : '';
  const diagnoses = diag ? diag.diagnoses : null;
  // 融合:LLM 看內容更貼實況,以 llmSuggest 為主建議;CPU 不同時並陳當第二視角。
  const finalSuggest = llmSuggest || cpuSuggest || null;
  const agree = cpuSuggest && llmSuggest && cpuSuggest === llmSuggest;
  // 建議原因:LLM 對建議項的具體診斷優先,退回 markerGap.evidence(CPU 特徵)。
  const suggestReason = (diagnoses && finalSuggest && diagnoses[finalSuggest])
    || (markerGap && markerGap.evidence) || '';

  // 起始分:對「現有內容」(代表片段)評鑒四項 %,顯示在主卡(與凝聚卡同一把尺、連續)。
  const recsSorted = records.filter(r => r && r.ts).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const contextDigest = sampleEvenly_(recsSorted, 6).map(r => truncate_(recText_(r), 80)).filter(Boolean).join('；');
  // 〔穩定·避免「下次進來分數又不同」〕startScores 是 LLM 評估、每次會浮動；按「成員 id 指紋」
  // 快取，同一批內容 6h 內回到這張卡給相同分數，內容變了（指紋變）才重算。
  let startScores = null;
  let ssKey = '';
  try {
    const fp = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, records.map(r => r.id).sort().join(','))
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 16);
    ssKey = 'tstart_' + cid + '_' + fp;
    const cv = CacheService.getScriptCache().get(ssKey);
    if (cv) startScores = JSON.parse(cv);
  } catch (_) {}
  if (!startScores) {
    try { const se = evaluateTransitionDraft_(contextDigest, contextSummary); startScores = se ? se.scores : null; }
    catch (e) { console.warn('start eval failed:', e && e.message); }
    if (startScores && ssKey) { try { CacheService.getScriptCache().put(ssKey, JSON.stringify(startScores), 21600); } catch (_) {} }
  }

  // 〔修正·達標即指向該項〕現有內容若某項轉折已達門檻，別再建議「別種轉折」（會出現「後設反思
  // 60%✓ 卻叫你補 行動指向 55%」的矛盾）——改直接指向那項，補一句寫明就升格。只在「有達標項」時覆寫；
  // 全項偏低仍走 LLM 診斷建議（原設計）。
  let fSuggest = finalSuggest, fReason = suggestReason, fHint = llmHint, passedType = null;
  if (startScores) {
    const passed = ['概念重述', '跨主題整合', '行動指向', '後設反思']
      .map(n => ({ n, s: startScores[n] || 0 }))
      .filter(x => x.s >= SUPPLEMENT_EVAL_THRESHOLD)
      .sort((a, b) => b.s - a.s);
    if (passed.length) {
      passedType = passed[0].n;
      fSuggest = passedType;
      fReason = `你現有內容的「${passedType}」已達 ${Math.round(passed[0].s * 100)}%——這條其實已經有這個轉折了，補一句把它寫明確、按「補進脈絡」就升格。`;
      fHint = `用一句話把「${passedType}」寫明確：${transitionWriteHint_(passedType)}`;
    }
  }

  // Dialog state 帶 contextSummary + contextDigest(連續評鑒)+ 融合建議起點(凝聚卡對照)。
  saveAskDialog_(scope, {
    mode: 'supplement', gap: topic, contextId: cid,
    contextSummary: contextSummary, contextDigest: contextDigest, suggestType: fSuggest,
    turns: [], draft: '', startedAt: Date.now()
  });

  const bubbles = [
    buildTransitionSuppIntroBubble_(topic, startScores, { finalSuggest: fSuggest, cpuSuggest: cpuSuggest, llmSuggest: llmSuggest, agree: agree, suggestReason: fReason, passedType: passedType }, fHint),
    buildTransitionStatusBubble_(records, context.criteria)
  ];
  lineReplyFlex_(ev.replyToken, `補一個轉折:${truncate_(topic, 24)}`,
    { type: 'carousel', contents: bubbles }, suppModeQuickReply_());
}

/** 四種轉折的「現況缺點」診斷文案(非 top1 項用;top1 用 markerGap.evidence 更具體)。
 *  描述「這條脈絡目前在這項上還缺什麼」,讓使用者看到全貌、理解為何建議從某項開始。 */
function markerGapDiagnosis_(type) {
  return {
    '概念重述': '還沒用自己的話重講核心概念',
    '跨主題整合': '還沒連到其他主題或經驗',
    '行動指向': '記錄不少,但還沒寫到「接下來要做什麼」',
    '後設反思': '還停在記錄,沒跳出來看自己學到什麼'
  }[type] || '';
}

/** 某項轉折「補一句把它寫明確」的引導題（達標項用，免再打一次 LLM）。 */
function transitionWriteHint_(type) {
  return {
    '概念重述': '用自己的話，把這次學到的核心概念重講一遍。',
    '跨主題整合': '把它跟你另一個主題連起來，說說怎麼互相影響。',
    '行動指向': '寫下你接下來具體會怎麼做、第一步是什麼。',
    '後設反思': '回看自己：在這件事上你的理解或方法有什麼轉變？'
  }[type] || '用一句話把這個轉折寫明確。';
}

/** Phase 3〔融合〕:主卡——四種轉折的現況診斷(LLM 看內容,各項缺什麼)+ 融合建議起點
 *  (CPU 特徵 × LLM 內容)+ LLM 題目。fuse = {diagnoses, finalSuggest, cpuSuggest,
 *  llmSuggest, agree, markerGap, passedType}。LLM 診斷不可用時退回模板。 */
function buildTransitionSuppIntroBubble_(topic, startScores, fuse, llmHint) {
  const accent = THEME.stage.supplement;
  const TYPES = [
    { icon: '🔁', name: '概念重述', hint: '用自己的話重講一個概念' },
    { icon: '🧩', name: '跨主題整合', hint: '把它連到另一個主題' },
    { icon: '🎯', name: '行動指向', hint: '下一步具體做什麼' },
    { icon: '🔭', name: '後設反思', hint: '回看自己在哪個學習階段' }
  ];
  fuse = fuse || {};
  const finalSuggest = fuse.finalSuggest;      // 融合後的主建議
  const cpuSuggest = fuse.cpuSuggest;
  const llmSuggest = fuse.llmSuggest;
  const suggestReason = fuse.suggestReason;    // 為什麼建議這項(LLM 診斷 / CPU 特徵)
  const thrPct = Math.round(SUPPLEMENT_EVAL_THRESHOLD * 100);
  const contents = [];

  if (startScores && finalSuggest) {
    // 〔達標橫幅〕現有內容已有某項轉折達門檻 → 明說「已經有轉折了，補一句寫明就升格」，不再像
    // 「都還沒補」那樣引導。解掉「某項已 ✓ 卻被叫去補別項」的矛盾。
    if (fuse.passedType) {
      contents.push({ type: 'text', text: `🎉 你的「${fuse.passedType}」已達標 ✓ — 這條已經有轉折了`, size: 'sm', weight: 'bold', color: THEME.success, wrap: true });
      contents.push({ type: 'text', text: '補一句把它寫明確、按「補進脈絡」就升格成學習歷程（想寫別種轉折也行）。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
      contents.push({ type: 'separator', margin: 'md' });
    }
    // 四項目前分數(% 進度條,✨ 標建議項)。分數來自評鑒「現有內容」,候選歷程通常四項偏低。
    contents.push({ type: 'text', text: `📊 你目前的轉折分數(達 ${thrPct}% 升格)`, size: 'xxs', color: THEME.muted, weight: 'bold' });
    TYPES.forEach(t => {
      const score = startScores[t.name] || 0;
      const isSug = t.name === finalSuggest;
      const passed = score >= SUPPLEMENT_EVAL_THRESHOLD;
      const color = passed ? THEME.success : (isSug ? accent : THEME.muted);
      const weight = (passed || isSug) ? 'bold' : 'regular';
      contents.push({
        type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: `${t.icon} ${t.name}${isSug ? ' ✨' : ''}`, size: 'xs', color: color, weight: weight, flex: 6 },
          { type: 'text', text: gapBar_(score), size: 'xs', color: color, weight: weight, flex: 4 },
          { type: 'text', text: `${Math.round(score * 100)}%${passed ? ' ✓' : ''}`, size: 'xs', color: color, weight: weight, align: 'end', flex: 3 }
        ]
      });
    });
    // 為什麼建議(解決「四項同分卻建議某項」的困惑):依脈絡累積樣態,不是看上面分數。
    // 但若已有達標項，建議就是「指向那項」（基於分數），標題與說明都改成達標語氣。
    contents.push({ type: 'separator', margin: 'lg' });
    contents.push({ type: 'text', text: fuse.passedType
      ? `✨ 往「${finalSuggest}」補（已達標·補一句寫明就升格）`
      : `✨ 為什麼建議補「${finalSuggest}」`, size: 'xxs', color: accent, weight: 'bold', margin: 'md' });
    if (suggestReason) {
      contents.push({
        type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'md', contents: [
          { type: 'box', layout: 'vertical', width: '5px', backgroundColor: accent, cornerRadius: 'sm', contents: [{ type: 'filler' }] },
          { type: 'text', text: suggestReason, size: 'xs', color: THEME.textBody, wrap: true, flex: 1 }
        ]
      });
    }
    if (!fuse.passedType) {
      contents.push({ type: 'text', text: '(依這條脈絡的累積樣態判斷,不是看上面四個分數)', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
      if (!fuse.agree && cpuSuggest && llmSuggest) {
        contents.push({ type: 'text', text: `特徵建議「${cpuSuggest}」、內容看來「${llmSuggest}」——以內容為主`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' });
      }
    }
    if (llmHint) {
      contents.push({ type: 'separator', margin: 'lg' });
      contents.push({ type: 'text', text: '💡 建議題目', size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' });
      contents.push({
        type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'md', contents: [
          { type: 'box', layout: 'vertical', width: '5px', backgroundColor: accent, cornerRadius: 'sm', contents: [{ type: 'filler' }] },
          { type: 'text', text: llmHint, size: 'sm', color: THEME.text, wrap: true, flex: 1 }
        ]
      });
    }
    contents.push({ type: 'text', text: '(也可以選別種轉折寫,不一定要照建議)', size: 'xxs', color: THEME.muted, margin: 'md', wrap: true });
  } else {
    // Fallback:無 markerGap,顯示 4 種轉折通用介紹
    contents.push({ type: 'text', text: '這條脈絡三條件都過了,只差一個轉折就升格成歷程。挑一種寫下來:', size: 'xs', color: THEME.textBody, wrap: true });
    contents.push({ type: 'separator', margin: 'md' });
    TYPES.forEach(t => {
      contents.push({
        type: 'box', layout: 'vertical', margin: 'sm', contents: [
          { type: 'text', text: `${t.icon} ${t.name}`, size: 'sm', weight: 'bold', color: THEME.text },
          { type: 'text', text: t.hint, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
        ]
      });
    });
  }

  contents.push({ type: 'separator', margin: 'lg' });
  contents.push({ type: 'text', text: (startScores && fuse.passedType)
    ? `你已有達標項——直接打一句把「${fuse.passedType}」寫明確、按「補進脈絡」就升格（分數是 LLM 評估、每次略有浮動，但達標的結論穩定）。`
    : `上面是你「目前內容」的分數,通常偏低(還沒補轉折)。直接打字開始,每寫一段這些數字會往上動,任一條達 ${thrPct}% 就能補進脈絡升格。`,
    size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' });

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🔁 轉折成形', size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: `針對:${truncate_(topic, 22)}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: contents },
    footer: exitModeFooter_('離開補充模式')
  };
}

/** Phase 3:Carousel 第二張——脈絡現況(三條件 + 代表片段 + time-strip)。 */
function buildTransitionStatusBubble_(records, criteria) {
  const accent = THEME.stage.supplement;
  const contents = [];
  const recs = (records || []).filter(r => r && r.ts).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  if (criteria) {
    const C = CONTEXT_CRITERIA;
    const densOk = densityConditionMet_(criteria);
    const visitOk = (criteria.returnVisits || 0) >= C.returnVisitsMin && (criteria.returnSpanHours || 0) >= C.returnSpanHoursMin;
    const mediaOk = (criteria.mediaKinds || 0) >= C.mediaKindsMin;
    contents.push({ type: 'text', text: '三條件', size: 'xxs', color: THEME.muted, weight: 'bold' });
    contents.push({ type: 'text', text: `語意密度 ${(criteria.semanticDensity || 0).toFixed(2)} ${densOk ? '✅' : '⬜'}`, size: 'xs', color: THEME.textBody, margin: 'xs' });
    contents.push({ type: 'text', text: `意向回返 ${criteria.returnVisits || 0} 次·${Math.round(criteria.returnSpanHours || 0)}h ${visitOk ? '✅' : '⬜'}`, size: 'xs', color: THEME.textBody, margin: 'xs' });
    contents.push({ type: 'text', text: `跨媒介 ${criteria.mediaKinds || 0} 種 ${mediaOk ? '✅' : '⬜'}`, size: 'xs', color: THEME.textBody, margin: 'xs' });
    contents.push({ type: 'separator', margin: 'md' });
  }
  if (recs.length) {
    contents.push({ type: 'text', text: '代表片段', size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' });
    sampleEvenly_(recs, 5).forEach(r => {
      contents.push({ type: 'text', text: `· ${truncate_(recText_(r), 40)}`, size: 'xs', color: THEME.textBody, wrap: true, maxLines: 2, margin: 'xs' });
    });
  }
  if (recs.length >= 2) {
    contents.push({ type: 'separator', margin: 'sm' });
    contents.push(episodeTimelineStrip_({ startTs: Date.parse(recs[0].ts), endTs: Date.parse(recs[recs.length - 1].ts), records: recs }));
  }
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: '🧶 脈絡現況', size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: `${recs.length} 則紀錄`, size: 'xxs', color: THEME.muted, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: contents },
    footer: exitModeFooter_('離開補充模式')
  };
}

/** 進度條 0-1 → 4 格 ▮▯ (cell-based,中文字粒度) */
function gapBar_(score) {
  const filled = Math.min(4, Math.max(0, Math.round((Number(score) || 0) * 4)));
  return '▮'.repeat(filled) + '▯'.repeat(4 - filled);
}

/** Entry card for /ask 答案補充強化（無 contextId 的補充模式）: 補想法 → 整理 → 補進脈絡.
 *  〔專屬文案〕與凝聚卡同身分「💬 補充強化這個答案」——不與脈絡補密度/補轉折共用標題。 */
function buildSuppIntroBubble_(gap) {
  const accent = THEME.stage.supplement;
  const step = (icon, label) => ({ type: 'text', text: `${icon} ${label}`, size: 'sm', color: THEME.text, wrap: true });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: '💬 補充強化這個答案', size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: `針對問題：${truncate_(gap, 22)}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', contents: [
        step('💬', '你補上想法'),
        { type: 'text', text: '⋁⋁', size: 'md', color: accent, margin: 'sm' },
        step('🎯', '整理成一段知識'),
        { type: 'text', text: '⋁⋁', size: 'md', color: accent, margin: 'sm' },
        step('🌱', '補進脈絡，下次查得到'),
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '直接打字開始；貼圖可給方向。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' }
      ]
    },
    footer: exitModeFooter_('離開補充模式')
  };
}

/** Organize the supplement turns into one self-contained piece of knowledge for
 *  the gap — strictly from what the user said, no world knowledge. */
function synthesizeSupplementDraft_(gap, turns) {
  const sys = '你協助把使用者補充的零散片段，整理成「一段清楚、自足、未來可被檢索的知識」，用來回答指定問題。只輸出那段知識本身（繁體中文，1-3 句；不要解釋、不要引號、不要開場白）。嚴格根據使用者提供的內容，不要自行加入你的世界知識。';
  const prompt = `問題（缺口）：${gap}\n\n使用者補充的片段：\n` + turns.map((t, i) => `(${i + 1}) ${t}`).join('\n');
  const out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.3, maxOutputTokens: 400 });
  const d = (out || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, '').slice(0, 500);
  return d || turns.join('；');
}

/** 進行中脈絡補密度的凝聚：把使用者「這次自己寫下的幾段」接成一段連貫、可被檢索的話，併入這條脈絡。
 *  〔唯一原則·忠實於原文〕輸出只能用使用者寫的字——每個事實/用詞（人名、地名、物件、數字、說法）原樣保留、
 *  一句不漏，讀起來就是使用者本人在講。**不再餵既有記錄當素材**：那是「凝聚被前面記寫訊息淹沒、看不出
 *  原話」的根源（使用者回報）。單則直接原樣保留、不過 LLM；多則才用一通 LLM 只做「接成一段＋補最少連接詞」。
 *  records/turnFocus 參數保留相容、本函式不用於內容。 */
function synthesizeDensityDraft_(records, turns, topic, turnFocus) {
  const ts = (turns || []).filter(t => t && t.trim());
  if (!ts.length) return (turns || []).join('；');
  // 單則：原樣保留、不過 LLM——最忠實、零「既有記寫影子」。
  if (ts.length === 1) return ts[0].trim().slice(0, 800);
  // 多則：只把使用者「這次自己寫的幾段」接成一段連貫的話。不餵既有記錄當素材（那是先前
  // 「凝聚被既有記寫淹沒」的根源），保留全部用詞與事實、只補最少量連接詞。
  const turnLines = ts.map((t, i) => `(${i + 1}) ${t}`).join('\n');
  const sys = '把使用者剛剛分幾次寫下的內容，接成「一段」連貫、可被檢索的話。'
    + '【鐵則·只能用使用者的字】每一個事實、人名、地名、數字、說法都要照原話保留，一句都不能漏、不能換成抽象概括、不能加入使用者沒寫的內容或背景。'
    + '你唯一能做的是補上最少量的連接詞讓幾段接得通順，讀起來必須就是使用者本人在講這段話。'
    + '只輸出那段話（繁體中文；不要解釋、不要引號、不要開場白、不要編號）。';
  const prompt = `主題：${topic || '（未命名）'}\n\n使用者這次寫的（全部照原話保留、接成一段）：\n${turnLines}`;
  const out = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.2, maxOutputTokens: 500 });
  const d = (out || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, '').slice(0, 800);
  return d || ts.join('；');
}

/** 補密度時量化「補充當下那則記寫」的聚焦程度（ABC 共用、增量算一則就好、省 embedding）：
 *  對這條脈絡的群心算 focus=cos(turn,群心)、對既有成員算 novelty=1−max cos(turn,成員)。
 *  records 無可用 embedding 或 turn 空 → 回 null（降級回原行為，不擋）。 */
function suppTurnFocus_(records, turnText) {
  const recs = (records || []).filter(r => r && r.embedding && r.embedding.length === EMBED_DIM);
  if (!recs.length || !turnText || !turnText.trim()) return null;
  let emb = null;
  try { emb = geminiEmbed_(turnText); } catch (e) { console.warn('supp turn embed failed:', e && e.message); return null; }
  if (!emb || emb.length !== EMBED_DIM) return null;
  const centroid = meanVector_(recs.map(r => r.embedding));
  const focus = cosineSim_(emb, centroid);
  let maxSim = -2;
  recs.forEach(r => { const c = cosineSim_(emb, r.embedding); if (c > maxSim) maxSim = c; });
  return { focus: focus, novelty: Math.max(0, 1 - maxSim) };
}

/** 把各則補充的 {focus,novelty}（含失敗的 null）聚合成這次補充的整體判讀：
 *  meanFocus（平均聚焦，給 B 顯示）、trend（最後一則 vs 之前平均，給 B 標 ↑/↓）、
 *  anyNovel（有沒有「不是近重複」的一則 → 結果卡的非阻擋提示用；防灌水的硬把關已移到 §C 密度去重）。 */
function suppFocusAgg_(perTurn) {
  const valid = (perTurn || []).filter(Boolean);
  if (!valid.length) return null;
  const meanFocus = valid.reduce((s, p) => s + p.focus, 0) / valid.length;
  const anyNovel = valid.some(p => p.novelty >= SUPP_NOVELTY_MIN);   // 有沒有「不是近重複」的一則
  let trend = 'flat';
  if (valid.length >= 2) {
    const last = valid[valid.length - 1].focus;
    const earlier = valid.slice(0, -1).reduce((s, p) => s + p.focus, 0) / (valid.length - 1);
    if (last - earlier > SUPP_FOCUS_TREND_EPS) trend = 'up';
    else if (earlier - last > SUPP_FOCUS_TREND_EPS) trend = 'down';
  }
  return { meanFocus: meanFocus, anyNovel: anyNovel, trend: trend, n: valid.length };
}

/** 補進脈絡 → record gap+draft as a Q&A, then re-ask the gap so the user sees it
 *  is now answerable. Closes the loop. */
function handleSuppSave_(ev, scope) {
  const s = loadAskDialog_(scope);
  if (!s || s.mode !== 'supplement' || !s.draft) {
    return lineReply_(ev.replyToken, '補充已逾時或還沒組好，請重新開始。');
  }
  // Phase 3 防呆:UI 已 disable button,但若 postback 從舊卡或繞道進來,server 端再擋一次
  if (s.contextId && s.eval && s.eval.topScore < SUPPLEMENT_EVAL_THRESHOLD) {
    const pct = Math.round(s.eval.topScore * 100);
    const thrPct = Math.round(SUPPLEMENT_EVAL_THRESHOLD * 100);
    const nm = truncate_(s.gap || '這條脈絡', 20);
    return lineReplyFlex_(ev.replyToken, `補充結果 · ${nm}`, buildSuppResultBubble_({
      tone: 'blocked', icon: '🌀', topic: nm, staying: true,
      headline: `這次補充最高貢獻度（${s.eval.topType}）${pct}%，還沒到 ${thrPct}% 門檻。`,
      hints: (s.eval.missingHint ? [`${s.eval.topType} 缺：${s.eval.missingHint}`] : []).concat(['請再補一段更具體的內容（直接打字繼續）。'])
    }), suppModeQuickReply_());
  }
  const ctx = { scope, replyToken: ev.replyToken, userId: scope.userId };
  const gap = s.gap, draft = s.draft, contextId = s.contextId || null;
  const askHome = s.askHome || null;       // 〔/ask 補充·歸戶〕答案依據的線索群主題（無 contextId 時用）
  const suppFocus = s.suppFocus || null;   // 〔補密度 C〕這次補充的 focus×novelty(防灌水閘用)
  clearAskDialog_(scope);
  let recId = null;
  try { recId = recordAskQA_(ctx, gap, draft); }
  catch (e) { console.warn('supplement record failed:', e && e.message); }

  // Context-targeted supplement: attach to that 脈絡 and judge it now, so the
  // user's intentional write promotes on the spot instead of waiting for the
  // throttled background sweep. Branch on the context's CURRENT status —
  // 候選歷程 ('context') needs 轉折 detection; 進行中脈絡 ('candidate') needs
  // re-evaluating the 三條件 to see if this new record carries it over.
  if (contextId) {
    const c = loadContexts_(scope).find(x => x.id === contextId);
    if (c && c.status === 'candidate') return finishCandidateSupplement_(ev, scope, contextId, recId, gap, suppFocus);
    return finishTransitionSupplement_(ev, scope, contextId, recId, gap, s.eval, draft);
  }

  // 〔/ask 補充·歸戶〕沒有 contextId＝補強某個 /ask 答案。答案是「根據線索群」推出來的，所以補充
  // 記錄應直接歸到線索群最相符的 (大類,議題標籤)＋鎖定（topicLocked），而不是丟背景獨立重判——
  // 否則「🔍探問…💡…」這種泛語感文字常被分類器判進隨想，再被時間相近的別題併成一條（修正本問題）。
  // 這只做歸戶、不走升格評鑒（/ask 補充＝補強答案，沒有三條件/轉折那回事）。
  let homedLabel = '';
  if (recId && askHome && askHome.topicLabel) {
    try {
      if (setRecordsCategoryTopic_(scope, [recId], askHome.category || '', askHome.topicLabel) > 0) homedLabel = askHome.topicLabel;
    } catch (e) { console.warn('ask supplement 歸戶 failed:', e && e.message); }
  }

  lineReply_(ev.replyToken, homedLabel
    ? `✓ 已補強並歸到「${homedLabel}」，下次就查得到了。`
    : '✓ 已補進脈絡，下次就查得到了。');
  // Re-ask the gap so the user sees it's now answerable. Closes the loop.
  runAndReplyAsk_(ctx, gap, false, null);
}

/**
 * Immediate 轉折 detection for a context-targeted supplement. Attaches the new
 * record to the 脈絡, re-judges that single 脈絡 (one Gemini call), and 升格 it to
 * a 歷程 on the spot when a 轉折 is found. Mirrors detectJourneys_'s journey-record
 * shape (basedOnUpdatedAt = the bumped context.updatedAt), so the next background
 * sweep reconciles consistently rather than re-judging needlessly.
 */
function finishTransitionSupplement_(ev, scope, contextId, recId, topic, evalData, draft) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 20); } catch (_) {} }
  const contexts = loadContexts_(scope);
  const c = contexts.find(x => x.id === contextId);
  if (!c || c.status !== 'context') {
    return lineReply_(ev.replyToken, '✓ 已補進這條脈絡。背景會自動重新評估是否升格。');
  }
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });

  // 〔2026-06-02 移除 cos 歸屬閘〕使用者是從「這條脈絡的補一個轉折」按鈕進來的,歸屬已由
  // 他的行動決定——這個流程唯一該判的是「夠不夠格當好轉折」(品質),不該再用 cos 重判歸屬。
  // 舊 cos 閘(SUPPLEMENT_RELATEDNESS_MIN)的三個毛病:(a) 重複判斷一件使用者已用行動決定的
  // 事;(b) 違背設計哲學「向量只參考、不當淘汰閘」(§0.4.1),是全系統唯一用 cos 硬擋處,
  // 與背景 label group-by 歸屬打架(前景擋下、背景卻用 label 撿回去升格,造成「說沒過卻偷偷
  // 升格」的矛盾);(c) 被合成測試向量誤判。品質把關交給凝聚卡評鑒閘(已擋過 60%);離題防護
  // 也由評鑒涵蓋(離題內容對四轉折評分必然低)。前景背景自此一致:都只判「夠不夠格」、不判歸屬。

  // 掛上脈絡 + 跑轉折偵測
  if (recId && (c.recordIds || []).indexOf(recId) < 0) {
    // 〔關鍵〕把補充 record 的 (category, topicLabel) 鎖成這條脈絡成員的代表標籤 +
    // topicLocked=true。否則背景 upgradeContexts_ 用 (category,topicLabel) group-by 重分群時,
    // 分類器會獨立判補充的標籤(可能判成別的議題),把它從這條脈絡抽出、自成一條新候選——
    // 結果「補進的轉折」跟脈絡分家、歷程報告讀不到補充。鎖標籤讓 group-by 留住它(同 §0.6.3)。
    const memberCat = c.category || '';
    let memberTopic = '';
    for (const id of (c.recordIds || [])) {
      const r = recById[id];
      if (r && r.topicLabel) { memberTopic = r.topicLabel; break; }
    }
    if (memberCat && memberTopic) {
      try { setRecordsCategoryTopic_(scope, [recId], memberCat, memberTopic); }
      catch (e) { console.warn('lock supplement topic failed:', e && e.message); }
      if (recById[recId]) { recById[recId].category = memberCat; recById[recId].topicLabel = memberTopic; recById[recId].topicLocked = true; }
    }
    c.recordIds = (c.recordIds || []).concat([recId]);
    c.updatedAt = new Date().toISOString();
    saveContexts_(scope, contexts);
  }
  const records = (c.recordIds || []).map(id => recById[id]).filter(Boolean);

  // detectContextMarkers_ 仍跑——用它生標題/摘要/關鍵字(歷程卡與故事需要)。
  let res = { title: '', summary: '', keywords: null, markers: [] };
  // 〔前景不吃背景額度·Fix2〕補充升格的標題/摘要產生是前景動作，不扣背景每日額度。
  try { res = detectContextMarkers_(c, records); }
  catch (e) {
    console.warn('immediate journey detect failed:', e && e.message);
    return lineReply_(ev.replyToken, '✓ 已補進這條脈絡。轉折判讀暫時失敗，背景會再評估。');
  }
  const nowIso = new Date().toISOString();

  // 〔一致〕升格的 markers(轉折理由)直接用「凝聚卡評鑒達標的項」——也就是你補充時看到的
  // 那些分數,而非 detectContextMarkers_ 另判的結果,否則升格理由會跟你剛看到的評鑒對不上。
  // evidence 用補充原文、confidence 用評鑒分數。LLM 評鑒不可用時退回 detectContextMarkers_。
  let markers;
  if (evalData && evalData.scores) {
    const TT = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
    const evi = truncate_((draft || '').replace(/\s+/g, ' '), 200);
    markers = TT.filter(t => (evalData.scores[t] || 0) >= SUPPLEMENT_EVAL_THRESHOLD)
      .map(t => ({ type: t, evidence: evi, confidence: clamp01_(evalData.scores[t]), detectedAt: nowIso }));
    if (!markers.length) markers = res.markers || [];
  } else {
    markers = res.markers || [];
  }

  const journeys = loadJourneys_(scope);
  const idx = journeys.findIndex(j => j.contextId === c.id);
  const prev = idx >= 0 ? journeys[idx] : null;
  const jrec = {
    id: prev ? prev.id : newId_(),
    createdAt: prev ? prev.createdAt : nowIso,
    updatedAt: nowIso,
    contextId: c.id,
    label: c.label,
    title: res.title || (prev && prev.title) || '',
    summary: res.summary || (prev && prev.summary) || '',
    keywords: res.keywords || (prev && prev.keywords) || null,
    markers: markers,
    status: (markers.length || (prev && prev.status === 'journey')) ? 'journey' : 'watch',
    basedOnUpdatedAt: c.updatedAt,
    // 讓這條升格成歷程的「轉折關鍵」記錄 id——不可移除(脈絡生為歷程的依據)。累積、去重。
    keyRecordIds: ((prev && prev.keyRecordIds) || []).concat(recId ? [recId] : []).filter((v, i, a) => v && a.indexOf(v) === i)
  };
  if (idx >= 0) journeys[idx] = jrec; else journeys.push(jrec);
  saveJourneys_(scope, journeys);

  const name = truncate_(c.label || topic || '這條脈絡', 20);
  if (markers.length) {
    // 〔去重〕當面已用升格卡告知,把這條 journey id 記進 notifiedJourneyIds,背景
    // notifyNewUpgrades_ 就不會再推一張「🌱 你的記寫有新進展」重複轟炸(那張是給
    // 「背景自動發現新歷程」用的;前景當場升格已當面講過,不該重複)。
    updateChatMeta_(scope, m => {
      const seen = m.notifiedJourneyIds || [];
      if (seen.indexOf(jrec.id) < 0) seen.push(jrec.id);
      m.notifiedJourneyIds = seen;
      return m;
    });
    return lineReplyFlex_(ev.replyToken, `🎉 升格成學習歷程 · ${name}`,
      buildPromotedJourneyBubble_(jrec.title || name, markers, c.id, jrec.id));
  }
  return lineReplyFlex_(ev.replyToken, `補充結果 · ${name}`, buildSuppResultBubble_({
    tone: 'progress', icon: '🌀', topic: name,
    headline: `✓ 已補進「${name}」。`,
    hints: ['這次還沒判讀到明確的轉折。試著更具體：「我原本以為…，現在覺得…」「我打算…」「我發現我一直在…」，或等背景再評估。']
  }));
}

/** 〔轉折成形→升格〕當場升格成學習歷程的慶祝卡:列偵測到的轉折、說明背景接下來做
 *  什麼(這條不是終點)、可直接點開完整歷程報告。取代舊純文字回報。 */
function buildPromotedJourneyBubble_(title, markers, cid, jid) {
  const ICON = { '概念重述': '🔁', '跨主題整合': '🧩', '行動指向': '🎯', '後設反思': '🔭' };
  const markerRows = (markers || []).map(m => ({
    type: 'text', text: `${ICON[m.type] || '•'} ${m.type}`, size: 'sm', color: THEME.text, margin: 'sm', weight: 'bold'
  }));
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.success, paddingAll: 'md',
      contents: [{ type: 'text', text: '🎉 升格成學習歷程', size: 'md', weight: 'bold', color: THEME.onDark }]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'lg', contents: [
        { type: 'text', text: truncate_(title, 24), size: 'lg', weight: 'bold', color: THEME.text, wrap: true },
        { type: 'text', text: '剛剛:把你的補充併入這條脈絡、重判轉折、生成歷程標題', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' },
        { type: 'text', text: '這次寫出的轉折(就是你補充時達標的那些)', size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' }
      ].concat(markerRows).concat([
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '接下來', size: 'xxs', color: THEME.muted, weight: 'bold', margin: 'md' },
        { type: 'text', text: '這條已成學習歷程。背景會持續把你之後相關的記寫吸收進來、讓它長大;隨時可用 /story 產出完整敘事。', size: 'xs', color: THEME.textBody, wrap: true, margin: 'sm' }
      ])
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md', contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '歷程現況', data: `action=journey_story&cid=${cid}${jid ? '&jid=' + jid : ''}`, displayText: opEcho_('歷程現況', title) },
        contents: [{ type: 'text', text: '📖 歷程現況', size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
      }]
    }
  };
}

/** Entry from /themes 進行中脈絡 卡 的「補一筆撐到候選歷程」按鈕：開 supplement 模式、
 *  intro 卡明示這條脈絡還缺哪些條件 (密度/回返/媒介)，引導使用者寫一筆有幫助的紀錄。 */
function handleCandidateSupplementEntry_(ev, scope, cid) {
  const context = loadContexts_(scope).find(c => c.id === cid);
  if (!context) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /themes 後再補充。');
  const topic = context.label || '這條脈絡';
  const recById = {};
  loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (context.recordIds || []).map(id => recById[id]).filter(Boolean);
  saveAskDialog_(scope, { mode: 'supplement', gap: topic, contextId: cid, turns: [], draft: '', startedAt: Date.now() });
  lineReplyFlex_(ev.replyToken, `補一筆：${truncate_(topic, 24)}`,
    buildCandidateSuppIntroBubble_(topic, context.criteria || {}, records, cid), suppModeQuickReply_());
}

/** 補充模式 intro tailored for 進行中脈絡 — names the failing gates so the user
 *  knows what to aim for (密度 = 更聚焦、回返 = 不同時段、媒介 = 加上圖／語音／檔)。 */
/** 群心最近那筆（最「扣核心」的代表片段）——補充引導往這方向寫，密度才拉得高。只看語意內容成員。 */
function nearestToCentroid_(records) {
  const vs = (records || []).filter(r => r && r.embedding && r.embedding.length === EMBED_DIM && CONTEXT_MEDIA_TYPES[r.type]);
  if (vs.length < 2) return null;
  const centroid = meanVector_(vs.map(r => r.embedding));
  if (!centroid) return null;
  let best = null, bestS = -2;
  vs.forEach(r => { const s = cosineSim_(r.embedding, centroid); if (s > bestS) { bestS = s; best = r; } });
  return best;
}

/** 〔§A·密度槓桿〕找「離核心最遠」的成員（拉低密度的離群筆）。只看語意內容。
 *  回 { keep, drop:[{r,cos}], prevD, keepD } 或 null（太少/無明顯離群＝不是混雜，補新內容才有效）。 */
function contextOutliers_(recs) {
  const vs = (recs || []).filter(r => r && r.embedding && r.embedding.length === EMBED_DIM && CONTEXT_MEDIA_TYPES[r.type]);
  if (vs.length < 4) return null;
  const centroid = meanVector_(vs.map(r => r.embedding));
  if (!centroid) return null;
  const scored = vs.map(r => ({ r, cos: cosineSim_(r.embedding, centroid) })).sort((a, b) => a.cos - b.cos);
  const fit = CONTEXT_CRITERIA.densityFocusFitMin;   // 0.50：低於此＝沒扣到核心
  let dropN = scored.filter(s => s.cos < fit).length;
  dropN = Math.min(dropN, Math.max(0, vs.length - 3), Math.floor(vs.length * 0.4));   // 至少留 3、最多丟 40%
  if (dropN < 1) return null;
  const drop = scored.slice(0, dropN);
  const dropIds = {}; drop.forEach(s => { dropIds[s.r.id] = true; });
  const keep = vs.filter(r => !dropIds[r.id]);
  return {
    keep, drop,
    prevD: avgPairwiseCosine_(vs.map(r => r.embedding), 2000),
    keepD: avgPairwiseCosine_(keep.map(r => r.embedding), 2000)
  };
}

/** 〔§A〕密度卡關時的「分開離核心最遠幾筆」區塊：點名離群筆＋一鍵分開（複用 ctx_split）。
 *  回 Flex box 或 null（無明顯離群→不顯示，補新內容才有效）。 */
function buildOutlierSplitBox_(cid, recs) {
  const o = contextOutliers_(recs);
  if (!o || !o.drop.length) return null;
  const contents = [
    { type: 'separator', margin: 'md' },
    { type: 'text', text: '🔀 這條混了不同的事——補很難拉高，分開更有效', size: 'xxs', color: THEME.warning, weight: 'bold', margin: 'md', wrap: true },
    { type: 'text', text: '離核心最遠（在拉低密度）：', size: 'xxs', color: THEME.muted, margin: 'sm' }
  ];
  o.drop.slice(0, 3).forEach(d => {
    contents.push({ type: 'text', text: `· ${truncate_(recText_(d.r), 24)}（相似 ${d.cos.toFixed(2)}）`, size: 'xxs', color: THEME.textBody, wrap: true, maxLines: 1 });
  });
  contents.push({
    type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', margin: 'md',
    action: { type: 'postback', label: '分開混到的幾筆', data: `action=ctx_split&cid=${cid}`, displayText: '▸ 分開混到的幾筆' },
    contents: [{ type: 'text', text: `🔀 分開混到的（核心密度估 ${o.prevD.toFixed(2)} → ${o.keepD.toFixed(2)}）`, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
  });
  return { type: 'box', layout: 'vertical', contents: contents };
}

function buildCandidateSuppIntroBubble_(topic, criteria, records, cid) {
  const accent = THEME.stage.supplement;
  const C = CONTEXT_CRITERIA;
  const cr = criteria || {};
  const densOk = densityConditionMet_(cr);
  const visitOk = (cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin;
  const mediaOk = (cr.mediaKinds || 0) >= C.mediaKindsMin;
  const gapLine = (icon, label, hint) => ({
    type: 'box', layout: 'vertical', margin: 'md', contents: [
      { type: 'text', text: `${icon} ${label}`, size: 'sm', weight: 'bold', color: THEME.text },
      { type: 'text', text: hint, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
    ]
  });
  const contents = [
    { type: 'text', text: '這條脈絡離成形還缺幾項；現在補一筆能立刻檢查。挑下面任一種來補：', size: 'xs', color: THEME.textBody, wrap: true }
  ];
  if (!densOk) {
    contents.push(gapLine('🎯', '語意密度', `現在群內相似度 ${(cr.semanticDensity || 0).toFixed(2)}、需 ≥ ${C.semanticDensityMin}。寫一段更聚焦在同一件事的補充。`));
    // §A 引導：秀「這條的核心」（群心最近那筆）讓使用者往這方向寫，密度才容易過。
    const core = nearestToCentroid_(records);
    if (core) contents.push({ type: 'text', text: `往這個核心方向寫越貼越好：「${truncate_(recText_(core), 30)}」`, size: 'xxs', color: THEME.stage.supplement, wrap: true, margin: 'xs' });
    // §A：若這條其實混了不同的事，補很難拉高 → 點名離群筆＋一鍵分開（比補有效）。
    const ob = buildOutlierSplitBox_(cid, records);
    if (ob) contents.push(ob);
  }
  if (!visitOk) {
    contents.push(gapLine('🔁', '意向回返', `不同時段回來這主題 ≥ ${C.returnVisitsMin} 次、首末跨 ≥ ${C.returnSpanHoursMin}h（間隔 ≥ ${C.returnGapMinutes} 分算一次）；當下補不能算回返，等過一段再來寫一筆比較有效。`));
  }
  if (!mediaOk) {
    contents.push(gapLine('🎨', '跨媒介', `現在 ${cr.mediaKinds || 0} 種媒介、需 ≥ ${C.mediaKindsMin}。傳一張相關的圖／一段語音／一個檔，會自動歸進這條脈絡。`));
  }
  const recs = (records || []).filter(r => r && r.ts).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (recs.length) {
    contents.push({ type: 'separator', margin: 'md' });
    contents.push({ type: 'text', text: '這條脈絡已寫了什麼（代表片段）', size: 'xxs', color: THEME.muted, margin: 'sm' });
    sampleEvenly_(recs, 4).forEach(r => {
      contents.push({ type: 'text', text: `· ${truncate_(recText_(r), 38)}`, size: 'xs', color: THEME.textBody, wrap: true, maxLines: 2 });
    });
  }
  contents.push({ type: 'separator', margin: 'lg' });
  contents.push({ type: 'text', text: '直接打字寫完按「補進脈絡」；上傳圖／語音／檔會自動補進、當場重判三條件（媒體照收，跟平常記寫一樣）。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'md' });
  if (recs.length >= 2) {
    contents.push({ type: 'separator', margin: 'sm' });
    contents.push(episodeTimelineStrip_({ startTs: Date.parse(recs[0].ts), endTs: Date.parse(recs[recs.length - 1].ts), records: recs }));
  }
  // 〔依缺項命名〕標題直接寫「在補哪一條」：顧密度／顧媒介（一看就知道要寫什麼），
  // 依實際缺項動態列、已達標的不寫進來；回返本質上要不同時段（另走提醒）。
  const suppNeeds = []; if (!densOk) suppNeeds.push('密度'); if (!mediaOk) suppNeeds.push('媒介');
  const headTitle = `🌱 補一筆顧${suppNeeds.join('／') || '密度'}`;
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, paddingAll: 'md',
      contents: [
        { type: 'text', text: headTitle, size: 'sm', weight: 'bold', color: accent },
        { type: 'text', text: `針對：${truncate_(topic, 22)}`, size: 'xxs', color: THEME.muted, margin: 'xs', wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: contents },
    footer: exitModeFooter_('離開補充模式')
  };
}

/**
 * Attach a new record id to a 進行中脈絡 and re-run contextGapReport_ in one
 * shot. Updates c.criteria + flips status='context' when all 3 gates pass.
 * Returns { c, report } for the caller to compose a reply, or null if the
 * context is gone (caller should fall back to a generic "保留中" message).
 * Shared between text-supplement (handleSuppSave_) and media-supplement
 * (handleSupplementMediaAttach_) paths so both report consistent state.
 */
function attachRecordToCandidate_(scope, contextId, recId) {
  const contexts = loadContexts_(scope);
  const c = contexts.find(x => x.id === contextId);
  if (!c) return null;
  const allRecords = loadEmbeddingRecords_(scope);
  const recById = {};
  allRecords.forEach(r => { recById[r.id] = r; });
  if (recId && (c.recordIds || []).indexOf(recId) < 0) {
    // 〔關鍵·防補進的資料下次背景掃描就消失〕把補充 record 的 (category, topicLabel) 鎖成本脈絡
    // 成員的代表標籤 + topicLocked=true。否則背景 upgradeContexts_ 以 (category,topicLabel) group-by
    // 重分群時，分類器會獨立判補充的標籤(或還沒判、topicLabel 為空 → 直接不成群)，把它從本脈絡
    // 抽走，recordIds 被 fresh cluster 覆寫 → 使用者「補進脈絡」的內容在下次掃描就不見了。
    // 鎖標籤讓 group-by 留住它(與 finishTransitionSupplement_ 的轉折補充同法)。補一筆即永久保留。
    const memberCat = c.category || '';
    let memberTopic = '';
    for (const id of (c.recordIds || [])) {
      const r = recById[id];
      if (r && r.topicLabel) { memberTopic = r.topicLabel; break; }
    }
    if (memberCat && memberTopic) {
      try { setRecordsCategoryTopic_(scope, [recId], memberCat, memberTopic); }
      catch (e) { console.warn('lock candidate supplement topic failed:', e && e.message); }
      if (recById[recId]) { recById[recId].category = memberCat; recById[recId].topicLabel = memberTopic; recById[recId].topicLocked = true; }
    }
    c.recordIds = (c.recordIds || []).concat([recId]);
    c.updatedAt = new Date().toISOString();
  }
  const records = (c.recordIds || []).map(id => recById[id]).filter(Boolean);
  const corpusMedia = allRecords.filter(r => r && r.embedding && CONTEXT_MEDIA_TYPES[r.type] && r.type !== 'text');
  const report = contextGapReport_(records, corpusMedia);
  // §A 密度 delta：補進「前」（排除這筆、只算語意內容）的密度，給結果卡顯示 0.48→0.50。
  const prevVecs = records.filter(r => r.id !== recId && CONTEXT_MEDIA_TYPES[r.type]).map(r => r.embedding).filter(Boolean);
  const prevDensity = avgPairwiseCosine_(prevVecs, 2000);
  c.criteria = {
    semanticDensity: report.density,
    coreFrac: report.coreFrac,                                             // 聚焦補償用（densityConditionMet_ 讀這個）
    clusterSeparation: (c.criteria && c.criteria.clusterSeparation) || 0,  // separation is global; leave background to refresh
    returnVisits: report.visits,
    returnSpanHours: report.spanHours,
    mediaKinds: report.mediaKinds,
    passed: report.met
  };
  if (report.met) { c.status = 'context'; clearCandidateReminder_(scope, contextId); }   // 升格 → 取消回返提醒
  saveContexts_(scope, contexts);
  return { c, report, prevDensity };
}

/**
 * Text-supplement finish for 進行中脈絡 (called from handleSuppSave_ when the
 * targeted context has status='candidate'). Attaches the recorded Q&A then
 * tells the user where things stand.
 */
/** 補充結果／建議卡（補進脈絡後的統一結果卡）。
 *  tone：ok（達標升格・綠）／progress（差一點・藍）／blocked（未過門檻・橘）。
 *  gaps＝還缺哪幾條；hints＝怎麼補才會上去；staying＝留在補充模式時附「續寫／離開」footer。 */
function buildSuppResultBubble_(opts) {
  const tone = opts.tone || 'progress';
  const headerBg = tone === 'ok' ? THEME.success : (tone === 'blocked' ? THEME.warning : THEME.cta);
  const body = [{ type: 'text', text: opts.headline || '', size: 'sm', weight: 'bold', color: THEME.text, wrap: true }];
  // §A 密度 delta：補這筆讓語意密度從多少→多少（升＝綠、降＝橘、持平＝灰）。
  if (typeof opts.density === 'number' && typeof opts.prevDensity === 'number') {
    const d0 = opts.prevDensity, d1 = opts.density, delta = d1 - d0;
    const passed = d1 >= CONTEXT_CRITERIA.semanticDensityMin;
    const dColor = delta > 0.005 ? THEME.success : (delta < -0.005 ? THEME.warning : THEME.muted);
    const tail = passed ? '　已過語意密度 ✅' : (delta > 0.005 ? '　往上了，再貼一點' : (delta < -0.005 ? '　這筆偏題了' : '　持平'));
    body.push({
      type: 'text', size: 'xs', weight: 'bold', wrap: true, margin: 'md',
      contents: [
        { type: 'span', text: `🎯 密度 ${d0.toFixed(2)} → ${d1.toFixed(2)}`, color: THEME.text },
        { type: 'span', text: `（${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}）`, color: dColor },
        { type: 'span', text: tail, color: passed ? THEME.success : THEME.muted }
      ],
      text: `🎯 密度 ${d0.toFixed(2)} → ${d1.toFixed(2)}`
    });
  }
  if (opts.gaps && opts.gaps.length) {
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: '還缺', size: 'xxs', color: THEME.muted, margin: 'md' });
    opts.gaps.forEach(g => body.push({ type: 'text', text: `・${g}`, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' }));
  }
  if (opts.hints && opts.hints.length) {
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: '建議', size: 'xxs', color: THEME.muted, margin: 'md' });
    opts.hints.forEach(h => body.push({ type: 'text', text: h, size: 'xs', color: THEME.textBody, wrap: true, margin: 'xs' }));
  }
  // §A 密度卡關時：點名離核心最遠的幾筆＋一鍵分開（比補更有效）。
  if (opts.outlierBox) body.push(opts.outlierBox);
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: `${opts.icon || '🌀'} 補充結果／建議`, size: 'xs', color: THEME.onDark },
        { type: 'text', text: truncate_(opts.topic || '', 22), size: 'md', weight: 'bold', color: THEME.onDark, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
  if (opts.staying) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: 'sm', spacing: 'xs', contents: [
        { type: 'text', text: '還在補充模式——直接繼續打字補。', size: 'xxs', color: THEME.muted, wrap: true },
        exitModeFooter_('離開補充模式')
      ]
    };
  }
  return bubble;
}

function finishCandidateSupplement_(ev, scope, contextId, recId, topic, suppFocus) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 15); } catch (_) {} }
  // 〔不阻擋・一律保留〕使用者每次「補進脈絡」都附進去並 topicLock（attachRecordToCandidate_），
  // 即使還沒達標也不丟、不踢出——下次背景掃描不會再把它洗掉。防灌水交給密度度量去近重複（§C，
  // avgPairwiseCosine_）：灌水那種雖然存著、但不會幫密度往上，所以「補了會留、但灌水沒用」。
  const result = attachRecordToCandidate_(scope, contextId, recId);
  if (!result) return lineReply_(ev.replyToken, '✓ 已補進這條脈絡。背景會自動重新評估是否升格。');
  const { c, report, prevDensity } = result;
  const name = truncate_(c.label || topic || '這條脈絡', 20);
  if (report.met) {
    return lineReplyFlex_(ev.replyToken, `🎉 升格成候選歷程 · ${name}`, buildSuppResultBubble_({
      tone: 'ok', icon: '🎉', topic: name,
      headline: '🎉 三條件齊備，升格成候選歷程！',
      density: report.density, prevDensity: prevDensity,
      hints: ['背景會接著判讀有沒有轉折；也可以 /journey 找這條補一個轉折。']
    }));
  }
  // 沒達標：不踢出——重建補充 session（重置 turns）、留在補充模式繼續補，並用結果卡給可操作建議。
  saveAskDialog_(scope, { mode: 'supplement', gap: topic, contextId: contextId, turns: [], draft: '', startedAt: Date.now() });
  const recById = {}; loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
  const records = (c.recordIds || []).map(id => recById[id]).filter(Boolean);
  const gaps = report.gaps && report.gaps.length ? report.gaps : ['再多累積一點'];
  const hints = candidateSupplementHint_(report, records);
  // 〔C 的非阻擋提示〕這次補充和既有內容偏像（沒新意）→ 提醒換個新角度才幫得到密度（但已留存）。
  if (SUPP_FOCUS_WEIGHT_ENABLED && suppFocus && suppFocus.anyNovel === false) {
    hints.unshift('這次補的和脈絡裡已有的偏像（比較像重複）——已經留著了，但要把密度帶上去，換個還沒寫過的角度更有效。');
  }
  // §A：密度卡關時，點名離核心最遠的幾筆＋一鍵分開（數學上比補有效）。
  const outlierBox = !densityConditionMet_(c.criteria || {}) ? buildOutlierSplitBox_(contextId, records) : null;
  return lineReplyFlex_(ev.replyToken, `補充結果 · ${name}`, buildSuppResultBubble_({
    tone: 'progress', icon: '🌱', topic: name, staying: true,
    headline: `✓ 已補進「${name}」（會留著），還沒達標、繼續補。`,
    density: report.density, prevDensity: prevDensity, outlierBox: outlierBox,
    gaps: gaps, hints: hints
  }), suppModeQuickReply_());
}

/** 「怎麼補才會讓條件往上」的可操作建議（回 string[]）：依實際缺項給。語意密度＝群內彼此夠不夠像，
 *  故建議「更貼近核心、講同一件事」（並點出核心代表片段供對齊）；上不去多半是混了不同的事 →
 *  提示用敘事片段「分開」。媒介缺就提示傳圖/音/檔。純 CPU、不打 LLM。 */
function candidateSupplementHint_(report, records) {
  const C = CONTEXT_CRITERIA;
  const tips = [];
  const densMet = densityConditionMet_({ semanticDensity: report.density, coreFrac: report.coreFrac });
  if (!densMet) {
    const recs = (records || []).filter(r => r && r.embedding && r.embedding.length === EMBED_DIM);
    let core = '';
    if (recs.length >= 2) {
      const centroid = meanVector_(recs.map(r => r.embedding));
      let best = null, bestCos = -2;
      recs.forEach(r => { const cos = cosineSim_(r.embedding, centroid); if (cos > bestCos) { bestCos = cos; best = r; } });
      if (best) core = truncate_((recText_(best) || '').replace(/\s+/g, ' '), 22);
    }
    tips.push(`💡 語意密度 ${report.density} 偏低＝這條彼此不夠像。`
      + (core ? `核心像是「${core}」——` : '')
      + `再補一兩句更貼近核心、講同一件事的具體內容（別岔題）會往上。`);
    tips.push('↔ 若相似度一直上不去，多半是混了不同的事——可到敘事片段把不屬於的那幾筆「分開」。');
  }
  if ((report.mediaKinds || 0) < C.mediaKindsMin) {
    tips.push('🎨 也可以傳一張相關的圖／一段語音／一個檔，補滿跨媒介。');
  }
  if (!tips.length) tips.push('再補一兩句更聚焦的具體內容試試。');
  return tips;
}

/* ---- 回返提醒 (candidate context that's missing 回返 condition) ---- */

const REMINDER_KEY_PREFIX = 'reminder_';
const REMINDER_MIN_DELAY_MS = 1 * 60 * 60 * 1000;   // 隨機提醒窗下界（1 小時）
const REMINDER_MAX_DELAY_MS = 12 * 60 * 60 * 1000;  // 隨機提醒窗上界（12 小時）

function saveCandidateReminder_(scope, cid, label) {
  // 「之後再提醒」：不再固定「明天同一時間」，改在 1～12 小時間取隨機時間。下界 1h 同時 ≥ 回返
  // 間隔(returnGapMinutes 20 分)、也達首末跨 ≥1h 門檻，確保你回來寫時算得上一次新回返；隨機 +
  // 分散到不同時段也較自然、更有機會幫忙湊「不同時段回返 ≥3 次」與「首末跨 ≥1h」。
  // 落在夜間靜默窗（22:00–08:00）就順延到早上——回返提醒不該半夜響（合宜）。
  const dueTs = clampOutOfQuiet_(Date.now() + REMINDER_MIN_DELAY_MS + Math.random() * (REMINDER_MAX_DELAY_MS - REMINDER_MIN_DELAY_MS));
  const key = `${REMINDER_KEY_PREFIX}${scope.key}::${cid}`;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
    scopeKey: scope.key, scopeType: scope.type, scopeId: scope.id,
    contextId: cid, dueTs: dueTs, label: label || ''
  }));
  return dueTs;
}

/** 這條脈絡是否已排入回返提醒（未到期才算）。回 {dueTs,...} 或 null。卡片用來顯示「已排入提醒」、
 *  避免重複點按浪費 push。 */
function getCandidateReminder_(scope, cid) {
  if (!scope || !scope.key || !cid) return null;
  try {
    const v = PropertiesService.getScriptProperties().getProperty(`${REMINDER_KEY_PREFIX}${scope.key}::${cid}`);
    if (!v) return null;
    const r = JSON.parse(v);
    return (r && r.dueTs) ? r : null;
  } catch (_) { return null; }
}

/** 取消某條脈絡的回返提醒（升格後／改歸後不需再提醒回來寫）。 */
function clearCandidateReminder_(scope, cid) {
  if (!scope || !scope.key || !cid) return;
  try { PropertiesService.getScriptProperties().deleteProperty(`${REMINDER_KEY_PREFIX}${scope.key}::${cid}`); } catch (_) {}
}

/** Push any due 回返 reminders and delete their entries. Called from
 *  backgroundSweep once per sweep (cheap — scans script-properties once).
 *  也順手「提醒前自動取消」：掃到的提醒若其脈絡已升格(非 candidate)或已不存在，直接刪掉、
 *  不等到期——免得回來寫的提醒在升格後還照推（浪費 push、語意也錯）。 */
function sweepDueReminders_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  const ctxCache = {};   // scopeKey → contexts[]（同 scope 只讀一次）
  const ctxFor = (r) => {
    if (!(r.scopeKey in ctxCache)) {
      try { ctxCache[r.scopeKey] = loadContexts_({ type: r.scopeType, id: r.scopeId, key: r.scopeKey }); }
      catch (_) { ctxCache[r.scopeKey] = null; }
    }
    return ctxCache[r.scopeKey];
  };
  for (const k in all) {
    if (k.indexOf(REMINDER_KEY_PREFIX) !== 0) continue;
    let r;
    try { r = JSON.parse(all[k]); } catch (_) { props.deleteProperty(k); continue; }
    if (!r || !r.dueTs) { try { props.deleteProperty(k); } catch (_) {} continue; }

    // 〔提醒前自動取消〕脈絡已升格(不再 candidate)或不存在 → 取消這則提醒（不論到期與否）。
    let label = r.label || '';
    if (r.scopeType === 'user' && r.scopeId) {
      const ctxs = ctxFor(r);
      if (ctxs) {
        const c = ctxs.find(x => x.id === r.contextId);
        if (!c || c.status !== 'candidate') { try { props.deleteProperty(k); } catch (_) {} continue; }
        label = c.userTitle || c.label || label;
      }
    }

    if (r.dueTs > now) continue;   // 還沒到期、且仍是 candidate → 留著等下次掃描

    // 〔合宜〕到期但落在夜間靜默窗 → 順延到早上、不在半夜推（不刪、改 dueTs 留著）。
    if (inQuietHours_(now)) {
      r.dueTs = clampOutOfQuiet_(now);
      try { props.setProperty(k, JSON.stringify(r)); } catch (_) {}
      continue;
    }

    if (r.scopeType === 'user' && r.scopeId) {
      const rscope = { type: r.scopeType, id: r.scopeId, key: r.scopeKey, userId: r.scopeId };
      // 總開關/全域冷卻：這輪先別推就留著（dueTs 已過、下輪會再被掃到），不丟失。
      if (!proactivePushAllowed_(rscope)) continue;
      try {
        linePushFlex_(r.scopeId,
          `📅 提醒：回來補一筆撐「${truncate_(label, 22)}」`,
          buildCandidateRemindBubble_(r.contextId, label));
        markProactivePush_(rscope);
      } catch (e) { console.warn('reminder push failed:', e && e.message); }
    }
    try { props.deleteProperty(k); } catch (_) {}
  }
}

/** 回返提醒的 Flex 卡：點按鈕直接進該脈絡的「補一筆」模式（ctx_supp_cand），
 *  不必再自己去 /themes 找——回應「點選連結直接連到可補寫的地方」。 */
function buildCandidateRemindBubble_(cid, label) {
  const tier = THEME.depth.l2;
  const topic = truncate_(label || '這條脈絡', 22);
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: '📅 回返提醒', size: 'xs', color: tier.headerSub },
        { type: 'text', text: topic, size: 'lg', weight: 'bold', color: tier.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: [
        { type: 'text', text: '這條進行中脈絡就差「不同時段再回來寫一筆」，就能撐到候選歷程。', size: 'sm', color: THEME.textBody, wrap: true },
        { type: 'text', text: '現在正是不同時段——點下面直接補一筆，當場重判三條件。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'sm' }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '回來補一筆',
          data: `action=ctx_supp_cand&cid=${cid}`, displayText: opEcho_('回來補一筆', label) },
        contents: [{ type: 'text', text: '✏️ 回來補一筆（算一次回返）', size: 'sm', color: THEME.ctaText, align: 'center', weight: 'bold' }]
      }]
    }
  };
}

function handleCandidateRemind_(ev, scope, cid) {
  const c = loadContexts_(scope).find(x => x.id === cid);
  if (!c) return lineReply_(ev.replyToken, '這條脈絡已更新，請重新 /themes。');
  const nm = truncate_(c.userTitle || c.label || '', 20);
  // 已升格就不用提醒回來寫了（從舊卡點到也擋下）。
  if (c.status !== 'candidate') return lineReply_(ev.replyToken, `「${nm}」已經升格了，不用再提醒回來寫囉。`);
  // 已排過提醒就不重排（避免重複點按改掉時間、浪費 push）。
  const existing = getCandidateReminder_(scope, cid);
  if (existing && existing.dueTs > Date.now()) {
    const had = Utilities.formatDate(new Date(existing.dueTs), TIME_ZONE, 'MM/dd HH:mm');
    return lineReply_(ev.replyToken, `🔔 這條已經排好提醒了——約 ${had} 會通知你回來寫，不用重排。`);
  }
  const dueTs = saveCandidateReminder_(scope, cid, c.userTitle || c.label || '');
  const dueLabel = Utilities.formatDate(new Date(dueTs), TIME_ZONE, 'MM/dd HH:mm');
  return lineReply_(ev.replyToken,
    `🔔 好，之後再提醒你——約 ${dueLabel} 會推一則通知（特地隔開一段時間，你回來寫時就算一次新的回返），撐「${nm}」。`);
}

/** 背景智慧合併通知卡上的「↩️ 取消這次合併」：呼叫 undoJourneyMerge_ 還原，回一則確認。 */
function handleMergeUndo_(ev, scope, token) {
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 15); } catch (_) {} }
  let res;
  try { res = undoJourneyMerge_(scope, token); }
  catch (e) { console.warn('handleMergeUndo_ failed:', e && e.message); return lineReply_(ev.replyToken, '取消時出了點狀況，請稍後再試一次。'); }
  if (!res || !res.ok) {
    return lineReply_(ev.replyToken, '這次合併已無法取消（可能已取消過、或保留資料已過期）。要分開可到該主題詳情手動改歸。');
  }
  const from = res.targetTitle ? `從歷程「${res.targetTitle}」` : '從該歷程';
  if (res.forcedSplit) {
    return lineReply_(ev.replyToken,
      `↩️ 已取消合併並徹底分開（${res.n} 筆）：因為「${res.candTitle}」和目標${from}是同名主題，純還原會被自動聚回，所以已把它獨立改名為「${res.forcedSplit}」、並記住不再聚回。\n查證：到 /themes 該大類就能看到「${res.forcedSplit}」自成一條。`);
  }
  return lineReply_(ev.replyToken,
    `↩️ 已取消合併：把「${res.candTitle}」${from}移回、還原成原本的主題（${res.n} 筆），背景之後也不會再自動把它併回這條。\n查證：開那條歷程的「歷程現況」，「🔀 背景併入的主題」清單裡已不會再有「${res.candTitle}」。`);
}

/**
 * 記寫回執：寫了一段、停筆 settle 後，若這段「夠量＋夠集中＋已歸入一條進行中脈絡(candidate)」
 * → 推一張「你剛寫的這段被怎麼處理了」卡。背景 sweep 呼叫（per scope）。
 * 設計：1對1；按 episode startTs 去重（meta.lastReceiptEpisodeStart）；保守門檻；只報正面結果
 * （太零散/還沒成形 → 不推也不標記，留待下輪；有新段時這段自然不再是最新段）。context/候選歷程
 * 與 journey/學習歷程 的升格由 notifyNewUpgrades_ 負責——這裡只認 candidate，避免雙推。
 */
function maybePushWriteReceipt_(scope) {
  if (!RECEIPT_ENABLED) return;
  if (!scope || scope.type !== 'user' || !scope.id) return;
  const all = loadEmbeddingRecords_(scope)
    .filter(r => r && r.ts && r.embedding && r.embedding.length === EMBED_DIM);
  if (all.length < RECEIPT_MIN_RECORDS) return;
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const eps = groupByEpisode_(all, EPISODE_GAP_MS);
  const burst = eps.length ? eps[eps.length - 1] : null;            // 最新一段
  if (!burst || burst.records.length < RECEIPT_MIN_RECORDS) return;
  if (Date.now() - burst.endTs < RECEIPT_SETTLE_MS) return;         // 心流還沒停
  if (loadChatMeta_(scope).lastReceiptEpisodeStart === burst.startTs) return;  // 已回執

  // 集中度（群內平均 cos）；太零散 → 不報（只報正面）。
  const density = avgPairwiseCosine_(burst.records.map(r => r.embedding), 2000);
  if (density < RECEIPT_DENSITY_MIN) return;

  // 正面歸戶：這段 ≥ 半數記錄落在「同一條進行中脈絡(candidate)」。還沒成形 → 不報、不標記
  // （留待下輪；多半下一輪背景分群跑完就有）。
  const burstIds = {}; burst.records.forEach(r => { burstIds[r.id] = 1; });
  let best = null, bestN = 0;
  for (const c of loadContexts_(scope)) {
    let hit = 0; for (const id of (c.recordIds || [])) if (burstIds[id]) hit++;
    if (hit > bestN) { bestN = hit; best = c; }
  }
  if (!best || best.status !== 'candidate') return;
  if (bestN < Math.ceil(burst.records.length * RECEIPT_DOMINANT_FRACTION)) return;

  // 〔更安靜・只報高價值〕只在這段歸入的脈絡「接近升格」（三條件達標數 ≥ 門檻＝差一條件）才回執；
  // 純整理好但離成形還遠的不打擾、也不標記（留待後輪、有進展再說）。
  const cr = best.criteria || {};
  const C = CONTEXT_CRITERIA;
  const metCount = (densityConditionMet_(cr) ? 1 : 0)
    + (((cr.returnVisits || 0) >= C.returnVisitsMin && (cr.returnSpanHours || 0) >= C.returnSpanHoursMin) ? 1 : 0)
    + (((cr.mediaKinds || 0) >= C.mediaKindsMin) ? 1 : 0);
  if (metCount < RECEIPT_NEAR_UPGRADE_MIN_CONDITIONS) return;
  if (!proactivePushAllowed_(scope)) return;   // 〔合宜〕靜默窗/總開關/全域冷卻 → 這輪先別推、別 claim 本段，下輪再評估

  try {
    linePushFlex_(scope.id,
      `📋 剛剛這段：歸到「${truncate_(best.userTitle || best.label || '主題', 16)}」（差一步成形）`,
      buildWriteReceiptBubble_(burst, density, best, bestN));
  } catch (e) { console.warn('write receipt push failed:', e && e.message); return; }
  markProactivePush_(scope);
  updateChatMeta_(scope, m => { m.lastReceiptEpisodeStart = burst.startTs; return m; });
}

/** 記寫回執卡：你剛寫的這段（HH:MM–HH:MM・N 筆）被歸到哪、形成/併入哪條進行中脈絡、
 *  集中度＋媒介＋這段的記寫時間分布；一顆「看歸到的主題」直達導覽卡＋瀏覽卡。 */
function buildWriteReceiptBubble_(burst, density, ctx, hitN) {
  const tier = THEME.depth.l2;
  const recs = burst.records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const n = recs.length;
  const range = `${Utilities.formatDate(new Date(burst.startTs), TIME_ZONE, 'MM/dd HH:mm')}–${Utilities.formatDate(new Date(burst.endTs), TIME_ZONE, 'HH:mm')}`;
  const title = ctx.userTitle || ctx.label || '主題';
  const cat = themeNormCategory_(ctx.category);
  const catLabel = cat ? `${THEME_CATEGORY_ICON[cat] || '🗄️'} ${cat}｜${truncate_(title, 16)}` : truncate_(title, 16);

  // candidate 是這段新形成，還是併入既有？這段佔該脈絡幾乎全部 → 新形成。
  const total = (ctx.recordIds || []).length;
  const stateText = (hitN >= total) ? '🌱 形成一條新的進行中脈絡（還在累積三條件）'
                                    : '🌱 併入進行中脈絡（還在累積三條件）';

  const comp = {};
  recs.forEach(r => { comp[r.type] = (comp[r.type] || 0) + 1; });
  const compStr = Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ') || '—';
  const densLabel = density >= 0.72 ? '高' : (density >= 0.64 ? '中' : '尚可');

  const infoRow = (k, v, color) => ({
    type: 'box', layout: 'baseline', spacing: 'sm', margin: 'xs', contents: [
      { type: 'text', text: k, size: 'xs', color: THEME.muted, flex: 0 },
      { type: 'text', text: v, size: 'xs', color: color || THEME.textBody, weight: color ? 'bold' : 'regular', wrap: true, flex: 1 }
    ]
  });
  const body = [
    { type: 'text', text: `你剛寫的這段（${n} 筆）已自動處理：`, size: 'sm', color: THEME.text, wrap: true },
    infoRow('歸類', catLabel, THEME.cta),
    infoRow('脈絡', stateText),
    infoRow('集中', `這段語意集中度 ${densLabel}（${density.toFixed(2)}）・媒介 ${compStr}`)
  ];
  // 〔資訊更完整〕這條脈絡整體規模 + 三條件進度 + 還缺什麼（回執只在「差一條件」時推，故這裡一眼看到差哪條）。
  const span = spanLabel_(ctx.firstTs, ctx.lastTs);
  body.push(infoRow('整體', `這條脈絡共 ${total} 筆${span ? '・' + span : ''}`));
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: '離成形（候選歷程）的三條件：', size: 'xxs', color: THEME.muted });
  body.push(criteriaStatusRow_(ctx.criteria || {}));
  const hint = criteriaHintText_(ctx, null);
  if (hint) body.push({ type: 'text', text: hint, size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  if (burst.endTs > burst.startTs) {
    body.push({ type: 'separator', margin: 'md' });
    body.push(episodeTimelineStrip_({
      startTs: burst.startTs, endTs: burst.endTs, records: recs,
      headText: `這段的記寫時間分布 · ${range}`
    }));
  }

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [
        { type: 'text', text: `📋 剛剛這段 · ${range}`, size: 'xs', color: tier.headerSub, wrap: true },
        { type: 'text', text: truncate_(title, 22), size: 'lg', weight: 'bold', color: tier.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{
        type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
        action: { type: 'postback', label: '看歸到的主題', data: `action=theme_topic&cid=${ctx.id}`, displayText: opEcho_('看歸到的主題', title) },
        contents: [{ type: 'text', text: '📂 看歸到的主題（含敘事片段）', size: 'sm', color: THEME.ctaText, align: 'center', weight: 'bold' }]
      }]
    }
  };
}

/** 記寫延續提醒（c·統一框架）：偵測到你「又回到某條非歷程的線」、停筆 settle 後，輕推一則，
 *  ask 隨這條線「下一步缺什麼」自動切（都軟）：
 *    - 進行中脈絡 candidate（缺回返）→ 鼓勵延續：「回來累積幾筆就會成形」
 *    - 候選歷程 context（缺轉折）   → 軟邀轉折：「接著寫下新想法，常會自然冒出新連結/轉折」
 *    - 學習歷程 journey            → 不吵
 *  1對1、每脈絡每日最多一次＋全域節流、可永久關。⚠ production：只對「剛剛的回返」推（FRESH 上限）。
 *  與記寫回執/聚焦共用「每段一次」去重（回執先跑先 claim，本函式不重推，避免雙推）。 */
function maybePushContinuityNudge_(scope) {
  if (!RETURN_INVITE_ENABLED) return;
  if (!scope || scope.type !== 'user' || !scope.id) return;
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts);
  if (all.length < 2) return;
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const recById = {}; all.forEach(r => { recById[r.id] = r; });
  const eps = groupByEpisode_(all, EPISODE_GAP_MS);
  const burst = eps.length ? eps[eps.length - 1] : null;          // 最近一段
  if (!burst) return;
  const sinceEnd = Date.now() - burst.endTs;
  if (sinceEnd < RETURN_INVITE_SETTLE_MS) return;                 // 心流還沒停
  if (sinceEnd > RETURN_INVITE_FRESH_MS) return;                  // 太舊：不回頭翻舊資料推

  // 這次回來的記錄主要落在哪條脈絡（dominant）。
  const burstIds = {}; burst.records.forEach(r => { burstIds[r.id] = 1; });
  let best = null, bestN = 0;
  for (const c of loadContexts_(scope)) {
    let hit = 0; for (const id of (c.recordIds || [])) if (burstIds[id]) hit++;
    if (hit > bestN) { bestN = hit; best = c; }
  }
  if (!best || best.status !== 'context') return;                // 只針對候選歷程（差一個轉折）
  const jrn = loadJourneys_(scope).find(j => j.contextId === best.id);
  if (jrn && jrn.status === 'journey') return;                    // 已是學習歷程，不吵

  // 「有意義的回返」：這條上次記寫（排除本次 burst）距本段開始 ≥ GAP。
  let prevTs = 0;
  for (const id of (best.recordIds || [])) {
    if (burstIds[id]) continue;
    const r = recById[id]; if (!r) continue;
    const t = Date.parse(r.ts); if (!isNaN(t) && t > prevTs && t < burst.startTs) prevTs = t;
  }
  if (!prevTs || burst.startTs - prevTs < RETURN_INVITE_GAP_MS) return;

  // 去重／靜音：與記寫回執共用「每段一次」（回執先跑、先 claim 本段就不重推）；每脈絡每日一次＋全域節流。
  const meta = loadChatMeta_(scope);
  if ((meta.returnInviteMuted || {})[best.id]) return;
  if (meta.lastReceiptEpisodeStart === burst.startTs) return;
  if (meta.lastReturnInviteEpisodeStart === burst.startTs) return;
  if (Date.now() - ((meta.returnInviteAt || {})[best.id] || 0) < RETURN_INVITE_COOLDOWN_MS) return;
  if (Date.now() - (meta.lastContinuityNudgeAt || 0) < RETURN_INVITE_GLOBAL_COOLDOWN_MS) return;
  if (!proactivePushAllowed_(scope)) return;   // 〔合宜〕靜默窗/總開關/全域冷卻 → 這輪先別推、別 claim，下輪再評估

  const gapLabel = reportGapCompact_(burst.startTs - prevTs);
  const icon = best.status === 'context' ? '🌿' : '🌱';
  try {
    linePushFlex_(scope.id,
      `${icon} 你又回到「${truncate_(best.userTitle || best.label || '主題', 16)}」了（${gapLabel}）`,
      buildContinuityNudgeBubble_(best, gapLabel));
  } catch (e) { console.warn('continuity nudge push failed:', e && e.message); return; }
  markProactivePush_(scope);

  updateChatMeta_(scope, m => {
    m.returnInviteAt = m.returnInviteAt || {};
    m.returnInviteAt[best.id] = Date.now();
    m.lastReturnInviteEpisodeStart = burst.startTs;
    m.lastContinuityNudgeAt = Date.now();
    return m;
  });
}

/** 記寫延續提醒卡（B·只候選歷程）：直接就是「轉折形成卡」——點明差一個轉折、列四種轉折、一鍵補轉折。 */
function buildContinuityNudgeBubble_(ctx, gapLabel) {
  const title = ctx.userTitle || ctx.label || '主題';
  const btn = (label, data, primary) => ({
    type: 'box', layout: 'vertical', margin: 'sm',
    backgroundColor: primary ? THEME.cta : THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm',
    action: { type: 'postback', label: label, data: data, displayText: opEcho_(label, title) },
    contents: [{ type: 'text', text: label, size: 'sm', weight: 'bold', align: 'center', color: primary ? THEME.ctaText : THEME.cta }]
  });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        { type: 'text', text: `🌿 又回到這條了（${gapLabel}）`, size: 'xs', color: THEME.ctaText },
        { type: 'text', text: truncate_(title, 22), size: 'lg', weight: 'bold', color: THEME.ctaText, wrap: true, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: [
        { type: 'text', text: '這條已是候選歷程，就差一個「轉折」就升學習歷程。', size: 'sm', color: THEME.text, wrap: true },
        { type: 'text', text: '轉折＝概念重述／跨主題整合／行動指向／後設反思 任一種，寫一句真實的想法就算。', size: 'xxs', color: THEME.muted, wrap: true }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [
        btn('🔭 補一個轉折', `action=ctx_supplement&cid=${ctx.id}`, true),
        btn('🔕 這條別再提醒', `action=return_invite_mute&cid=${ctx.id}`, false)
      ]
    }
  };
}

/** 聚焦偵測（停筆後推版）：最近一段停筆 settle 後，純向量重算四指標（夠筆×聚焦×具體×不雜），
 *  跨門檻就推一則 🎯「這段夠具體聚焦」。零 LLM。寫當下不出聲（無痕靜默），只在停筆後推；
 *  只對「剛剛這段」推（沿用 3h 新鮮窗、不翻舊資料）。與記寫回執／回返邀請共用「每段一次」去重
 *  （那兩者在 sweep 中先跑、先 claim 本段；本函式只在它們沒推時才推）。 */
function maybePushFocusSettled_(scope) {
  if (!FOCUS_DETECT_ENABLED) return;
  if (!scope || scope.type !== 'user' || !scope.id) return;
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts && r.embedding && r.embedding.length === EMBED_DIM);
  if (all.length < FOCUS_MIN_N) return;
  all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const eps = groupByEpisode_(all, EPISODE_GAP_MS);
  const burst = eps.length ? eps[eps.length - 1] : null;
  if (!burst) return;
  const sinceEnd = Date.now() - burst.endTs;
  if (sinceEnd < RECEIPT_SETTLE_MS) return;                 // 心流還沒停
  if (sinceEnd > RETURN_INVITE_FRESH_MS) return;            // 太舊：不回頭翻舊資料
  const recs = burst.records;
  if (recs.length < FOCUS_MIN_N) return;
  // 每段一次：與記寫回執／回返邀請共用去重（前兩者先跑、先 claim）。
  const meta = loadChatMeta_(scope);
  if (meta.lastReceiptEpisodeStart === burst.startTs) return;
  if (meta.lastReturnInviteEpisodeStart === burst.startTs) return;
  if (meta.lastFocusEpisodeStart === burst.startTs) return;
  // 四指標（批次重算，與舊串流版同尺）。
  const embs = recs.map(r => r.embedding);
  const density = avgPairwiseCosine_(embs, 2000);
  if (density == null || density < FOCUS_DENSITY_GATE) return;
  const avgLen = recs.reduce((s, r) => s + ((r.text || '').trim().length), 0) / recs.length;
  if (avgLen < FOCUS_LEN_FLOOR) return;
  const centroid = meanVector_(embs);
  let nLowFit = 0;
  for (const r of recs) if (cosineSim_(r.embedding, centroid) < FOCUS_FIT_FLOOR) nLowFit++;
  const coreFrac = (recs.length - nLowFit) / recs.length;
  if (coreFrac < FOCUS_CORE_FRAC) return;

  const range = `${Utilities.formatDate(new Date(burst.startTs), TIME_ZONE, 'HH:mm')}–${Utilities.formatDate(new Date(burst.endTs), TIME_ZONE, 'HH:mm')}`;
  try {
    linePush_(scope.id,
      `🎯 你剛寫的這段（${range}・${recs.length} 筆）夠「具體聚焦」了\n` +
      `聚焦度 ${density.toFixed(2)}（核心 ${recs.length - nLowFit}/${recs.length}）・平均 ${Math.round(avgLen)} 字\n` +
      `背景正在歸類；之後 /themes 或 /journey 看它落在哪條脈絡。`);
  } catch (e) { console.warn('focus settle push failed:', e && e.message); return; }
  updateChatMeta_(scope, m => { m.lastFocusEpisodeStart = burst.startTs; return m; });
}

const SEARCH_MAX_RESULTS = 200;
const SEARCH_MIN_SCORE = 0.6;   // default threshold; users can broaden / narrow via on-empty Quick Reply
const SEARCH_THRESHOLD_STEP = 0.05;  // how much 擴大 / 縮小 shifts the threshold

/**
 * Cards per page, scaled to the total result count: small result sets get
 * a light page that's easy to scan on a phone, large sets pack more per
 * page so you don't paginate forever. Capped at 10 (LINE carousel allows
 * 12 bubbles, leaving headroom for the layout).
 */
function searchPageSize_(total) {
  if (total <= 8) return 4;
  if (total <= 30) return 6;
  return 10;
}

/**
 * Pack pre-rendered Flex bubbles into pages so each page's carousel JSON stays
 * under LINE's 50KB carousel cap. Starts at searchPageSize_(total) cards per
 * page and shrinks if any page would overflow. Returns the requested page's
 * cards plus the effective pageSize/totalPages.
 *
 * /themes & /journey cards each carry a 24-cell timeline strip (~5KB per
 * card); at 10 cards/page the carousel blew past 50KB and LINE rejected the
 * message ("Too large flex message"). This helper packs deterministically so
 * pagination is stable across page hops.
 *
 * Critically, LINE's cap is on UTF-8 *bytes*, not JS string length. A Chinese
 * char is 1 UTF-16 unit in JS but 3 bytes in UTF-8 — measuring `.length` would
 * undercount by ~3× on CJK-heavy bodies, leaving the pager confident a 120KB
 * payload fit.
 */
function utf8ByteLength_(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c < 0xDC00) { n += 4; i++; }  // surrogate pair
    else n += 3;
  }
  return n;
}

function paginateFlexCards_(cards, page) {
  const total = cards.length;
  if (total === 0) return { pageCards: [], pageSize: 0, totalPages: 0, page: 0 };
  const SAFE_LIMIT = 48 * 1024;  // 50KB carousel cap, 2KB headroom for envelope
  const ENVELOPE = 32;           // {"type":"carousel","contents":[...]}
  const sizes = cards.map(c => utf8ByteLength_(JSON.stringify(c)));
  const fitsAt = sz => {
    for (let s = 0; s < sizes.length; s += sz) {
      let bytes = ENVELOPE;
      const end = Math.min(sizes.length, s + sz);
      for (let i = s; i < end; i++) bytes += sizes[i] + 1;  // +1 for comma
      if (bytes > SAFE_LIMIT) return false;
    }
    return true;
  };
  let pageSize = Math.min(total, searchPageSize_(total));
  while (pageSize > 1 && !fitsAt(pageSize)) pageSize--;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.max(0, Math.min(totalPages - 1, parseInt(page, 10) || 0));
  return {
    pageCards: cards.slice(p * pageSize, (p + 1) * pageSize),
    pageSize, totalPages, page: p
  };
}

/** Page-number window: show all when ≤8 pages, else an 8-wide window. */
const SEARCH_PAGE_WINDOW = 8;
const SEARCH_THRESHOLD_FLOOR = 0.3;
const SEARCH_THRESHOLD_CEIL  = 0.9;

// Display threshold without redundant trailing zeros (0.50 → "0.5", 0.55 → "0.55").
function fmtThreshold_(x) { return (+x.toFixed(2)).toString(); }

/** Cache a query under a short key. Postback/quickReply data caps at 300 chars,
 *  and a URL-encoded CJK query (~3 chars each) blows past that — so we ship a
 *  short key in the data and resolve it back to the query on tap. */
function cacheQuery_(query) {
  const k = newId_().slice(0, 10);
  try { CacheService.getScriptCache().put('q_' + k, query, 21600); } catch (_) {}
  return k;
}
function loadCachedQuery_(k) {
  if (!k) return '';
  try { return CacheService.getScriptCache().get('q_' + k) || ''; } catch (_) { return ''; }
}

function replySearch_(ctx, query, page, threshold, opts) {
  page = page || 0;
  threshold = (threshold == null || isNaN(threshold)) ? SEARCH_MIN_SCORE : threshold;
  if (!query) return lineReply_(ctx.replyToken, '用法：/recall <關鍵字或一句話>');
  // Reached from a gap card (看相關片段)? Then /ask already failed for this query,
  // so don't offer 直接問這個 again — it would just loop back to the same gap.
  const suppressAsk = !!(opts && opts.suppressAsk);
  const qk = cacheQuery_(query);  // short key for postback data (300-char cap)
  const rawHits = topKByQuery_(ctx.scope, query, SEARCH_MAX_RESULTS);
  if (!rawHits.length) return lineReply_(ctx.replyToken, '沒有結果。');
  // Compare on the same 2-decimal value we display, so a score shown as equal
  // to the threshold is included (no "0.60 < 0.60" surprise from rounding).
  let allHits = rawHits.filter(h => Math.round(h.score * 100) / 100 >= threshold);
  // /recall lesson:X —— 後置過濾到該節課內的記錄（explorationId 是成員歸屬的單一真相）。
  if (opts && opts.explorationId) allHits = allHits.filter(h => h.record && h.record.explorationId === opts.explorationId);
  if (!allHits.length) {
    if (opts && opts.explorationId) {
      return lineReply_(ctx.replyToken, `「${opts.explorationLabel || '該課程'}」這節課裡沒有「${truncate_(query, 20)}」相關的記錄。`);
    }
    const topScore = rawHits[0].score.toFixed(2);
    const qr = noResultQuickReply_(query, threshold, qk);
    return lineReply_(ctx.replyToken,
      `沒有夠相關的結果\n最高相似度 ${topScore}，目前門檻 ${threshold.toFixed(2)}\n\n試試換個關鍵字，或：`,
      qr);
  }

  // 記錄框架（ask-gap「看相關記錄」）：直接列命中的原始記錄（按相似度），不分組成時間
  // episode——relevance 查詢該聚焦「命中的那幾筆」，不被同時段鄰居稀釋/誤導（episode 留給
  // /recall、/themes、/journey 等時間脈絡情境）。記錄卡本身就有「看完整內容」可再鑽 context。
  if (opts && opts.recordView) {
    const recPageSize = searchPageSize_(allHits.length);
    const recTotalPages = Math.ceil(allHits.length / recPageSize);
    if (page >= recTotalPages) page = recTotalPages - 1;
    if (page < 0) page = 0;
    const pageHits = allHits.slice(page * recPageSize, (page + 1) * recPageSize);
    const recBubbles = pageHits.map((h, i) =>
      buildSearchBubble_(h.record, h.score, page * recPageSize + i + 1, 0, null, null, { scope: ctx.scope, query: query, matchMeta: true }));
    const recContents = recBubbles.length === 1 ? recBubbles[0] : { type: 'carousel', contents: recBubbles };
    const recAlt = recTotalPages > 1
      ? `相關記錄「${query}」第 ${page + 1}/${recTotalPages} 頁（${allHits.length} 筆）`
      : `相關記錄「${query}」${allHits.length} 筆`;
    const qr = hasResultQuickReply_(query, threshold, qk, suppressAsk);
    const minParam = threshold != null ? `&min=${threshold.toFixed(2)}` : '';
    const messages = [{ type: 'flex', altText: recAlt, contents: recContents }];
    if (recTotalPages > 1) {
      const sq = query.length > 20 ? query.slice(0, 20) + '…' : query;
      const pTitle = `👉 相關記錄"${sq}"(${allHits.length} 筆 / ${recTotalPages} 頁)`;
      messages.push({
        type: 'flex',
        altText: `分頁（第 ${page + 1}/${recTotalPages} 頁）`,
        contents: buildPaginationBubble_(pTitle, page, recTotalPages, p => `action=search_page&qk=${qk}&p=${p}${minParam}&na=1&rv=1`),
        quickReply: qr
      });
    } else if (qr) {
      messages[0].quickReply = qr;
    }
    lineReplyMessages_(ctx.replyToken, messages);
    return;
  }

  // Group the matching records by their inquiry episode — 記寫脈絡's unit is
  // the moment, not the isolated capture. Each episode's relevance = its
  // highest-scoring matched record; same-episode hits collapse into one card
  // (no fragmented duplicates).
  const allRecords = loadEmbeddingRecords_(ctx.scope);
  const epIndex = indexEpisodes_(allRecords);
  const groups = {};
  for (const h of allHits) {
    const key = epIndex.keyByRecord[h.record.id];
    if (!key) continue;
    if (!groups[key]) groups[key] = { ep: epIndex.episodesByKey[key], score: 0, matched: [] };
    if (h.score > groups[key].score) groups[key].score = h.score;
    groups[key].matched.push(h);
  }
  const epHits = Object.keys(groups).map(k => groups[k]).sort((a, b) => b.score - a.score);
  if (!epHits.length) return lineReply_(ctx.replyToken, '沒有結果。');

  const pageSize = searchPageSize_(epHits.length);
  const totalPages = Math.ceil(epHits.length / pageSize);
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  const pageGroups = epHits.slice(page * pageSize, (page + 1) * pageSize);

  const bubbles = pageGroups.map((g, i) =>
    buildEpisodeSearchBubble_(g.ep, g.score, page * pageSize + i + 1, g.matched, g.ep._day, query));
  // 概覽卡併進輪播當第 0 張（每頁都帶，像 index=0 的標題頁）：回應使用者「不要獨立呈現、
  // 算入瀏覽卡的第一張」。≥2 筆命中才出（單筆不必概覽）。
  const overview = allHits.length >= 2
    ? recallOverviewBubble_(query, allHits, epHits.length, allRecords, threshold)
    : null;
  const finalBubbles = overview ? [overview].concat(bubbles) : bubbles;
  // Flex carousel needs ≥2 bubbles; for a single hit send the bubble directly.
  const resultContents = finalBubbles.length === 1
    ? finalBubbles[0]
    : { type: 'carousel', contents: finalBubbles };

  const altText = totalPages > 1
    ? `回想「${query}」第 ${page + 1}/${totalPages} 頁（${epHits.length} 個敘事片段）`
    : `回想「${query}」${epHits.length} 個敘事片段`;

  const qr = hasResultQuickReply_(query, threshold, qk, suppressAsk);
  const minParam = threshold != null ? `&min=${threshold.toFixed(2)}` : '';
  const naParam = suppressAsk ? '&na=1' : '';
  // Name why the net looks wider/narrower than a plain /recall (e.g. 看相關片段
  // enters at 0.35), so the same tool reading differently isn't confusing.
  const tNote = threshold < SEARCH_MIN_SCORE ? '（已放寬）' : (threshold > SEARCH_MIN_SCORE ? '（已收緊）' : '');
  const tPrefix = threshold != null ? `t=${threshold.toFixed(2)}${tNote} ` : '';
  const shortQuery = query.length > 20 ? query.slice(0, 20) + '…' : query;
  const pagerTitle = `${tPrefix}👉 回想"${shortQuery}"(${epHits.length} 敘事片段 / ${totalPages} 頁)`;
  const messages = [];
  messages.push({ type: 'flex', altText, contents: resultContents });
  messages.push({
    type: 'flex',
    altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
    contents: buildPaginationBubble_(pagerTitle, page, totalPages, p => `action=search_page&qk=${qk}&p=${p}${minParam}${naParam}`),
    quickReply: qr
  });
  lineReplyMessages_(ctx.replyToken, messages);
}

/**
 * /recall 結果列表上方的概覽卡：以 corpus-span strip 顯示「命中筆 vs 其他筆」在全語料
 * 時間軸的分布，配上「N 筆命中 / M 段 / 全 K 筆」摘要——讓使用者一眼掌握該關鍵字在
 * 記寫訊息流中的「成分與時段集中度」。純資訊卡、無 action。
 */
function recallOverviewBubble_(query, allHits, episodeCount, allRecords, threshold) {
  if (!allHits || !allHits.length || !allRecords || allRecords.length < 2) return null;
  const tsList = allRecords.map(r => Date.parse(r && r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (tsList.length < 2) return null;
  const corpusStart = tsList[0], corpusEnd = tsList[tsList.length - 1];
  const hitRecords = allHits.map(h => h.record).filter(Boolean);
  const mineIds = {}; hitRecords.forEach(r => { if (r.id) mineIds[r.id] = true; });
  const otherRecords = allRecords.filter(r => r && r.id && !mineIds[r.id]);
  const topScore = allHits[0] && allHits[0].score;
  const hitTs = hitRecords.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  const hitRange = hitTs.length >= 2 ? formatClusterRange_(hitTs[0], hitTs[hitTs.length - 1]) : (hitTs.length === 1 ? Utilities.formatDate(new Date(hitTs[0]), TIME_ZONE, 'MM/dd HH:mm') : '—');
  // 命中組成：整批結果多少字面命中、多少純語意相近（與卡片上的 🔤/🧠 同語彙）。
  let ovLit = 0, ovSem = 0;
  hitRecords.forEach(r => { matchSnippet_(r && r.text, query).matched ? ovLit++ : ovSem++; });
  const ovCompParts = [];
  if (ovLit) ovCompParts.push(`🔤 字詞 ${ovLit}`);
  if (ovSem) ovCompParts.push(`🧠 語意 ${ovSem}`);
  const tier = THEME.depth.l1;
  const body = [
    { type: 'text', text: `「${truncate_(query, 20)}」`, size: 'md', weight: 'bold', color: tier.title, wrap: true },
    { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm', contents: [
      { type: 'text', text: `${allHits.length}`, size: 'xl', weight: 'bold', color: THEME.cta, flex: 0 },
      { type: 'text', text: `筆命中 · ${episodeCount} 段 · 全 ${allRecords.length} 筆`, size: 'xxs', color: THEME.muted, flex: 1, wrap: true }
    ]},
    { type: 'text', text: `命中時段 ${hitRange}${typeof topScore === 'number' ? `　最高相似度 ${topScore.toFixed(2)}` : ''}${threshold != null ? `　門檻 ${threshold.toFixed(2)}` : ''}`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' },
    ...(ovCompParts.length ? [{ type: 'text', text: '命中組成 ' + ovCompParts.join('　·　'), size: 'xxs', color: THEME.depth.l1.accent, wrap: true, margin: 'xs' }] : []),
    { type: 'separator', margin: 'md' },
    episodeTimelineStrip_({
      startTs: corpusStart,
      endTs: corpusEnd,
      records: hitRecords,
      otherRecords: otherRecords,
      headText: `✓ 命中紀錄在「全部記寫 ${formatClusterRange_(corpusStart, corpusEnd)}」中的位置`,
      headPrefix: '回想命中'
    }),
    { type: 'text', text: '✓ 命中　● 同段其他　◯ 無紀錄', size: 'xxs', color: THEME.muted, align: 'center', margin: 'sm' }
  ];
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [{ type: 'text', text: '🔍 回想命中分布', size: 'sm', weight: 'bold', color: tier.headerText }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

/* ===== 命中內容呈現（置中開窗 + 高亮 + 命中訊號）=====
 * 痛點：搜尋結果舊版只截「前 N 字」，命中詞若在後面就看不到、看不出為何命中。
 * 這組 helper 把片段改成「以命中詞為中心開窗」並用 Flex span 高亮命中詞；純語意命中
 * （無字面詞）退回前綴。命中訊號 🔤字詞/🧠語意 與相關度（高/中/低）讓「為何命中」一眼可讀。 */

/** 以命中詞為中心，從 text 開一個長度 ≈maxLen 的視窗。
 *  回 { matched:true, pre, mid, post }（mid＝命中詞，前後帶 … 表示有截斷）
 *  或 { matched:false, plain }（純語意命中／無 query → 退回前綴）。 */
function matchSnippet_(text, query, maxLen) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  maxLen = maxLen || 80;
  if (!clean) return { matched: false, plain: '(無內容)' };
  const q = String(query || '').trim().toLowerCase();
  let idx = -1, termLen = 0;
  if (q) {
    const lc = clean.toLowerCase();
    idx = lc.indexOf(q);
    if (idx >= 0) termLen = q.length;
    else {  // 整句找不到 → 用空白切詞找最先出現的（中英混合查詢友善）
      const toks = q.split(/\s+/).filter(t => t.length >= 1);
      for (const t of toks) { const i = lc.indexOf(t); if (i >= 0) { idx = i; termLen = t.length; break; } }
    }
  }
  if (idx < 0) return { matched: false, plain: truncate_(clean, maxLen) };   // 純語意命中：前綴
  const ctxLen = Math.max(0, maxLen - termLen);
  let start = Math.max(0, idx - Math.floor(ctxLen / 2));
  let end = Math.min(clean.length, start + maxLen);
  start = Math.max(0, end - maxLen);   // 末端不足時回拉，吃滿視窗
  return {
    matched: true,
    pre: (start > 0 ? '…' : '') + clean.slice(start, idx),
    mid: clean.slice(idx, idx + termLen),
    post: clean.slice(idx + termLen, end) + (end < clean.length ? '…' : '')
  };
}

/** 把 matchSnippet_ 的結果渲染成一個 Flex text 元件：命中時用 span 高亮命中詞（變色＋粗體），
 *  否則純文字。opts: { size, color, hlColor, iconColor, maxLines, margin, icon } */
function snippetComponentFromMatch_(m, opts) {
  opts = opts || {};
  const base = opts.color || THEME.text;
  const hl = opts.hlColor || THEME.cta;
  const icon = opts.icon ? opts.icon + ' ' : '';
  const comp = { type: 'text', wrap: true, size: opts.size || 'xs', color: base };
  if (opts.maxLines) comp.maxLines = opts.maxLines;
  if (opts.margin) comp.margin = opts.margin;
  if (!m.matched) { comp.text = icon + (m.plain || ''); return comp; }
  const spans = [];
  if (icon) spans.push({ type: 'span', text: icon, color: opts.iconColor || THEME.muted });
  if (m.pre) spans.push({ type: 'span', text: m.pre, color: base });
  spans.push({ type: 'span', text: m.mid, color: hl, weight: 'bold' });
  if (m.post) spans.push({ type: 'span', text: m.post, color: base });
  comp.contents = spans;
  comp.text = icon + m.pre + m.mid + m.post;   // 純文字 fallback（有 contents 時 LINE 取 contents）
  return comp;
}

/** 相對相關度標籤（裸 cos 分數沒語意，補一個直覺判讀）。回 {text,color} 或 null。 */
function relevanceLabel_(score) {
  if (typeof score !== 'number') return null;
  if (score >= 0.80) return { text: '高相關', color: THEME.success };
  if (score >= 0.62) return { text: '中相關', color: THEME.cta };
  return { text: '低相關', color: THEME.muted };
}

/** 命中訊號列：🔤 字詞命中 / 🧠 語意相近 ＋ 相關度標籤。matched 由 matchSnippet_ 推導。 */
function matchMetaComponent_(matched, score, margin) {
  const spans = [{
    type: 'span', text: matched ? '🔤 字詞命中' : '🧠 語意相近',
    color: matched ? THEME.cta : THEME.depth.l1.accent, weight: 'bold'
  }];
  const rel = relevanceLabel_(score);
  if (rel) {
    spans.push({ type: 'span', text: '　·　', color: THEME.muted });
    spans.push({ type: 'span', text: rel.text, color: rel.color, weight: 'bold' });
  }
  const comp = { type: 'text', wrap: true, size: 'xxs',
    contents: spans, text: (matched ? '字詞命中' : '語意相近') + (rel ? ' ' + rel.text : '') };
  if (margin) comp.margin = margin;
  return comp;
}

/**
 * Slim-tall search bubble matching the user's sweethome-style reference.
 *   hero (only for image/video) — Drive thumbnail
 *   header (light blue) — No.<idx> + green separator + type icon + score
 *   body (white)        — snippet
 *   footer (light yellow) — full timestamp + tappable green CTA box
 */
// 執行期快取 owner 的 linkIntent：buildSearchBubble_ 在列表中逐卡呼叫，避免每卡重讀 meta。
var _ownerLinkIntentCache;
function ownerLinkIntent_() {
  if (_ownerLinkIntentCache !== undefined) return _ownerLinkIntentCache;
  try { _ownerLinkIntentCache = (loadChatMeta_(ownerScope_()) || {}).linkIntent || {}; }
  catch (_) { _ownerLinkIntentCache = {}; }
  return _ownerLinkIntentCache;
}

/** LINE URI action 防呆：回傳可安全放進 action.uri 的字串，否則 null（呼叫端略過該 action，
 *  避免一個壞網址讓整則 Flex 被 LINE 退 400「Invalid action URI」）。LINE 規則：要有
 *  http(s)/tel/mailto/line scheme、不能有空白、長度 ≤ 1000。順手砍掉被中文標點黏住的尾巴。 */
function safeActionUri_(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const u = uri.trim().replace(/[，。、；！？,.;!?]+$/, '');   // 砍尾端句讀（不砍 ) ] 以免誤傷網址內括號，如維基）
  if (!u || u.length > 1000) return null;
  if (/[^\x21-\x7e]/.test(u)) return null;   // 只允許可見 ASCII：有空白/中文＝抽取雜訊或 LINE 不收 → 寧可不掛
  if (!/^(https?:\/\/|tel:|mailto:|line:\/\/)/i.test(u)) return null;
  return u;
}

function buildSearchBubble_(record, score, idx, suppCount, quotedTarget, strip, opts) {
  const dateLong = Utilities.formatDate(new Date(record.ts), TIME_ZONE, 'yyyy/MM/dd HH:mm:ss');
  const snippet = truncate_((record.text || '').replace(/\s+/g, ' '), 80) || '(無內容)';
  const ext = extractExtensionLabel_(record);
  // 外部連結記錄：以新入庫型別 type:'link' 為準（舊紀錄退回「文字含網址」判定）。純文字
  // （無網址）一律不是連結。連結記錄顯示「外部連結」並掛「🔗 開啟連結」（收藏/學習素材切換已取消）。
  const isLinkRec = record.type === 'link' || /https?:\/\/\S/.test(record.text || '');
  // 外部連結記錄的可點 URL：優先用 urlPreview.url，否則從原文抽第一個 http(s) 網址。
  const linkUri = isLinkRec
    ? safeActionUri_((record.urlPreview && record.urlPreview.url) || ((record.text || '').match(/https?:\/\/[\x21-\x7e]+/) || [null])[0])
    : null;
  const typeIcon = isLinkRec ? '🔗' : ({ text: '📝', image: '🖼️', audio: '🎤', video: '🎬', file: '📄', sticker: '😀', location: '📍' }[record.type] || '📌');
  // 折進貼圖情緒的卡：型別標「文字＋貼圖／圖片＋貼圖…」，一眼看出這則內容帶當下心情。
  const _hasEmo = !!(((record.reactions || []).length) || ((record._emotions || []).length));
  const typeFull = (isLinkRec ? '外部連結' : `${typeLabel_(record.type)}${ext ? ' ' + ext : ''}`) + (_hasEmo ? '＋貼圖' : '');
  // Quote-reply context badges: this record is a supplement to something
  // older, and/or this record has been supplemented by something newer.
  // Both surface in the body so a search result reads as part of a thread,
  // not an isolated note.
  // 命中內容呈現：有 query 時以命中詞為中心開窗＋高亮（snippetComponentFromMatch_）；
  // recall（matchMeta）再於片段上方加一行命中訊號 🔤/🧠 ＋ 相關度。其他呼叫端（無 query）維持前綴。
  const _m = (opts && opts.query) ? matchSnippet_(record.text, opts.query, 80) : null;
  const snippetComp = _m
    ? snippetComponentFromMatch_(_m, { size: 'xs', color: THEME.text, maxLines: 6 })
    : { type: 'text', text: snippet, wrap: true, size: 'xs', color: THEME.text, maxLines: 6 };
  const bodyContents = [];
  if (opts && opts.matchMeta) bodyContents.push(matchMetaComponent_(_m ? _m.matched : false, score));
  bodyContents.push(snippetComp);
  // 目前歸類（新模型 大類｜議題）——一眼看到這筆在哪個主題群組，決定要不要改歸。
  // 〔2026-06-03〕取消「收藏」後連結也進主題，故連結一律一併顯示歸類（不再因 isLinkRec 隱藏）。
  {
    const topicTxt = record.category ? `📂 ${record.category}｜${record.topicLabel || '未細分'}` : '📂 尚未歸類';
    bodyContents.push({ type: 'text', text: topicTxt, size: 'xxs', color: THEME.depth.l2.accent, margin: 'sm', wrap: true });
  }
  // 儀式軸來源：record 有 explorationId 時加一行「🎒 來自：<lesson 名>」標示當時在哪節課寫的。
  // 與上方 📂 語意軸歸類獨立——前者「事件 metadata」、後者「內容主題」，不互蓋。
  if (record.explorationId && opts && opts.scope) {
    const explorationLabel = explorationLabelsByScope_(opts.scope)[record.explorationId];
    if (explorationLabel) {
      bodyContents.push({
        type: 'text',
        text: `🎒 來自：${truncate_(explorationLabel, 18)}`,
        size: 'xxs', color: THEME.depth.l1.accent, margin: 'xs', wrap: true
      });
    }
  }
  // /ask LOW 模式的 LLM 註解：「這條跟問題哪部分有關 / 為何相關度有限」。
  // 只在 replyAskCluesAnnotated_ 呼叫時帶入；其他用 buildSearchBubble_ 的場景不顯示。
  if (opts && opts.askAnnotation) {
    bodyContents.push({
      type: 'text',
      text: `✦ ${opts.askAnnotation}`,
      size: 'xxs', color: THEME.stage.gap, margin: 'xs', wrap: true
    });
  }
  // "↳ 引述…" line: resolve the quoted target live so it shows the target's
  // current content (transcript / text), not the filename frozen at quote
  // time. Falls back to the stored summary when the target can't be
  // resolved (e.g. it was a bot reply).
  if (quotedTarget) {
    const qDate = Utilities.formatDate(new Date(quotedTarget.ts), TIME_ZONE, 'MM/dd HH:mm');
    const qPrev = truncate_((quotedTarget.text || '').replace(/\s+/g, ' '), 50) || '(內容處理中)';
    bodyContents.push({
      type: 'text',
      text: `↳ 引述 ${qDate} 的 ${typeLabel_(quotedTarget.type)}：${qPrev}`,
      wrap: true, size: 'xxs', color: THEME.textMuted, margin: 'sm', maxLines: 4
    });
    // Quoted target's thumbnail BELOW the quoted text (reads:
    // annotation → what was quoted → its image). Body image, not hero —
    // hero is structurally pinned to the top of the bubble.
    if (quotedTarget.fileId &&
        (quotedTarget.type === 'image' || quotedTarget.type === 'video' || quotedTarget.type === 'file')) {
      bodyContents.push({
        type: 'image',
        url: `https://drive.google.com/thumbnail?id=${quotedTarget.fileId}&sz=w400`,
        size: 'full', aspectRatio: '4:3', aspectMode: 'cover', margin: 'sm',
        action: { type: 'uri', label: '引述原檔', uri: `https://drive.google.com/file/d/${quotedTarget.fileId}/view` }
      });
    } else if (quotedTarget.type === 'sticker' && quotedTarget.stickerUrl) {
      bodyContents.push({
        type: 'image', url: quotedTarget.stickerUrl,
        size: 'full', aspectRatio: '1:1', aspectMode: 'fit', margin: 'sm'
      });
    }
  } else if (record.quotedSummary) {
    bodyContents.push({
      type: 'text',
      text: `↳ ${record.quotedSummary}`,
      wrap: true, size: 'xxs', color: THEME.textMuted, margin: 'sm', maxLines: 3
    });
  }
  // suppCount is derived live (buildSupplementCounts_), so the badge is
  // correct even before any aggregated re-embed has materialized.
  if (suppCount > 0) {
    bodyContents.push({
      type: 'text',
      text: `💬 已被補充 ${suppCount} 則`,
      size: 'xxs', color: THEME.cta, margin: 'sm', weight: 'bold'
    });
  }
  // 〔情緒層〕這則訊息收到的貼圖情緒：入庫存的 reactions ∪ 清單折疊進來的 _emotions（display）。
  // 同一張貼圖可能同時存在多份（捕捉掛的＋回填掛的＋折疊的）→ 以 emoji+情緒詞 為鍵去重、只留一份。
  // 折進來的貼圖讓型別標「＋貼圖」（見表頭），這裡直接秀「原貼圖」＋emoji 情緒詞。
  const _emosRaw = (record.reactions || []).concat(record._emotions || []);
  const _emoSeen = {}; const _emos = [];
  _emosRaw.forEach(e => {
    if (!e) return;
    const k = `${e.emoji || ''}|${e.summary || e.phrase || ''}`;
    if (_emoSeen[k]) return;
    _emoSeen[k] = true; _emos.push(e);
  });
  if (_emos.length) {
    const rx = _emos.slice(-3);
    const words = rx.map(r => r && `${r.emoji || ''} ${r.summary || r.phrase || ''}`.trim()).filter(Boolean).join('、');
    const row = { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', alignItems: 'center', contents: [] };
    const lastUrl = rx[rx.length - 1] && rx[rx.length - 1].stickerUrl;
    if (lastUrl) row.contents.push({ type: 'image', url: lastUrl, size: 'md', aspectMode: 'fit', flex: 0 });
    row.contents.push({ type: 'text', text: `心情：${words || '（貼圖）'}`, size: 'xxs', color: THEME.textBody, wrap: true, flex: 1, gravity: 'center' });
    bodyContents.push(row);
  }
  // Timeline strip (pre-built by caller — episode-span for 看原始紀錄,
  // corpus-span for /ask citations; the framing depends on what scope this
  // record belongs to).
  if (strip) { bodyContents.push({ type: 'separator', margin: 'sm' }); bodyContents.push(strip); }
  // 表頭：依據模式（/ask 證據）＝暖紙「證物」身分（💬 問答 ▸ 依據①、無 cosine，與 recall 藍記錄卡區隔）；
  // 否則維持 recall 記錄的深藍表頭。
  const evMode = !!(opts && opts.evidenceMode);
  const headerBox = evMode ? {
    type: 'box', layout: 'vertical', backgroundColor: THEME.ask.evidenceBg, paddingAll: 'md',
    contents: [
      { type: 'text', text: `💬 問答 ▸ ${(opts && opts.evidenceLabel) || '依據'}${(opts && opts.evidenceOrdinal) || ''}`, size: 'xxs', color: THEME.ask.evidenceSub, weight: 'bold' },
      { type: 'text', text: `${Utilities.formatDate(new Date(record.ts), TIME_ZONE, 'MM/dd HH:mm')}　${typeIcon} ${typeFull}`, size: 'sm', weight: 'bold', color: THEME.ask.evidenceInk, margin: 'xs', wrap: true }
    ]
  } : {
    type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l3.headerBg, paddingAll: 'md',
    contents: [
      breadcrumbKicker_(['敘事片段', '原始記錄'], THEME.depth.l3),
      // 標頭用「該筆記錄時間」(MM/dd HH:mm) 取代無資訊的 No.N；footer 的 dateLong 仍有到秒完整時間。
      { type: 'text', text: Utilities.formatDate(new Date(record.ts), TIME_ZONE, 'MM/dd HH:mm'), weight: 'bold', size: 'lg', color: THEME.depth.l3.headerText, margin: 'xs' },
      { type: 'separator', margin: 'sm', color: THEME.success },
      { type: 'text', text: `${typeIcon} ${typeFull}${typeof score === 'number' ? ` (${score.toFixed(2)})` : ''}`, size: 'xs', color: THEME.depth.l3.headerSub, margin: 'sm' }
    ]
  };
  const bubble = {
    type: 'bubble',
    size: (opts && opts.size) || 'micro',   // /ask 引用整併進答案輪播時傳 kilo 以對齊答案卡；看原始紀錄維持 micro
    header: headerBox,
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'md',
      contents: bodyContents
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: THEME.surfaceWarm,
      paddingAll: 'sm',
      contents: [
        { type: 'text', text: dateLong, size: 'xxs', color: THEME.textDim, wrap: true, align: 'center' },
        ...((record.type === 'audio' && record.fileId) ? [{
          type: 'box',
          layout: 'vertical',
          backgroundColor: THEME.audio,
          cornerRadius: 'md',
          paddingAll: 'sm',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '試聽',
            data: `action=play&id=${record.id}`,
            displayText: '▸ 試聽語音'
          },
          contents: [
            { type: 'text', text: '▶ 試聽', size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }
          ]
        }] : []),
        ...((function () {
          // One button for either a location-type record (coords →
          // Google Maps query) or a text-type record that contains a
          // pasted Maps share URL.
          let uri = null;
          if (record.type === 'location' && record.latitude != null && record.longitude != null) {
            uri = `https://www.google.com/maps?q=${record.latitude},${record.longitude}`;
          } else if (record.mapsUrl) {
            uri = safeActionUri_(record.mapsUrl);
          }
          if (!uri) return [];
          return [{
            type: 'box',
            layout: 'vertical',
            backgroundColor: THEME.success,
            cornerRadius: 'md',
            paddingAll: 'sm',
            margin: 'sm',
            action: { type: 'uri', label: '開啟地圖', uri },
            contents: [
              { type: 'text', text: '🗺 開啟地圖', size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }
            ]
          }];
        })()),
        ...((isLinkRec && linkUri) ? [{
          // 直接開原連結（uri action）。所有外部連結記錄都有，不限於抓到縮圖者——FB 登入牆
          // 等抓不到 og 的連結，至少能一鍵點開原網址。
          type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
          action: { type: 'uri', label: '開啟連結', uri: linkUri },
          contents: [{ type: 'text', text: '🔗 開啟連結', size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
        }] : []),
        ...((opts && opts.reclassify && record.embedding && record.embedding.length === EMBED_DIM) ? [{
          type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
          action: { type: 'postback', label: '改歸主題', data: `action=rec_pick_topic&rid=${record.id}`, displayText: '▸ 改歸主題' },
          contents: [{ type: 'text', text: '📌 改歸主題', size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
        }] : []),
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: THEME.cta,
          cornerRadius: 'md',
          paddingAll: 'sm',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '看完整內容',
            data: `action=detail&id=${record.id}`,
            displayText: `▸ 看完整內容 · 第 ${idx} 筆`
          },
          contents: [
            { type: 'text', text: '看完整內容', size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }
          ]
        }
      ]
    }
  };

  // Hero thumbnail for image / video / file records (Drive thumbnail endpoint —
  // file 涵蓋 PDF/Office，Drive 會產生首頁縮圖)。任何有視覺縮圖的訊息形式都帶上，便於辨識。
  if ((record.type === 'image' || record.type === 'video' || record.type === 'file') && record.fileId) {
    bubble.hero = {
      type: 'image',
      url: `https://drive.google.com/thumbnail?id=${record.fileId}&sz=w400`,
      size: 'full',
      aspectRatio: '4:3',
      aspectMode: 'cover',
      action: {
        type: 'uri',
        label: '原檔',
        uri: `https://drive.google.com/file/d/${record.fileId}/view`
      }
    };
  }
  // Hero for sticker records — show the sticker itself (square, contain).
  if (record.type === 'sticker' && record.stickerUrl) {
    bubble.hero = {
      type: 'image',
      url: record.stickerUrl,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'fit'
    };
  }
  // 外部連結 → 用抓到的 og:image / YouTube / 網頁縮圖當 hero（YT/FB/IG/部落格），點擊
  // 開原連結。讓記錄卡也帶縮圖，不只貼上當下的選擇泡泡才有。!bubble.hero 確保不蓋掉
  // 圖片/影片/貼圖的既有 hero。
  const recHeroUrl = (record.urlPreview && httpsImageUrl_(record.urlPreview.thumbnail, record.urlPreview.url)) || '';
  if (!bubble.hero && recHeroUrl) {
    const heroImg = {
      type: 'image', url: recHeroUrl,
      size: 'full', aspectRatio: '20:13', aspectMode: 'cover'
    };
    if (linkUri) heroImg.action = { type: 'uri', label: '開啟連結', uri: linkUri };
    bubble.hero = heroImg;
  }
  return bubble;
}

/**
 * Pagination card placed below the search results.
 *   👉 回想"<query>"(共 N 筆)
 *   pre.    <p-1>  [p]  <p+1>    next       (cyclic at edges)
 *   first                                last
 */
/** Quick Reply on a "no result" reply — only offer 擴大 (broader). */
function noResultQuickReply_(query, currentThreshold, qk) {
  const broader = Math.max(SEARCH_THRESHOLD_FLOOR, currentThreshold - SEARCH_THRESHOLD_STEP);
  if (broader >= currentThreshold) return null;  // already at the floor
  return {
    items: [{
      type: 'action',
      action: {
        type: 'postback',
        label: `擴大 (↓${fmtThreshold_(broader)})`,
        data: `action=search_page&qk=${qk}&p=0&min=${broader.toFixed(2)}`,
        displayText: `▸ 擴大回想範圍 · 門檻 ${broader.toFixed(2)}`
      }
    }]
  };
}

/** Heuristic: does this recall query read like a question (worth a one-shot
 *  answer) vs a bare topic/keyword (which would usually just gap)? Used to gate
 *  the 直接問這個 escalation so keyword recalls don't dead-end at /ask. */
function looksLikeQuestion_(q) {
  if (!q) return false;
  if (/[?？]/.test(q)) return true;
  return /(嗎|呢|什麼|甚麼|如何|怎麼|怎樣|為什麼|為何|多少|幾時|哪|是不是|有沒有|能不能|可不可以|要不要|該不該|是否)/.test(q);
}

/** Quick Reply on a result reply — offer both 擴大 and 縮小, plus the default nav. */
function hasResultQuickReply_(query, currentThreshold, qk, suppressAsk) {
  const broader  = Math.max(SEARCH_THRESHOLD_FLOOR, currentThreshold - SEARCH_THRESHOLD_STEP);
  const stricter = Math.min(SEARCH_THRESHOLD_CEIL,  currentThreshold + SEARCH_THRESHOLD_STEP);
  const naParam = suppressAsk ? '&na=1' : '';
  const items = [];
  // Escalate browse → answer, but only when it can plausibly work: skip for a
  // gap re-loop (suppressAsk), and skip bare keywords (a topic just gaps — ask
  // needs a question). A typed-out question keeps the shortcut.
  if (!suppressAsk && looksLikeQuestion_(query)) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: '直接問這個',
        data: `action=ask_run&qk=${qk}`,
        displayText: `▸ 直接問 · ${truncate_(query, 60)}`
      }
    });
  }
  if (broader < currentThreshold) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: `擴大 (↓${fmtThreshold_(broader)})`,
        data: `action=search_page&qk=${qk}&p=0&min=${broader.toFixed(2)}${naParam}`,
        displayText: `▸ 擴大回想範圍 · 門檻 ${broader.toFixed(2)}`
      }
    });
  }
  if (stricter > currentThreshold) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: `縮小 (↑${fmtThreshold_(stricter)})`,
        data: `action=search_page&qk=${qk}&p=0&min=${stricter.toFixed(2)}${naParam}`,
        displayText: `▸ 縮小回想範圍 · 門檻 ${stricter.toFixed(2)}`
      }
    });
  }
  return items.length ? { items } : null;
}

/**
 * Generic pagination card. `title` is the header line; `makeData(page)`
 * returns the postback data string for a given 0-based page, so the same
 * pager serves /search and /episodes raw view.
 */
function buildPaginationBubble_(title, currentPage, totalPages, makeData, viewLabel) {
  // 頁碼按鈕回顯本來是裸「第 N 頁」——夾進筆記裡看不出是哪個視圖的第幾頁。改成帶視圖名：
  // 未傳 viewLabel 就從 title 推導（剝開頭 👉/📂/threshold 前綴 → 切到第一個（/( 的計數尾 →
  // 截 14），故 12 個呼叫端零改動仍生效。按鈕 label 維持「第 N 頁」（卡上頁碼窗本就直觀）。
  const viewTag = viewLabel || truncate_(
    String(title || '').replace(/^[^一-鿿A-Za-z0-9]*\s*/, '').replace(/\s*[（(].*$/, '').trim() || '清單', 14);
  const pageAction = (p) => ({
    type: 'postback',
    label: `第 ${p + 1} 頁`,
    data: makeData(p),
    displayText: `▸ ${viewTag} · 第 ${p + 1} 頁`
  });
  const prevPage = (currentPage - 1 + totalPages) % totalPages;
  const nextPage = (currentPage + 1) % totalPages;

  // Sliding page-number window: show all pages when there are few, else an
  // 8-wide window centred on the current page so the row never overflows.
  const windowSize = Math.min(totalPages, SEARCH_PAGE_WINDOW);
  let start = Math.max(0, currentPage - Math.floor((windowSize - 1) / 2));
  let end = Math.min(totalPages, start + windowSize);
  start = Math.max(0, end - windowSize);
  const pageItems = [];
  for (let p = start; p < end; p++) {
    const isCur = p === currentPage;
    const item = {
      type: 'text', text: `${p + 1}`, size: 'sm',
      color: isCur ? THEME.danger : THEME.textDim,
      weight: isCur ? 'bold' : 'regular',
      align: 'center', flex: 1
    };
    if (!isCur) item.action = pageAction(p);
    pageItems.push(item);
  }

  const navDisabled = totalPages <= 1;
  const navItem = (text, align, targetPage) => {
    const item = { type: 'text', text, size: 'xs', flex: 1 };
    if (align) item.align = align;
    if (navDisabled) { item.color = THEME.faint; item.decoration = 'line-through'; }
    else { item.color = THEME.muted; item.action = pageAction(targetPage); }
    return item;
  };

  const bodyContents = [
    { type: 'text', text: title, size: 'md', color: THEME.dangerSoft, wrap: true },
    { type: 'separator', margin: 'sm' },
    { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'xs', contents: pageItems }
  ];
  if (totalPages > 1) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        navItem('« first', null, 0),
        navItem('‹ pre', 'center', prevPage),
        navItem('next ›', 'center', nextPage),
        navItem('last »', 'end', totalPages - 1)
      ]
    });
  }

  return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: bodyContents } };
}

/**
 * Postback handler: send the raw audio back as a LINE audio message so it
 * can be played inline. Uses Drive's direct-download URL (file must be
 * shared ANYONE_WITH_LINK, which saveRawBlob_ now does by default).
 */
function replyAudioPlayback_(ev, scope, recordId) {
  const records = loadEmbeddingRecords_(scope);
  const r = records.find(x => x.id === recordId);
  if (!r) return lineReply_(ev.replyToken, '⚠️ 找不到該筆紀錄。');
  if (r.type !== 'audio' || !r.fileId) {
    return lineReply_(ev.replyToken, '⚠️ 該紀錄不是可播放的語音。');
  }
  const url = `https://drive.google.com/uc?export=download&id=${r.fileId}`;
  // LINE requires duration. Fall back to 60s for older records without it.
  const duration = r.duration && r.duration > 0 ? r.duration : 60000;
  lineReplyMessages_(ev.replyToken, [{
    type: 'audio',
    originalContentUrl: url,
    duration
  }]);
}

/**
 * Postback handler: full content of a single record (the 看完整內容 target).
 *
 * Sent as TWO messages so we keep both the quote tie-back AND clean buttons:
 *   1. a TEXT message that quotes the user's original message (only text /
 *      sticker messages can carry a quoteToken — Flex cannot), holding the
 *      full readable content with no raw URLs;
 *   2. an L3-tier Flex "attachment / actions" card (same colour + breadcrumb
 *      language as the raw-record card it opened from) — hero thumbnail +
 *      開啟原檔 / 開啟地圖 / 試聽 buttons. Skipped entirely for plain-text
 *      records that have nothing to attach or act on.
 */
function replyRecordDetail_(ev, scope, recordId) {
  const records = loadEmbeddingRecords_(scope);
  const r = records.find(x => x.id === recordId);
  if (!r) return lineReply_(ev.replyToken, '⚠️ 找不到該筆紀錄。');

  const tier = THEME.depth.l3;
  const date = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
  const typeIcon = { text: '📝', image: '🖼️', audio: '🎤', video: '🎬', file: '📄', sticker: '😀', location: '📍' }[r.type] || '📌';

  // Resolve the quoted target (if this record is itself a supplement).
  const qt = (r.quotedRecordId && records.find(x => x.id === r.quotedRecordId))
    || (r.quotedLineMessageId && records.find(x => x.lineMessageId === r.quotedLineMessageId))
    || null;
  const supps = records
    .filter(x => x.id !== r.id && (
      x.quotedRecordId === r.id ||
      (r.lineMessageId && x.quotedLineMessageId === r.lineMessageId)
    ))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // ---- message 1: text, quoting the user's original message (no raw URLs) ----
  const lines = [`${typeIcon} ${typeLabel_(r.type)} · ${date}`];
  if (r.fileName) lines.push(`📎 ${r.fileName}`);
  if (qt) {
    const qDate = Utilities.formatDate(new Date(qt.ts), TIME_ZONE, 'MM/dd HH:mm');
    const qPrev = truncate_((qt.text || '').replace(/\s+/g, ' '), 120) || '(內容處理中)';
    lines.push('', `↳ 引述 ${qDate} 的 ${typeLabel_(qt.type)}：`, qPrev);
  } else if (r.quotedSummary) {
    lines.push('', `↳ ${r.quotedSummary}`);
  }
  lines.push('', r.text || '(無內容)');
  if (supps.length) {
    lines.push('', `💬 後續補充（${supps.length} 則）：`);
    for (const s of supps) {
      const sdate = Utilities.formatDate(new Date(s.ts), TIME_ZONE, 'MM/dd HH:mm');
      lines.push(`  ↳ ${sdate} ${s.text || ''}`);
    }
  }
  const textMsg = { type: 'text', text: truncate_(lines.join('\n'), 4900) };
  if (r.quoteToken) textMsg.quoteToken = r.quoteToken;
  const messages = [textMsg];

  // ---- message 2: L3 Flex attachment / actions card (only if it carries
  // a thumbnail, a quoted attachment, or at least one action button) ----
  const btn = (label, bg, action) => ({
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
    action, contents: [{ type: 'text', text: label, size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
  });
  const buttons = [];
  if (r.fileId) {
    buttons.push(btn('📂 開啟原檔', THEME.cta, { type: 'uri', label: '開啟原檔', uri: `https://drive.google.com/file/d/${r.fileId}/view` }));
  }
  if (r.type === 'location' && r.latitude != null && r.longitude != null) {
    buttons.push(btn('🗺 開啟地圖', THEME.success, { type: 'uri', label: '開啟地圖', uri: `https://www.google.com/maps?q=${r.latitude},${r.longitude}` }));
  } else if (safeActionUri_(r.mapsUrl)) {
    buttons.push(btn('🗺 開啟地圖', THEME.success, { type: 'uri', label: '開啟地圖', uri: safeActionUri_(r.mapsUrl) }));
  }
  if (r.type === 'audio' && r.fileId) {
    buttons.push(btn('▶ 試聽', THEME.audio, { type: 'postback', label: '試聽', data: `action=play&id=${r.id}`, displayText: '▸ 試聽語音' }));
  }
  // 外部連結 → 一鍵開原網址（urlPreview.url 優先，否則抽原文第一個網址）。
  const _isLink = r.type === 'link' || /https?:\/\/\S/.test(r.text || '');
  const _linkUri = _isLink
    ? safeActionUri_((r.urlPreview && r.urlPreview.url) || ((r.text || '').match(/https?:\/\/[\x21-\x7e]+/) || [null])[0])
    : null;
  if (_linkUri) {
    buttons.push(btn('🔗 開啟連結', THEME.cta, { type: 'uri', label: '開啟連結', uri: _linkUri }));
  }

  let hero = null;
  if ((r.type === 'image' || r.type === 'video') && r.fileId) {
    hero = {
      type: 'image', url: `https://drive.google.com/thumbnail?id=${r.fileId}&sz=w600`,
      size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
      action: { type: 'uri', label: '原檔', uri: `https://drive.google.com/file/d/${r.fileId}/view` }
    };
  } else if (r.type === 'sticker' && r.stickerUrl) {
    hero = { type: 'image', url: r.stickerUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' };
  }

  // Quoted attachment thumbnail — keeps the quoted file reachable without a URL.
  const qtBody = [];
  if (qt && qt.fileId && (qt.type === 'image' || qt.type === 'video')) {
    qtBody.push({ type: 'text', text: `↳ 引述的${typeLabel_(qt.type)}`, size: 'xxs', color: THEME.textMuted, wrap: true });
    qtBody.push({
      type: 'image', url: `https://drive.google.com/thumbnail?id=${qt.fileId}&sz=w400`,
      size: 'full', aspectRatio: '4:3', aspectMode: 'cover', margin: 'sm',
      action: { type: 'uri', label: '引述原檔', uri: `https://drive.google.com/file/d/${qt.fileId}/view` }
    });
  } else if (qt && qt.type === 'sticker' && qt.stickerUrl) {
    qtBody.push({ type: 'text', text: '↳ 引述的貼圖', size: 'xxs', color: THEME.textMuted });
    qtBody.push({ type: 'image', url: qt.stickerUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'fit', margin: 'sm' });
  }

  if (buttons.length || hero || qtBody.length) {
    const bubble = {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
        contents: [
          breadcrumbKicker_(['敘事片段', '原始記錄', '看完整內容'], tier),
          { type: 'text', text: `${typeIcon} ${typeLabel_(r.type)} · ${date}`, size: 'md', weight: 'bold', color: tier.headerText, margin: 'xs', wrap: true }
        ]
      }
    };
    if (hero) bubble.hero = hero;
    if (qtBody.length) bubble.body = { type: 'box', layout: 'vertical', paddingAll: 'md', contents: qtBody };
    if (buttons.length) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'none', contents: buttons };
    messages.push({ type: 'flex', altText: `${typeLabel_(r.type)} 附件 · ${date}`, contents: bubble });
  }

  lineReplyMessages_(ev.replyToken, messages);
}

