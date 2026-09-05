/**
 * 探索敘事段 / 事件軸（第三條軸，與時間軸＝敘事片段、語意軸＝脈絡並列）。
 *
 * 時間軸切「我何時寫」、語意軸切「我寫了什麼」，兩者都切不出「我在哪一場情境寫」——
 * 同一節課內跳兩主題會被語意軸拆開；中間沒休 30 分但其實是兩節課會被時間軸黏住。
 * `/explore` 讓使用者**主動宣告**一場課程/工作坊/讀書會：期間每筆 record 繼承 `explorationId`，
 * 結束後持久化到 explorations.jsonl、可檢索。exploration 既是檢索 metadata，也是聚類的弱信號（Stage 4）。
 *
 * 進行中狀態存 chatMeta（與 recordPins/linkIntent 同處、per-scope 隔離）：
 *   meta.activeExplorationId         進行中 exploration id
 *   meta.activeExplorationExpiresAt  到期 epoch ms（到時惰性自動關閉）
 *
 * exploration 物件（explorations.jsonl 每行，沿用 loadJsonl_/upsertJsonl_）：
 *   { id, createdAt, label, plannedMinutes, startTs, endTs(null=進行中),
 *     status:'active'|'closed', recordIds:[], userId,
 *     miniClusters:[ {id, label, recordIds[], centroid[]} ] }   // Stage 3 才填
 *
 * record.explorationId 是成員歸屬的**單一真相**；exploration.recordIds 只是快取（closeExploration_ 收尾時
 * 從 record.explorationId 反查回填），所以每則訊息不必額外鎖寫 exploration row。
 */

/* ============================ 舊資料一次性遷移（lesson → exploration） ============================ */

// 第一次部署時把舊資料的命名搬到新名稱：
//   - record.lessonId → record.explorationId
//   - lessons.jsonl 內容 → explorations.jsonl（舊檔丟 trash）
//   - meta.activeLessonId/ExpiresAt/ClusterCount、meta.pendingLessonClosedNotice → exploration* 同名
// meta.lessonsMigratedToExplorations 標記成功；之後 no-op。
// per-execution 用 _explorationMigrationDone 快取避免同次 webhook 內反覆讀 meta。

let _explorationMigrationDone = {};

function migrateLessonToExploration_(scope) {
  if (!scope || !scope.key) return;
  if (_explorationMigrationDone[scope.key]) return;
  const probe = loadChatMeta_(scope);
  if (probe && probe.lessonsMigratedToExplorations) {
    _explorationMigrationDone[scope.key] = true;
    return;
  }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(60000); } catch (_) { return; }
  try {
    const m = loadChatMeta_(scope);
    if (m && m.lessonsMigratedToExplorations) { _explorationMigrationDone[scope.key] = true; return; }
    // 1. records: lessonId → explorationId
    let recDirty = false;
    const allRec = loadEmbeddingRecords_(scope);
    for (const r of allRec) {
      if (r && r.lessonId && !r.explorationId) {
        r.explorationId = r.lessonId;
        delete r.lessonId;
        recDirty = true;
      }
    }
    if (recDirty) {
      const f = chatEmbeddingsFile_(scope);
      f.setContent(allRec.map(r => JSON.stringify(r)).join('\n'));
    }
    // 2. lessons.jsonl → explorations.jsonl
    try {
      const parent = chatFolder_(scope);
      const it = parent.getFilesByName('lessons.jsonl');
      if (it.hasNext()) {
        const oldFile = it.next();
        const content = oldFile.getBlob().getDataAsString();
        const it2 = parent.getFilesByName('explorations.jsonl');
        const newFile = it2.hasNext() ? it2.next() : parent.createFile('explorations.jsonl', '', MimeType.PLAIN_TEXT);
        if (content) newFile.setContent(content);
        oldFile.setTrashed(true);
      }
    } catch (e) { console.warn('migrate lessons.jsonl failed:', e && e.message); }
    // 3. meta keys
    updateChatMeta_(scope, mm => {
      if (mm.activeLessonId !== undefined) { mm.activeExplorationId = mm.activeLessonId; delete mm.activeLessonId; }
      if (mm.activeLessonExpiresAt !== undefined) { mm.activeExplorationExpiresAt = mm.activeLessonExpiresAt; delete mm.activeLessonExpiresAt; }
      if (mm.activeLessonClusterCount !== undefined) { mm.activeExplorationClusterCount = mm.activeLessonClusterCount; delete mm.activeLessonClusterCount; }
      if (mm.pendingLessonClosedNotice !== undefined) { mm.pendingExplorationClosedNotice = mm.pendingLessonClosedNotice; delete mm.pendingLessonClosedNotice; }
      mm.lessonsMigratedToExplorations = true;
      return mm;
    });
    _explorationMigrationDone[scope.key] = true;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ============================ 生命週期 ============================ */

/** 進行中 exploration（惰性自動關閉）。讀 meta → 過期就 close 後回 null → 否則回 exploration 物件。
 *  所有「讀進行中 exploration」都走這個，不依賴背景 sweep。
 *  順手做舊資料一次性遷移（lesson → exploration field/key 改名）。 */
function activeExploration_(scope) {
  migrateLessonToExploration_(scope);
  const meta = loadChatMeta_(scope);
  if (!meta || !meta.activeExplorationId) return null;
  if (meta.activeExplorationExpiresAt && Date.now() > meta.activeExplorationExpiresAt) {
    try { closeExploration_(scope, meta.activeExplorationId, { autoExpired: true }); }
    catch (e) { console.warn('exploration auto-close failed:', e && e.message); }
    return null;
  }
  const exploration = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE)).find(l => l.id === meta.activeExplorationId);
  if (!exploration || exploration.status !== 'active') {
    // meta 指向已關閉/不存在的 exploration → 清掉，避免每次都白讀。
    updateChatMeta_(scope, m => { delete m.activeExplorationId; delete m.activeExplorationExpiresAt; return m; });
    return null;
  }
  return exploration;
}

/** 開課：建 exploration row + 寫 meta 兩欄 + ack 開場 flex 卡（儀式感、與一般 ack 視覺區隔）。
 *  已有進行中則拒絕。 */
function startExploration_(ctx, label, minutes) {
  const scope = ctx.scope;
  const now = Date.now();
  const id = newId_();
  const exploration = {
    id,
    createdAt: new Date(now).toISOString(),
    label: label,
    plannedMinutes: minutes,
    startTs: new Date(now).toISOString(),
    endTs: null,
    status: 'active',
    recordIds: [],
    userId: ctx.userId || (scope && scope.id) || null,
    miniClusters: []
  };
  upsertJsonl_(scope, EXPLORATIONS_FILE, exploration);
  updateChatMeta_(scope, m => {
    m.activeExplorationId = id;
    m.activeExplorationExpiresAt = now + minutes * 60000;
    return m;
  });
  return lineReplyFlex_(ctx.replyToken,
    `🎒 開始「${truncate_(label, 24)}」(${minutes} 分)`,
    buildExplorationStartBubble_(exploration));
}

/** label 正規化比對（trim＋收合空白＋小寫）：判斷「是不是同一個主題名」。 */
function sameExplorationLabel_(a, b) {
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

/** 找同名（已結束）的探索：回最近一條，給「延續同主題」復用。無則 null。 */
function findExplorationByLabel_(scope, label) {
  const rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE));
  return rows.filter(l => l && sameExplorationLabel_(l.label, label))
    .sort((a, b) => Date.parse(b.startTs || 0) - Date.parse(a.startTs || 0))[0] || null;
}

/** 延續同主題：復用既有 exploration（同 explorationId）→ 新寫的併進同一條，不另開重複主題。
 *  status 轉回 active、清 endTs、記 resumedAt（本段視窗用）、plannedMinutes＝這段的時長。 */
function resumeExploration_(ctx, exploration, minutes) {
  const scope = ctx.scope;
  const now = Date.now();
  exploration.status = 'active';
  exploration.endTs = null;
  exploration.resumedAt = new Date(now).toISOString();
  exploration.plannedMinutes = minutes;
  upsertJsonl_(scope, EXPLORATIONS_FILE, exploration);
  updateChatMeta_(scope, m => {
    m.activeExplorationId = exploration.id;
    m.activeExplorationExpiresAt = now + minutes * 60000;
    return m;
  });
  const members = loadEmbeddingRecords_(scope).filter(r => r && r.explorationId === exploration.id);
  const priorN = members.length;
  // 最後 3 則（時間序）→ 開場卡列出「上次寫到」，提示學習者接著哪裡繼續。
  const recent = members.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-3);
  return lineReplyFlex_(ctx.replyToken,
    `🎒 繼續「${truncate_(exploration.label, 24)}」（接續上次・已有 ${priorN} 則）`,
    buildExplorationStartBubble_(exploration, { resumed: true, priorN: priorN, recent: recent }));
}

/** 關課：set endTs/status、從 record.explorationId 反查回填 recordIds、清 meta。
 *  手動 end 與惰性到期共用；到期關閉無 replyToken，用 push 發結束泡泡。
 *  空白探索（按錯沒寫任何東西）→ 整列刪掉、不發 push、不留延遲告知，避免雜訊。
 *  回傳的 exploration 物件帶 `_empty: true` 讓 caller 改顯示「已取消空白探索」而非結束卡。 */
function closeExploration_(scope, explorationId, opts) {
  opts = opts || {};
  const rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE));
  const exploration = rows.find(l => l.id === explorationId);
  // 先清 meta（即使 exploration row 缺失也要清，免得 activeExploration_ 反覆嘗試關閉）。
  updateChatMeta_(scope, m => {
    if (m.activeExplorationId === explorationId) { delete m.activeExplorationId; delete m.activeExplorationExpiresAt; }
    return m;
  });
  if (!exploration) return null;
  const members = loadEmbeddingRecords_(scope).filter(r => r && r.explorationId === explorationId);

  // 空白探索：直接從 jsonl 刪掉。不 push、不留延遲告知。
  if (members.length === 0) {
    const cleaned = rows.filter(l => l.id !== explorationId);
    saveJsonl_(scope, EXPLORATIONS_FILE, cleaned);
    return { id: exploration.id, label: exploration.label || '', _empty: true };
  }

  exploration.endTs = new Date().toISOString();
  exploration.status = 'closed';
  exploration.recordIds = members.map(r => r.id);
  upsertJsonl_(scope, EXPLORATIONS_FILE, exploration);
  if (opts.autoExpired) {
    try {
      const uid = exploration.userId || (scope && scope.type === 'user' ? scope.id : null);
      if (uid) linePushFlex_(uid, explorationClosedAltText_(exploration), buildExplorationEndBubble_(scope, exploration));
    } catch (e) { console.warn('exploration close push failed:', e && e.message); }
    // 延遲告知 fallback：push 可能因離線/通知關閉沒被看到。在 chatMeta 標記一筆 pending
    // notice，下次使用者傳文字訊息時於 ack 前置一行「上一節 X 於 14:25 自動結束 · N 筆」。
    // 使用者下次看見就消化掉，避免「悄悄關掉、毫不知情」。
    try {
      const lid = exploration.id;
      const label = exploration.label || '';
      const endIso = exploration.endTs;
      const n = (exploration.recordIds || []).length;
      updateChatMeta_(scope, m => {
        m.pendingExplorationClosedNotice = { explorationId: lid, label: label, endTs: endIso, n: n };
        return m;
      });
    } catch (e) { console.warn('exploration late notice mark failed:', e && e.message); }
  }
  return exploration;
}

/** 取出「上次 exploration 自動關閉但還沒在 LINE 上跟使用者打過招呼」的提醒；順手清掉。
 *  caller 拿到字串就 prepend 到下一個 ack 文字前置；null 表示無事。 */
function consumePendingExplorationNotice_(scope) {
  const meta = loadChatMeta_(scope);
  const p = meta && meta.pendingExplorationClosedNotice;
  if (!p || !p.label) return null;
  updateChatMeta_(scope, m => { delete m.pendingExplorationClosedNotice; return m; });
  const endHM = p.endTs ? Utilities.formatDate(new Date(p.endTs), TIME_ZONE, 'MM/dd HH:mm') : '';
  return `📦 上一節「${truncate_(p.label, 20)}」於 ${endHM} 自動結束 · ${p.n || 0} 筆`;
}

function explorationClosedAltText_(exploration) {
  if (!exploration) return '📦 探索已結束';
  return `📦「${truncate_(exploration.label, 24)}」已結束 · ${(exploration.recordIds || []).length} 則`;
}

/** ack 用的進行中標記（空字串＝沒在上課）。 */
function explorationStatusLine_(scope) {
  const al = activeExploration_(scope);
  return al ? `🎒 ${truncate_(al.label, 20)} 進行中` : '';
}

/* ============================ 指令 ============================ */

/** `/explore` 分流：
 *    空 + 有進行中 → 狀態文字；空 + 無進行中 → 過去探索列表（flex）
 *    list/清單/recent/最近 → 過去探索列表（無論是否進行中皆可用）
 *    end/結束 → 關課
 *    其餘 → 開課（尾段純數字＝分鐘，其餘＝名稱）。 */
function handleExploreCommand_(ctx, arg) {
  arg = (arg || '').trim();

  // 列表入口（任何時候可用）。第一 token 是 list-trigger，其餘為 label 模糊比對關鍵字。
  const listTokens = arg.split(/\s+/);
  const listHead = listTokens[0] || '';
  const LIST_TRIGGERS = ['list', '清單', 'recent', '最近', 'ls'];
  if (LIST_TRIGGERS.indexOf(listHead) >= 0) {
    const query = listTokens.slice(1).join(' ').trim();
    return replyExplorationsList_(ctx, { page: 0, query: query || null });
  }

  // 空 arg：進行中 → 狀態；無進行中 → 直接列出過去探索 + 開始提示。
  if (!arg) {
    return activeExploration_(ctx.scope) ? explorationStatusReply_(ctx) : replyExplorationsList_(ctx, { page: 0 });
  }

  if (arg === 'end' || arg === '結束' || arg === 'stop' || arg === '停') {
    const al = activeExploration_(ctx.scope);
    if (!al) return lineReply_(ctx.replyToken, '目前沒有進行中的探索。\n開始一節：/explore <名稱> [分鐘]');
    const closed = closeExploration_(ctx.scope, al.id);
    if (closed && closed._empty) {
      return lineReply_(ctx.replyToken, `🗑️ 已取消空白探索「${truncate_(closed.label, 20)}」（沒有任何記錄）。`);
    }
    return lineReplyFlex_(ctx.replyToken, explorationClosedAltText_(closed), buildExplorationEndBubble_(ctx.scope, closed));
  }

  // 改名：/explore rename <新名> 或 /explore 改名 <新名>
  if (/^(rename|改名)(\s+|$)/.test(arg)) {
    const al = activeExploration_(ctx.scope);
    if (!al) return lineReply_(ctx.replyToken, '目前沒有進行中的探索可改名。');
    const newName = arg.replace(/^(rename|改名)\s*/, '').trim().slice(0, 60);
    if (!newName) return lineReply_(ctx.replyToken,
      `用法：/explore rename <新名稱>\n目前：「${truncate_(al.label, 20)}」`);
    return renameActiveExploration_(ctx, al, newName);
  }

  // 調整時長：/explore +15  /explore -10  /explore extend 15  /explore 延長 15
  const adj = parseExplorationDurationAdjust_(arg);
  if (adj != null) {
    const al = activeExploration_(ctx.scope);
    if (!al) return lineReply_(ctx.replyToken, '目前沒有進行中的探索可以調整時長。');
    return adjustActiveExplorationDuration_(ctx, al, adj);
  }

  // 解析名稱與分鐘（尾段純數字＝分鐘）。
  const parts = arg.split(/\s+/);
  let minutes = EXPLORATION_DEFAULTS.durationMinutes;
  if (parts.length > 1 && /^\d{1,3}$/.test(parts[parts.length - 1])) {
    minutes = Math.max(1, Math.min(600, parseInt(parts.pop(), 10)));
  }
  const label = parts.join(' ').slice(0, 60) || '未命名探索';

  const existing = activeExploration_(ctx.scope);
  if (existing) {
    // 同名＝你已經在這個主題裡，直接寫就好（不必、也不會另開）；不同名才擋（一次一節）。
    if (sameExplorationLabel_(existing.label, label)) {
      return lineReply_(ctx.replyToken,
        `🎒「${truncate_(existing.label, 20)}」正在進行中——你已在這個主題裡，直接寫就會記進去。`);
    }
    return lineReply_(ctx.replyToken,
      `🎒 已有進行中探索「${truncate_(existing.label, 20)}」。\n先 /explore end 結束，再開「${truncate_(label, 16)}」。`);
  }

  // 同名主題已存在（已結束）→ **視為延續**：復用同一條（同 explorationId），不另開重複主題。
  const prior = findExplorationByLabel_(ctx.scope, label);
  if (prior) return resumeExploration_(ctx, prior, minutes);
  return startExploration_(ctx, label, minutes);
}

/** 解析 `+N` `-N` `extend N` `延長 N` `shorten N` `縮短 N`；回 +/- 分鐘整數或 null。 */
function parseExplorationDurationAdjust_(arg) {
  let m = arg.match(/^([+\-])\s*(\d{1,3})$/);
  if (m) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
  m = arg.match(/^(extend|延長)\s+(\d{1,3})$/);
  if (m) return parseInt(m[2], 10);
  m = arg.match(/^(shorten|縮短)\s+(\d{1,3})$/);
  if (m) return -parseInt(m[2], 10);
  return null;
}

/** 改進行中 exploration 名稱：更新 exploration.label + 重發狀態文字（避免 LINE quick reply 上「離開 X」
 *  顯示舊名 — 那個 quick reply 是 message action，只有下次 reply 才會帶到新名）。 */
function renameActiveExploration_(ctx, exploration, newName) {
  const before = exploration.label || '';
  exploration.label = newName;
  upsertJsonl_(ctx.scope, EXPLORATIONS_FILE, exploration);
  // 改名後 mini cluster label 不需要動（mini label 是「群心 record 的 topic」，與 exploration 名無關）。
  // dominantLessonLabel cache 是 per-execution，下次 webhook 自然重抓。
  return lineReply_(ctx.replyToken,
    `✏️ 已改名為「${truncate_(newName, 24)}」（原：「${truncate_(before, 24)}」）。`);
}

/** 調整進行中 exploration 的時長：±delta 分鐘。若縮短到 ≤ 已過時間，視為立刻結束。 */
function adjustActiveExplorationDuration_(ctx, exploration, deltaMin) {
  const meta = loadChatMeta_(ctx.scope);
  const expires = meta.activeExplorationExpiresAt || (Date.parse(exploration.startTs) + exploration.plannedMinutes * 60000);
  const newExpires = expires + deltaMin * 60000;
  const now = Date.now();
  // 縮短到已過 → 直接結束
  if (newExpires <= now) {
    const closed = closeExploration_(ctx.scope, exploration.id);
    if (closed && closed._empty) {
      return lineReply_(ctx.replyToken, `🗑️ 已取消空白探索「${truncate_(closed.label, 20)}」（沒有任何記錄）。`);
    }
    return lineReplyFlex_(ctx.replyToken, explorationClosedAltText_(closed), buildExplorationEndBubble_(ctx.scope, closed));
  }
  exploration.plannedMinutes = Math.max(1, exploration.plannedMinutes + deltaMin);
  // 改動時長後 warnedAt 重置，下次接近新到期時間可再提醒一次（否則延長後永遠不會再 warn）。
  if (exploration.warnedAt) delete exploration.warnedAt;
  upsertJsonl_(ctx.scope, EXPLORATIONS_FILE, exploration);
  updateChatMeta_(ctx.scope, m => { m.activeExplorationExpiresAt = newExpires; return m; });
  const verb = deltaMin >= 0 ? '延長' : '縮短';
  const absMin = Math.abs(deltaMin);
  const newEndHM = Utilities.formatDate(new Date(newExpires), TIME_ZONE, 'HH:mm');
  return lineReply_(ctx.replyToken,
    `⏳ 已${verb} ${absMin} 分鐘，新到期時間 ${newEndHM}（總 ${exploration.plannedMinutes} 分）。`);
}

/** `/explore` 無參數：回進行中狀態或用法。 */
function explorationStatusReply_(ctx) {
  const al = activeExploration_(ctx.scope);
  if (al) {
    const left = Math.max(0, Math.round((Date.parse(al.startTs) + al.plannedMinutes * 60000 - Date.now()) / 60000));
    const n = loadEmbeddingRecords_(ctx.scope).filter(r => r && r.explorationId === al.id).length;
    return lineReply_(ctx.replyToken,
      `🎒 進行中：「${al.label}」\n· 已記 ${n} 則 · 剩約 ${left} 分\n· /explore end 結束`);
  }
  return lineReply_(ctx.replyToken,
    '目前沒有進行中的探索。\n開始一節：/explore <名稱> [分鐘]\n' +
    '例：/explore 高三物理 50（不填分鐘預設 ' + EXPLORATION_DEFAULTS.durationMinutes + ' 分）');
}

/* ---- /recall exploration:X 篩選 ---- */

/** 從 /recall 參數抽出 `exploration:xxx` token：回 { query(去掉 token), explorationId, explorationLabel }。
 *  xxx 以 label 模糊比對 explorations.jsonl（先精確、再 contains），取最近一筆。 */
function extractExplorationFilter_(scope, arg) {
  const out = { query: (arg || '').trim(), explorationId: null, explorationLabel: null };
  const m = out.query.match(/(^|\s)exploration:(\S+)/i);
  if (!m) return out;
  const term = m[2];
  out.query = (out.query.slice(0, m.index) + out.query.slice(m.index + m[0].length)).trim();
  const rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE))
    .slice()
    .sort((a, b) => Date.parse(b.startTs || 0) - Date.parse(a.startTs || 0));
  const exact = rows.find(l => l.label === term);
  const hit = exact || rows.find(l => (l.label || '').indexOf(term) >= 0);
  if (hit) { out.explorationId = hit.id; out.explorationLabel = hit.label; }
  else { out.explorationLabel = term; }   // 沒對到 → 帶原字串，replySearch_ 回友善空訊息
  return out;
}

/* ============================ quick reply ============================ */

/** 「離開（exploration 名）」單一 item，可被各種 quick reply 組合複用。
 *  按鈕走 message action（送 `/explore end` 文字）→ 走既有 handleExploreCommand_ 分流，
 *  零新 handler；displayText 讓使用者看到「他自己」按了離開、行為一致。 */
function explorationLeaveQuickReplyItem_(label) {
  const short = truncate_(label || '', 6);   // LINE quick reply label ≈ 20 bytes，留餘裕給「離開 」
  return {
    type: 'action',
    action: { type: 'message', label: `離開 ${short}`, text: '/explore end' }
  };
}

/** exploration 進行中專用：給 buffer 最後一則訊息掛「離開 X」quick reply（**僅在 bot 本來就會
 *  reply 時**——這函式只在 Router flush 前被呼叫，沒 reply 就不會掛，不打破節流）。
 *  ensureSessionQuickReply_（askDialog）優先：若最後一則已有 qr 就不覆蓋。 */
function ensureExplorationQuickReply_(scope) {
  if (!_replyBuffer || !_replyBuffer.messages.length) return;
  const al = activeExploration_(scope);
  if (!al) return;
  const msgs = _replyBuffer.messages;
  const lastSent = msgs[Math.min(msgs.length, 5) - 1];   // LINE 一次最多送 5 則，qr 顯示在最後送出那則
  if (lastSent && !lastSent.quickReply) {
    lastSent.quickReply = { items: [explorationLeaveQuickReplyItem_(al.label)] };
  }
}

/* ============================ 到期前提醒 ============================ */

/** 背景 sweep 兜底：對 active exploration 在剩 ≤leadMinutes 時 push 一次提醒，warnedAt 去重。
 *  只在使用者活動少時起作用——多數情況使用者自己會看時間，提醒只是兜底安全網。 */
function maybeWarnExplorationExpiring_(scope) {
  const al = activeExploration_(scope);   // 順手做了惰性到期檢查
  if (!al) return;
  if (al.plannedMinutes < EXPLORATION_EXPIRY_WARN.minExplorationMinutes) return;   // 太短的不提醒
  if (al.warnedAt) return;                                                // 每段最多一次
  const remainMs = Date.parse(al.startTs) + al.plannedMinutes * 60000 - Date.now();
  const leadMs = EXPLORATION_EXPIRY_WARN.leadMinutes * 60000;
  if (remainMs > leadMs || remainMs <= 0) return;                        // 還早 / 已到期（讓自動關閉那條路處理）
  const remainMin = Math.max(1, Math.round(remainMs / 60000));
  try {
    const uid = al.userId || (scope && scope.type === 'user' ? scope.id : null);
    if (uid) linePush_(uid, `⏰「${truncate_(al.label, 20)}」還剩約 ${remainMin} 分鐘。\n要結束就 /explore end，繼續寫就照常。`);
  } catch (e) {
    console.warn('exploration expiry warn push failed:', e && e.message);
    return;
  }
  // 標記已提醒（先 push 成功才寫，避免推播失敗下次不再嘗試）。
  const rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE));
  const exploration = rows.find(l => l.id === al.id);
  if (exploration) { exploration.warnedAt = new Date().toISOString(); upsertJsonl_(scope, EXPLORATIONS_FILE, exploration); }
}

// exploration 軸自己的視覺語彙：開始用較亮的 l1（如鐘響開課）、結束用較深的 l2（收束的下課鐘）。
// 沿用 THEME.depth 既有色階，不另定義新的色票體系（避免色彩漂移）。

/* ============================ /me 儀表板統計 ============================ */

/** 給 /me 用的 exploration 統計。30 天滾動視窗（與 records.month 同尺度）。
 *  - total: 全部節數（含進行中）
 *  - closed: 已結束節數
 *  - month: 30 天內結束 + 進行中
 *  - monthMinutes: 30 天內節課總時長
 *  - active: 進行中 exploration（label / 剩餘分鐘）或 null
 */
function gatherExplorationStats_(scope, monthAgo) {
  let rows = [];
  try { rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE)); }
  catch (_) {}
  const now = Date.now();
  const monthAgoMs = monthAgo.getTime();
  let monthCount = 0, monthMinutes = 0, closedTotal = 0;
  let active = null;
  for (const l of rows) {
    if (!l || !l.startTs) continue;
    const start = Date.parse(l.startTs);
    const end = l.endTs ? Date.parse(l.endTs) : now;
    const mins = Math.max(0, Math.round((end - start) / 60000));
    if (l.status === 'closed') closedTotal++;
    if (start >= monthAgoMs || end >= monthAgoMs) {
      monthCount++;
      monthMinutes += mins;
    }
    if (l.status === 'active') {
      const expires = (loadChatMeta_(scope).activeExplorationExpiresAt) || (start + (l.plannedMinutes || 0) * 60000);
      const remain = Math.max(0, Math.round((expires - now) / 60000));
      active = { label: l.label, remainMinutes: remain };
    }
  }
  return {
    total: rows.length,
    closed: closedTotal,
    month: monthCount,
    monthMinutes: monthMinutes,
    active: active
  };
}

/* ---- 過去探索列表（/explore 無進行中時、/explore list [關鍵字] 任何時候）---- */

const EXPLORATION_LIST_PER_PAGE = 8;

/** 過去探索列表 flex 卡（含分頁、關鍵字過濾）。
 *  opts = { page, query }；page 0-based；query 為 label 模糊比對（substring，大小寫不敏感）。
 *  totalPages > 1 時用 buildPaginationBubble_ 多送一張 pager（同 /recall、/journey 模式）。 */
function replyExplorationsList_(ctx, opts) {
  opts = opts || {};
  const query = (opts.query || '').trim();
  const qLower = query.toLowerCase();
  const raw = loadJsonl_(chatJsonlFile_(ctx.scope, EXPLORATIONS_FILE));

  // 每個探索 records 的首末 ts ＋ ids（單一真相 explorationId）：給「資料起迄」「精確筆數」
  // 與下方孤兒修復回填 recordIds 共用。
  const byExp = {};
  loadEmbeddingRecords_(ctx.scope).forEach(r => {
    if (!r || !r.explorationId) return;
    const t = Date.parse(r.ts); if (isNaN(t)) return;
    const g = byExp[r.explorationId] || (byExp[r.explorationId] = { first: t, last: t, ids: [] });
    if (t < g.first) g.first = t;
    if (t > g.last) g.last = t;
    g.ids.push(r.id);
  });
  const recCount = id => (byExp[id] ? byExp[id].ids.length : 0);

  // 防禦性清理：① 已結束、0 筆的空白列刪掉（按錯遺留）；② **孤兒「進行中」**——最多一節真正
  // 進行中（meta 追蹤的那節，liveId）；其他 status='active' 的列＝舊測試/異常殘留（關不掉的
  // 進行中），自動關閉（endTs 用最後一則 ts、回填 recordIds），避免列表永遠卡著。
  const live = activeExploration_(ctx.scope);   // 順手結算到期；回真正進行中的那節或 null
  const liveId = live ? live.id : null;
  let changed = false;
  let cleaned = raw.filter(l => {
    if (l && l.status === 'closed' && recCount(l.id) === 0 && !(l.recordIds || []).length) { changed = true; return false; }
    return true;
  });
  cleaned.forEach(l => {
    if (l && l.status === 'active' && l.id !== liveId) {
      const g = byExp[l.id];
      l.status = 'closed';
      l.endTs = (g && g.last) ? new Date(g.last).toISOString() : (l.endTs || new Date().toISOString());
      if (g) l.recordIds = g.ids;
      changed = true;
    }
  });
  if (changed) {
    try { saveJsonl_(ctx.scope, EXPLORATIONS_FILE, cleaned); }
    catch (e) { console.warn('exploration list repair failed:', e && e.message); }
  }
  const all = cleaned.slice()
    .sort((a, b) => Date.parse(b.startTs || 0) - Date.parse(a.startTs || 0));
  const filtered = query
    ? all.filter(l => ((l.label || '').toLowerCase()).indexOf(qLower) >= 0)
    : all;

  if (!filtered.length) {
    if (query) {
      return lineReply_(ctx.replyToken,
        `找不到 label 含「${truncate_(query, 20)}」的探索。\n/explore list 看全部、或開新的一節：/explore <名稱> [分鐘]`);
    }
    return lineReply_(ctx.replyToken,
      '還沒有任何探索紀錄。\n開始一節：/explore <名稱> [分鐘]\n例：/explore 高三物理 50');
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / EXPLORATION_LIST_PER_PAGE));
  let page = opts.page || 0;
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  const pageRows = filtered.slice(page * EXPLORATION_LIST_PER_PAGE, (page + 1) * EXPLORATION_LIST_PER_PAGE);

  // 導覽卡（index 0）＋列表卡（rows，分頁），比照 /journey、/recall 的總覽→明細結構，
  // 讓探索變多時一眼看見全貌、再滑右看每一節。
  const navBubble = buildExplorationsNavBubble_(all, filtered.length, query);
  const listBubble = buildExplorationsListBubble_(filtered.length, all.length, query, page, totalPages, pageRows, byExp);
  const carousel = { type: 'carousel', contents: [navBubble, listBubble] };
  const headTitle = query ? `過去的探索「${truncate_(query, 14)}」` : '過去的探索';
  const altText = totalPages > 1
    ? `${headTitle} · 第 ${page + 1}/${totalPages} 頁（${filtered.length}）`
    : `${headTitle} · ${filtered.length} 節`;

  if (totalPages <= 1) {
    return lineReplyFlex_(ctx.replyToken, altText, carousel);
  }
  const qEnc = query ? `&q=${encodeURIComponent(query)}` : '';
  const pagerTitle = `👉 ${headTitle}（${filtered.length} 節 / ${totalPages} 頁）`;
  lineReplyMessages_(ctx.replyToken, [
    { type: 'flex', altText: altText, contents: carousel },
    { type: 'flex', altText: `分頁（第 ${page + 1}/${totalPages} 頁）`,
      contents: buildPaginationBubble_(pagerTitle, page, totalPages, p => `action=explore_list&p=${p}${qEnc}`) }
  ]);
}

/** 探索總覽（列表 index 0 導覽卡）：節數、進行中/已結束、跨度、進行中主題名、篩選結果＋指令。 */
function buildExplorationsNavBubble_(all, filteredN, query) {
  const tier = THEME.depth.l1;
  const totalN = all.length;
  const activeRows = all.filter(l => l && l.status === 'active');
  const activeN = activeRows.length;
  const closedN = totalN - activeN;
  const fmt = ts => ts ? Utilities.formatDate(new Date(ts), TIME_ZONE, 'MM/dd') : '—';
  const rangeStr = totalN ? `${fmt(all[totalN - 1].startTs)} – ${fmt(all[0].startTs)}` : '—';
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: String(totalN), size: '3xl', weight: 'bold', color: tier.accent, flex: 0 },
      { type: 'text', text: '節探索', size: 'sm', color: THEME.muted, flex: 0, gravity: 'bottom' }
    ]},
    { type: 'text', text: `🎒 ${activeN} 進行中　📦 ${closedN} 已結束`, size: 'xs', color: THEME.textBody, margin: 'sm', wrap: true },
    { type: 'text', text: `橫跨 ${rangeStr}`, size: 'xxs', color: THEME.muted, margin: 'xs' }
  ];
  if (activeN) body.push({ type: 'text', text: `進行中：${activeRows.map(l => truncate_(l.label || '未命名', 12)).join('、')}`, size: 'xxs', color: THEME.cta, wrap: true, margin: 'xs' });
  if (query) body.push({ type: 'text', text: `篩選「${truncate_(query, 14)}」：${filteredN} 節`, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' });
  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: '指令', size: 'xxs', color: THEME.muted, margin: 'md' });
  body.push({ type: 'text', text: '開始／延續：/explore <名稱> [分鐘]', size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  body.push({ type: 'text', text: '（同名＝自動接續同一主題、不另開重複）', size: 'xxs', color: THEME.muted, wrap: true });
  body.push({ type: 'text', text: '篩選：/explore list <關鍵字>　結束：/explore end', size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
  body.push({ type: 'text', text: '👉 滑右邊看每一節 →', size: 'xs', color: THEME.textBody, wrap: true, margin: 'md' });
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['探索敘事段', '總覽'], tier),
        { type: 'text', text: '🎒 探索總覽', size: 'lg', weight: 'bold', color: tier.headerText, margin: 'xs' }
      ] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'none', contents: body }
  };
}

function buildExplorationsListBubble_(filteredN, totalN, query, page, totalPages, pageRows, byExp) {
  byExp = byExp || {};
  const fmtFull = t => Utilities.formatDate(new Date(t), TIME_ZONE, 'MM/dd HH:mm');
  const fmtHM = t => Utilities.formatDate(new Date(t), TIME_ZONE, 'HH:mm');
  const sameDay = (a, b) => Utilities.formatDate(new Date(a), TIME_ZONE, 'yyyyMMdd') === Utilities.formatDate(new Date(b), TIME_ZONE, 'yyyyMMdd');
  const items = pageRows.map(l => {
    const g = byExp[l.id];
    // 資料起迄：用 records 首末 ts（同分鐘只顯一個；同日省略末端日期）；無 records 退回 startTs。
    let dateStr;
    if (g) dateStr = (g.first === g.last) ? fmtFull(g.first)
      : `${fmtFull(g.first)} – ${sameDay(g.first, g.last) ? fmtHM(g.last) : fmtFull(g.last)}`;
    else dateStr = l.startTs ? fmtFull(l.startTs) : '—';
    const n = g ? g.ids.length : (l.recordIds || []).length;
    const isActive = l.status === 'active';
    const statusIcon = isActive ? '🎒' : '📦';
    const statusText = isActive ? '進行中' : '已結束';
    const label = truncate_(l.label || '未命名', 16);
    return {
      type: 'box', layout: 'horizontal', backgroundColor: THEME.surface,
      cornerRadius: 'md', paddingAll: 'md', margin: 'sm', spacing: 'sm',
      action: { type: 'postback', label: '看記寫',
        data: `action=explore_view&lid=${l.id}`, displayText: opEcho_('看記寫', label) },
      contents: [
        { type: 'text', text: statusIcon, size: 'lg', flex: 0, gravity: 'center' },
        { type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: label, size: 'sm', weight: 'bold', color: THEME.ink, wrap: true },
          { type: 'text', text: `${dateStr} · ${n} 筆 · ${statusText}`,
            size: 'xxs', color: THEME.muted, margin: 'xs' }
        ]},
        { type: 'text', text: '›', size: 'sm', color: THEME.cta, weight: 'bold',
          flex: 0, align: 'end', gravity: 'center' }
      ]
    };
  });

  const subtitle = query
    ? `「${truncate_(query, 14)}」· ${filteredN}/${totalN} 節${totalPages > 1 ? ` · 第 ${page + 1}/${totalPages} 頁` : ''}`
    : `共 ${totalN} 節${totalPages > 1 ? ` · 第 ${page + 1}/${totalPages} 頁` : ''}`;
  const hint = query
    ? '點一段看記寫；/explore list 清掉篩選'
    : '點一段看記寫；/explore list <關鍵字> 篩 label；或 /explore <名稱> [分鐘] 開新的';

  const body = [
    { type: 'text', text: subtitle, size: 'xs', color: THEME.textBody, wrap: true },
    { type: 'text', text: hint, size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' },
    { type: 'separator', margin: 'md' }
  ].concat(items);

  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [{ type: 'text', text: query ? `🎒 過去的探索・${truncate_(query, 12)}` : '🎒 過去的探索',
        size: 'md', weight: 'bold', color: THEME.onDark }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: body }
  };
}

function explorationRangeText_(exploration) {
  if (!exploration || !exploration.startTs) return '';
  const start = Utilities.formatDate(new Date(exploration.startTs), TIME_ZONE, 'MM/dd HH:mm');
  const endIso = exploration.endTs || new Date(Date.parse(exploration.startTs) + (exploration.plannedMinutes || 0) * 60000).toISOString();
  const sameDay = Utilities.formatDate(new Date(exploration.startTs), TIME_ZONE, 'yyyy-MM-dd')
              === Utilities.formatDate(new Date(endIso), TIME_ZONE, 'yyyy-MM-dd');
  const end = Utilities.formatDate(new Date(endIso), TIME_ZONE, sameDay ? 'HH:mm' : 'MM/dd HH:mm');
  return `${start}–${end}`;
}

/** 開始卡：鐘響開課的儀式感。深色 header + 大字 exploration 名 + 預定資訊 + 結束按鈕。 */
function buildExplorationStartBubble_(exploration, opts) {
  opts = opts || {};
  const resumed = !!opts.resumed;
  const tier = THEME.depth.l1;
  // 延續時用 resumedAt 當「本段」視窗起點（startTs 是這個主題最初開始的時間，沿用會算錯）。
  const sessionStart = (resumed && exploration.resumedAt) ? exploration.resumedAt : exploration.startTs;
  const startHM = Utilities.formatDate(new Date(sessionStart), TIME_ZONE, 'HH:mm');
  const endIso = new Date(Date.parse(sessionStart) + exploration.plannedMinutes * 60000).toISOString();
  const endHM = Utilities.formatDate(new Date(endIso), TIME_ZONE, 'HH:mm');
  const bodyContents = [
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: '預定', size: 'xs', color: THEME.muted, flex: 0 },
      { type: 'text', text: `${exploration.plannedMinutes} 分鐘`, size: 'sm', color: THEME.textBody, weight: 'bold', flex: 0 },
      { type: 'text', text: `${startHM} → ${endHM}`, size: 'xs', color: THEME.textDim, align: 'end' }
    ]},
    { type: 'separator', margin: 'sm' }
  ];
  if (resumed) {
    // UI 明確提示「這是延續、不是新開」。
    bodyContents.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
      contents: [
        { type: 'text', text: `🔁 延續同主題・已有 ${opts.priorN || 0} 則`, size: 'xs', weight: 'bold', color: THEME.cta, wrap: true },
        { type: 'text', text: '同名主題已存在，這次接續它——新寫的會併進同一條，不另開重複的探索。', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
      ]
    });
    // 「上次寫到」：列最後幾則，讓學習者一眼接回上次的脈絡。
    if (opts.recent && opts.recent.length) {
      const items = [{ type: 'text', text: `📝 上次寫到（最後 ${opts.recent.length} 則）`, size: 'xxs', weight: 'bold', color: THEME.muted, margin: 'md' }];
      opts.recent.forEach(r => {
        const t = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
        const icon = (typeof EPISODE_TYPE_ICON !== 'undefined' && EPISODE_TYPE_ICON[r.type]) || '·';
        const txt = truncate_((r.text || '').replace(/\s+/g, ' ').trim(), 36) || `（${typeLabel_(r.type)}）`;
        items.push({ type: 'text', text: `${t} ${icon} ${txt}`, size: 'xxs', color: THEME.textBody, wrap: true, margin: 'xs' });
      });
      bodyContents.push({ type: 'box', layout: 'vertical', spacing: 'none', margin: 'sm', contents: items });
    }
  } else {
    bodyContents.push({ type: 'text', text: '期間每一則都會被記進這次探索；到時自動收尾，也能隨時手動結束。',
      size: 'xs', color: THEME.textBody, wrap: true, margin: 'sm' });
  }
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['探索敘事段', resumed ? '延續這次探索' : '開始這次探索'], tier),
        { type: 'text', text: `🎒 ${truncate_(exploration.label, 18)}`, size: 'lg', weight: 'bold',
          color: tier.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: bodyContents
    },
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.surfaceSoft, cornerRadius: 'md',
      paddingAll: 'sm', margin: 'none',
      action: { type: 'message', label: `結束 ${truncate_(exploration.label, 6)}`, text: '/explore end' },
      contents: [{ type: 'text', text: `／ 結束這次探索（${truncate_(exploration.label, 10)}）／`,
        size: 'xs', color: THEME.cta, align: 'center', weight: 'bold' }]
    }
  };
}

/** 結束卡：下課的儀式感。深色 header + 統計（時長/筆數/媒介組成）+「看本次探索所有記寫」主 CTA。
 *  opts.overview = true 時改用「回顧/進行中」麵包屑（exploration view 第 0 張總覽用，與 end 時刻不同）。 */
function buildExplorationEndBubble_(scope, exploration, opts) {
  opts = opts || {};
  const isOverview = !!opts.overview;
  const isActive = exploration && exploration.status === 'active';
  const tier = THEME.depth.l2;
  // 麵包屑與 icon 依場景變：
  //   end 時刻（預設）         → 📦 探索敘事段 › 結束這次探索（強調「結束」這個動作）
  //   view 入口・已結束         → 📦 探索 › 回顧（強調「回頭看」）
  //   view 入口・進行中         → 🎒 探索 › 進行中
  let crumbs, headerIcon;
  if (isOverview && isActive) { crumbs = ['探索', '進行中']; headerIcon = '🎒'; }
  else if (isOverview)        { crumbs = ['探索', '回顧'];   headerIcon = '📦'; }
  else                        { crumbs = ['探索敘事段', '結束這次探索']; headerIcon = '📦'; }
  const startTs = Date.parse(exploration.startTs || 0);
  const endTs = Date.parse(exploration.endTs || new Date().toISOString());
  const mins = Math.max(1, Math.round((endTs - startTs) / 60000));
  // 從 record.explorationId 反查（單一真相）；exploration.recordIds 是快取，作 fallback。
  let records = [];
  try { records = loadEmbeddingRecords_(scope).filter(r => r && r.explorationId === exploration.id); }
  catch (e) { console.warn('buildExplorationEndBubble_ load records failed:', e && e.message); }
  const n = records.length || (exploration.recordIds || []).length;
  const comp = {};
  records.forEach(r => { comp[r.type] = (comp[r.type] || 0) + 1; });
  const compStr = Object.keys(comp).length
    ? Object.keys(comp).map(t => `${EPISODE_TYPE_ICON[t] || '·'}${comp[t]}`).join('  ')
    : '—';
  // 記寫時間分布 strip：導覽卡無「焦點」記錄 → 全部以中性 ● 顯示密度（非綠 ✓ 命中），空檔 ◯。
  // 軸用記錄實際 min/max（比 exploration.startTs/endTs 準）。放 body 最末（同 §九 編排）。
  const recTs = records.map(r => Date.parse(r.ts)).filter(t => !isNaN(t));
  const sStart = recTs.length ? Math.min.apply(null, recTs) : startTs;
  const sEnd = recTs.length ? Math.max.apply(null, recTs) : endTs;
  const distStrip = (sEnd > sStart) ? episodeTimelineStrip_({
    startTs: sStart, endTs: sEnd, records: [], otherRecords: records,
    headText: `本次探索記寫時間分布 · ${formatClusterRange_(sStart, sEnd)}`
  }) : null;
  const bodyContents = [
    { type: 'text', text: compStr, size: 'sm', weight: 'bold', color: tier.accent },
    { type: 'text', text: `${mins} 分鐘 · ${n} 筆記錄`, size: 'xxs', color: THEME.muted, margin: 'xs' },
    { type: 'separator', margin: 'sm' },
    { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm', contents: [
      { type: 'text', text: '區段', size: 'xs', color: THEME.muted, flex: 0 },
      { type: 'text', text: explorationRangeText_(exploration), size: 'xs', color: THEME.textBody, wrap: true }
    ]}
  ];
  if (distStrip) bodyContents.push(distStrip);
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(crumbs, tier),
        { type: 'text', text: `${headerIcon} ${truncate_(exploration.label, 18)}`, size: 'lg', weight: 'bold',
          color: tier.headerText, wrap: true, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: bodyContents }
  };
  // 「看本次探索所有記寫」CTA 只在 end 時刻（單卡）需要；overview 導覽卡後面就接著瀏覽卡，
  // 這顆按鈕多餘 → 不放（回應使用者：第一張卡那顆 17 筆按鈕其實多餘）。
  if (!isOverview) {
    bubble.footer = {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md',
      paddingAll: 'sm', margin: 'none',
      action: { type: 'postback', label: '看本次探索所有記寫',
        data: `action=explore_view&lid=${exploration.id}`, displayText: opEcho_('看本次探索記寫', exploration.label) },
      contents: [{ type: 'text', text: `📂 看本次探索所有記寫（${n} 筆）`,
        size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }]
    };
  }
  return bubble;
}

/* ============================ Stage 5 卡片整合 ============================ */

// 純顯示，零邏輯：脈絡/歷程詳情卡上多一列「🎒 主要發生於『X』」，X = 該脈絡 ≥ 半數成員所屬
// 的那段 exploration。占比不到一半就不顯示——避免「橫跨多段的脈絡」誤指單一節為主場。
// 每次 buildContextCard_ render 重新讀 explorations.jsonl 太貴，per-execution 用 _explorationLabelCache
// 快取（一次 webhook 處理期間共用，下次 webhook 自然重抓）。

let _explorationLabelCache = null;

/** explorationId → label 的快取表（per-execution，scope-keyed）。*/
function explorationLabelsByScope_(scope) {
  if (!_explorationLabelCache) _explorationLabelCache = {};
  const k = scope && scope.key;
  if (!k) return {};
  if (_explorationLabelCache[k]) return _explorationLabelCache[k];
  const map = {};
  try { loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE)).forEach(l => { if (l && l.id) map[l.id] = l.label || ''; }); }
  catch (_) {}
  _explorationLabelCache[k] = map;
  return map;
}

/** 算「主要發生於」label：recs 內 explorationId 眾數，占比 ≥ 50% 才回 label，否則 null。 */
function dominantExplorationLabel_(scope, recs) {
  if (!recs || !recs.length) return null;
  const votes = {};
  let total = 0;
  for (const r of recs) {
    if (!r || !r.explorationId) continue;
    votes[r.explorationId] = (votes[r.explorationId] || 0) + 1;
    total++;
  }
  if (!total) return null;
  let topId = '', topN = 0;
  for (const id in votes) if (votes[id] > topN) { topN = votes[id]; topId = id; }
  if (topN * 2 < recs.length) return null;   // < 50%
  return explorationLabelsByScope_(scope)[topId] || null;
}

/** 數 records 內出現多少個不同的 explorationId（給 /episodes 索引卡 "🎒 N 探索" 用）。 */
function distinctExplorationCount_(recs) {
  if (!recs || !recs.length) return 0;
  const ids = new Set();
  for (const r of recs) if (r && r.explorationId) ids.add(r.explorationId);
  return ids.size;
}

/** 給 episode 卡用：無閾值（只要有探索就標），按 distinct 數切文案。回字串或 null。
 *  - 1 個探索 → 「🎒 屬於：X」
 *  - 2 個 → 「🎒 屬於：X、Y」（簡短時）
 *  - 3+ → 「🎒 跨 N 探索」 */
function explorationLineForEpisode_(scope, recs) {
  if (!recs || !recs.length) return null;
  const labelMap = explorationLabelsByScope_(scope);
  const counts = {};
  for (const r of recs) if (r && r.explorationId) counts[r.explorationId] = (counts[r.explorationId] || 0) + 1;
  const ids = Object.keys(counts);
  if (!ids.length) return null;
  if (ids.length === 1) {
    return `🎒 屬於：${truncate_(labelMap[ids[0]] || '', 18)}`;
  }
  if (ids.length === 2) {
    const a = labelMap[ids[0]] || '';
    const b = labelMap[ids[1]] || '';
    if (a && b) return `🎒 屬於：${truncate_(a, 9)}、${truncate_(b, 9)}`;
  }
  return `🎒 跨 ${ids.length} 探索`;
}

/** 卡片用：回一個「🎒 主要發生於『X』」flex text 片段，或 null。供 buildContextCard_ 嵌入 body。 */
function dominantExplorationLineForCard_(scope, recs) {
  const label = dominantExplorationLabel_(scope, recs);
  if (!label) return null;
  return {
    type: 'text',
    text: `🎒 主要發生於『${truncate_(label, 18)}』`,
    size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs'
  };
}

/**
 * 一次性 exploration 查找器，給 /themes 卡在「主題」層（L0 列／L1 卡）標來源用：
 * 建好 recordId→explorationId 索引（只收有 explorationId 的 record，省記憶體），
 * 回傳 `count(recordIds)` → 該主題內有幾則記寫是在某段 explore 裡寫的（不限同一段）。
 * 純 metadata、不參與聚類。recs 可選傳入已載的 record 陣列（如 replyThemeCategories_
 * 已 loadEmbeddingRecords_），省重載。
 */
function buildExplorationLookup_(scope, recs) {
  const records = recs || loadEmbeddingRecords_(scope);
  const byRecord = {};
  for (const r of records) if (r && r.explorationId) byRecord[r.id] = r.explorationId;
  return {
    count: function (recordIds) {
      if (!recordIds || !recordIds.length) return 0;
      let n = 0;
      for (const id of recordIds) if (byRecord[id]) n++;
      return n;
    }
  };
}

/* ============================ 看本次探索所有記寫 ============================ */

/** explore_view postback：列出該次探索內所有記錄，按時間排序 + 用既有 episode bubble 渲染。
 *  records pool = record.explorationId === lid（單一真相）；空時回友善文字。 */
function replyExplorationView_(ev, scope, explorationId) {
  const exploration = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE)).find(l => l.id === explorationId);
  if (!exploration) return lineReply_(ev.replyToken, '⚠️ 找不到該次探索（可能已被刪除）。');
  const records = loadEmbeddingRecords_(scope)
    .filter(r => r && r.explorationId === explorationId && r.ts)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!records.length) {
    return lineReply_(ev.replyToken, `📦「${truncate_(exploration.label, 20)}」這次探索還沒有任何記錄。`);
  }

  // typing indicator while we build (1-on-1 only).
  if (scope && scope.type === 'user') { try { showLoadingAnimation_(scope.id, 30); } catch (_) {} }

  const episodes = groupByEpisode_(records, EPISODE_GAP_MS);
  // 一節課通常 1-2 段；極端情形（4 小時跨多次休息）取最近 EPISODE_MAX_CARDS 段，避免炸卡。
  const recent = episodes.slice().reverse().slice(0, EPISODE_MAX_CARDS);
  const dayStr = Utilities.formatDate(new Date(recent[0].startTs), TIME_ZONE, 'yyyy-MM-dd');

  const startMs = Math.min.apply(null, episodes.map(e => e.startTs));
  const endMs = Math.max.apply(null, episodes.map(e => e.endTs));
  const allRecs = episodes.reduce((acc, e) => acc.concat(e.records || []), []);
  let freshBudget = EPISODE_NARRATIVE_BUDGET;
  const bubbles = recent.map(ep => {
    let narrative = episodeNarrativeCached_(ep);
    if (!narrative && ep.records.length >= 2 && freshBudget > 0) {
      narrative = episodeNarrativeGenerate_(ep);
      freshBudget--;
    }
    let strip = null;
    if (endMs > startMs) {
      const epIds = {}; ep.records.forEach(r => { epIds[r.id] = 1; });
      strip = episodeTimelineStrip_({
        startTs: startMs, endTs: endMs,
        records: ep.records,
        otherRecords: allRecs.filter(r => !epIds[r.id]),
        subLabel: `本次探索 ${formatClusterRange_(startMs, endMs)}`,
        headPrefix: '所選敘事片段'
      });
    }
    return buildEpisodeBubble_(ep, narrative, dayStr, {
      crumbs: ['探索', truncate_(exploration.label, 14), dayStr.slice(5)],
      strip,
      // 預設 rawData 用 day-scoped、找不到——本次探索的 ep.startTs 是「exploration 內第一筆」，
      // 同 30 分內的 exploration 外記錄會被合進更大的 day-episode，find(startTs===) 找不到。
      // 改用 exploration-scoped raw handler，records pool 跟 view 路徑一致。
      rawData: `action=explore_raw&lid=${explorationId}&s=${ep.startTs}`
    });
  });

  // 第 0 張：總覽卡（複用結束卡，但傳 overview:true 用「探索 › 回顧/進行中」麵包屑，
  // 區別於 end 時刻的「結束這次探索」）。active exploration 也能算統計：endTs 缺時 fallback 到 now。
  // 11 張 ≤ LINE carousel 12 張上限（EPISODE_MAX_CARDS=10 → 1 + 10 = 11）。
  const overview = buildExplorationEndBubble_(scope, exploration, { overview: true });
  const finalBubbles = [overview].concat(bubbles);
  const contents = finalBubbles.length === 1 ? finalBubbles[0] : { type: 'carousel', contents: finalBubbles };
  const capped = episodes.length > recent.length ? `（顯示最近 ${recent.length} 段）` : '';
  lineReplyFlex_(ev.replyToken,
    `📦「${truncate_(exploration.label, 20)}」這次探索 ${episodes.length} 段 · ${records.length} 筆${capped}`,
    contents);
}

/** explore_raw postback：展開該次探索內某一段敘事的原始記錄。仿 replyContextRaw_，差別在
 *  records pool 換成「explorationId === lid」，避免被同 30 分內的 exploration 外記錄拉走 startTs 邊界。 */
function replyExplorationRaw_(ev, scope, explorationId, startTs, page) {
  const all = loadEmbeddingRecords_(scope).filter(r => r && r.ts);
  const lessonRecs = all
    .filter(r => r.explorationId === explorationId)
    .sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  if (!lessonRecs.length) return lineReply_(ev.replyToken, '找不到該次探索的記錄。');
  const ep = groupByEpisode_(lessonRecs, EPISODE_GAP_MS).find(e => e.startTs === startTs);
  if (!ep) return lineReply_(ev.replyToken, '找不到該敘事片段（紀錄可能已變動）。');
  // 暫不傳 epRef → 不掛「整段改歸主題」quick reply（要做的話需擴 episodeRecordsFromRef_ 支援
  // mode=exploration；先把核心「看不到原始紀錄」修好）。
  renderEpisodeRaw_(ev, all, ep, page || 0,
    p => `action=explore_raw&lid=${explorationId}&s=${startTs}&p=${p}`,
    null, scope);
}

/* ============================ 診斷（editor 直跑） ============================ */

/** 印 OWNER scope 的進行中 exploration 與 meta 兩欄。 */
function debugActiveExploration() {
  const scope = ownerScope_();
  const meta = loadChatMeta_(scope);
  console.log('meta.activeExplorationId =', meta.activeExplorationId || '(none)',
    '| expiresAt =', meta.activeExplorationExpiresAt
      ? new Date(meta.activeExplorationExpiresAt).toISOString() + (Date.now() > meta.activeExplorationExpiresAt ? ' (EXPIRED)' : '')
      : '(none)');
  console.log('activeExploration_ =>', JSON.stringify(activeExploration_(scope)));
}

/** 印 OWNER scope 全部 exploration。 */
function debugExplorationList() {
  const scope = ownerScope_();
  const rows = loadJsonl_(chatJsonlFile_(scope, EXPLORATIONS_FILE));
  console.log(`explorations = ${rows.length}`);
  rows.slice().sort((a, b) => Date.parse(b.startTs || 0) - Date.parse(a.startTs || 0)).forEach(l => {
    console.log(`[${l.status}] ${l.label} · ${l.plannedMinutes}分 · ${(l.recordIds || []).length}則 · ${l.startTs}${l.endTs ? ' → ' + l.endTs : ''}`);
  });
}

/* 〔2026-06-03 刪除〕runExplorationClusterNow / debugSuggestFor：隨「寫時延續建議」整套移除。 */
