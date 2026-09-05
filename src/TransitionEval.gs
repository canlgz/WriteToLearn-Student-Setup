/**
 * 轉折評鑒 v2(multi-signal composite)— 取代 JourneyDetect.gs:evaluateTransitionDraft_
 * 的單純 LLM 判斷,以兩個獨立信號的 min-rule 合成最終分數,確保「LLM 認定 + 結構真有」
 * 才算數。讓「我認為 X」這類空話無法靠 LLM 寬鬆過閘。
 *
 * 設計原理(對應「形成性評量工具」研究方法):
 *
 *   S1 = LLM rubric judgment   :Gemini + 嵌入 anchor exemplars 的 prompt 給 0-1 分數
 *   S2 = Structural features   :程式 regex 配對 + 長度/句法評分,純 CPU 不靠 LLM
 *   final = 0.65·max(S1,S2) + 0.35·min(S1,S2)   :max-biased 加權合成
 *
 * 〔2026-06-02 校準後改 min → max-biased 加權〕第一輪 80 例校準發現:anchor
 * exemplars 已讓 S1 對空話判得很準(「我認為提問策略」S1=0.05),原 min() 守門
 * 價值大減,反而讓「一邊 rater 漏接」變一票否決、系統性低估高分(MAE 0.18、
 * 高分案例被砍至 0.15)。改 max-biased:兩個各有盲點的 rater 互補,一邊抓到就
 * 大致採信、另一邊弱也不歸零;但兩邊都低(空話)時 max 也低,守門力不失。
 *
 * 對「我認為提問策略的訓練」:S1=0.05 S2=0.05 → 0.05(仍擋下)
 * 對「我突然發現我教《野獸國》是在做兒童心理諮商」:S1=0.85 S2=0.15 → 0.61(不再被砍死)
 *
 * 不影響升格 detect(下游 detectContextMarkers_ 不動),只影響「補進脈絡」入場閘。
 */

/** 〔通用原則 1〕非對稱合成:final = S1 + max(0, S2-S1)·BOOST。
 *  S2 只上修(比 S1 高時拉一部分上來)、漏接不下扣(比 S1 低時不動)。
 *  0=純 S1、1=等於 max(S1,S2)。0.6=S2 命中時可觀拉抬,但仍以 S1 為錨。 */
const EVAL_S2_BOOST = 0.6;

/* ============== Structural features (S2):純 CPU、regex-based ============== */

const STRUCT_PATTERNS = {
  '概念重述': {
    // 自己的話的開頭(必須跟著實質內容,所以後面 .{6,} 強制有後文)。
    // 〔校準補強〕加「在我看來 / 我看來 / 在我眼中 / 我的理解是 / 我傾向把…理解成」等口語標記。
    paraphrase: /(我自己(理解|的理解|的看法)|我認為.{8,}|我覺得.{8,}|對我來說|我會這樣(說|講|理解)|在我看來|我看來|在我眼中|我的理解(是|就是)|我傾向(把|將).{2,}(理解|看|想)成?|我.{0,3}會這樣(看|講|說|理解))/,
    // 「就是 / 其實是 / 不是 X 而是 Y」概念說明結構。
    // 〔校準補強〕加「不是 X,是 Y(逗號版)」「它不是…是…」「X 其實…」「不僅僅是 X,(同時)也是 Y」。
    explainStruct: /(就是.{4,}|其實是.{4,}|其實.{2,}是.{3,}|不是.{2,}而是.{4,}|不是.{2,}[，,].{0,4}是.{3,}|它?不是.{2,}[，,。].{0,6}是.{3,}|不僅僅?是.{2,}[，,。]?.{0,6}(同時)?也是.{2,}|不只是.{2,}[，,。]?.{0,6}(同時)?也是.{2,}|本質(是|在|就是).{3,}|關鍵(是|在|就在).{3,}|機制是.{3,}|是一個.{2,}(過程|系統|狀態|工具|管道|能力))/,
    // 對比 / 釐清的字眼
    clarify: /(不是.{2,}而是|不是.{2,}[，,].{0,4}是|並非|跟.{1,8}差別|相對於|區別在|差別在)/,
    minLen: 15
  },
  '跨主題整合': {
    // 整合關係詞:「A 跟 B 是同一回事 / 兩面 / 對應 / 對得起來 / 接得上」。
    // 〔校準補強〕加「對得起來 / 對應得上 / 搭得上 / 接得起來 / 接上 / 是一回事 / 互相印證 / 不謀而合」。
    integrate: /(跟.{1,12}(是|都).{0,4}(同|一樣|一回事)|一體兩面|同一回事|是一回事|相對應|對應得上|對得起來|呼應|搭得上|接(得|起)來|接上|連到|連起來|延伸到|不謀而合|互相印證|兩面)/,
    // 「X 跟 Y」配對 + 連接詞
    pairing: /(.{2,8}跟(.{2,8}))(是|的|都|跟|可以|對|搭|接|連|不謀)/,
    // 跨領域標記
    crossDomain: /(其實|根本|沒想到|才發現|突然發現|原來).{0,10}(就是|是同|是一回事|跟.{1,8}(一樣|對得起來|不謀))/,
    minLen: 15
  },
  '行動指向': {
    // 〔校準補強〕個人未來行動定錨——必須是「我要/我會做」或明確時間起點,不收
    // 「必須讓/應該/要能」這種規範論述(那是『提問策略應該怎樣』,不是『我接下來要做什麼』)。
    // 這道閘修掉論述句被 actionVerb 誤判成行動計畫(實機「提問策略必須讓學生…」誤報 47%)。
    futureTime: /(我(要|會|將|打算|預計|計畫|準備)|下(週|月|個|次|學期|年)|明(天|早|年)|接下來我|本週起|從(明天|下週|下個|今天|下星期)|每(週|天|次|堂|節)(課)?(我|都|要|會)|連續.{0,3}(週|天|個月))/,
    // 具體教學動作——去掉泛詞(試試/做/練習/嘗試),只留可觀察的具體動作,避免論述祈使誤命中。
    actionVerb: /(設計|蒐集|收集|記錄|施測|批改|觀課|觀察|統計|出題|備課|實施|推廣|安排|發放|訪談|錄|拍|追蹤|彙整|分析)/,
    // 量化 / 條件
    concrete: /(\d+|分鐘|小時|連續|兩(週|天)|三(週|天)|個學生|題|次|份|堂|節|每(週|天|堂))/,
    minLen: 15
  },
  '後設反思': {
    // 後設動詞(對自己學習狀態的觀察)
    metaVerb: /(發現自己|意識到|原本以為|沒想到|回頭看|現在想想|現在覺得|我才知道|赫然|看清楚|看出來|始終|一直在|終於發現)/,
    // 階段語言
    stageLang: /(階段|還在|還沒|已經|原本|現在|曾經|過去|這段時間)/,
    // 自我指涉的學習觀察
    selfObs: /(我.{0,4}(一直|還在|早就|還沒|終於)|我.{0,6}的(問題|盲點|迷思|盲區))/,
    minLen: 15
  }
};

/**
 * 〔通用原則 2+3〕型別閘 + 強度分級,取代窮舉句型加分。
 * - hasCore:該轉折的「結構必要條件」。不過閘 → 封頂低分(結構上看不出該轉折),
 *   這道閘防止「論述句被當行動」「單主題被當整合」「對事物的發現被當後設」等誤報。
 * - 過閘 → 0.40 基底 + addends 強度加成 + 長度加成。
 * - 短句若有強 core 標記(hasCore=true)豁免長度地板,不被 minLen 壓掉。
 */
function structGatedScore_(draft, minLen, hasCore, addends) {
  if (!hasCore) {
    // 結構上看不出該轉折:短句更低,長句也只給微量基底(交給 S1 語意判斷)。
    return draft.length < minLen ? Math.max(0.02, draft.length / minLen * 0.1) : 0.08;
  }
  let score = 0.40;  // 過閘基底
  for (const a of addends) if (a.test) score += a.w;
  if (draft.length >= 60) score += 0.15;
  else if (draft.length >= 40) score += 0.08;
  return Math.min(1, score);
}

function structConceptRestatement_(draft) {
  const p = STRUCT_PATTERNS['概念重述'];
  // 型別閘:有概念展開結構,或有個人視角標記(用自己的話講)。
  const hasCore = p.explainStruct.test(draft) || p.paraphrase.test(draft);
  return structGatedScore_(draft, p.minLen, hasCore, [
    { test: p.explainStruct.test(draft), w: 0.20 },
    { test: p.paraphrase.test(draft),    w: 0.15 },
    { test: p.clarify.test(draft),       w: 0.10 }
  ]);
}

function structTopicIntegration_(draft) {
  const p = STRUCT_PATTERNS['跨主題整合'];
  // 型別閘:有整合關係詞,或(明確配對 + 跨域標記)。單一主題不過閘。
  const hasCore = p.integrate.test(draft) || (p.pairing.test(draft) && p.crossDomain.test(draft));
  return structGatedScore_(draft, p.minLen, hasCore, [
    { test: p.integrate.test(draft),   w: 0.25 },
    { test: p.pairing.test(draft),     w: 0.10 },
    { test: p.crossDomain.test(draft), w: 0.10 }
  ]);
}

function structActionOrientation_(draft) {
  const p = STRUCT_PATTERNS['行動指向'];
  // 型別閘:必須有「個人未來行動定錨」。論述/描述句(必須讓…要能…)無此標記 → 不過閘。
  const hasCore = p.futureTime.test(draft);
  return structGatedScore_(draft, p.minLen, hasCore, [
    { test: p.actionVerb.test(draft), w: 0.25 },
    { test: p.concrete.test(draft),   w: 0.25 }
  ]);
}

function structMetaReflection_(draft) {
  const p = STRUCT_PATTERNS['後設反思'];
  // 型別閘:必須有後設動詞或自我指涉(觀察自己)。對事物的發現(我發現學生…)不過閘。
  const hasCore = p.metaVerb.test(draft) || p.selfObs.test(draft);
  return structGatedScore_(draft, p.minLen, hasCore, [
    { test: p.metaVerb.test(draft),  w: 0.20 },
    { test: p.selfObs.test(draft),   w: 0.15 },
    { test: p.stageLang.test(draft), w: 0.15 }
  ]);
}

function computeS2StructuralScores_(draft) {
  return {
    '概念重述':   structConceptRestatement_(draft),
    '跨主題整合': structTopicIntegration_(draft),
    '行動指向':   structActionOrientation_(draft),
    '後設反思':   structMetaReflection_(draft)
  };
}

/* ============== S1:LLM rubric with embedded anchor exemplars ============== */

/** 從 calibration set 撈 4 個 anchor exemplars(0%, 30%, 60%, 85% 附近),嵌入 prompt
 *  讓 LLM 有錨可依、避免漂浮判斷。如果 calibration 不可用,退回通用 rubric。 */
function buildAnchorRubric_(transType) {
  const all = (typeof TRANSITION_CALIBRATION !== 'undefined' && TRANSITION_CALIBRATION[transType]) || [];
  if (!all.length) return '';
  // 找最接近 0.05 / 0.30 / 0.60 / 0.85 的 exemplars
  const targets = [0.05, 0.30, 0.60, 0.85];
  const lines = ['【' + transType + ' 評分尺度範例】'];
  targets.forEach(t => {
    let best = null, bestDist = 999;
    for (const ex of all) {
      const d = Math.abs(ex.score - t);
      if (d < bestDist) { bestDist = d; best = ex; }
    }
    if (best) lines.push(`  ${Math.round(best.score * 100)}%: 「${best.input}」`);
  });
  return lines.join('\n');
}

function computeS1LLMScores_(draft, contextSummary) {
  const sys = '你是嚴格的學習轉折評鑒員,**評分嚴格,寧可低估不要高估**。依下列各類型 anchor exemplars 的尺度評分,只看實質內容,不因「主題詞有出現」「我認為/我覺得開頭」就加分。嚴格 JSON、繁體中文。';
  const rubrics = ['概念重述', '跨主題整合', '行動指向', '後設反思']
    .map(t => buildAnchorRubric_(t)).filter(Boolean).join('\n\n');
  const prompt = [
    rubrics,
    '',
    '評分總原則:',
    '- 只看實質內容,不看文字量。',
    '- 「我認為 X」「對於 X 的訓練」「X 很重要」一律 ≤ 10%——只是命名主題,不是轉折。',
    '- 用範例間插值(0%→30%→60%→85%),要接近哪個範例就給對應分數。',
    '- 寧可低估、不要高估。',
    '',
    `脈絡背景:${contextSummary || ''}`,
    '',
    '使用者補充(原話):',
    draft,
    '',
    '對四種轉折分別評分(0~1)。只輸出 JSON:',
    '{"概念重述":0.x,"跨主題整合":0.x,"行動指向":0.x,"後設反思":0.x}',
    '不要 markdown code fence、不要解說。'
  ].join('\n');

  let raw;
  try {
    // 〔前景不吃背景額度·Fix2〕補充評鑑是使用者主動觸發的前景動作（每打一輪都會跑），不該扣
    // 背景分類/升格共用的每日額度（JOURNEY_DETECT_DAILY_MAX）——否則猛測補充會把基礎分類的額度
    // 吸乾、新記錄卡在「等待整理」。前景由使用者打字節奏 + Gemini RPD 自然封頂即可。
    raw = geminiGenerate_([{ text: prompt }], { systemInstruction: sys, temperature: 0.2, maxOutputTokens: 200 });
  } catch (e) { console.warn('computeS1LLMScores_ failed:', e && e.message); return null; }
  const json = extractJson_(raw || '');
  if (!json) return null;
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const out = {};
  for (const t of TYPES) out[t] = clamp01_(json[t]);
  return out;
}

/* ============== Composite final eval ============== */

/**
 * Multi-signal composite scoring:final = min(S1_LLM, S2_structural) per type。
 * 同舊 evaluateTransitionDraft_ 回傳的 shape(scores/topType/topScore/sum/missingHint),
 * 額外多帶 breakdown 給診斷用。
 *
 * 一次 LLM call(S1) + 純 CPU 規則(S2)。比舊版多了 S2 把關,計算成本基本不變。
 */
function evaluateTransitionDraftComposite_(draft, contextSummary) {
  if (!draft) return null;
  const s2 = computeS2StructuralScores_(draft);
  const s1 = computeS1LLMScores_(draft, contextSummary);
  if (!s1) return null;
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const composed = {};
  TYPES.forEach(t => {
    // 〔通用原則 1〕非對稱合成:S1 為語意判斷主力(anchor 已校準守門),S2 結構信號
    // 只在比 S1 高時「上修」,比 S1 低時「不下扣」。一句寫得好但句型沒被 S2 收錄,
    // 不該被懲罰(治本「未收錄句型拖低高品質補充」,免去窮舉句型補 regex 的無底洞)。
    const a = s1[t] || 0, b = s2[t] || 0;
    composed[t] = a + Math.max(0, b - a) * EVAL_S2_BOOST;
  });
  let topType = TYPES[0], topScore = -1;
  TYPES.forEach(t => { if (composed[t] > topScore) { topScore = composed[t]; topType = t; } });
  const sum = TYPES.reduce((acc, t) => acc + composed[t], 0);
  // missingHint:看 top type 的 S1 跟 S2 哪個低,給對應提示
  let missingHint = '';
  if (topScore < SUPPLEMENT_EVAL_THRESHOLD) {
    const s1Top = s1[topType] || 0;
    const s2Top = s2[topType] || 0;
    if (s2Top < s1Top - 0.10) {
      missingHint = missingStructuralHint_(topType);
    } else if (s1Top < s2Top - 0.10) {
      missingHint = '內容具體性還不夠,LLM 判定該轉折還沒到位';
    } else {
      missingHint = '請更具體地寫出該轉折的實質內容';
    }
  }
  return {
    scores: composed,
    topType: topType,
    topScore: topScore,
    sum: sum,
    missingHint: missingHint,
    breakdown: { s1: s1, s2: s2 }
  };
}

function missingStructuralHint_(transType) {
  return {
    '概念重述':   '缺「就是 X / 其實是 X / 不是 X 而是 Y」這種概念說明結構',
    '跨主題整合': '缺「X 跟 Y 是同一回事 / 兩面 / 對應」這種整合關係詞',
    '行動指向':   '缺具體時間(下週/明天)+ 具體動作 + 量化',
    '後設反思':   '缺「我發現自己一直在.../我還在 X 階段」這種跳出來看自己的句子'
  }[transType] || '請更具體';
}
