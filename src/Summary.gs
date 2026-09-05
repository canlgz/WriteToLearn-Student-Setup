/**
 * Build summaries over a time window for one chat scope.
 *
 * summarizeRecentDays_ : structured 5-section bullet output (used by /now).
 *   The 5th section「今日心情・聚焦」reads the writer's affect from the *tone*
 *   of the day's records (語感) and judges how focused vs. scattered the day
 *   was — surfaced highlighted on the card and in the PDF.
 * (The narrative /story path moved to the 5-layer model — see ContextStory.gs.)
 *
 * Window semantics:
 *   - days === 1 → strictly today's calendar day (midnight to now in TIME_ZONE).
 *     This matches user intuition that "/now" (目前記事) means "what I've written
 *     TODAY", not "the last 24 hours".
 *   - days >  1 → rolling window: now − days*24h to now.
 */

function summaryWindowMs_(days) {
  const endMs = Date.now();
  if (days === 1) {
    const todayStr = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    const startMs = Utilities.parseDate(todayStr + ' 00:00:00', TIME_ZONE, 'yyyy-MM-dd HH:mm:ss').getTime();
    return { startMs, endMs };
  }
  return { startMs: endMs - days * 24 * 3600 * 1000, endMs };
}

function summarizeRecentDays_(scope, days, label) {
  const { startMs, endMs } = summaryWindowMs_(days);
  const records = recordsInRange_(scope, startMs, endMs);
  if (!records.length) return '';

  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // Fold quote-reply chains into single logical units. Each thread becomes
  // one entry whose supplements are listed beneath, so Gemini sees "you
  // uploaded X and later corrected/expanded it" rather than two unrelated
  // bullets. recordsInRange_ may miss supplements from outside the window
  // that reference an in-window root, or vice versa — we tolerate that:
  // each entry-set is self-contained within the window.
  const threads = groupRecordsIntoThreads_(records);
  const entries = threads.map(t => renderThreadForPrompt_(t)).join('\n');

  const sys = '你是學習歷程教練。彙整以下時間段內的紀錄，輸出繁體中文 markdown，固定五個區塊、每塊用「## 」當標題、要點用「- 」條列：\n## 主題重點\n## 新學到的概念／詞彙\n## 待釐清・待跟進\n## 一句話總結\n## 今日心情・聚焦\n第四塊「一句話總結」只寫一句話、不要條列。第五塊「今日心情・聚焦」寫 1～2 句、不要條列：先純粹從上面紀錄的語感、用詞、語氣讀出書寫當下的心情與態度（用具體情緒詞，如「興奮又帶點焦慮」「平靜踏實」「自我懷疑、低落」，不要空話）；再判斷今天的書寫是「高度聚焦於某主題」「多線並行」還是「發散探索」，若聚焦就點名是哪個主題。避免重複原文、要做歸納；有「↳ 補充」代表使用者後來對原內容做了修正或補充，請把這層演變寫進敘事。直接從第一個「## 」開始，不要任何開場白、寒暄或結語。';
  const prompt = `時間段：${label}（最近 ${days} 天）\n共 ${records.length} 筆紀錄（已合併引述補充串）：\n\n${entries}`;
  return geminiGenerate_([{ text: prompt }], {
    systemInstruction: sys,
    temperature: 0.4,
    maxOutputTokens: 4096
  });
}

/**
 * Group records into threads keyed by their quote-reply ancestor.
 *
 *   - A record with no quotedRecordId, or whose quoted target is outside
 *     this window, becomes a thread root.
 *   - A record whose quotedRecordId is in-window attaches to that root's
 *     thread (multi-level chains flatten under their ultimate root —
 *     keeps the prompt simple).
 *
 * Output preserves chronological order of roots; within a thread,
 * supplements are listed in their own chronological order.
 */
function groupRecordsIntoThreads_(records) {
  const byId = {};
  for (const r of records) byId[r.id] = r;
  // Resolve each record to its root id (walk quotedRecordId chain while
  // the target is still in-window).
  const rootOf = {};
  function findRoot(r) {
    let cur = r;
    while (cur.quotedRecordId && byId[cur.quotedRecordId]) {
      cur = byId[cur.quotedRecordId];
      if (cur.id === r.id) break;  // pathological cycle guard
    }
    return cur.id;
  }
  for (const r of records) rootOf[r.id] = findRoot(r);
  const threadsById = {};
  for (const r of records) {
    const rid = rootOf[r.id];
    if (!threadsById[rid]) threadsById[rid] = { root: byId[rid], supplements: [] };
    if (r.id !== rid) threadsById[rid].supplements.push(r);
  }
  // Order threads by root timestamp; supplements stay in chronological order
  // (records were sorted by ts before grouping).
  return Object.keys(threadsById)
    .map(id => threadsById[id])
    .sort((a, b) => Date.parse(a.root.ts) - Date.parse(b.root.ts));
}

function renderThreadForPrompt_(thread) {
  const r = thread.root;
  const date = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd HH:mm');
  let out = `- [${date}][${typeLabel_(r.type)}] ${truncate_((r.text || '').replace(/\s+/g, ' '), 600)}`;
  for (const s of thread.supplements) {
    const sdate = Utilities.formatDate(new Date(s.ts), TIME_ZONE, 'MM/dd HH:mm');
    out += `\n  ↳ [${sdate}][補充 · ${typeLabel_(s.type)}] ${truncate_((s.text || '').replace(/\s+/g, ' '), 400)}`;
  }
  return out;
}

