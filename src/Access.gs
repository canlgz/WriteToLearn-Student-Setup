/**
 * Multi-user access control + per-user budget tracking.
 *
 * Approval flow (1-on-1, non-OWNER):
 *   1. Stranger 甲 sends first message → checkAccess_ returns 'unknown'.
 *   2. Main.gs calls handleNewStranger_ which:
 *      - registers 甲 as pending in ScriptProperties
 *      - replies to 甲 ("審核中")
 *      - pushes OWNER a Flex bubble with [同意 $1] [同意 $5] [拒絕]
 *   3. OWNER taps → postback action=access_approve / access_deny.
 *   4. Approval pushes 甲 "✓ 已核准"; deny pushes 甲 "請求被拒絕".
 *
 * Group / room: OWNER's presence implicitly grants the whole chat. Detection:
 *   - Bot sees OWNER's userId in a message / memberJoined event → mark group
 *     as "owner-active". memberLeft of OWNER → unmark.
 *
 * Billing:
 *   - OWNER: no limit (only global usage tracking).
 *   - 1-on-1 approved member: per-user budget; Gemini call cost added to
 *     spentUsd after each successful call. Exceeding budget → hard stop.
 *   - Group/room (owner-active): no per-user billing — counts toward OWNER's
 *     global usage only (owner's bot, owner's spend).
 *
 * Storage layout (ScriptProperties):
 *   access:member:U_xxx  → JSON {status, displayName, budgetUsd, spentUsd, ...}
 *   access:owner_chats   → JSON array of group/room IDs where OWNER is active
 */

const ACCESS_MEMBER_PREFIX = 'access:member:';
const ACCESS_OWNER_CHATS_KEY = 'access:owner_chats';
const PENDING_REMINDER_THROTTLE_MS = 10 * 60 * 1000;  // 10 min

/** Current execution's billing userId. Set by Main.gs auth gate; null = no charge. */
let _currentBillingUser = null;
function setBillingUser_(userId) { _currentBillingUser = userId || null; }
function getBillingUser_() { return _currentBillingUser; }

/* -------------------- Member CRUD -------------------- */

function loadMember_(userId) {
  if (!userId) return null;
  const v = PropertiesService.getScriptProperties().getProperty(ACCESS_MEMBER_PREFIX + userId);
  return v ? JSON.parse(v) : null;
}

function saveMember_(userId, member) {
  PropertiesService.getScriptProperties().setProperty(
    ACCESS_MEMBER_PREFIX + userId, JSON.stringify(member));
}

function deleteMember_(userId) {
  PropertiesService.getScriptProperties().deleteProperty(ACCESS_MEMBER_PREFIX + userId);
}

/** Returns array of { userId, ...member } */
function listMembers_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const out = [];
  for (const k in props) {
    if (k.indexOf(ACCESS_MEMBER_PREFIX) === 0) {
      const userId = k.substring(ACCESS_MEMBER_PREFIX.length);
      try { out.push(Object.assign({ userId }, JSON.parse(props[k]))); }
      catch (_) {}
    }
  }
  return out;
}

/** Atomic-ish update via LockService. */
function updateMember_(userId, mutator) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cur = loadMember_(userId) || {};
    const next = mutator(cur) || cur;
    saveMember_(userId, next);
    return next;
  } finally {
    lock.releaseLock();
  }
}

/* -------------------- Owner-active chats -------------------- */

function getOwnerChats_() {
  const v = PropertiesService.getScriptProperties().getProperty(ACCESS_OWNER_CHATS_KEY);
  return v ? JSON.parse(v) : [];
}

function isOwnerChat_(chatId) {
  return getOwnerChats_().indexOf(chatId) >= 0;
}

function markOwnerChat_(chatId) {
  if (!chatId) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const set = new Set(getOwnerChats_());
    if (set.has(chatId)) return;
    set.add(chatId);
    PropertiesService.getScriptProperties().setProperty(
      ACCESS_OWNER_CHATS_KEY, JSON.stringify([...set]));
  } finally {
    lock.releaseLock();
  }
}

function unmarkOwnerChat_(chatId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const list = getOwnerChats_().filter(x => x !== chatId);
    PropertiesService.getScriptProperties().setProperty(
      ACCESS_OWNER_CHATS_KEY, JSON.stringify(list));
  } finally {
    lock.releaseLock();
  }
}

/* -------------------- Auth gate -------------------- */

/**
 * Decide whether this event should be processed.
 * Returns { decision, member?, billTo? } where decision is one of:
 *   'allow'           — process; billTo = userId to charge (null = no charge)
 *   'unknown'         — stranger; caller should run handleNewStranger_
 *   'pending'         — already pending OWNER decision
 *   'denied'          — OWNER explicitly denied
 *   'revoked'         — previously approved, now revoked
 *   'no_budget'       — approved but spent >= budget
 *   'group_inactive'  — group/room where OWNER hasn't appeared yet; silent drop
 */
function checkAccess_(ev, scope) {
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  // Before OWNER is claimed at all: legacy "open" behavior so the first follow
  // can become OWNER. maybeClaimOwner_ in Router will set OWNER then.
  if (!owner) return { decision: 'allow', billTo: null };

  // OWNER themselves always allowed, no charge.
  if (scope.userId && scope.userId === owner) {
    return { decision: 'allow', billTo: null };
  }

  // Group / room: gated by OWNER's presence.
  if (scope.type !== 'user') {
    if (isOwnerChat_(scope.id)) return { decision: 'allow', billTo: null };
    return { decision: 'group_inactive' };
  }

  // 1-on-1 with non-OWNER.
  const member = loadMember_(scope.userId);
  if (!member) return { decision: 'unknown' };
  if (member.status === 'approved') {
    if ((member.spentUsd || 0) >= (member.budgetUsd || 0)) {
      return { decision: 'no_budget', member };
    }
    return { decision: 'allow', member, billTo: scope.userId };
  }
  return { decision: member.status || 'unknown', member };
}

/* -------------------- New stranger handling -------------------- */

function handleNewStranger_(ev, scope) {
  const userId = scope.userId;
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (!owner) return;  // shouldn't happen — checkAccess_ would have allowed

  // Try to fetch display name (best effort).
  let displayName = '';
  try {
    const p = getUserProfile_(userId);
    displayName = (p && p.displayName) || '';
  } catch (_) {}

  const now = new Date().toISOString();
  saveMember_(userId, {
    status: 'pending',
    displayName,
    requestedAt: now,
    lastPendingNotifyAt: now,
    budgetUsd: 0,
    spentUsd: 0
  });

  // Reply to 甲 immediately (free).
  if (ev.replyToken) {
    try {
      lineReply_(ev.replyToken,
        '⏳ 您是新使用者，已通知擁有者審核中。\n核准後會主動通知您。');
    } catch (_) {}
  }

  // Push approval request to OWNER (1 push).
  try {
    pushApprovalRequestToOwner_(owner, userId, displayName);
  } catch (e) {
    console.error('pushApprovalRequestToOwner_ failed:', e && e.message);
  }
}

function pushApprovalRequestToOwner_(ownerId, newUserId, newDisplayName) {
  const nameLabel = newDisplayName || '(未取得名稱)';
  const shortId = newUserId.slice(-8);
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: THEME.dangerSoft, paddingAll: 'md',
      contents: [{ type: 'text', text: '🔔 新使用者請求加入', weight: 'bold', color: '#ffffff', align: 'center', size: 'md' }]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '名稱', size: 'xs', color: THEME.muted, flex: 2 },
          { type: 'text', text: nameLabel, size: 'sm', color: THEME.text, flex: 6, wrap: true }
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'userId', size: 'xs', color: THEME.muted, flex: 2 },
          { type: 'text', text: `…${shortId}`, size: 'xs', color: THEME.textDim, flex: 6 }
        ]},
        { type: 'separator', margin: 'md' },
        accessActionBtn_('同意 $1', THEME.success,
          `action=access_approve&user=${newUserId}&budget=1`,
          `同意 ${nameLabel} ($1)`),
        accessActionBtn_('同意 $5', THEME.cta,
          `action=access_approve&user=${newUserId}&budget=5`,
          `同意 ${nameLabel} ($5)`),
        accessActionBtn_('拒絕', THEME.muted,
          `action=access_deny&user=${newUserId}`,
          `拒絕 ${nameLabel}`)
      ]
    }
  };
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({
      to: ownerId,
      messages: [{ type: 'flex', altText: `新使用者請求：${nameLabel}`, contents: bubble }]
    }),
    muteHttpExceptions: true
  });
}

function accessActionBtn_(label, color, data, displayText) {
  return {
    type: 'box', layout: 'vertical',
    backgroundColor: color, cornerRadius: 'md', paddingAll: 'sm', margin: 'sm',
    action: { type: 'postback', label, data, displayText },
    contents: [{ type: 'text', text: label, size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
  };
}

/* -------------------- Already-pending reminder (throttled) -------------------- */

function replyPendingThrottled_(ev, scope, member) {
  const now = Date.now();
  const last = member.lastPendingNotifyAt ? Date.parse(member.lastPendingNotifyAt) : 0;
  if (last && (now - last) < PENDING_REMINDER_THROTTLE_MS) return;  // silent
  if (ev.replyToken) {
    try { lineReply_(ev.replyToken, '⏳ 您的請求仍在審核中，請耐心等候。'); } catch (_) {}
  }
  updateMember_(scope.userId, (m) => {
    m.lastPendingNotifyAt = new Date(now).toISOString();
    return m;
  });
}

/* -------------------- Approve / Deny / Revoke / Topup -------------------- */

function approveMember_(userId, budgetUsd) {
  const now = new Date().toISOString();
  return updateMember_(userId, (m) => {
    m.status = 'approved';
    m.approvedAt = now;
    m.budgetUsd = (m.budgetUsd || 0) + (budgetUsd || 0);
    m.spentUsd = m.spentUsd || 0;
    return m;
  });
}

function denyMember_(userId) {
  return updateMember_(userId, (m) => {
    m.status = 'denied';
    m.deniedAt = new Date().toISOString();
    return m;
  });
}

function revokeMember_(userId) {
  return updateMember_(userId, (m) => {
    m.status = 'revoked';
    m.revokedAt = new Date().toISOString();
    return m;
  });
}

function topupMember_(userId, addUsd) {
  return updateMember_(userId, (m) => {
    m.budgetUsd = (m.budgetUsd || 0) + (addUsd || 0);
    if (m.status === 'revoked' || m.status === 'denied') m.status = 'approved';
    return m;
  });
}

function restoreMember_(userId) {
  return updateMember_(userId, (m) => {
    m.status = 'approved';
    m.restoredAt = new Date().toISOString();
    delete m.revokedAt;
    delete m.deniedAt;
    return m;
  });
}

/** User blocked the bot (LINE unfollow). Remember prior status so re-follow restores. */
function markMemberBlocked_(userId) {
  return updateMember_(userId, (m) => {
    if (m.status !== 'blocked') m.statusBeforeBlock = m.status;
    m.status = 'blocked';
    m.blockedAt = new Date().toISOString();
    return m;
  });
}

/** User re-added the bot (LINE follow). Restore to the status they had
 *  before blocking so OWNER's revoke / deny decisions can't be bypassed by
 *  blocking-then-re-adding. Approved members come back as approved; revoked
 *  / denied stay where OWNER put them. */
function unblockMember_(userId) {
  return updateMember_(userId, (m) => {
    if (m.status === 'blocked') {
      m.status = m.statusBeforeBlock || 'approved';
      m.unblockedAt = new Date().toISOString();
      delete m.statusBeforeBlock;
      delete m.blockedAt;
    }
    return m;
  });
}

/* -------------------- Per-user spend recording -------------------- */

/** Called from Gemini.gs after each successful call. Charges _currentBillingUser. */
function chargeCurrentBillingUser_(usd) {
  if (!_currentBillingUser || !(usd > 0)) return;
  // Never track spend against the OWNER (not a budgeted member) or a userId
  // with no member record (e.g. a group uploader whose file was swept) —
  // charging the latter would auto-create a status-less phantom member.
  const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
  if (_currentBillingUser === owner) return;
  if (!loadMember_(_currentBillingUser)) return;
  try {
    updateMember_(_currentBillingUser, (m) => {
      m.spentUsd = (m.spentUsd || 0) + usd;
      m.lastActiveAt = new Date().toISOString();
      return m;
    });
  } catch (e) {
    console.warn('chargeCurrentBillingUser_ failed:', e && e.message);
  }
}
