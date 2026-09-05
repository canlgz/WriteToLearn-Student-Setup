/**
 * 轉折評鑒校準集 + 驗證報告 — 用 anchor exemplars + ground truth scores 做 evaluation
 * tool calibration、reliability、validity 三層研究級驗證。
 *
 * 設計:每類 20 例,涵蓋 5%~90% 分數段,作者(本檔)依轉折定義的操作化指標給 ground
 * truth 分數,後續若有共識評分(rater 共議),可重寫此檔的 score 值。
 *
 * 用途:
 *   - 改評鑒 prompt 或 structural pattern 後,runEvalCalibration() 跑全集,看 MAE
 *     / 相關係數變化,有客觀指標可比較,不靠主觀「改改試試」。
 *   - runEvalReliability() 同 input 重跑 N 次測 LLM 隨機性,給「分數 ± X%」誤差條。
 *   - runEvalValidity() 用 detectContextMarkers_ 已認定的 journey markers.evidence
 *     當 gold standard,評鑒 vs 下游 detect 的一致性。
 *
 * 校準集也是 LLM rubric 的 anchor 來源(由 TransitionEval.gs:buildAnchorRubric_ 引用)
 * 與使用者手冊範例(同一份資料兩用)。
 */

const TRANSITION_CALIBRATION = {
  /* ───────────────────────── 概念重述 ───────────────────────── */
  '概念重述': [
    // 0~15%:空話、命名主題
    { input: '我認為提問策略', score: 0.05, label: '只命名主題 + 認知標記' },
    { input: '提問策略很重要', score: 0.05, label: '空泛肯定,無內容' },
    { input: '我覺得提問是教學的核心', score: 0.08, label: '宣稱重要性,無解釋' },
    { input: '我認為對於提案策略的訓練', score: 0.06, label: '命名 + 訓練,未說' },
    { input: 'X 是有趣的主題', score: 0.05, label: '抽象標示' },

    // 15~35%:有觀點但表淺
    { input: '提問策略應該重視思考', score: 0.18, label: '一句宣稱、無深入' },
    { input: '形成性評量是過程中的評估', score: 0.30, label: '基本定義' },
    { input: '我認為提問策略要考慮學生程度', score: 0.25, label: '一個面向,簡略' },
    { input: '提問策略主要是讓學生思考', score: 0.22, label: '功能描述' },
    { input: '鷹架理論是給學生支持的方式', score: 0.28, label: '泛泛定義' },

    // 35~60%:有個人觀點但不完整
    { input: '提問策略對我來說是設計問題的能力', score: 0.40, label: '個人定義、表淺' },
    { input: '我認為提問策略其實是怎麼問,不是問什麼', score: 0.55, label: '個人對比角度' },
    { input: '形成性評量就是邊教邊測,看學生卡哪裡', score: 0.55, label: '簡潔重述' },
    { input: '我覺得形成性評量重點不在「評」,在「回饋」', score: 0.60, label: '個人深度看法' },

    // 60~85%:清楚自話、有延伸
    { input: '提問策略我認為就是「邊問邊調整」,不是準備好題目一路問完——從學生反應決定下一個問題深度', score: 0.75, label: '清楚自話 + 對比 + 延伸' },
    { input: '鷹架理論其實是「先扶後放」的過程,Vygotsky 的 ZPD 就是「獨立會」跟「協助才會」之間的差距', score: 0.82, label: '自話重述 + 概念連結' },
    { input: '形成性評量在我看來就是邊教邊看學生哪裡卡住、馬上回應,不必等期末考', score: 0.85, label: '完整自話 + 對比說明' },

    // 85~95%:深度自話、含實踐連結
    { input: '我會這樣講形成性評量:它不是另一張小考,是教室裡的對話狀態——我邊講邊聽學生回什麼,就知道下一句該怎麼接', score: 0.90, label: '深度自話 + 操作化解釋' },
    { input: '提問策略對我來說的本質,是把問題當診斷工具,從學生的回答聽他停在哪、再決定下一步問什麼。問句不是要學生答對,是要看他怎麼想', score: 0.92, label: '深度自話 + 機制 + 目的' },
    { input: '鷹架其實是一個動態系統:我給多少支持、什麼時候撤,完全看學生現在能獨立做到哪。撤太快學生會掉,撤太慢學生不會獨立', score: 0.88, label: '機制 + 操作判準' }
  ],

  /* ───────────────────────── 跨主題整合 ───────────────────────── */
  '跨主題整合': [
    // 0~15%:只提一個主題
    { input: '提問策略很重要', score: 0.02, label: '單一主題,無整合' },
    { input: '我覺得鷹架理論很有意思', score: 0.05, label: '單一主題' },
    { input: '我之前讀過形成性評量', score: 0.05, label: '單一主題提及' },

    // 15~35%:提到兩主題但沒明示關係
    { input: '形成性評量很重要,鷹架也是', score: 0.18, label: '並列但無關係' },
    { input: '提問策略跟鷹架理論都跟教學有關', score: 0.25, label: '泛泛分類' },
    { input: '我在讀鷹架,之前也讀過形成性評量', score: 0.20, label: '只說我讀過' },
    { input: '形成性評量裡常用到鷹架的概念', score: 0.32, label: '輕度連結' },

    // 35~60%:有連結但不完整
    { input: '鷹架理論跟形成性評量都是在教學過程中支持學生', score: 0.45, label: '指出共性' },
    { input: '提問策略需要鷹架的設計才能用得好', score: 0.45, label: '工具性連結' },
    { input: '我發現鷹架跟形成性評量都在談「過程」', score: 0.50, label: '共性點出' },

    // 60~85%:清楚整合
    { input: '鷹架理論跟形成性評量根本是一體兩面——鷹架在說怎麼扶,形成性評量在說怎麼看,合起來才是完整的過程教學', score: 0.85, label: '兩面 + 各自功能 + 合一' },
    { input: '其實提問策略跟鷹架是同一回事:你問就是在搭一個架,撤掉提問讓學生獨立答,就是把鷹架撤掉', score: 0.82, label: '同一回事 + 機制對應' },
    { input: '我突然發現,我教《野獸國》其實是在無意識做兒童心理諮商——情緒命名跟容納,Bettelheim 講的儀式跟 Winnicott 的過渡空間都對得起來', score: 0.88, label: '跨領域 + 多重連結' },
    { input: '讀 scaffolding 文獻時越來越覺得它跟形成性評量是同一回事——都是在過程中扶學生一把,差別在 scaffolding 強調撤、formative 強調看', score: 0.85, label: '同一回事 + 細緻分辨' },

    // 85~95%:深度跨域整合
    { input: '形成性評量、鷹架、提問策略其實是教學支持的三個側面:formative 是診斷面、鷹架是介入面、提問是溝通面,合起來才是完整的過程教學', score: 0.92, label: '三項整合 + 系統觀' },
    { input: 'Vygotsky 的 ZPD、Bruner 的 scaffolding、Black & Wiliam 的 formative assessment 其實在講同一件事的不同層次——學習者跟支持者之間的對話空間', score: 0.90, label: '跨理論整合' }
  ],

  /* ───────────────────────── 行動指向 ───────────────────────── */
  '行動指向': [
    // 0~15%:無未來時態,無具體
    { input: '我覺得提問策略很重要', score: 0.03, label: '只是宣稱' },
    { input: '形成性評量是好東西', score: 0.03, label: '評價' },
    { input: '我需要練習提問', score: 0.10, label: '空泛意向' },
    { input: '我認為應該重視提問', score: 0.08, label: '宣稱應該' },

    // 15~35%:空決心或單一面向
    { input: '我會努力試試提問策略', score: 0.18, label: '空決心' },
    { input: '我應該多用形成性評量', score: 0.15, label: '空應該' },
    { input: '下週我要好好想想提問策略', score: 0.30, label: '有時間但動作虛' },
    { input: '我會想想看怎麼問問題', score: 0.20, label: '有意向無動作' },

    // 35~60%:有時間或行動但不完整
    { input: '下週每堂課我會試試開放式問題', score: 0.50, label: '時間 + 動作,缺量化' },
    { input: '我要設計三個 open question 練習', score: 0.45, label: '動作 + 量化,缺時間' },
    { input: '從明天開始我要記錄學生提問次數', score: 0.55, label: '時間 + 動作 + 對象' },

    // 60~85%:具體 + 量化 + 時間
    { input: '下週起每堂課第一個 5 分鐘設計一個 open question,讓學生先寫 2 分鐘再小組討論,連兩週收回應數據', score: 0.85, label: '時間 + 動作 + 量化 + 驗證' },
    { input: '從明天的數學課開始,我會每節課給三題 exit ticket,蒐集學生迷思,隔天上課第一件事針對它做回饋', score: 0.85, label: '完整行動計畫' },
    { input: '下週共備我會帶 5 個自己設計的提問範例給同事看,聽他們的反饋,再修一輪試用', score: 0.78, label: '時間 + 動作 + 反饋循環' },

    // 85~95%:含驗證機制
    { input: '從下週開始連續四週,每堂課第一個 5 分鐘做 open question,每週統計學生主動發言次數,看是否從第二週起有上升趨勢', score: 0.92, label: '時間 + 動作 + 量化 + 驗證 + 假設' },
    { input: '明早第一節課開始用迷思診斷選擇題,每週修一版,蒐集兩個月的數據看是否能在單元中段預測學生期末表現', score: 0.90, label: '完整實證計畫' },
    { input: '下週起每天結束前 5 分鐘做 exit ticket,連續一個月,蒐集 80 筆學生回應,看哪些迷思反覆出現,作為下學期備課依據', score: 0.88, label: '時間/動作/量化/長期應用' }
  ],

  /* ───────────────────────── 後設反思 ───────────────────────── */
  '後設反思': [
    // 0~15%:純描述,無跳出
    { input: '今天觀察了 A 班', score: 0.02, label: '純描述' },
    { input: '我覺得提問策略不錯', score: 0.05, label: '評價' },
    { input: '我要多練習提問', score: 0.05, label: '行動傾向' },
    { input: '形成性評量我已經做了一個月', score: 0.10, label: '時間描述' },

    // 15~35%:有「我覺得」但對象是事物
    { input: '我發現提問策略很有用', score: 0.15, label: '對事物的發現' },
    { input: '我覺得鷹架理論不錯', score: 0.10, label: '評價事物' },
    { input: '我發現學生對開放式問題反應比較好', score: 0.22, label: '對學生的觀察' },
    { input: '我意識到提問設計很重要', score: 0.25, label: '對概念的意識' },

    // 35~60%:對自己的觀察初步
    { input: '我發現自己常常準備太多問題', score: 0.45, label: '對自己行為的觀察' },
    { input: '我意識到我給回饋的方式偏結果導向', score: 0.55, label: '對自己模式的覺察' },
    { input: '原本以為提問是學生的問題,現在發現是我設計的問題', score: 0.60, label: '觀念翻轉' },

    // 60~85%:清楚跳出 + 階段性
    { input: '我發現自己一直在累積觀察資料,但很少回頭問「這些告訴我什麼」——我還在資料蒐集階段,還沒進到詮釋階段', score: 0.88, label: '跳出 + 階段意識' },
    { input: '回頭看,我一直把「教完」當成「學會」,這個迷思其實困住我很久了', score: 0.85, label: '回看 + 自我迷思識別' },
    { input: '原本以為形成性評量是另一個工具,現在覺得它其實是教學狀態的轉變——我自己還沒完全轉過來', score: 0.82, label: '觀念翻轉 + 自我位置' },

    // 85~95%:深度後設 + 學習軌跡
    { input: '我發現我一直在被動接收研習內容,沒有主動連結到自己的教學現場——這是我這幾個月學習姿態的問題,不是研習內容的問題', score: 0.90, label: '深度後設 + 重新歸因' },
    { input: '回頭看這學期讀的文獻,我才發現我每篇都只挑「跟我想法一致」的部分,真正挑戰我預設的我都跳過了——我還在 confirmation 階段,不是真的開放閱讀', score: 0.92, label: '深度後設 + 學習階段命名' }
  ]
};

/* ============================================================
 * Editor 驗證報告函式(三層)
 * ============================================================ */

/**
 * 校準度測試(MAE + 相關係數)。對全集 80 例跑當前 evaluateTransitionDraftComposite_,
 * 對每例該轉折類型的 composed score 跟 ground truth 比較,輸出每類的:
 *   - n
 *   - MAE(平均絕對誤差,越低越好)
 *   - Pearson r(相關係數,越接近 1 越好)
 *   - hits within ±10% / ±20%(寬鬆吻合度)
 *
 * ⚠️ 此函式會跑 80 次 LLM call,執行時間 ~5-10 分鐘,**會耗 daily budget 一輪**。
 * 跑完才能評估 prompt / structural pattern 是否改善。預設在 OWNER scope 跑。
 */
function runEvalCalibration() {
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const detail = [];
  const results = {};
  TYPES.forEach(t => { results[t] = { n: 0, errs: [], xs: [], ys: [] }; });

  let totalCalls = 0;
  for (const transType of TYPES) {
    const exemplars = TRANSITION_CALIBRATION[transType] || [];
    console.log(`\n=== 評鑒「${transType}」(${exemplars.length} 例)===`);
    for (const ex of exemplars) {
      const result = evaluateTransitionDraftComposite_(ex.input, '');
      totalCalls++;
      if (!result) {
        console.log(`  [LLM 錯] ${truncate_(ex.input, 30)}`);
        detail.push({ transType, input: ex.input, gt: ex.score, label: ex.label, error: 'LLM 錯' });
        continue;
      }
      const predicted = result.scores[transType] || 0;
      const error = predicted - ex.score;
      results[transType].n++;
      results[transType].errs.push(Math.abs(error));
      results[transType].xs.push(ex.score);
      results[transType].ys.push(predicted);
      const flag = Math.abs(error) <= 0.10 ? '✓' : Math.abs(error) <= 0.20 ? '~' : '✗';
      console.log(`  ${flag} GT=${ex.score.toFixed(2)} pred=${predicted.toFixed(2)} | ${truncate_(ex.input, 36)}`);
      detail.push({
        transType, input: ex.input, label: ex.label,
        gt: ex.score, predicted: predicted, error: error,
        breakdown: result.breakdown,        // S1 & S2 per type
        composed: result.scores,            // 4 種 composed
        topType: result.topType, topScore: result.topScore
      });
    }
  }

  const summary = {};
  console.log('\n=== 校準度總結 ===');
  TYPES.forEach(t => {
    const r = results[t];
    if (r.n === 0) { summary[t] = { n: 0 }; console.log(`[${t}] n=0`); return; }
    const mae = r.errs.reduce((a, b) => a + b, 0) / r.n;
    const within10 = r.errs.filter(e => e <= 0.10).length / r.n;
    const within20 = r.errs.filter(e => e <= 0.20).length / r.n;
    const r_corr = pearsonR_(r.xs, r.ys);
    summary[t] = { n: r.n, mae, r: r_corr, within10, within20 };
    console.log(`[${t}] n=${r.n} MAE=${mae.toFixed(3)} r=${r_corr.toFixed(3)} ±10%:${(within10*100).toFixed(0)}% ±20%:${(within20*100).toFixed(0)}%`);
  });
  console.log(`\nTotal LLM calls: ${totalCalls}`);

  // 寫報告到 OWNER chat folder _reports/eval_calibration.json 供 AI 讀取分析
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  writeEvalReport_(scope, 'eval_calibration.json', {
    runAt: new Date().toISOString(),
    type: 'calibration',
    totalCalls,
    summary,
    detail
  });
  console.log('\n報告已寫入 Drive: _reports/eval_calibration.json');
}

/**
 * 信度測試(test-retest reliability)。同一 input 跑 N 次,觀察 score 抖動範圍(SD)。
 * 每類取 5 個 anchor exemplars,各跑 N 次。預設 N=3 控制成本(60 calls)。
 */
function runEvalReliability(N) {
  N = N || 3;
  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const detail = [];
  console.log(`=== Test-retest reliability(N=${N})===`);
  let totalCalls = 0;
  for (const transType of TYPES) {
    const exemplars = TRANSITION_CALIBRATION[transType] || [];
    const targets = [0.10, 0.30, 0.50, 0.70, 0.85];
    const picked = targets.map(t => {
      let best = null, bestDist = 999;
      for (const ex of exemplars) {
        const d = Math.abs(ex.score - t);
        if (d < bestDist) { bestDist = d; best = ex; }
      }
      return best;
    }).filter(Boolean);
    console.log(`\n[${transType}]`);
    for (const ex of picked) {
      const scores = [];
      for (let i = 0; i < N; i++) {
        const result = evaluateTransitionDraftComposite_(ex.input, '');
        totalCalls++;
        if (result) scores.push(result.scores[transType] || 0);
      }
      if (!scores.length) { console.log(`  [LLM 全錯] ${truncate_(ex.input, 30)}`); continue; }
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
      console.log(`  GT=${ex.score.toFixed(2)} N=${scores.length} mean=${mean.toFixed(3)} SD=${sd.toFixed(3)} | ${truncate_(ex.input, 30)}`);
      detail.push({ transType, input: ex.input, label: ex.label, gt: ex.score, scores, mean, sd });
    }
  }
  console.log(`\nTotal LLM calls: ${totalCalls}`);

  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  writeEvalReport_(scope, 'eval_reliability.json', {
    runAt: new Date().toISOString(),
    type: 'reliability', N, totalCalls, detail
  });
  console.log('\n報告已寫入 Drive: _reports/eval_reliability.json');
}

/**
 * 效度測試(concurrent validity)。用 detectContextMarkers_ 已認定的 journey markers
 * 當 gold standard——那些 evidence 對應的 marker 類型,理論上 composite eval 應該
 * 給高分(≥ 0.60)。算各類的 sensitivity(% of true positives caught)。
 *
 * 需要先有 journey 資料(/journey 跑過、有 markers)。
 */
function runEvalValidity() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const journeys = loadJourneys_(scope).filter(j => j.status === 'journey');
  if (!journeys.length) { console.log('沒有已升格歷程,跑 runJourneyDetectNow 後再試。'); return; }

  const TYPES = ['概念重述', '跨主題整合', '行動指向', '後設反思'];
  const stats = {};
  TYPES.forEach(t => { stats[t] = { n: 0, hits: 0 }; });
  const detail = [];

  console.log(`=== Concurrent validity(${journeys.length} 條歷程當 gold standard)===`);
  let totalCalls = 0;
  for (const j of journeys) {
    for (const m of (j.markers || [])) {
      if (!m.evidence || !m.type) continue;
      const result = evaluateTransitionDraftComposite_(m.evidence, j.summary || '');
      totalCalls++;
      if (!result) continue;
      const predicted = result.scores[m.type] || 0;
      stats[m.type].n++;
      if (predicted >= 0.60) stats[m.type].hits++;
      const flag = predicted >= 0.60 ? '✓' : '✗';
      console.log(`  ${flag} ${m.type} pred=${predicted.toFixed(2)} | ${truncate_(m.evidence, 40)}`);
      detail.push({
        journeyTitle: j.title || j.label, transType: m.type,
        evidence: m.evidence, predicted, breakdown: result.breakdown
      });
    }
  }

  const summary = {};
  console.log('\n=== Validity 總結 ===');
  TYPES.forEach(t => {
    const s = stats[t];
    if (s.n === 0) { summary[t] = { n: 0 }; console.log(`[${t}] n=0`); return; }
    const sens = s.hits / s.n;
    summary[t] = { n: s.n, hits: s.hits, sensitivity: sens };
    console.log(`[${t}] sensitivity=${(sens * 100).toFixed(0)}% (${s.hits}/${s.n} hits ≥ 0.60)`);
  });
  console.log(`\nTotal LLM calls: ${totalCalls}`);

  writeEvalReport_(scope, 'eval_validity.json', {
    runAt: new Date().toISOString(),
    type: 'validity', totalCalls, summary, detail
  });
  console.log('\n報告已寫入 Drive: _reports/eval_validity.json');
}

/** 把報告寫到 chat folder 下的 _reports/<name>,Drive MCP 可直接讀。 */
function writeEvalReport_(scope, name, payload) {
  const parent = chatFolder_(scope);
  const subIt = parent.getFoldersByName('_reports');
  const sub = subIt.hasNext() ? subIt.next() : parent.createFolder('_reports');
  const fileIt = sub.getFilesByName(name);
  const file = fileIt.hasNext() ? fileIt.next() : sub.createFile(name, '', MimeType.PLAIN_TEXT);
  file.setContent(JSON.stringify(payload, null, 2));
}

/** Pearson correlation coefficient — 純 CPU 算 r。 */
function pearsonR_(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return 0;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
