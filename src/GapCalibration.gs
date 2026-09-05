/**
 * 落差量尺驗證骨架 — 回答「『歷程現況 ↔ 有意義歷程』的距離,目前這把尺量得準嗎?」
 *
 * 目的不是把分數做高,而是用客觀數據檢驗這把尺的三件事(對齊使用者:要忠實反映距離):
 *   1) 效度(validity)      ── 算出的距離 vs 人(本檔作者)對距離的判斷,一致嗎?(MAE / Pearson r)
 *      再拆兩段:  (a) LLM 判的等級 vs 作者等級;
 *                 (b) 「等級→分數」公式 vs 作者的整體距離感(gtHolistic)——這段測**公式本身**的構念效度。
 *   2) 單調性(monotonicity)── 真的深化一段,距離該縮小;灌水重複,距離不該動。尺反映得出來嗎?
 *   3) 鑑別度(discrimination)── 好/中/差三組,算出的分數分布有沒有分開(還是全擠在 40~52)?
 *
 * 方法沿用 Calibration.gs(轉折評鑒)的 design-once 客觀驗證法:作者依操作化定義標 ground truth、
 * editor 直接跑、報告寫 _reports/*.json(Drive MCP 可讀)。每例 = 1 次 computeJourneyGap_ LLM call。
 *
 * 跑法(GAS editor):
 *   runGapCalibration()    ── 全集效度 + 鑑別度(~14 calls)
 *   runGapMonotonicity()   ── 深化↑/灌水≈ 單調性(~9 calls)
 *   runGapReliability(3)   ── 同 input 重跑測抖動(~15 calls)
 *
 * ⚠️ 校準集是「合成 mini-journey」,ground truth 是作者依 computeJourneyGap_ 的等級定義所標。
 *    若日後與共識評分(rater 共議)有出入,重寫本檔 gt / gtHolistic 即可。
 */

/* ============================================================
 * 校準集:涵蓋「離有意義很遠 → 很近」的光譜。
 * 每例:records(依序的記寫)、title、可選 otherTopics、
 *       gt(作者標的四軸「發展程度」連續 0~1)、gtHolistic(作者對「離有意義多近」的整體感 0-100,獨立於公式)。
 * gt 四軸＝四種學習轉折(與 computeJourneyGap_ 同構):
 *   conceptDepth 概念深化、crossTopic 跨主題整合、actionOrient 行動指向、metaReflection 後設反思,各 0~1。
 * 公式分數由 gapScoreFromLevels_(gt) 即時算(不硬編、不漂移)。
 * ============================================================ */
const GAP_CALIBRATION = [
  {
    id: 'naming', title: '形成性評量', gtHolistic: 5,
    gt: { conceptDepth: 0, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: ['形成性評量', '形成性評量好像很重要', '再去看看形成性評量']
  },
  {
    id: 'collect', title: '形成性評量資料', gtHolistic: 6,
    gt: { conceptDepth: 0, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: ['轉貼一篇形成性評量的文章', '又看到一支形成性評量的影片', '先存起來之後看']
  },
  {
    id: 'pad-water', title: '提問的重要', gtHolistic: 4,
    gt: { conceptDepth: 0, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: ['提問很重要', '提問真的很重要', '我覺得提問超重要', '提問策略很關鍵']
  },
  {
    id: 'shallow-define', title: '幾個教學名詞', gtHolistic: 16,
    gt: { conceptDepth: 0.3, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: ['形成性評量是過程中的評估', '它就是邊教邊測', '鷹架是給學生支持的方式']
  },
  {
    id: 'partial-move', title: '提問是什麼', gtHolistic: 24,
    gt: { conceptDepth: 0.4, crossTopic: 0, actionOrient: 0, metaReflection: 0.1 },
    records: ['一開始我以為提問就是準備好問題', '後來覺得好像不只這樣', '可能要看學生反應再問', '還在想到底差在哪']
  },
  {
    // 單軸深化原型(把提問重新理解成「邊問邊調整」):概念深化中等,其餘軸尚無。
    id: 'clear-move', title: '提問策略', gtHolistic: 32,
    gt: { conceptDepth: 0.6, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: [
      '原本我把提問當成準備好題目一路問完',
      '試了幾次發現學生一卡住我就接不下去',
      '現在我會看學生怎麼回答、再決定下一題問什麼',
      '提問對我來說其實是邊問邊調整,不是照稿問'
    ]
  },
  {
    id: 'deep-concept', title: '形成性評量', gtHolistic: 45,
    gt: { conceptDepth: 0.85, crossTopic: 0, actionOrient: 0, metaReflection: 0 },
    records: [
      '本來以為形成性評量就是多考幾次小考',
      '讀了一陣子,我會這樣講它:它不是另一張考卷,是教室裡的對話狀態',
      '我邊講邊聽學生回什麼,就知道下一句該怎麼接——重點不在評,在即時回饋',
      '所以同一個單元我每天都在「測」,只是測的是理解、不是分數'
    ]
  },
  {
    // 整合探針:概念中等 + 清楚的跨子面向整合(整合維現在會給分、不再被歸 0)。
    id: 'cross-mid', title: '鷹架與形成性評量', gtHolistic: 50,
    gt: { conceptDepth: 0.45, crossTopic: 0.6, actionOrient: 0, metaReflection: 0 },
    records: [
      '在看鷹架理論',
      '也想到之前讀的形成性評量',
      '我發現鷹架跟形成性評量根本一體兩面——鷹架在說怎麼扶,形成性評量在說怎麼看',
      '合起來才是完整的過程教學'
    ]
  },
  {
    // 後設探針:明確的自我學習姿態觀察 + 概念中等。
    id: 'meta-mid', title: '我的研習筆記', gtHolistic: 52,
    gt: { conceptDepth: 0.4, crossTopic: 0, actionOrient: 0, metaReflection: 0.7 },
    records: [
      '這幾個月一直在記研習觀察',
      '今天回頭看,我發現我一直在累積資料、卻很少回頭問「這些告訴我什麼」',
      '我還停在蒐集階段,還沒真的進到詮釋',
      '這是我學習姿態的問題,不是研習內容的問題'
    ]
  },
  {
    // 行動探針:扎實具體的行動計畫。修正後「行動指向」已是正式維度,這軸該拿到高分。
    id: 'action-strong', title: '提問改進計畫', gtHolistic: 42,
    gt: { conceptDepth: 0.2, crossTopic: 0, actionOrient: 0.85, metaReflection: 0 },
    records: [
      '決定來改我的提問',
      '下週起每堂課第一個 5 分鐘設計一個開放式問題,讓學生先寫 2 分鐘再小組討論',
      '連兩週收回學生回應數、看主動發言有沒有變多',
      '每週修一版題目,把效果差的換掉'
    ]
  },
  {
    id: 'cross-deep', title: '過程教學', gtHolistic: 68,
    gt: { conceptDepth: 0.85, crossTopic: 0.7, actionOrient: 0, metaReflection: 0 },
    records: [
      '原本把提問、鷹架、形成性評量當三個各自的工具',
      '讀久了我會這樣說:它們是教學支持的三個側面——形成性評量是診斷面、鷹架是介入面、提問是溝通面',
      '形成性評量看學生卡哪、鷹架決定怎麼扶、提問是把這對話接起來',
      '合起來才是完整的過程教學,缺一個都接不順'
    ]
  },
  {
    id: 'meta-deep', title: '我怎麼讀文獻', gtHolistic: 72,
    gt: { conceptDepth: 0.85, crossTopic: 0, actionOrient: 0, metaReflection: 0.8 },
    records: [
      '原本覺得自己讀文獻很認真',
      '回頭看這學期讀的,我才發現我每篇都只挑「跟我想法一致」的部分',
      '真正會挑戰我預設的段落,我都跳過了',
      '所以我其實還停在 confirmation 階段,不是真的開放閱讀——這個發現比文獻內容更重要'
    ]
  },
  {
    id: 'rich-full', title: '提問策略的轉變', gtHolistic: 92,
    gt: { conceptDepth: 0.85, crossTopic: 0.7, actionOrient: 0.6, metaReflection: 0.85 },
    records: [
      '一開始我把提問當成備好題目一路問完',
      '試過幾輪後我重新理解:提問是把問題當診斷工具,從學生回答聽他停在哪、再決定下一步',
      '我也發現這跟鷹架是同一回事——問就是搭架、撤掉提問讓學生獨立答就是撤架',
      '回頭看,我之所以一直問不好,是因為我把焦點放在「學生答對」、而不是「他怎麼想」——這是我這學期最大的姿態轉變',
      '下一步想把這套用到備課,連兩週記錄學生的回答路徑'
    ]
  }
];

/* 單調性集:每個 base 各造「深化(deepen)」與「灌水(pad)」兩版本。
 *   deepen ── 加入真正往前一步的內容(補上後設/整合/想透)→ 距離應縮小(分數應升)。
 *   pad    ── 只是重複/換句話說同一件事 → 距離不應變(分數應≈不動)。 */
const GAP_MONOTONICITY = [
  {
    id: 'mono-clear', title: '提問策略',
    base: [
      '原本我把提問當成準備好題目一路問完',
      '試了幾次發現學生卡住我就接不下去',
      '現在我會看學生回答再決定下一題'
    ],
    deepen: [   // 補後設 + 整合 → 應更接近有意義
      '回頭看,我問不好是因為我把焦點放在學生答對、不是他怎麼想',
      '這其實跟鷹架是同一回事:問就是搭架,撤掉提問讓他獨立答就是撤架'
    ],
    pad: [      // 換句話說同一件事 → 不應加分
      '總之提問要看學生反應',
      '提問真的不能照稿問',
      '要邊問邊調整啦'
    ]
  },
  {
    id: 'mono-define', title: '形成性評量',
    base: [
      '形成性評量是過程中的評估',
      '它就是邊教邊測'
    ],
    deepen: [
      '我會這樣講它:不是另一張考卷,是教室裡的對話狀態',
      '我邊講邊聽學生回什麼就知道下一句怎麼接,重點在即時回饋不在打分'
    ],
    pad: [
      '形成性評量很重要',
      '形成性評量就是邊教邊評估啦',
      '反正是過程中的評估'
    ]
  },
  {
    id: 'mono-cross', title: '鷹架理論',
    base: [
      '在讀鷹架理論',
      '鷹架是先扶後放、給學生支持'
    ],
    deepen: [
      '我突然發現鷹架跟形成性評量是一體兩面——鷹架說怎麼扶、形成性評量說怎麼看',
      '而且回頭看,我自己教學時根本沒在「撤」,一直扶到底——這才是我要改的'
    ],
    pad: [
      '鷹架理論真的很有用',
      '就是給學生搭架子',
      '先扶後放這樣'
    ]
  }
];

/* ============================================================
 * 共用:把校準例 → computeJourneyGap_ 能吃的 (journey, records)。
 * computeJourneyGap_ 只用到 journey.title、records(text/ts)、otherTopics(context 參數未使用)。
 * ts 以每筆約隔一天合成,讓「依時間排序」自然。
 * ============================================================ */
function gapCalRecords_(texts) {
  const base = Date.parse('2026-01-06T09:00:00+08:00');
  return (texts || []).map((t, i) => ({
    id: 'gapcal_' + i + '_' + Math.random().toString(36).slice(2, 7),
    ts: new Date(base + i * 26 * 3600 * 1000).toISOString(),
    type: 'text', text: String(t)
  }));
}
function gapCalScore_(texts, title, otherTopics) {
  const g = computeJourneyGap_({ title: title || '' }, {}, gapCalRecords_(texts), otherTopics || []);
  return g ? g : null;
}
function gapCalScope_() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  return { type: 'user', id: owner, key: 'user_' + owner, userId: owner };
}
function mean_(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd_(a) { const m = mean_(a); return a.length ? Math.sqrt(mean_(a.map(x => (x - m) ** 2))) : 0; }

/* ============================================================
 * 1) 效度 + 鑑別度
 * ============================================================ */
function runGapCalibration() {
  const DIMS = ['conceptDepth', 'crossTopic', 'actionOrient', 'metaReflection'];   // 連續 0~1
  const detail = [];
  const predScores = [], gtScores = [], holistics = [];
  const dimHit = { conceptDepth: 0, crossTopic: 0, actionOrient: 0, metaReflection: 0 };  // ±0.2 內算吻合
  const dimErr = { conceptDepth: [], crossTopic: [], actionOrient: [], metaReflection: [] };
  let n = 0, calls = 0;

  console.log('=== 落差量尺校準(' + GAP_CALIBRATION.length + ' 例)===');
  for (const ex of GAP_CALIBRATION) {
    const g = gapCalScore_(ex.records, ex.title, ex.otherTopics); calls++;
    const gtScore = gapScoreFromLevels_(ex.gt);
    if (!g) { console.log('  [LLM 錯] ' + ex.id); detail.push({ id: ex.id, error: 'LLM 錯', gt: ex.gt, gtScore: gtScore, gtHolistic: ex.gtHolistic }); continue; }
    n++;
    const pl = g.levels;
    DIMS.forEach(d => { const e = Math.abs((pl[d] || 0) - (ex.gt[d] || 0)); if (e <= 0.2) dimHit[d]++; dimErr[d].push(e); });
    predScores.push(g.score); gtScores.push(gtScore); holistics.push(ex.gtHolistic);
    const flag = Math.abs(g.score - gtScore) <= 10 ? '✓' : Math.abs(g.score - gtScore) <= 20 ? '~' : '✗';
    console.log('  ' + flag + ' [' + ex.id + '] pred=' + g.score + ' gt(公式)=' + gtScore + ' 作者整體=' + ex.gtHolistic
      + ' | LLM軸 ' + DIMS.map(d => (pl[d] || 0).toFixed(2)).join('/') + ' vs gt ' + DIMS.map(d => (ex.gt[d] || 0).toFixed(2)).join('/'));
    detail.push({
      id: ex.id, title: ex.title, gtHolistic: ex.gtHolistic,
      gtLevels: ex.gt, gtScore: gtScore,
      predLevels: pl, predScore: g.score,
      errScore: g.score - gtScore,
      byDim: g.byDim, has: g.has, missing: g.missing
    });
  }

  // 效度(a):LLM 等級 → 分數,vs 公式 ground-truth
  const scoreMAE = mean_(predScores.map((p, i) => Math.abs(p - gtScores[i])));
  const scoreR = pearsonR_(gtScores, predScores);
  // 效度(b):公式分數 vs 作者整體距離感 —— 測公式本身的構念效度
  const formulaVsHolisticMAE = mean_(gtScores.map((s, i) => Math.abs(s - holistics[i])));
  const formulaVsHolisticR = pearsonR_(holistics, gtScores);
  // 端到端:LLM+公式 vs 作者整體
  const e2eMAE = mean_(predScores.map((p, i) => Math.abs(p - holistics[i])));
  const e2eR = pearsonR_(holistics, predScores);

  // 鑑別度:依作者整體分三組,看「算出的分數」分布有沒有分開
  const bins = { poor: [], mid: [], good: [] };
  detail.filter(d => d.predScore != null).forEach(d => {
    const b = d.gtHolistic < 35 ? 'poor' : d.gtHolistic <= 65 ? 'mid' : 'good';
    bins[b].push(d.predScore);
  });
  const disc = {};
  Object.keys(bins).forEach(b => { disc[b] = { n: bins[b].length, mean: +mean_(bins[b]).toFixed(1), sd: +sd_(bins[b]).toFixed(1), min: Math.min.apply(null, bins[b].concat([999])), max: Math.max.apply(null, bins[b].concat([-1])) }; });

  const dimAcc = {}; DIMS.forEach(d => { dimAcc[d] = { within02: +(dimHit[d] / n).toFixed(2), mae: +mean_(dimErr[d]).toFixed(2) }; });

  console.log('\n=== 效度 ===');
  console.log('LLM等級→分數 vs 公式GT:  MAE=' + scoreMAE.toFixed(1) + '  r=' + scoreR.toFixed(2));
  console.log('公式分數 vs 作者整體感:    MAE=' + formulaVsHolisticMAE.toFixed(1) + '  r=' + formulaVsHolisticR.toFixed(2) + '  ← 測公式構念是否抓對距離');
  console.log('端到端(LLM+公式) vs 作者:  MAE=' + e2eMAE.toFixed(1) + '  r=' + e2eR.toFixed(2));
  console.log('\n=== 各軸 LLM 判發展程度準度 ===');
  DIMS.forEach(d => console.log('  ' + d + ': ±0.2 內 ' + (dimAcc[d].within02 * 100).toFixed(0) + '%  MAE=' + dimAcc[d].mae));
  console.log('\n=== 鑑別度(算出分數依作者組別)===');
  ['poor', 'mid', 'good'].forEach(b => console.log('  ' + b + ': n=' + disc[b].n + ' mean=' + disc[b].mean + ' sd=' + disc[b].sd + ' [' + disc[b].min + '~' + disc[b].max + ']'));
  console.log('\nTotal LLM calls: ' + calls);

  writeEvalReport_(gapCalScope_(), 'gap_calibration.json', {
    runAt: new Date().toISOString(), type: 'gap_calibration', n: n, calls: calls,
    validity: {
      llmLevelsToScore_vs_formulaGT: { mae: +scoreMAE.toFixed(2), r: +scoreR.toFixed(3) },
      formula_vs_authorHolistic: { mae: +formulaVsHolisticMAE.toFixed(2), r: +formulaVsHolisticR.toFixed(3) },
      endToEnd_vs_authorHolistic: { mae: +e2eMAE.toFixed(2), r: +e2eR.toFixed(3) }
    },
    dimAccuracy: dimAcc, discrimination: disc, detail: detail
  });
  console.log('\n報告已寫入 Drive: _reports/gap_calibration.json');
  return 'gap_calibration n=' + n + '/' + GAP_CALIBRATION.length
    + ' | 公式vs作者整體 r=' + formulaVsHolisticR.toFixed(2) + ' MAE=' + formulaVsHolisticMAE.toFixed(1)
    + ' | LLM等級vs公式 r=' + scoreR.toFixed(2) + ' MAE=' + scoreMAE.toFixed(1)
    + ' | 鑑別度 mean poor=' + disc.poor.mean + ' mid=' + disc.mid.mean + ' good=' + disc.good.mean
    + ' → _reports/gap_calibration.json';
}

/* ============================================================
 * 2) 單調性:深化↑ / 灌水≈
 * ============================================================ */
function runGapMonotonicity() {
  const DEEPEN_MIN = 8;   // 深化至少要讓分數升這麼多才算「反映得出進步」
  const PAD_TOL = 6;      // 灌水造成的變動超過這個就算「被灌水騙到」
  const detail = []; let calls = 0, passDeepen = 0, passPad = 0;

  console.log('=== 單調性(深化應↑、灌水應≈)===');
  for (const m of GAP_MONOTONICITY) {
    const gB = gapCalScore_(m.base, m.title); calls++;
    const gD = gapCalScore_(m.base.concat(m.deepen), m.title); calls++;
    const gP = gapCalScore_(m.base.concat(m.pad), m.title); calls++;
    if (!gB || !gD || !gP) { console.log('  [LLM 錯] ' + m.id); continue; }
    const dDeepen = gD.score - gB.score;
    const dPad = gP.score - gB.score;
    const okD = dDeepen >= DEEPEN_MIN, okP = Math.abs(dPad) <= PAD_TOL;
    if (okD) passDeepen++; if (okP) passPad++;
    console.log('  [' + m.id + '] base=' + gB.score + '  深化→' + gD.score + ' (Δ' + (dDeepen >= 0 ? '+' : '') + dDeepen + (okD ? ' ✓' : ' ✗') + ')  灌水→' + gP.score + ' (Δ' + (dPad >= 0 ? '+' : '') + dPad + (okP ? ' ✓' : ' ✗') + ')');
    detail.push({ id: m.id, base: gB.score, deepen: gD.score, pad: gP.score, dDeepen: dDeepen, dPad: dPad, okDeepen: okD, okPad: okP, baseLevels: gB.levels, deepenLevels: gD.levels, padLevels: gP.levels });
  }
  console.log('\n深化正確反映: ' + passDeepen + '/' + GAP_MONOTONICITY.length + '   灌水未被騙: ' + passPad + '/' + GAP_MONOTONICITY.length);
  console.log('Total LLM calls: ' + calls);
  writeEvalReport_(gapCalScope_(), 'gap_monotonicity.json', {
    runAt: new Date().toISOString(), type: 'gap_monotonicity', calls: calls,
    thresholds: { deepenMin: DEEPEN_MIN, padTol: PAD_TOL },
    passDeepen: passDeepen, passPad: passPad, total: GAP_MONOTONICITY.length, detail: detail
  });
  console.log('\n報告已寫入 Drive: _reports/gap_monotonicity.json');
  return 'gap_monotonicity 深化↑ ' + passDeepen + '/' + GAP_MONOTONICITY.length
    + '  灌水≈ ' + passPad + '/' + GAP_MONOTONICITY.length + ' → _reports/gap_monotonicity.json';
}

/* ============================================================
 * 3) 信度:同 input 重跑 N 次,看分數與各維等級的抖動(SD)
 * ============================================================ */
function runGapReliability(N) {
  N = N || 3;
  const picks = ['shallow-define', 'clear-move', 'cross-mid', 'meta-mid', 'cross-deep']
    .map(id => GAP_CALIBRATION.find(e => e.id === id)).filter(Boolean);
  const detail = []; let calls = 0;
  console.log('=== 信度 test-retest(N=' + N + ')===');
  for (const ex of picks) {
    const scores = [];
    for (let i = 0; i < N; i++) { const g = gapCalScore_(ex.records, ex.title, ex.otherTopics); calls++; if (g) scores.push(g.score); }
    if (!scores.length) { console.log('  [LLM 全錯] ' + ex.id); continue; }
    const m = mean_(scores), s = sd_(scores);
    console.log('  [' + ex.id + '] gt(公式)=' + gapScoreFromLevels_(ex.gt) + ' N=' + scores.length + ' mean=' + m.toFixed(1) + ' SD=' + s.toFixed(1) + ' [' + scores.join(',') + ']');
    detail.push({ id: ex.id, gtScore: gapScoreFromLevels_(ex.gt), scores: scores, mean: +m.toFixed(1), sd: +s.toFixed(1) });
  }
  console.log('\nTotal LLM calls: ' + calls);
  writeEvalReport_(gapCalScope_(), 'gap_reliability.json', {
    runAt: new Date().toISOString(), type: 'gap_reliability', N: N, calls: calls, detail: detail
  });
  console.log('\n報告已寫入 Drive: _reports/gap_reliability.json');
  const sds = detail.map(d => d.sd);
  return 'gap_reliability N=' + N + ' maxSD=' + (sds.length ? Math.max.apply(null, sds) : 0).toFixed(1)
    + ' → _reports/gap_reliability.json';
}
