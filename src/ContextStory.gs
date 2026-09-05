/**
 * 學習歷程總冊（/story）的內文產生器。See docs/design/context-to-journey.md §五 + §0.6.14.
 *
 *   summarizeJourneyStory_ — 每條有轉折標記的歷程(層5)寫成一個 before→after 的學習單元，
 *   明確標出轉折種類。由持久化的 歷程 物件(block 3 output)而非 raw 時間窗建構。
 *   Orchestration（總冊封面/目錄/Drive/Flex）在 replyStory_（Handlers.gs）。
 *
 *   （舊「雙版 story」的 _context.md「在想什麼」日記版 2026-06-10 隨 /story 改造成總冊移除。）
 */

const STORY_JOURNEY_RECORDS = 12;  // records per 歷程 fed to the journey story

/** Evenly sample up to n elements across a (time-sorted) array, keeping ends. */
function sampleEvenly_(arr, n) {
  if (arr.length <= n) return arr.slice();
  if (n <= 1) return [arr[0]];
  const out = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

function recordsForContext_(context, recById) {
  return (context.recordIds || [])
    .map(id => recById[id])
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function recText_(r) {
  return ((r.aggregatedText || r.text) || '').replace(/\s+/g, ' ');
}

/** 總冊內文 — 每條有轉折的歷程一個學習單元. One Gemini call. */
function summarizeJourneyStory_(journeys, ctxById, recById) {
  if (!journeys.length) return '';
  const blocks = journeys.map(j => {
    const c = ctxById[j.contextId];
    const recs = c ? recordsForContext_(c, recById) : [];
    const msgs = sampleEvenly_(recs, STORY_JOURNEY_RECORDS).map(r => {
      const d = Utilities.formatDate(new Date(r.ts), TIME_ZONE, 'MM/dd');
      return `  - [${d}] ${truncate_(recText_(r), 150)}`;
    }).join('\n');
    const marks = (j.markers || []).map(m => `  - ${m.type}：「${m.evidence}」`).join('\n');
    return `【歷程：${j.label}】\n轉折標記：\n${marks}\n依時間的訊息：\n${msgs}`;
  }).join('\n\n');

  const sys = '你是學習歷程教練。以下每條歷程都已偵測到「學習轉折」。請為每條寫一個「學習單元」，用 markdown：以 `## <主題>` 開頭，內含——轉折種類（明確寫出概念重述／跨主題整合／行動指向／後設反思中的哪些）、轉折前後對照（before → after）、學到了什麼、下一步可能。只根據提供內容、不腦補，不要寒暄與結語，直接從第一個 `## ` 開始。';
  const prompt = `請把以下每條歷程各寫成一個學習單元，回答「我這陣子學到了什麼」：\n\n${blocks}`;
  return geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.45, maxOutputTokens: 4096 });
}
