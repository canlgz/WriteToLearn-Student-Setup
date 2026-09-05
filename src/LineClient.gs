/**
 * LINE Messaging API client.
 *
 * Reply buffering: when a buffer is active (Router wraps each event with
 * startReplyBuffer_ / flushReplyBuffer_), all lineReply_* / lineReplyMessages_
 * calls accumulate into the buffer instead of firing immediately. At the end
 * of the event Router flushes the buffer as one combined reply via the event's
 * replyToken — which lets us merge multiple handler outputs (e.g. handler reply
 * + auto-sweep results) into a single FREE reply instead of paying for pushes.
 */
let _replyBuffer = null;

function startReplyBuffer_() { _replyBuffer = { messages: [] }; }

/** While an ask/supplement session is open, guarantee the user always has a
 *  one-tap way out: attach the leave quick reply to the last reply that will be
 *  sent, unless it already carries one. Called right before flush, so it covers
 *  every card — including generic ones reached mid-mode (e.g. a clue's 看完整).
 *  No-op when not in a session. */
function ensureSessionQuickReply_(scope) {
  if (!_replyBuffer || !_replyBuffer.messages.length) return;
  const qr = dialogLeaveQuickReply_(scope);
  if (!qr) return;
  const msgs = _replyBuffer.messages;
  const lastSent = msgs[Math.min(msgs.length, 5) - 1];  // LINE sends ≤5; QR shows on the last sent
  if (lastSent && !lastSent.quickReply) lastSent.quickReply = qr;
}

function flushReplyBuffer_(replyToken) {
  if (!_replyBuffer) return;
  const msgs = _replyBuffer.messages;
  _replyBuffer = null;
  if (!msgs.length) return;
  if (!replyToken) {
    console.warn('flushReplyBuffer_: no replyToken; dropping', msgs.length, 'messages');
    return;
  }
  if (msgs.length > 5) {
    console.warn('flushReplyBuffer_: dropping', msgs.length - 5, 'messages beyond LINE 5-per-reply limit');
  }
  const head = msgs.slice(0, 5);
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = lineReplyFetch_(token, replyToken, head);
  let code = res.getResponseCode();
  let body = res.getContentText();

  // LINE rejects the entire batch atomically; one stale quoteToken can sink
  // four other valid messages. Retry once without any quoteToken so the user
  // at least sees the content — losing the quote is the lesser evil.
  if (code >= 400 && head.some(m => m && m.quoteToken)) {
    console.warn('flushReplyBuffer_ failed with quoteToken:', code, body.slice(0, 200), '— retrying without quoteTokens');
    const stripped = head.map(m => {
      if (!m || !m.quoteToken) return m;
      const copy = Object.assign({}, m);
      delete copy.quoteToken;
      return copy;
    });
    const res2 = lineReplyFetch_(token, replyToken, stripped);
    code = res2.getResponseCode();
    body = res2.getContentText();
  }

  if (code >= 400) {
    console.error('flushReplyBuffer_ failed:', code, body.slice(0, 600));
    try {
      const owner = PropertiesService.getScriptProperties().getProperty('OWNER_LINE_USER_ID');
      if (owner) linePush_(owner, `⚠️ LINE 拒絕訊息（${code}）：\n${body.slice(0, 400)}`);
    } catch (e) {
      console.error('failed to push error notice:', e && e.message);
    }
  }
}

function lineReply_(replyToken, text, customQuickReply, quoteToken) {
  const msg = {
    type: 'text',
    text: truncate_(text, 4900)
  };
  if (customQuickReply) msg.quickReply = customQuickReply;
  if (quoteToken) msg.quoteToken = quoteToken;

  if (_replyBuffer) {
    _replyBuffer.messages.push(msg);
    return;
  }
  if (!replyToken) return;
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = lineReplyFetch_(token, replyToken, msg);
  // If the only message-level field that LINE might reject is quoteToken,
  // retry once without it so the user still gets a response.
  if (res.getResponseCode() >= 400 && quoteToken) {
    console.warn('lineReply with quoteToken failed:', res.getResponseCode(), res.getContentText().slice(0, 200), '— retrying without quoteToken');
    delete msg.quoteToken;
    const res2 = lineReplyFetch_(token, replyToken, msg);
    if (res2.getResponseCode() >= 400) {
      console.error('lineReply retry also failed:', res2.getResponseCode(), res2.getContentText().slice(0, 200));
    }
  } else if (res.getResponseCode() >= 400) {
    console.error('lineReply failed:', res.getResponseCode(), res.getContentText().slice(0, 200));
  }
}

/** Drop characters LINE rejects in a message ("Invalid characters are included
 *  in flex message"): C0 control chars (except \n, \t) and lone UTF-16
 *  surrogates — the latter typically produced by slicing an emoji mid-pair. */
function sanitizeLineText_(s) {
  if (!s) return s;
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {                 // high surrogate
      const n = s.charCodeAt(i + 1);
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++; }  // valid pair
      // else: lone high surrogate → drop
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      // lone low surrogate → drop
    } else {
      out += s[i];
    }
  }
  return out;
}

/** Recursively sanitize every string in an outgoing message payload, so one bad
 *  character in any text field can't get the whole reply rejected. */
function sanitizeOutgoing_(obj) {
  if (typeof obj === 'string') return sanitizeLineText_(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeOutgoing_);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k in obj) out[k] = sanitizeOutgoing_(obj[k]);
    return out;
  }
  return obj;
}

function lineReplyFetch_(token, replyToken, msgOrMessages) {
  const messages = sanitizeOutgoing_(Array.isArray(msgOrMessages) ? msgOrMessages : [msgOrMessages]);
  return UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ replyToken, messages }),
    muteHttpExceptions: true
  });
}

/** Send multiple messages (up to 5) in one reply. */
function lineReplyMessages_(replyToken, messages) {
  if (!messages || !messages.length) return;
  if (_replyBuffer) {
    for (const m of messages) _replyBuffer.messages.push(m);
    return;
  }
  if (!replyToken) {
    console.warn('lineReplyMessages: skipped — no replyToken, messages?', messages.length);
    return;
  }
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const payload = JSON.stringify({ replyToken, messages });
  const res = lineReplyFetch_(token, replyToken, messages);
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code >= 400) {
    console.error('lineReplyMessages failed:', code, body.slice(0, 800));
    console.error('lineReplyMessages payload (first 1500):', payload.slice(0, 1500));
    // Surface rejection to the OWNER so we don't need to dig into the
    // Apps Script Executions log to notice broken replies.
    try {
      const owner = PropertiesService.getScriptProperties().getProperty('OWNER_LINE_USER_ID');
      if (owner) {
        linePush_(owner, `⚠️ LINE 拒絕訊息（${code}）：\n${body.slice(0, 400)}`);
      }
    } catch (e) {
      console.error('failed to push error notice:', e && e.message);
    }
  }
}

/**
 * Send a Template Carousel message — horizontal swipeable cards, each
 * with title / text / 1-3 action buttons. All columns must have the
 * same number of actions per LINE's constraint.
 */
function lineReplyCarousel_(replyToken, altText, columns, customQuickReply) {
  const msg = {
    type: 'template',
    altText: (altText || '').slice(0, 400),
    template: { type: 'carousel', columns: columns }
  };
  if (customQuickReply) msg.quickReply = customQuickReply;
  if (_replyBuffer) { _replyBuffer.messages.push(msg); return; }
  if (!replyToken) return;
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = lineReplyFetch_(token, replyToken, msg);
  if (res.getResponseCode() >= 400) {
    console.error('lineReplyCarousel failed:', res.getResponseCode(), res.getContentText().slice(0, 300));
  }
}

/**
 * Send a Flex Message — custom-layout cards with full control over
 * proportions, colors, and content. `contents` is a single bubble
 * object or a carousel object ({ type: 'carousel', contents: [...] }).
 */
function lineReplyFlex_(replyToken, altText, contents, customQuickReply) {
  const msg = {
    type: 'flex',
    altText: (altText || '').slice(0, 400),
    contents: contents
  };
  if (customQuickReply) msg.quickReply = customQuickReply;
  if (_replyBuffer) { _replyBuffer.messages.push(msg); return; }
  if (!replyToken) return;
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = lineReplyFetch_(token, replyToken, msg);
  if (res.getResponseCode() >= 400) {
    console.error('lineReplyFlex failed:', res.getResponseCode(), res.getContentText().slice(0, 300));
  }
}

function linePush_(userId, text, quoteToken) {
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const msg = { type: 'text', text: truncate_(text, 4900) };
  if (quoteToken) msg.quoteToken = quoteToken;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({
      to: userId,
      messages: sanitizeOutgoing_([msg])
    }),
    muteHttpExceptions: true
  });
}

/** Push a Flex bubble/carousel (same quota cost as a text push). */
function linePushFlex_(userId, altText, contents) {
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const msg = { type: 'flex', altText: (altText || '').slice(0, 400), contents: contents };
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ to: userId, messages: sanitizeOutgoing_([msg]) }),
    muteHttpExceptions: true
  });
}

/* ===== 背景主動推播的「合宜」守門（時機集中管控，對齊無痕靜默·少打擾） ===== */

/** 夜間靜默窗（TIME_ZONE）：預設 22:00–08:00 不主動推播。 */
function inQuietHours_(ts) {
  const h = parseInt(Utilities.formatDate(new Date(ts || Date.now()), TIME_ZONE, 'H'), 10);
  return (PROACTIVE_QUIET_START_HOUR > PROACTIVE_QUIET_END_HOUR)
    ? (h >= PROACTIVE_QUIET_START_HOUR || h < PROACTIVE_QUIET_END_HOUR)   // 跨午夜窗
    : (h >= PROACTIVE_QUIET_START_HOUR && h < PROACTIVE_QUIET_END_HOUR);
}

/** 把落在靜默窗的時間點順延到出窗後（早上）＋隨機 0–60 分（免整點齊射）。回返提醒排程用。 */
function clampOutOfQuiet_(ts) {
  let t = ts || Date.now();
  let guard = 0;
  while (inQuietHours_(t) && guard++ < 26) t += 60 * 60 * 1000;   // 逐時推到出靜默窗
  return t + Math.floor(Math.random() * 60 * 60 * 1000);
}

/** 主動學習推播統一守門：① 使用者全關（meta.proactivePushMuted）② 夜間靜默 ③ 跨功能全域冷卻
 *  （PROACTIVE_PUSH_GLOBAL_COOLDOWN_MS，杜絕一輪噴多張）。回 true＝可推（推完務必 markProactivePush_）；
 *  false＝這輪先別推、**別 claim 去重鍵**，下輪再評估。 */
function proactivePushAllowed_(scope) {
  if (!scope || !scope.key) return false;   // meta 以 scope 為單位；推播目標由呼叫端自理（1:1 或 group 的 userId）
  const meta = loadChatMeta_(scope);
  if (meta.proactivePushMuted) return false;
  if (inQuietHours_()) return false;
  if (Date.now() - (meta.lastProactivePushAt || 0) < PROACTIVE_PUSH_GLOBAL_COOLDOWN_MS) return false;
  return true;
}

/** 推完一張主動卡後呼叫：記錄時間，餵全域冷卻（「一輪一張」）。 */
function markProactivePush_(scope) {
  try { updateChatMeta_(scope, m => { m.lastProactivePushAt = Date.now(); return m; }); } catch (_) {}
}

/** reorg 類通知（新進展/智慧合併）也等使用者停筆（REORG_SETTLE_MS），不在打字中打斷。 */
function userSettledForReorg_(scope) {
  const meta = loadChatMeta_(scope);
  const last = meta.lastIngestTs ? Date.parse(meta.lastIngestTs) : 0;
  return !last || (Date.now() - last) >= REORG_SETTLE_MS;
}

/**
 * Show a typing / loading indicator in the user's chat for `seconds`
 * (rounded to the nearest 5, clamped 5-60). One-on-one chats only;
 * group / room chats do not support this API.
 */
function showLoadingAnimation_(userId, seconds) {
  if (!userId) return;
  const s = Math.min(60, Math.max(5, Math.round((seconds || 30) / 5) * 5));
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ chatId: userId, loadingSeconds: s }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    console.warn('showLoadingAnimation failed:', res.getResponseCode(), res.getContentText().slice(0, 200));
  }
}

/**
 * Fetch the channel's current month push-message quota and consumption.
 * Returns null if either API call fails. Reply / webhook events are NOT
 * counted — only push / multicast / broadcast.
 *   type === 'none'    → no limit (paid premium plan)
 *   type === 'limited' → value = monthly cap
 *
 * Cached in CacheService for 60s — channel-level data that doesn't change
 * fast, and removes ~1s of latency from every /me call.
 */
const LINE_QUOTA_CACHE_KEY = 'line:quota:v1';
const LINE_QUOTA_CACHE_TTL_S = 60;

function getLineMessageQuota_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(LINE_QUOTA_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (_) {}
  }
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const opts = {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  };
  try {
    const r1 = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota', opts);
    const r2 = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', opts);
    if (r1.getResponseCode() >= 400 || r2.getResponseCode() >= 400) {
      console.warn('getLineMessageQuota_ HTTP failure',
        r1.getResponseCode(), r2.getResponseCode());
      return null;
    }
    const quota = JSON.parse(r1.getContentText());
    const consumed = JSON.parse(r2.getContentText());
    const remaining = quota.type === 'limited' && typeof quota.value === 'number'
      ? Math.max(0, quota.value - (consumed.totalUsage || 0))
      : null;
    const result = {
      type: quota.type,
      limit: quota.value || null,
      consumed: consumed.totalUsage || 0,
      remaining
    };
    try { cache.put(LINE_QUOTA_CACHE_KEY, JSON.stringify(result), LINE_QUOTA_CACHE_TTL_S); } catch (_) {}
    return result;
  } catch (e) {
    console.error('getLineMessageQuota_ failed:', e && e.message);
    return null;
  }
}

/**
 * Download media content (image/audio/video/file) for a given LINE message.
 *
 * Audio/video can be transiently 404 right after upload (server still encoding)
 * and api-data.line.me sometimes stalls long enough for UrlFetchApp to time out.
 * Retry 404/408/429/5xx and fetch-thrown errors (timeouts) up to 3 attempts
 * with 1s/3s backoff — well under LINE's ~30s webhook tolerance.
 */
function lineGetContent_(messageId) {
  const token = getProp_(PROP.LINE_CHANNEL_ACCESS_TOKEN);
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const opts = {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  };
  const backoffMs = [1000, 3000];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = UrlFetchApp.fetch(url, opts);
    } catch (e) {
      lastErr = e;
      console.warn(`lineGetContent ${messageId} attempt ${attempt + 1} threw: ${(e && e.message) || e}`);
      if (attempt < backoffMs.length) { Utilities.sleep(backoffMs[attempt]); continue; }
      throw new Error(`lineGetContent ${messageId} timeout after 3 attempts: ${(e && e.message) || e}`);
    }
    const code = res.getResponseCode();
    if (code < 300) return res.getBlob();
    const retriable = code === 404 || code === 408 || code === 429 || code >= 500;
    if (retriable && attempt < backoffMs.length) {
      console.warn(`lineGetContent ${messageId} attempt ${attempt + 1} got ${code}; retrying`);
      Utilities.sleep(backoffMs[attempt]);
      continue;
    }
    throw new Error(`lineGetContent ${messageId} failed: ${code} ${res.getContentText().slice(0, 200)}`);
  }
  throw lastErr || new Error(`lineGetContent ${messageId} failed after retries`);
}

function truncate_(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  let end = n - 1;
  // Don't cut in the middle of a surrogate pair — a lone surrogate gets the
  // whole flex message rejected by LINE ("Invalid characters").
  const last = s.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return s.slice(0, end) + '…';
}

/**
 * 卡片按鈕回顯（displayText）統一格式：`▸ <動詞>[ · <目標>]`。
 * 在 LINE 上，按鈕的 displayText 會以「使用者自己的綠泡泡」夾進真實記寫——前置 `▸`
 * 讓人一眼看出是「操作回顯」而非自己打的字（手寫筆記幾乎不會以 ▸ 開頭），`· 目標`
 * 講清楚操作對象，`truncate_` 控長度避免囉唆。動作全域明確時可不給 target。
 * 集中在一處，杜絕各檔回顯格式漂移。
 */
function opEcho_(verb, target, n) {
  return target ? `▸ ${verb} · ${truncate_(String(target), n || 16)}` : `▸ ${verb}`;
}
