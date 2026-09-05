/**
 * Dispatch a single LINE webhook event to the appropriate handler.
 *
 * Handles:
 *   - message events  → existing ingest pipeline (text / image / audio / video / file)
 *   - follow / join   → ensure the chat folder + meta.json exist
 *   - unfollow / leave → mark chat archivedAt
 *   - memberJoined / memberLeft → keep meta.members up to date
 */
function routeEvent_(ev) {
  const scope = scopeFromEvent_(ev);
  if (!scope) return;

  switch (ev.type) {
    case 'follow': {
      const isNewOwner = maybeClaimOwner_(scope);
      chatFolder_(scope);
      // Re-follow by a previously blocked member → restore their prior status.
      maybeUnblockOnRefollow_(scope);
      if (ev.replyToken) lineReplyFlex_(ev.replyToken, '歡迎使用 WriteToLearn — 學習歷程 Bot', welcomeFlex_(scope, { isNewOwner }));
      return;
    }

    case 'join':
      chatFolder_(scope);
      if (ev.replyToken) lineReplyFlex_(ev.replyToken, '歡迎使用 WriteToLearn — 學習歷程 Bot', welcomeFlex_(scope, {}));
      return;

    case 'unfollow':
    case 'leave':
      // 1-on-1 unfollow = user blocked / removed the bot. Mark them blocked
      // in the access list + notify OWNER (1 push). Folder archived as before.
      if (ev.type === 'unfollow' && scope.type === 'user') {
        markMemberBlockedAndNotifyOwner_(scope);
      }
      if (chatFolderExists_(scope)) {
        updateChatMeta_(scope, (m) => {
          m.archivedAt = new Date(ev.timestamp || Date.now()).toISOString();
          return m;
        });
      }
      return;

    case 'memberJoined':
      maybeMarkOwnerChatFromJoin_(scope, ev);
      return handleMemberJoined_(ev, scope);

    case 'memberLeft':
      maybeUnmarkOwnerChatFromLeft_(scope, ev);
      return handleMemberLeft_(ev, scope);

    case 'unsend':
      // 使用者在 LINE 收回訊息 → LINE 只給被收回的 messageId（不含內容）。用 lineMessageId
      // 對應回 record，比照 /del 從脈絡移除（不再被 /recall、/ask 搜到、不進主題）；
      // 聊天室原訊息已被使用者收回、transcript 一併清。語意＝「收回＝反悔」。
      return handleUnsend_(ev, scope);

    case 'message':
      // OWNER speaking in a group/room implicitly activates that chat for all
      // its members (we can't query LINE for group membership directly).
      maybeMarkOwnerChatFromActivity_(scope, ev);
      startReplyBuffer_();
      try {
        handleMessage_(ev, scope);
        sweepStalePendings_(scope, ev.timestamp || Date.now());
      } finally {
        ensureSessionQuickReply_(scope);
        ensureExplorationQuickReply_(scope);   // askDialog 優先（先掛者贏）；exploration 進行中時補位「離開 X」
        flushReplyBuffer_(ev.replyToken);
      }
      return;

    case 'postback':
      maybeMarkOwnerChatFromActivity_(scope, ev);
      startReplyBuffer_();
      try {
        handlePostback_(ev, scope);
        sweepStalePendings_(scope, ev.timestamp || Date.now());
      } finally {
        ensureSessionQuickReply_(scope);
        ensureExplorationQuickReply_(scope);   // askDialog 優先（先掛者贏）；exploration 進行中時補位「離開 X」
        flushReplyBuffer_(ev.replyToken);
      }
      return;

    default:
      return;
  }
}

function handleMessage_(ev, scope) {
  const m = ev.message;
  const ctx = {
    scope,
    replyToken: ev.replyToken,
    userId: scope.userId,
    timestamp: ev.timestamp,
    messageId: m.id,
    quoteToken: m.quoteToken || null,
    quotedMessageId: m.quotedMessageId || null,
    duration: m.duration || null
  };
  if (m.type === 'text') return handleText_(ctx, m.text);

  // 〔暫時·診斷〕測試模式：非文字訊息一律忽略、不記錄（文字另在 handleText_ 內處理）。
  if (testModeActive_(scope)) return lineReply_(ctx.replyToken, '🧪 測試模式：非文字訊息已忽略（未記錄）。打 /test end 離開。');

  // Conversational ask mode accepts only text (a question turn) and stickers
  // (a focus / emotional steer). Anything else leaves the session and fires
  // the question honed so far — see handleAskInterrupt_.
  if (askDialogActive_(scope)) {
    const s = loadAskDialog_(scope);
    if (s && s.mode === 'supplement') {
      // 補充模式＝累積進凝聚卡、不離開。貼圖→情緒 emoji 併入凝聚段落（handleSuppStickerTurn_）。
      if (m.type === 'sticker') return handleSuppStickerTurn_(ctx, m);
      // 補轉折（候選歷程·轉折成形卡）只收文字＋貼圖情緒——轉折是「一句話的想法」，其他訊息形式婉拒、不離開。
      if (s.contextId) {
        const tc = loadContexts_(scope).find(c => c.id === s.contextId);
        if (tc && tc.status === 'context') {
          return lineReply_(ctx.replyToken, '🔁 補轉折只用文字（與貼圖表達情緒）——轉折是「一句話的想法」。圖／音／檔請先「離開補充模式」再傳。', suppModeQuickReply_());
        }
      }
      // 補密度（進行中脈絡）仍收媒體（幫跨媒介條件）。
      return dispatchNonText_(ctx, m);
    }
    // 提問模式才限文字/貼圖構思（媒體會中斷、另記）。
    if (m.type === 'sticker') return handleAskStickerTurn_(ctx, m);
    return handleAskInterrupt_(ctx, m);
  }
  return dispatchNonText_(ctx, m);
}

/** Route a non-text message to its capture handler. */
function dispatchNonText_(ctx, m) {
  switch (m.type) {
    case 'sticker':
      return handleSticker_(ctx, m);
    case 'image':
      return handleMedia_(ctx, 'image', 'image/jpeg', 'jpg');
    case 'audio':
      return handleMedia_(ctx, 'audio', 'audio/m4a', 'm4a');
    case 'video':
      return handleMedia_(ctx, 'video', 'video/mp4', 'mp4');
    case 'file':
      return handleMedia_(ctx, 'file', m.fileName ? guessMime_(m.fileName) : 'application/octet-stream', extOf_(m.fileName) || 'bin', m.fileName);
    case 'location':
      return handleLocation_(ctx, m);
    default:
      return lineReply_(ctx.replyToken, `尚未支援的訊息類型：${m.type}`);
  }
}

function handleMemberJoined_(ev, scope) {
  const ts = new Date(ev.timestamp || Date.now()).toISOString();
  const joined = (ev.joined && ev.joined.members) || [];
  updateChatMeta_(scope, (m) => {
    m.members = m.members || [];
    for (const mem of joined) {
      let dn = '';
      try {
        const p = scope.type === 'group'
          ? getGroupMemberProfile_(scope.id, mem.userId)
          : getRoomMemberProfile_(scope.id, mem.userId);
        dn = (p && p.displayName) || '';
      } catch (_) { /* best-effort */ }
      m.members.push({ userId: mem.userId, displayName: dn, joinedAt: ts, leftAt: null });
    }
    try {
      m.memberCount = scope.type === 'group'
        ? getGroupMemberCount_(scope.id)
        : getRoomMemberCount_(scope.id);
    } catch (_) {}
    return m;
  });
  refreshChatFolderName_(scope);
}

function handleMemberLeft_(ev, scope) {
  const ts = new Date(ev.timestamp || Date.now()).toISOString();
  const left = (ev.left && ev.left.members) || [];
  const leftIds = new Set(left.map(x => x.userId));
  updateChatMeta_(scope, (m) => {
    m.members = m.members || [];
    for (const member of m.members) {
      if (leftIds.has(member.userId) && !member.leftAt) member.leftAt = ts;
    }
    try {
      m.memberCount = scope.type === 'group'
        ? getGroupMemberCount_(scope.id)
        : getRoomMemberCount_(scope.id);
    } catch (_) {}
    return m;
  });
  refreshChatFolderName_(scope);
}

/**
 * unsend 事件：使用者在 LINE 收回某則訊息。LINE 只給 `ev.unsend.messageId`（不含內容），
 * 所以靠我們存的 `lineMessageId` 對應回 record / pending：
 *   - 已成 record：比照 /del 從 embeddings 移除（不再被 /recall、/ask 搜到、不進主題）；
 *     順手清 transcript。聊天室原訊息已被使用者收回。
 *   - 還在 pending（媒體處理中）：移除 pending，讓它不會繼續被處理成 record。
 *   - 對應不到（bot 回覆 / 舊訊息）：靜默略過。
 * 收回是低調操作，不回訊息給使用者（也避免在群組洗版）；僅記 log。
 */
function handleUnsend_(ev, scope) {
  const mid = ev.unsend && ev.unsend.messageId;
  if (!mid) return;
  if (!chatFolderExists_(scope)) return;
  try {
    const rec = loadEmbeddingRecords_(scope).find(r => r.lineMessageId === mid);
    if (rec) {
      deleteEmbeddingRecord_(scope, rec.id);
      try { deleteTranscript_(scope, rec.id); } catch (_) {}
      console.log(`unsend ${scope.key}: 收回 record ${rec.id}（已從脈絡移除）`);
      return;
    }
  } catch (e) { console.warn('handleUnsend_ record lookup failed:', e && e.message); }
  try {
    const pending = listPendings_(scope).find(p => p.lineMessageId === mid);
    if (pending) {
      removePending_(scope, pending.id);
      console.log(`unsend ${scope.key}: 收回 pending ${pending.id}（已移除）`);
    }
  } catch (e) { console.warn('handleUnsend_ pending lookup failed:', e && e.message); }
}

/** 1-on-1 unfollow: flag the member as blocked + push OWNER (1 push). */
function markMemberBlockedAndNotifyOwner_(scope) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner || !scope.userId || scope.userId === owner) return;
  const member = loadMember_(scope.userId);
  if (!member) return;  // never approved → nothing meaningful to flag
  const prevStatus = member.status;
  const updated = markMemberBlocked_(scope.userId);
  const name = updated.displayName || `…${scope.userId.slice(-8)}`;
  const spentLine = updated.spentUsd
    ? `\n累計花費 $${updated.spentUsd.toFixed(4)} / 預算 $${(updated.budgetUsd || 0).toFixed(4)}`
    : '';
  try {
    linePush_(owner,
      `🚷 ${name} 已封鎖此 bot（原狀態：${prevStatus || 'unknown'}）${spentLine}\n之後若重新加入會自動恢復為「${prevStatus || 'approved'}」。`);
  } catch (e) {
    console.error('block notification push failed:', e && e.message);
  }
}

/** Re-follow by a blocked member: restore to their pre-block status + notify OWNER. */
function maybeUnblockOnRefollow_(scope) {
  if (!scope || scope.type !== 'user' || !scope.userId) return;
  const member = loadMember_(scope.userId);
  if (!member || member.status !== 'blocked') return;
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  const restored = unblockMember_(scope.userId);
  if (!owner || scope.userId === owner) return;
  const name = restored.displayName || `…${scope.userId.slice(-8)}`;
  let body;
  if (restored.status === 'approved') {
    const remaining = Math.max(0, (restored.budgetUsd || 0) - (restored.spentUsd || 0));
    body = `狀態恢復為 approved，可繼續使用 $${remaining.toFixed(4)}（預算 $${(restored.budgetUsd || 0).toFixed(4)}，已用 $${(restored.spentUsd || 0).toFixed(4)}）`;
  } else {
    body = `狀態恢復為 ${restored.status}，仍無法使用 bot（需 OWNER 在 /me 點復原）`;
  }
  try {
    linePush_(owner, `♻️ ${name} 已重新加入\n${body}`);
  } catch (e) {
    console.error('rejoin notification push failed:', e && e.message);
  }
}

/** Mark group/room as owner-active when OWNER sends a message/postback in it. */
function maybeMarkOwnerChatFromActivity_(scope, ev) {
  if (!scope || scope.type === 'user') return;
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner) return;
  const fromUser = ev && ev.source && ev.source.userId;
  if (fromUser === owner) markOwnerChat_(scope.id);
}

/** memberJoined: if OWNER is in the join list, activate the chat. */
function maybeMarkOwnerChatFromJoin_(scope, ev) {
  if (!scope || scope.type === 'user') return;
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner) return;
  const joined = (ev.joined && ev.joined.members) || [];
  if (joined.some(m => m && m.userId === owner)) markOwnerChat_(scope.id);
}

/** memberLeft: if OWNER left, deactivate the chat (group falls back to silent). */
function maybeUnmarkOwnerChatFromLeft_(scope, ev) {
  if (!scope || scope.type === 'user') return;
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner) return;
  const left = (ev.left && ev.left.members) || [];
  if (left.some(m => m && m.userId === owner)) unmarkOwnerChat_(scope.id);
}

/** Claim OWNER on first 1-on-1 follow if it has not been set yet. */
function maybeClaimOwner_(scope) {
  if (scope.type !== 'user') return false;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.OWNER_LINE_USER_ID)) return false;
  props.setProperty(PROP.OWNER_LINE_USER_ID, scope.id);
  console.log('Auto-claimed owner:', scope.id);
  return true;
}

function welcomeFlex_(scope, opts) {
  opts = opts || {};
  const tier = THEME.depth.l1;
  const body = [];

  if (opts.isNewOwner) {
    body.push({
      type: 'box', layout: 'vertical', backgroundColor: THEME.surface, cornerRadius: 'md', paddingAll: 'sm',
      contents: [
        { type: 'text', text: '✅ 已將你設為主人（OWNER）', size: 'xs', weight: 'bold', color: tier.title, wrap: true },
        { type: 'text', text: '之後只有你能在一對一使用此 Bot', size: 'xxs', color: THEME.muted, wrap: true, margin: 'xs' }
      ]
    });
    body.push({ type: 'separator', margin: 'lg' });
  }

  // 小工具：指令膠囊 / 置中說明 / 灰字註 / 階段箭頭
  const pill = (cmd) => ({
    type: 'box', layout: 'vertical', backgroundColor: tier.accent, cornerRadius: 'xl', paddingAll: 'sm', flex: 1,
    contents: [{ type: 'text', text: cmd, size: 'xxs', color: THEME.onDark, weight: 'bold', align: 'center', wrap: false }]
  });
  const cap = (t) => ({ type: 'text', text: t, size: 'xs', align: 'center', color: THEME.textBody, wrap: true, margin: 'md' });
  const sub = (t) => ({ type: 'text', text: t, size: 'xxs', align: 'center', color: THEME.muted, wrap: true, margin: 'sm' });
  const flow = () => ({ type: 'text', text: '↓', size: 'lg', align: 'center', color: tier.accent, margin: 'lg' });

  // ── ① 隨手寫訊息（擷取）── 文字/圖片/語音/影片/檔案/貼圖 + 引述補充 + 探索
  body.push({ type: 'text', text: '① 隨手寫訊息', size: 'sm', weight: 'bold', color: THEME.cta });
  body.push({ type: 'box', layout: 'horizontal', margin: 'md', contents:
    ['📝', '🖼️', '🎤', '🎬', '📄', '😀'].map(e => ({ type: 'text', text: e, size: 'lg', align: 'center', flex: 1 })) });
  body.push(cap('文字・圖片・語音・影片・檔案・貼圖\n自動記錄、轉譯，存進你的脈絡'));
  body.push(sub('💬 引述某則 = 補充到那則　·　🎒 想集中收一段（上課／讀書會）→ /explore'));

  body.push(flow());

  // ── ② 隨身查脈絡（查詢）──
  body.push({ type: 'text', text: '② 隨身查脈絡', size: 'sm', weight: 'bold', color: tier.accent });
  body.push({ type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', contents: [pill('/now'), pill('/recall'), pill('/ask')] });
  body.push(sub('目前記事(重點＋心情・聚焦)・語意回想・有來源答案（…更多查法見下方 📖）'));

  body.push(flow());

  // ── ③ 脈絡長成歷程 ── 五層 blocks 1–5 都已落地。
  body.push({ type: 'text', text: '③ 脈絡長成歷程', size: 'sm', weight: 'bold', color: tier.accent });
  body.push(cap('🌱 脈絡浮現轉折 → 背景自動長成學習歷程'));
  body.push({ type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', contents: [pill('/themes'), pill('/journey'), pill('/portfolio')] });
  body.push(sub('主題群組 → 歷程現況 → 學習歷程總冊'));

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: tier.headerBg, paddingAll: 'xl',
      contents: [
        { type: 'text', text: '隨手寫，隨身查', size: 'xl', weight: 'bold', color: tier.headerText, align: 'center' },
        { type: 'text', text: '歡迎使用 WriteToLearn', size: 'xs', color: tier.headerSub, align: 'center', margin: 'sm' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: [
        { type: 'box', layout: 'vertical', backgroundColor: THEME.cta, cornerRadius: 'md', paddingAll: 'sm',
          action: { type: 'message', label: '完整指令', text: '/help' },
          contents: [{ type: 'text', text: '📖 完整指令說明', size: 'xs', color: THEME.ctaText, align: 'center', weight: 'bold' }] },
        { type: 'text', text: '隨時輸入 /info 再看這張引導', size: 'xxs', color: THEME.muted, align: 'center' }
      ]
    }
  };
}

function extOf_(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function guessMime_(name) {
  const ext = extOf_(name);
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp3: 'audio/mp3', m4a: 'audio/m4a', wav: 'audio/wav',
    mp4: 'video/mp4'
  };
  return map[ext] || 'application/octet-stream';
}
