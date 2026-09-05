/**
 * LINE webhook entry. GAS Web App invokes doPost on every webhook event.
 *
 * Permission model (see Access.gs):
 *   - 1-on-1 with OWNER: always allowed, no per-user charge.
 *   - 1-on-1 with stranger: first contact → register pending + push OWNER for
 *     approval; pending repeats → throttled reminder; approved + within budget
 *     → process and charge.
 *   - Group / room: open to everyone IF OWNER is in the chat (auto-tracked via
 *     message / memberJoined events); silently ignored otherwise.
 *
 * GAS Web Apps cannot read request headers, so LINE signature verification is
 * impossible. We rely on the webhook URL staying secret + access control above.
 */
function doPost(e) {
  try {
    ensureBackgroundSweep_();
    captureExecUrl_();   // 自學固定 /exec（webhook 請求裡 getUrl() 回 /exec），報告連結用
    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];
    for (const ev of events) {
      const scope = scopeFromEvent_(ev);
      if (!scope) continue;
      try {
        dispatchEvent_(ev, scope);
      } catch (err) {
        console.error('handler error:', err && err.stack || err);
        if (ev.replyToken) {
          try { lineReply_(ev.replyToken, `⚠️ 處理失敗：${(err && err.message) || err}`); } catch (_) {}
        }
      } finally {
        setBillingUser_(null);
      }
    }
  } catch (err) {
    console.error('doPost error:', err && err.stack || err);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Route one event through the access gate before reaching routeEvent_.
 * Side effects: registers pending users, replies with appropriate gating
 * messages, sets _currentBillingUser for Gemini cost attribution.
 */
function dispatchEvent_(ev, scope) {
  // Lifecycle events (unfollow / leave) must always reach the router so we
  // can mark the user as blocked / clean up state — independent of their
  // current access status.
  if (ev.type === 'unfollow' || ev.type === 'leave') {
    return routeEvent_(ev);
  }
  // Follow event from a KNOWN member (any status) must also reach the router,
  // so re-followers transition out of 'blocked' via maybeUnblockOnRefollow_.
  // Brand-new strangers still fall through to the gate → handleNewStranger_.
  if (ev.type === 'follow' && scope.type === 'user' && scope.userId) {
    const owner = getPropOptional_(PROP.OWNER_LINE_USER_ID);
    if (scope.userId === owner || loadMember_(scope.userId)) {
      return routeEvent_(ev);
    }
  }
  // Follow event from a stranger needs the same gating + approval push, so
  // do the access check first for every other event type.
  const access = checkAccess_(ev, scope);
  switch (access.decision) {
    case 'allow':
      setBillingUser_(access.billTo);
      return routeEvent_(ev);

    case 'unknown':
      // First contact from a non-OWNER 1-on-1 user.
      return handleNewStranger_(ev, scope);

    case 'pending':
      return replyPendingThrottled_(ev, scope, access.member);

    case 'denied':
      if (ev.replyToken) lineReply_(ev.replyToken, '⚠️ 您的存取請求已被拒絕。');
      return;

    case 'revoked':
      if (ev.replyToken) lineReply_(ev.replyToken, '⚠️ 您的存取權已被撤銷。');
      return;

    case 'no_budget':
      if (ev.replyToken) {
        const m = access.member;
        lineReply_(ev.replyToken,
          `⚠️ 您的預算 $${(m.budgetUsd || 0).toFixed(4)} 已用盡（已花 $${(m.spentUsd || 0).toFixed(4)}）。\n請聯絡 OWNER 補額。`);
      }
      return;

    case 'group_inactive':
      // OWNER hasn't shown presence in this group yet — silent drop, no reply.
      return;

    default:
      return;
  }
}

function doGet(e) {
  // 互動式歷程報告（?view=journey&jid=...&t=...）；其餘回健康檢查文字。
  try {
    const page = routeGetRequest_(e);
    if (page) return page;
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<meta charset="utf-8"><p style="font-family:sans-serif;padding:40px;color:#a00">報告載入失敗：' +
      String(err && err.message || err).replace(/[<>&]/g, '') + '</p>');
  }
  return ContentService.createTextOutput('LINE Bot Learning Journal — alive')
    .setMimeType(ContentService.MimeType.TEXT);
}
