/**
 * 轉折升格手動測試的種子資料(可從 editor 反覆跑、清乾淨重來)。
 *
 * 設計目標:讓使用者在 LINE 上對「補一個轉折→升格成歷程」這條流程做端到端驗收,
 *           不必等真實累積、也不被混雜資料干擾。
 *
 * 提供 4 條預先成形的脈絡(status='context'、watch journey),各為一種轉折量身打造:
 *   ① 形成性評量(測試)  → 期望轉折:概念重述
 *   ② 鷹架理論(測試)    → 期望轉折:跨主題整合(語意刻意接近①以滿足整合甜蜜帶)
 *   ③ 提問策略(測試)    → 期望轉折:行動指向(records 全是探問、沒有行動)
 *   ④ 課堂觀察(測試)    → 期望轉折:後設反思(跨度長、回返多、純描述)
 *
 * 每則 record 都會跑真實 geminiEmbed_(~25 次/seed,可接受),Phase 1 cos 閘吃到真語意,
 * detectContextMarkers_ 看到真內容,測試結果是可信的。
 *
 * 用法(editor):
 *   1) wipeAllOwnerData()           ← 清掉 OWNER 既有的 embeddings/contexts/journeys + 計數
 *   2) seedTransitionTestbed()      ← 種下四條測試脈絡(會跑 ~25 次 geminiEmbed_)
 *   3) LINE: /journey → 看到 4 條候選歷程,逐條按「補一個轉折」、輸入測試補充
 *
 * 兩個函式名都不帶尾底線——editor Run 選單看得到。
 */

function seedTransitionTestbed() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  const testbeds = transitionTestbedSpec_();
  const allRecords = [];
  const contexts = [];
  const journeys = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < testbeds.length; i++) {
    const tb = testbeds[i];
    console.log(`[${i + 1}/${testbeds.length}] embedding「${tb.label}」(${tb.records.length} records)…`);
    const recIds = [];
    let firstTs = null, lastTs = null;
    for (const r of tb.records) {
      const ts = relativeTs_(r.d, r.h, r.m || 0);
      const id = newId_();
      const record = {
        id: id,
        ts: ts,
        userId: owner,
        type: 'text',
        text: r.text,
        lineMessageId: null,
        embedding: geminiEmbed_(r.text),
        category: tb.category,
        topicLabel: tb.topicLabel
      };
      allRecords.push(record);
      recIds.push(id);
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    const ctxId = newId_();
    const spanH = Math.max(1, Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 3600000));
    contexts.push({
      id: ctxId, createdAt: nowIso, updatedAt: nowIso,
      label: tb.label,
      category: tb.category,
      recordIds: recIds,
      firstTs: firstTs, lastTs: lastTs,
      status: 'context',
      criteria: {
        semanticDensity: 0.70,         // 宣稱通過,實機算出來會接近但不一定一樣
        clusterSeparation: 0.18,
        returnVisits: tb.records.length,
        returnSpanHours: spanH,
        mediaKinds: 2,
        passed: true
      }
    });
    journeys.push({
      id: newId_(), createdAt: nowIso, updatedAt: nowIso,
      contextId: ctxId,
      label: tb.label,
      title: tb.title,
      summary: tb.summary,
      keywords: { category: tb.category, tags: tb.tags },
      markers: [],
      status: 'watch',
      basedOnUpdatedAt: nowIso,         // 對齊 context.updatedAt → 背景不會自動重判
      markerGap: tb.markerGap
    });
  }

  // 寫入:embeddings 用 setContent 一次性覆寫,contexts/journeys 用既有 save 函式。
  const embText = allRecords.map(r => JSON.stringify(r)).join('\n') + (allRecords.length ? '\n' : '');
  chatEmbeddingsFile_(scope).setContent(embText);
  saveContexts_(scope, contexts);
  saveJourneys_(scope, journeys);

  // 重置背景活動相關的 meta,避免 sweep 把這批種子當「新訊息」重新分類/重分群。
  updateChatMeta_(scope, m => {
    m.lastIngestTs = Date.now();
    m.lastClassifyAt = Date.now();
    m.lastContextUpgradeAt = new Date().toISOString();
    m.notifiedContextIds = [];
    m.notifiedJourneyIds = [];
    m.recordPins = {};
    return m;
  });

  console.log('\n=== 種子完成 ===');
  console.log(`records=${allRecords.length}  contexts=${contexts.length}  watch journeys=${journeys.length}`);
  console.log('\n各條期望:');
  contexts.forEach((c, i) => {
    const j = journeys[i];
    console.log(`  [${i + 1}] 「${c.label}」 → 期望轉折:${j.markerGap.type}`);
  });
  console.log('\n→ 到 LINE 打 /journey,逐條按「補一個轉折」,輸入下方說明文件提供的「正確補充文」');
  console.log('  正確的轉折補充 → 應該偵測到該種轉折 + 升格');
  console.log('  完全離題補充 → 應該被 Phase 1 cos 閘擋下 → 提示改歸');
}

function wipeAllOwnerData() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  chatEmbeddingsFile_(scope).setContent('');
  saveContexts_(scope, []);
  saveJourneys_(scope, []);
  updateChatMeta_(scope, m => {
    m.lastIngestTs = 0;
    m.lastClassifyAt = 0;
    m.lastContextUpgradeAt = null;
    m.notifiedContextIds = [];
    m.notifiedJourneyIds = [];
    m.recordPins = {};
    m.activeExplorationClusterCount = 0;
    return m;
  });
  console.log('wiped: embeddings.jsonl, contexts.jsonl, journeys.jsonl, meta counters');
  console.log('(explorations.jsonl 未動;如需清,到 Drive 手動刪)');
}

/** 把「距今幾天、幾點、幾分」轉成 ISO ts,用於塑造 records 的時間跨度。 */
function relativeTs_(daysAgo, hour, minute) {
  const t = new Date();
  t.setDate(t.getDate() - daysAgo);
  t.setHours(hour, minute, 0, 0);
  return t.toISOString();
}

/** 四條測試脈絡的完整內容定義。改測試文案就動這裡。 */
function transitionTestbedSpec_() {
  return [
    /* ─────────── ① 形成性評量 → 概念重述 ─────────── */
    {
      label: '形成性評量(測試)',
      category: '教學',
      topicLabel: '形成性評量',
      title: '形成性評量的閱讀與設計',
      summary: '使用者持續閱讀形成性評量相關文獻並嘗試設計具體工具,概念在不同時段反覆出現。',
      tags: ['形成性評量', '即時回饋'],
      records: [
        { d: 5, h: 10, m: 0,  text: '讀到 Black & Wiliam 的《Inside the Black Box》,形成性評量的關鍵是過程中即時的回饋。' },
        { d: 5, h: 10, m: 25, text: '他們強調 grades vs comments 對學生動機的不同影響——只給分數會掩蓋學習進度。' },
        { d: 3, h: 14, m: 30, text: '再次思考形成性評量,它跟總結性評量最大差別在「發生時機」——過程中 vs 結束後。' },
        { d: 1, h: 11, m: 0,  text: '今天設計了一份 exit ticket,作為下週課堂的形成性評量工具,問三個聚焦問題。' },
        { d: 0, h: 9,  m: 0,  text: '重新看 Wiliam 的另一篇文獻,形成性評量在數位環境的應用很有啟發。' }
      ],
      markerGap: {
        type: '概念重述',
        score: 0.85,
        scores: { '概念重述': 0.85, '跨主題整合': 0.45, '行動指向': 0.20, '後設反思': 0.40 },
        evidence: '「形成性評量」反覆出現,可請你用自己的話再講一次'
      }
    },

    /* ─────────── ② 鷹架理論 → 跨主題整合(語意刻意接近①) ─────────── */
    {
      label: '鷹架理論(測試)',
      category: '教學',
      topicLabel: '鷹架理論',
      title: 'Vygotsky 與 Bruner 的鷹架概念',
      summary: '整理鷹架理論的原始論文與後續發展,並對應到教學現場的階段性支持。',
      tags: ['鷹架理論', 'ZPD'],
      records: [
        { d: 4, h: 13, m: 0,  text: 'Vygotsky 的 ZPD(近側發展區)是鷹架理論的基礎概念,描述學生獨力與協助下能做的差距。' },
        { d: 3, h: 15, m: 0,  text: 'Bruner 把 scaffolding 概念正式化,強調逐步撤除支持、讓學生獨立完成。' },
        { d: 2, h: 10, m: 30, text: '讀了一篇把鷹架用在閱讀理解教學的論文,老師示範→引導→放手 三階段。' },
        { d: 1, h: 16, m: 0,  text: '想到我帶寫作課的順序,跟鷹架理論的階段其實非常像——示範一段、共寫一段、學生獨寫。' }
      ],
      markerGap: {
        type: '跨主題整合',
        score: 0.80,
        scores: { '概念重述': 0.50, '跨主題整合': 0.80, '行動指向': 0.15, '後設反思': 0.35 },
        evidence: '跟「形成性評量」語意鄰近(都在談教學過程的支持),可問你是不是同一回事'
      }
    },

    /* ─────────── ③ 提問策略 → 行動指向(全探問、沒行動) ─────────── */
    {
      label: '提問策略(測試)',
      category: '教學',
      topicLabel: '提問策略',
      title: '提問策略的諸多疑問',
      summary: '使用者對提問策略的設計、效果與適用情境提出多個探問,但尚未做出具體決定。',
      tags: ['提問策略', '探究'],
      records: [
        { d: 4, h: 9,  m: 0,  text: '為什麼學生在我的課堂上提問越來越少?是教學設計的問題嗎?' },
        { d: 3, h: 11, m: 0,  text: '怎麼樣設計開放式問題,才能真的促進思考而不是猜謎?' },
        { d: 2, h: 14, m: 0,  text: '提問策略跟直接講授,哪個適合什麼類型的內容?' },
        { d: 1, h: 10, m: 0,  text: '什麼樣的提問才能引發學生反思而不是只是回答?' }
      ],
      markerGap: {
        type: '行動指向',
        score: 0.78,
        scores: { '概念重述': 0.30, '跨主題整合': 0.40, '行動指向': 0.78, '後設反思': 0.30 },
        evidence: '多個探問還沒收尾,可請你寫「最具體的下一步」'
      }
    },

    /* ─────────── ④ 課堂觀察 → 後設反思(跨度長、純描述) ─────────── */
    {
      label: '課堂觀察(測試)',
      category: '研究',
      topicLabel: '課堂觀察',
      title: '兩班連續一個月的觀察紀錄',
      summary: '使用者持續觀察 A、B 兩班的課堂互動,累積大量描述性資料但尚未進入詮釋階段。',
      tags: ['課堂觀察', '行動研究'],
      records: [
        { d: 12, h: 10, m: 0,  text: '今天觀察 A 班,記錄了學生發言頻率,共 17 次有效發言。' },
        { d: 10, h: 11, m: 0,  text: 'B 班觀察,看了同一個題目的反應,小組討論氣氛比 A 班熱絡。' },
        { d: 8,  h: 9,  m: 30, text: '再次觀察 A 班,跟上次比較,女生發言比例略升。' },
        { d: 6,  h: 14, m: 0,  text: '繼續觀察 B 班的小組合作,記錄成員輪流發言的次序。' },
        { d: 4,  h: 10, m: 0,  text: 'A 班的觀察資料累積到一個月了,共 18 次紀錄。' },
        { d: 2,  h: 13, m: 0,  text: '整理觀察筆記,做了一個 A/B 班對比表,先呈現原始數據。' }
      ],
      markerGap: {
        type: '後設反思',
        score: 0.82,
        scores: { '概念重述': 0.20, '跨主題整合': 0.30, '行動指向': 0.25, '後設反思': 0.82 },
        evidence: '跨度長、回返多但反思詞少,可請你跳出來看自己學到什麼'
      }
    }
  ];
}
