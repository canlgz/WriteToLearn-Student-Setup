/**
 * Build the /me dashboard's stat bundle by combining sources.
 * Pure: no side effects on Drive / API beyond reads.
 */
function gatherDashboardStats_(scope) {
  const records = loadEmbeddingRecords_(scope);
  const meta = loadChatMeta_(scope);
  const folder = chatFolder_(scope);

  const now = new Date();
  const todayStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  let todayCount = 0, weekCount = 0, monthCount = 0, validCount = 0;
  const typeCounts = {};
  const hourCounts = {};
  const daySet = new Set();

  for (const r of records) {
    const date = new Date(r.ts);
    if (isNaN(date.getTime())) continue;
    const dStr = Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd');
    daySet.add(dStr);
    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
    if (r.embedding && r.embedding.length === EMBED_DIM) validCount++;
    const h = Utilities.formatDate(date, TIME_ZONE, 'HH');
    hourCounts[h] = (hourCounts[h] || 0) + 1;
    if (dStr === todayStr) todayCount++;
    if (date >= weekAgo) weekCount++;
    if (date >= monthAgo) monthCount++;
  }

  // 敘事片段 (層2) = episodes. 脈絡(進行中/候選)與學習歷程已持久化升格（blocks 1–5）→ 下方各自計數。
  const episodeCount = groupByEpisode_(
    records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
    SESSION_GAP_MINUTES * 60 * 1000
  ).length;

  // Current-calendar-month activity (separate from 30-day rolling monthCount).
  const monthStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM');
  let monthActiveDays = 0;
  for (const d of daySet) if (d.indexOf(monthStr) === 0) monthActiveDays++;
  const daysElapsedThisMonth = parseInt(Utilities.formatDate(now, TIME_ZONE, 'd'), 10);

  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  const isOwner = owner && scope.userId === owner;
  // Non-OWNER personal budget — only meaningful in 1-on-1 where each user has
  // their own member record. In groups the OWNER pays globally, no per-user.
  let myBudget = null;
  if (!isOwner && scope.type === 'user' && scope.userId) {
    const me = loadMember_(scope.userId);
    if (me) {
      myBudget = {
        status: me.status,
        budgetUsd: me.budgetUsd || 0,
        spentUsd: me.spentUsd || 0,
        approvedAt: me.approvedAt || me.requestedAt || null
      };
    }
  }

  // 「處理中」= 有 embedding 但還沒在任何持久脈絡裡的 records (排除收藏 / 裸連結)。
  // 包含兩種：(a) 沒 category（背景還沒判）(b) 已有 category+topicLabel 但尚未被併入任何
  // context.recordIds（等下次升格）。對「我剛寫的不見了？」回答「在排隊」。
  const allCtxs = loadContexts_(scope);
  const inCtxs = new Set();
  allCtxs.forEach(c => (c.recordIds || []).forEach(id => inCtxs.add(id)));
  const linkIntent = meta.linkIntent || {};
  const pendingForThemes = records.filter(r =>
    r.embedding && r.embedding.length === EMBED_DIM
      && !isCollectionRecord_(r, linkIntent)
      && (!r.category || !r.topicLabel || !inCtxs.has(r.id))
  ).length;

  return {
    chat: {
      type: scope.type,
      name: meta.name || '',
      memberCount: meta.memberCount,
      createdAt: meta.createdAt,
      lastIngestTs: meta.lastIngestTs
    },
    records: {
      total: records.length,
      today: todayCount,
      week: weekCount,
      month: monthCount,
      byType: typeCounts,
      narratives: episodeCount,  // 敘事片段 (層2)
      inquiries: validCount >= FOCUS_MIN_COUNT ? pickFocusK_(validCount) : null,  // 主題群組 (層3, 估計)
      contexts: countContexts_(scope),  // 脈絡 (層4) — 升格自主題群組（背景 sweep）
      contextCandidates: countContextCandidates_(scope),  // 進行中脈絡（未過三條件）
      journeys: countJourneys_(scope),  // 學習歷程 (層5)
      pendingForThemes: pendingForThemes
    },
    streak: calcStreak_(daySet),
    topHour: topKey_(hourCounts),
    monthActiveDays,
    daysElapsedThisMonth,
    explorations: gatherExplorationStats_(scope, monthAgo),
    pendingCount: listPendings_(scope).length,
    isOwner: !!isOwner,
    folderUrl: folder.getUrl(),
    // OWNER-only sections: hidden (null) for everyone else.
    usage: isOwner ? getUsageStats_() : null,
    lineQuota: isOwner ? getLineMessageQuota_() : null,
    // Skip status-less records — billing artifacts (e.g. a group uploader
    // whose swept file got cost-attributed), not real access members.
    members: isOwner ? listMembers_().filter(m => m.status) : null,
    myBudget
  };
}

function isOwnerScope_(scope) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  return owner && scope && scope.type === 'user' && scope.userId === owner;
}

/** Count consecutive days backwards from today (or yesterday if no record today). */
function calcStreak_(daySet) {
  let streak = 0;
  let d = new Date();
  const todayStr = Utilities.formatDate(d, TIME_ZONE, 'yyyy-MM-dd');
  if (!daySet.has(todayStr)) {
    d = new Date(d.getTime() - 86400000);
  }
  while (true) {
    const dStr = Utilities.formatDate(d, TIME_ZONE, 'yyyy-MM-dd');
    if (daySet.has(dStr)) {
      streak++;
      d = new Date(d.getTime() - 86400000);
    } else break;
  }
  return streak;
}

function topKey_(counts) {
  let topKey = null, topVal = 0;
  for (const k in counts) {
    if (counts[k] > topVal) { topKey = k; topVal = counts[k]; }
  }
  return topKey;
}

/** /me 儀表板：拆成兩張精編卡的輪播——① 學習狀態 ② 系統與帳號。 */
function buildDashboardBubble_(scope, stats) {
  const typeLabel = { text: '📝文字', image: '🖼️圖片', audio: '🎤語音', video: '🎬影片', file: '📄檔案', sticker: '😀貼圖', location: '📍地點' };
  const typeBreakdown = Object.keys(stats.records.byType)
    .sort()
    .map(t => `${typeLabel[t] || t} ${stats.records.byType[t]}`)
    .join(' · ');
  const lastActivity = stats.chat.lastIngestTs
    ? Utilities.formatDate(new Date(stats.chat.lastIngestTs), TIME_ZONE, 'MM/dd HH:mm')
    : '—';
  const hourLabel = stats.topHour ? `${stats.topHour}:00–${parseInt(stats.topHour, 10) + 1}:00` : '—';

  /* ───────── Card ①：學習狀態 ───────── */
  const b1 = [];
  if (scope.type !== 'user') {
    b1.push(kvLine_('群組', `${stats.chat.name || '—'}${stats.chat.memberCount ? ` (${stats.chat.memberCount} 人)` : ''}`));
  }
  if (stats.pendingCount > 0) {
    b1.push({
      type: 'box', layout: 'horizontal', backgroundColor: THEME.surfaceWarm, cornerRadius: 'sm', paddingAll: 'sm',
      action: { type: 'postback', label: '待處理', data: 'action=pending_list', displayText: '▸ 看待處理列表' },
      contents: [
        { type: 'text', text: '⏳ 待處理', size: 'xs', color: THEME.dangerSoft, flex: 3, weight: 'bold' },
        { type: 'text', text: `${stats.pendingCount} 個 →`, size: 'xs', color: THEME.text, flex: 5, align: 'end' }
      ]
    });
  }

  b1.push(sectionTitle_('✍️ 記寫脈絡'));
  b1.push(kvLine_('訊息流', `${stats.records.total} 筆（今 ${stats.records.today}・週 ${stats.records.week}・月 ${stats.records.month}）`));
  let narrativesValue = `${stats.records.narratives} 段`;
  if (stats.explorations && stats.explorations.closed) {
    narrativesValue += `（含探索 ${stats.explorations.closed} 段・${stats.explorations.monthMinutes} 分）`;
  }
  b1.push(kvLine_('敘事片段', narrativesValue));
  if (stats.explorations && stats.explorations.active) {
    b1.push(kvLine_('探索進行中', `🎒「${stats.explorations.active.label}」剩 ${stats.explorations.active.remainMinutes} 分`));
  }
  b1.push(kvLine_('🌱 進行中脈絡', `${stats.records.contextCandidates} 條`));
  b1.push(kvLine_('🌿 候選歷程', `${stats.records.contexts} 條`));
  if (stats.records.pendingForThemes > 0) {
    b1.push(kvLine_('🔄 處理中', `${stats.records.pendingForThemes} 筆（背景每 5 分跑一次；/themes 點「立即整理」也可）`));
  }
  if (typeBreakdown) b1.push({ type: 'text', text: typeBreakdown, size: 'xxs', wrap: true, color: THEME.textDim, margin: 'sm' });
  b1.push({ type: 'separator', margin: 'md' });

  b1.push(sectionTitle_('🌳 學習歷程現況'));
  b1.push(kvLine_('已升格', `${stats.records.journeys} 條`));
  // 〔重併哨兵·免 editor〕背景合併健康自檢：7 天內同一組被重複合併 ≥2 次＝合併沒固定住（迴圈）。
  {
    const rep = loadChatMeta_(scope).mergeRepeatLog || {};
    let worst = 0, worstT = '';
    Object.keys(rep).forEach(k => {
      const e = rep[k];
      if (e && (Date.now() - (e.lastAt || 0)) <= 7 * 86400000 && (e.n || 0) > worst) { worst = e.n; worstT = e.t || ''; }
    });
    b1.push(kvLine_('合併自檢', worst >= 2 ? `⚠️ 重併 ${worst} 次（${truncate_(worstT, 14)}）` : '✅ 正常（無重併）'));
  }
  // 〔分享回執〕新回執徽章（免費 pull；點開列名單並清新）。> 0 才顯示。
  {
    const newAcks = (loadChatMeta_(scope).pendingAckNotices || []).length;
    if (newAcks > 0) {
      b1.push({
        type: 'box', layout: 'baseline', spacing: 'sm', margin: 'xs',
        action: { type: 'postback', label: '看新回執', data: 'action=ack_inbox', displayText: '▸ 看新回執' },
        contents: [
          { type: 'text', text: '📩 分享回執', size: 'sm', color: THEME.textDim, flex: 0 },
          { type: 'text', text: `${newAcks} 筆新回執 ›`, size: 'xs', color: THEME.cta, weight: 'bold', flex: 1, align: 'end', wrap: true }
        ]
      });
    }
  }
  b1.push({ type: 'separator', margin: 'md' });

  b1.push(sectionTitle_('🔥 熱度'));
  b1.push(kvLine_('活躍', `連續 ${stats.streak} 天・本月 ${stats.monthActiveDays}/${stats.daysElapsedThisMonth} 天`));
  b1.push(kvLine_('最常', hourLabel));
  b1.push({ type: 'separator', margin: 'md' });

  // 背景主動提醒總開關（停筆後·非夜間 22:00–08:00·每輪最多一張；可全關）。
  const pmuted = !!loadChatMeta_(scope).proactivePushMuted;
  b1.push({
    type: 'box', layout: 'baseline', spacing: 'sm',
    action: { type: 'postback', label: pmuted ? '重開背景提醒' : '關閉背景提醒',
      data: `action=proactive_mute&v=${pmuted ? '0' : '1'}`, displayText: pmuted ? '🔔 重開背景提醒' : '🔕 關閉背景提醒' },
    contents: [
      { type: 'text', text: '🔔 背景提醒', size: 'sm', color: THEME.textDim, flex: 0 },
      { type: 'text', text: pmuted ? '已全關·點此重開 ›' : '開·點此關 ›', size: 'xs', color: pmuted ? THEME.warning : THEME.cta, flex: 1, align: 'end', wrap: true }
    ]
  });

  const card1 = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.cta, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['／me', '學習狀態'], THEME.depth.l1),
        { type: 'text', text: '📊 學習狀態', size: 'lg', weight: 'bold', color: '#ffffff' },
        { type: 'text', text: `最近活動 ${lastActivity}　·　1 / 2`, size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: b1 }
  };

  /* ───────── Card ②：系統與帳號 ───────── */
  const b2 = [];
  for (const part of [
    buildGeminiSection_(stats.usage),
    buildQuotaSection_(stats.lineQuota),
    buildMembersSection_(stats.members),
    buildMyBudgetSection_(stats.myBudget),
    buildDriveSection_(stats)
  ]) for (const el of part) b2.push(el);

  if (!b2.length) return card1;   // 一般成員可能沒有系統區 → 只回一張

  const card2 = {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: THEME.depth.l2.headerBg, paddingAll: 'md',
      contents: [
        breadcrumbKicker_(['／me', '系統｜帳號'], THEME.depth.l2),
        { type: 'text', text: '⚙️ 系統與帳號', size: 'lg', weight: 'bold', color: '#ffffff' },
        { type: 'text', text: '用量・額度・預算・Drive　·　2 / 2', size: 'xxs', color: THEME.depth.l2.headerSub, margin: 'xs' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm', contents: b2 }
  };

  return { type: 'carousel', contents: [card1, card2] };
}

/** Drive folder link — OWNER only (folder lives in OWNER's Drive, others can't open it anyway). */
function buildDriveSection_(stats) {
  if (!stats.isOwner) return [];
  return [
    sectionTitle_('📁 Drive'),
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: THEME.cta,
      cornerRadius: 'md',
      paddingAll: 'sm',
      margin: 'sm',
      action: { type: 'uri', label: '開啟', uri: stats.folderUrl },
      contents: [
        { type: 'text', text: '開啟資料夾', size: 'xs', color: '#ffffff', align: 'center', weight: 'bold' }
      ]
    }
  ];
}

function sectionTitle_(text) {
  return { type: 'text', text, size: 'sm', weight: 'bold', color: THEME.cta };
}

/** OWNER-only: list members with status / spend / revoke action. */
function buildMembersSection_(members) {
  if (!members) return [];  // not OWNER
  const rows = [sectionTitle_(`👥 成員 (${members.length})`)];
  if (!members.length) {
    rows.push({ type: 'text', text: '（尚無其他成員）', size: 'xs', color: THEME.muted });
    rows.push({ type: 'separator', margin: 'md' });
    return rows;
  }
  // Sort: active first, inactive (blocked/denied/revoked) at the bottom.
  const order = { approved: 0, pending: 1, blocked: 2, revoked: 3, denied: 4 };
  members.sort((a, b) => (order[a.status] || 9) - (order[b.status] || 9));
  for (const m of members.slice(0, 10)) rows.push(buildMemberRow_(m));
  if (members.length > 10) {
    rows.push({ type: 'text', text: `…還有 ${members.length - 10} 人`, size: 'xs', color: THEME.muted });
  }
  rows.push({ type: 'separator', margin: 'md' });
  return rows;
}

function buildMemberRow_(m) {
  const statusIcon = { approved: '✓', pending: '⏳', denied: '✗', revoked: '🚫', blocked: '🚷' }[m.status] || '?';
  const name = m.displayName || `…${(m.userId || '').slice(-6)}`;
  const spent = (m.spentUsd || 0).toFixed(4);
  const budget = (m.budgetUsd || 0).toFixed(4);
  // Visually de-emphasize anyone who can't currently use the bot (blocked,
  // revoked, denied) — grey + strikethrough. Reactivation (restore /
  // re-follow → approved) flips it back automatically.
  const isInactive = m.status === 'blocked' || m.status === 'revoked' || m.status === 'denied';
  const leftText = { type: 'text', text: `${statusIcon} ${name}`, size: 'xs', flex: 5, wrap: true };
  const rightText = { type: 'text', text: `$${spent}/${budget}`, size: 'xs', flex: 4, align: 'end' };
  if (isInactive) {
    leftText.color = THEME.faint;
    leftText.decoration = 'line-through';
    rightText.color = THEME.faint;
    rightText.decoration = 'line-through';
  } else {
    leftText.color = THEME.text;
    rightText.color = THEME.textDim;
  }
  const row = { type: 'box', layout: 'horizontal', contents: [leftText, rightText] };
  // Tappable behavior depends on current status. Revoke goes through a
  // confirm step (handleAccessRevokeConfirm_) so a single misclick can't lose
  // someone's access. Restore is direct (it's an "undo" already).
  if (m.status === 'approved' || m.status === 'pending') {
    row.action = {
      type: 'postback',
      label: '撤銷',
      data: `action=access_revoke_confirm&user=${m.userId}`,
      displayText: opEcho_('撤銷存取', name)
    };
  } else if (m.status === 'revoked' || m.status === 'denied') {
    row.action = {
      type: 'postback',
      label: '復原',
      data: `action=access_restore&user=${m.userId}`,
      displayText: opEcho_('復原存取', name)
    };
  }
  return row;
}

/** OWNER-only Gemini global usage. Returns [] for non-OWNER (stats.usage = null). */
function buildGeminiSection_(usage) {
  if (!usage) return [];
  const pct = (usage.todayCalls / FREE_TIER_RPD * 100).toFixed(1);
  return [
    sectionTitle_('💰 Gemini'),
    kvLine_('今日 RPD', `${usage.todayCalls}/${FREE_TIER_RPD} (${pct}%)`),
    kvLine_('本月', `生成 ${usage.monthGenCalls}・Embed ${usage.monthEmbedCalls}・$${usage.costUsd.toFixed(4)}`),
    { type: 'separator', margin: 'md' }
  ];
}

/** Personal budget row for non-OWNER 1-on-1 users. */
function buildMyBudgetSection_(b) {
  if (!b) return [];
  const ratio = b.budgetUsd > 0 ? b.spentUsd / b.budgetUsd : 0;
  const pct = (ratio * 100).toFixed(1);
  const joinedLabel = b.approvedAt
    ? Utilities.formatDate(new Date(b.approvedAt), TIME_ZONE, 'yyyy/MM/dd')
    : '—';
  // Use the same precision for spent / budget / remaining so the math is
  // transparent — even when the budget has drifted to non-round values from
  // historical operations.
  const rows = [
    sectionTitle_('💳 我的預算'),
    kvLine_('成員自', joinedLabel),
    kvLine_('已用', `$${b.spentUsd.toFixed(4)} / ${b.budgetUsd.toFixed(4)} (${pct}%)`),
    kvLine_('剩餘', `$${Math.max(0, b.budgetUsd - b.spentUsd).toFixed(4)}`)
  ];
  // Warn at 85%, alarm at 100%.
  if (ratio >= 1) {
    rows.push({ type: 'text', text: '⛔ 預算已用盡，請聯絡 OWNER 補額', size: 'xs', color: THEME.danger, weight: 'bold', wrap: true, margin: 'sm' });
  } else if (ratio >= 0.85) {
    rows.push({ type: 'text', text: `⚠️ 已使用 ${pct}% 預算，請聯絡 OWNER`, size: 'xs', color: THEME.warning, wrap: true, margin: 'sm' });
  }
  rows.push({ type: 'separator', margin: 'md' });
  return rows;
}

/** LINE push quota — single row X/Y. Returns [] when the API failed. */
function buildQuotaSection_(q) {
  if (!q) return [];
  let val;
  if (q.type === 'none') val = `${q.consumed} / ∞`;
  else if (q.type === 'limited' && q.limit) val = `${q.consumed} / ${q.limit}`;
  else return [];
  return [
    kvLine_('💬 LINE 推播', val),
    { type: 'separator', margin: 'md' }
  ];
}

/** Pending media list — Flex carousel (or single bubble) with 3 mode buttons per item. */
function replyPendingList_(ev, scope) {
  const items = listPendings_(scope);
  if (!items.length) {
    return lineReply_(ev.replyToken, '✅ 目前沒有待處理的媒體。');
  }
  items.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const bubbles = items.slice(0, 10).map(buildPendingBubble_);
  const contents = bubbles.length === 1
    ? bubbles[0]
    : { type: 'carousel', contents: bubbles };
  const altText = `待處理媒體 ${items.length} 個` + (items.length > 10 ? '（只顯示前 10 個）' : '');
  lineReplyFlex_(ev.replyToken, altText, contents);
}

function buildPendingBubble_(pending) {
  const date = Utilities.formatDate(new Date(pending.ts), TIME_ZONE, 'MM/dd HH:mm');
  const typeIcon = { image: '🖼️', audio: '🎤', video: '🎬', file: '📄' }[pending.type] || '📌';

  // Drive generates video thumbnails asynchronously — usually within ~1 min
  // but can take longer. Within this window we show a notice instead of a
  // broken hero; after, the hero just works on the next /me render.
  const VIDEO_THUMB_GRACE_MS = 120 * 1000;
  const isFreshVideo = pending.type === 'video' &&
    (Date.now() - Date.parse(pending.ts)) < VIDEO_THUMB_GRACE_MS;

  const bodyContents = [
    { type: 'text', text: `${typeIcon} ${typeLabel_(pending.type)}`, weight: 'bold', size: 'sm' },
    { type: 'text', text: date, size: 'xs', color: THEME.muted, margin: 'xs' }
  ];
  // Audio has no useful thumbnail; surface duration so the clip is at least
  // identifiable by length.
  if (pending.type === 'audio' && pending.duration) {
    const seconds = Math.round(pending.duration / 1000);
    bodyContents.push({ type: 'text', text: `${seconds} 秒`, size: 'xs', color: THEME.textDim, margin: 'sm' });
  }
  if (isFreshVideo) {
    bodyContents.push({
      type: 'text', text: '⏳ 影片縮圖建立中…',
      size: 'xs', color: THEME.muted, margin: 'sm', wrap: true
    });
  }
  bodyContents.push(
    { type: 'separator', margin: 'md' },
    pendingModeBtn_(pending.id, 'detailed', '詳細',     THEME.muted),
    pendingModeBtn_(pending.id, 'summary',  '摘要',     THEME.muted),
    pendingModeBtn_(pending.id, 'auto',     '幫我決定', THEME.muted)
  );

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    body: { type: 'box', layout: 'vertical', contents: bodyContents }
  };

  // Drive thumbnail hero for visual types. UUID-suffixed filenames carry no
  // meaning to the user, the thumbnail does. Drive's thumbnail endpoint
  // renders images, videos, and PDFs when the file is shared
  // ANYONE_WITH_LINK (saveRawBlob_ sets that on upload). Skip for
  // freshly-uploaded videos where the thumbnail isn't ready yet — body
  // already shows a "building thumbnail" notice instead. Tap → open the
  // original in Drive.
  const canShowHero = pending.fileId && !isFreshVideo &&
    (pending.type === 'image' || pending.type === 'video' || pending.type === 'file');
  if (canShowHero) {
    bubble.hero = {
      type: 'image',
      url: `https://drive.google.com/thumbnail?id=${pending.fileId}&sz=w400`,
      size: 'full',
      aspectRatio: '4:3',
      aspectMode: 'cover',
      action: {
        type: 'uri',
        label: '原檔',
        uri: `https://drive.google.com/file/d/${pending.fileId}/view`
      }
    };
  }

  return bubble;
}

function pendingModeBtn_(pendingId, mode, label, color) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: color,
    cornerRadius: 'md',
    paddingAll: 'sm',
    margin: 'sm',
    action: {
      type: 'postback',
      label,
      data: `mode=${mode}&id=${pendingId}`,
      displayText: opEcho_(label)
    },
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#ffffff', align: 'center', weight: 'bold' }
    ]
  };
}

function kvLine_(key, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: key, size: 'xs', color: THEME.muted, flex: 3 },
      { type: 'text', text: String(value), size: 'xs', color: THEME.text, flex: 5, wrap: true }
    ]
  };
}
