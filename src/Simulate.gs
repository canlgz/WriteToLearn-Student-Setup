/**
 * 模擬測試裝置 — 把 /episodes /themes /journey 整條 UI 流程拿來壓測。
 *
 * 兩種用法：
 *
 *   1) 場景式（推薦，測 pipeline 行為）：每個場景 = 數條「主題線」，
 *      每條線控制好筆數/天數/媒介/期望輸出，跑完後可逐層比對 UI vs 期望。
 *
 *        listScenarios()                        // 看可用場景與各自期望
 *        runScenarioPipeline('parallel3')       // 一鍵 wipe + seed + upgrade + detect
 *
 *   2) 隨機式（測 UI 邊界、跨主題雜訊）：simulateLearningData() / wipeSimulatedData()。
 *
 * 清空：
 *   wipeSimulatedData()       // 只砍 userId='simulated' 的 raw 紀錄（保留真實資料）
 *   wipeAllForTesting()       // 砍掉 embeddings + contexts + journeys + transcripts +
 *                             // 清掉 meta 上 pins/notified/throttle —— 重新開始
 *
 * 成本：每筆紀錄要一次 Gemini embedding（~$0.00001）；場景式不打 Gemini 文字
 * 生成（句子池硬編在這檔案裡）；隨機式才會打一次 Gemini text generation。
 * journey 偵測（detectJourneys_）才是貴的：每條 升格 context 一次 LLM。
 */

// ============================================================================
// 場景式模擬：scenario = threads[]，thread = 一條主題線
// ============================================================================

/**
 * 場景定義。每個 thread 會在指定的時間窗內均勻散布 count 筆紀錄，
 * 句子從對應 topic 的句子池循環取（含小變化），媒介按 mediaMix 比例分配。
 * spanDays = 從「最近 endOffsetDays 天前」往回展開的時間跨度。
 */
const SIM_SCENARIOS = {
  parallel3: {
    description: '三條獨立平行線（形成性評量 / 繪本教學 / Gemini API），時間重疊',
    expects: '/journey 應出現 3 條獨立 journey；merge drift guard 應擋住任何合併',
    threads: [
      { topic: 'formative',  count: 9, spanDays: 6, endOffsetDays: 0, mediaMix: { text: 6, image: 2, audio: 1 } },
      { topic: 'picturebook', count: 9, spanDays: 6, endOffsetDays: 0, mediaMix: { text: 6, image: 2, audio: 1 } },
      { topic: 'gemini',      count: 9, spanDays: 6, endOffsetDays: 0, mediaMix: { text: 6, file: 2, image: 1 } }
    ]
  },

  splitOne: {
    description: '同一份論文寫作的三個側面（文獻 / 方法 / 討論）—— k-means 容易切碎',
    expects: '預期 k-means 切成 2-3 cluster；合併判定應吃到 → 收斂為 1 條 journey',
    threads: [
      { topic: 'paper_lit',    count: 5, spanDays: 4, endOffsetDays: 0, mediaMix: { text: 4, file: 1 } },
      { topic: 'paper_method', count: 5, spanDays: 4, endOffsetDays: 0, mediaMix: { text: 4, image: 1 } },
      { topic: 'paper_disc',   count: 5, spanDays: 4, endOffsetDays: 0, mediaMix: { text: 4, audio: 1 } }
    ]
  },

  closePair: {
    description: '相近主題雙線（繪本教學設計 vs 繪本兒童心理）—— 表面像同主題',
    expects: '預期 2 條獨立 journey；drift guard 應擋住合併。若合併 = drift 閾值太鬆',
    threads: [
      { topic: 'picturebook',         count: 8, spanDays: 5, endOffsetDays: 0, mediaMix: { text: 6, image: 2 } },
      { topic: 'picturebook_psychology', count: 8, spanDays: 5, endOffsetDays: 0, mediaMix: { text: 6, audio: 2 } }
    ]
  },

  noisyEdge: {
    description: '一條紮實主題 + 3 筆語意邊緣雜訊',
    expects: '預期 1 條 journey；3 筆雜訊應被 per-record eviction 踢出（fit<0.55）',
    threads: [
      { topic: 'formative', count: 10, spanDays: 5, endOffsetDays: 0, mediaMix: { text: 7, image: 2, audio: 1 } },
      { topic: 'noise',     count: 3,  spanDays: 5, endOffsetDays: 0, mediaMix: { text: 3 } }
    ]
  },

  underqualified: {
    description: '兩條未達升格條件的線：A 全在 40 分鐘內（無回返）; B 全 text 媒介（不跨）',
    expects: '預期 2 條 candidate context、0 條 journey；/themes 應該顯示 🌱',
    threads: [
      { topic: 'formative',  count: 6, spanDays: 0.025, endOffsetDays: 0, mediaMix: { text: 4, image: 1, audio: 1 } }, // 36 min
      { topic: 'picturebook', count: 6, spanDays: 5, endOffsetDays: 0, mediaMix: { text: 6 } }                          // text-only
    ]
  }
};

const SIM_SENTENCE_POOLS = {
  formative: [
    '今天課堂用 Kahoot 做形成性評量，學生反應比想像中熱烈，但中後段有人放棄打點。',
    '讀到 Black & Wiliam 那篇 inside the black box，回頭看自己給回饋的方式太結果導向。',
    '備課時擬了三題判斷學生迷思的選擇題，明早上課試用看看會不會問出有意思的對話。',
    '下課收到學生問「老師為什麼這題選 B 是錯的」——這就是我要的對話，不是分數。',
    '整理今天 exit ticket 的回應，發現有 1/3 學生在比例與比的轉換上卡住。',
    '看 Ruth Butler 那個 grades vs comments 的對照實驗，再次提醒不要又給分數又給回饋。',
    '把單元前的 pre-assessment 改成短答題而非選擇題，學生回應差別很大。',
    '形成性評量不是另一張小考，是日常教學的對話狀態——這句話我抄在備課本第一頁。',
    '同事問怎麼做迷思診斷題，我整理一份範例給她，順便把自己的設計流程寫清楚。'
  ],
  picturebook: [
    '今天讀完《不是箱子》給三年級，孩子們的詮釋讓我嚇到——他們真的會主動延伸故事。',
    '把《奧莉薇》當作創造性人物分析的引子，原本擔心太抽象，沒想到很順。',
    '繪本不是給低年級看的，高年級拿來討論觀點轉換特別好用。',
    '備課《田鼠阿佛》——準備帶學生討論「無用之用」這個概念，先寫了五題引導問題。',
    '找到一個繪本教學單元設計工作坊的資料，下週去參加。',
    '重讀《野獸國》，從教學角度重新看 Max 的情緒地圖，很有東西。',
    '和同事討論繪本選書，發現大家偏好差異很大，這本身就是教學討論材料。',
    '整理這學期用過的 8 本繪本，按主題重新歸類成「身體」「家」「離別」「想像」四組。',
    '把《一片葉子落下來》放進生命教育單元，比直接講概念有力多了。'
  ],
  picturebook_psychology: [
    '看 Bettelheim《童話的魅力》第三章，他講小孩讀童話是在處理潛意識的恐懼。',
    '《野獸國》裡 Max 的情緒爆發到自我安撫，跟 Winnicott 的過渡空間概念很對。',
    '兒童心理發展的角度看繪本，重點不是故事好看，是孩子在故事裡安放自己的什麼。',
    '讀《情緒寶盒》研究，繪本作為情緒命名工具的實證資料其實不少。',
    '依附理論回看《猜猜我有多愛你》—— 那個重複問答的儀式就是 secure base 的演練。',
    '小孩反覆要求讀同一本繪本，不是任性，是在反覆練習掌握某種焦慮。',
    '皮亞傑具體運思期的孩子讀寓言，理解的層次跟成人不同 —— 這對選書很關鍵。',
    '《菲菲生氣了》示範了從情緒高峰回到平靜的完整曲線，幼兒情緒教育的好教材。',
    '兒童心理學家 Selma Fraiberg《魔法歲月》提醒：別用大人邏輯否定孩子的恐懼。'
  ],
  gemini: [
    '嘗試用 Gemini 1.5 Pro 的長上下文一次餵 200 頁 PDF，輸出比想像中穩。',
    '改了 prompt 加入「think step by step」，輸出立刻多了內部推理段，可讀性下降。',
    '把 system instruction 從中文換成英文，輸出格式服從度明顯提升。',
    'Gemini Flash 比 Pro 對短查詢更俐落，cost 又只有 1/10。',
    '讀 Gemini API 文件的 batch endpoint，看能不能做我的 RAG 預處理。',
    'tool calling 終於穩定了，這次接 Sheets API 一次到位。',
    'structured output mode 配 JSON schema，回應再也不用 regex 救援。',
    'embedding 模型換到 text-embedding-004，retrieval 命中率有感提升。',
    '把 Gemini 拿來做 LINE bot 後端，發現 streaming 在 GAS 環境根本不能用，要改 batch。'
  ],
  paper_lit: [
    '今天把 Vygotsky ZPD 跟 Bruner scaffolding 兩條線的文獻整理成表格，發現中介概念差很多。',
    '讀 Wood, Bruner & Ross 1976 那篇原始 scaffolding paper，跟後人引用的詮釋有偏差。',
    '文獻回顧的論證鏈卡在第三段——從理論定義跳到實證研究太快，缺一段方法學的橋。',
    '把 30 篇 scaffolding 在 K-12 數學教學的實證研究做了表格分類，三個流派浮現。',
    '中文文獻的 scaffolding 翻譯有「鷹架」「支架」兩派，論文要先說明採用哪個與為何。'
  ],
  paper_method: [
    '論文方法章節決定走 design-based research，先寫清楚 iteration 1 的介入設計。',
    '質性編碼用 NVivo 還是 Atlas.ti，今天試了兩個，NVivo 對 audio 標註更順。',
    '研究參與者三班 84 位學生，前測 + 中介後測 + 後測，T0 設計成 Likert + 開放題混合。',
    '把訪談大綱第二版寫完，從鬆散主題逐步收斂到三個核心提問。',
    '論文 IRB 申請的審查意見回來了，要求補家長同意書的中英文版。'
  ],
  paper_disc: [
    '論文討論章節寫到第二節卡住——資料支持結論，但跟既有理論的對話還沒寫透。',
    '把研究結果寫成三點 implication，第三點對教師現場最有幫助。',
    '討論章節的 limitation 段落該誠實寫多少？問同事意見大家標準不一。',
    '今天把論文摘要從 320 字壓到 250 字，刪了所有形容詞，論證反而更清楚。',
    '回頭重寫 conclusion 第一段，把 contribution 從三點精煉成一句。'
  ],
  noise: [
    // 刻意設計成「教學情境周邊」的雜訊：跟 formative 共享一些表層詞（教師/課程/學生）
    // 但實際內容是行政/雜事——希望 k-means 把它放進 formative 群，再讓 eviction 把它踢出。
    '今天教師會議講了兩小時，多半是行政事務，沒記到什麼學術內容，散會時手機都涼了。',
    '在 LINE 上跟某科主任討論排課，繞了一大圈才搞定教室分配，跟教學設計無關但很耗神。',
    '下午回信回到頭昏，學校行政信件量真的太大，跟學生學習一點關係都沒有的事情佔了一半時間。'
  ]
};

/**
 * 列出所有可用場景與期望輸出。Editor 直接呼叫。
 */
function listScenarios() {
  console.log('=== 可用測試場景 ===');
  for (const name in SIM_SCENARIOS) {
    const s = SIM_SCENARIOS[name];
    const totalCount = s.threads.reduce((a, t) => a + t.count, 0);
    console.log(`\n[${name}]  ${totalCount} 筆`);
    console.log(`  說明：${s.description}`);
    console.log(`  期望：${s.expects}`);
    console.log(`  線：${s.threads.map(t => `${t.topic}×${t.count}（${t.spanDays}d）`).join(' / ')}`);
  }
  console.log('\n用法：runScenarioPipeline("parallel3") 一鍵 wipe + seed + upgrade + detect');
}

/**
 * 灌入指定場景的紀錄。不清資料、不跑 upgrade —— 純插入。
 * 想完整測試請用 runScenarioPipeline()。
 */
function seedScenario(name) {
  const scenario = SIM_SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario "${name}". Try listScenarios().`);
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  if (!owner) throw new Error('OWNER_LINE_USER_ID 未設定');
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  console.log(`=== seedScenario [${name}] ===`);
  console.log(`  ${scenario.description}`);
  let total = 0;
  for (const thread of scenario.threads) {
    const specs = buildSpecsForThread_(thread);
    console.log(`  → 灌入 ${thread.topic}: ${specs.length} 筆 / ${thread.spanDays} 天`);
    for (const s of specs) {
      try { insertSimRecord_(scope, s); total++; }
      catch (e) { console.warn('  skip:', e && e.message); }
      Utilities.sleep(120);
    }
  }
  console.log(`=== 完成：插入 ${total} 筆 ===`);
  return total;
}

/**
 * 一鍵完整測試：清掉所有測試資料 → 灌場景 → 強制 upgrade → 強制 detect →
 * 標記為「已通知」（避免一次推播灌爆使用者）→ 列出每層結果。
 */
function runScenarioPipeline(name) {
  console.log(`\n████ runScenarioPipeline [${name}] 1/5 · 清空所有測試資料 ████`);
  wipeAllForTesting();
  console.log(`\n████ 2/5 · 灌入場景紀錄 ████`);
  seedScenario(name);

  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  console.log(`\n████ 3/5 · 重分群升格（upgradeContexts_） ████`);
  const upSummary = upgradeContexts_(scope);
  updateChatMeta_(scope, m => { m.lastContextUpgradeAt = new Date().toISOString(); return m; });
  console.log('  upgrade summary:', JSON.stringify(upSummary));

  console.log(`\n████ 4/5 · 偵測轉折 + 後置合併（detectJourneys_ + merge） ████`);
  const detSummary = detectJourneys_(scope);
  console.log('  detect summary:', JSON.stringify(detSummary));
  const merged = mergeOverlappingJourneys_(scope);
  console.log(`  post-merge: ${merged} pair(s) merged`);

  console.log(`\n████ 5/5 · 結果（對照 expects）████`);
  console.log('  期望：' + SIM_SCENARIOS[name].expects);
  logPipelineState_(scope);

  // 不要在測試後 push 通知（會在使用者裝置上一次塞爆）
  markUpgradesNotified_(scope);
  console.log('\n（已標記為已通知，下一輪背景 sweep 不會 push 這批）');
}

/**
 * 列出當前 contexts / journeys 的狀態，方便比對 UI（/themes /journey）。
 */
function logPipelineState_(scope) {
  const contexts = loadContexts_(scope);
  const journeys = loadJourneys_(scope);
  console.log(`\n  CONTEXTS (${contexts.length}):`);
  contexts.slice().sort((a, b) => (b.recordIds || []).length - (a.recordIds || []).length).forEach(c => {
    const cr = c.criteria || {};
    const flags = `${densityConditionMet_(cr) ? '✓' : '✗'}d/${(cr.returnVisits >= CONTEXT_CRITERIA.returnVisitsMin && cr.returnSpanHours >= CONTEXT_CRITERIA.returnSpanHoursMin) ? '✓' : '✗'}r/${(cr.mediaKinds >= CONTEXT_CRITERIA.mediaKindsMin) ? '✓' : '✗'}m`;
    console.log(`    [${c.status.padEnd(9)}] ${(c.recordIds || []).length}筆 ${flags} dens=${cr.semanticDensity} visits=${cr.returnVisits} span=${cr.returnSpanHours}h media=${cr.mediaKinds} — ${c.label}`);
  });
  const jrn = journeys.filter(j => j.status === 'journey');
  const watch = journeys.filter(j => j.status === 'watch');
  console.log(`\n  JOURNEYS (${jrn.length} journey + ${watch.length} watch):`);
  jrn.forEach(j => {
    const c = contexts.find(x => x.id === j.contextId);
    const ctxRecs = c ? (c.recordIds || []).length : '?';
    const markers = (j.markers || []).map(m => m.type).join('+') || '(none)';
    console.log(`    🌳 ${ctxRecs}筆  markers=${markers}  「${j.title || j.label || ''}」`);
  });
  if (jrn.length >= 2) {
    console.log('\n  JOURNEY 主題重疊檢查（centroid cosine, 越接近 1 越像）：');
    const recById = {}; loadEmbeddingRecords_(scope).forEach(r => { recById[r.id] = r; });
    const centroidOf = (j) => {
      const c = contexts.find(x => x.id === j.contextId);
      const embs = ((c && c.recordIds) || []).map(id => recById[id]).filter(r => r && r.embedding).map(r => r.embedding);
      return embs.length ? meanVector_(embs) : null;
    };
    const cents = jrn.map(j => ({ j, cent: centroidOf(j) }));
    for (let i = 0; i < cents.length; i++) {
      for (let k = i + 1; k < cents.length; k++) {
        if (!cents[i].cent || !cents[k].cent) continue;
        const sim = cosineSim_(cents[i].cent, cents[k].cent);
        const flag = sim >= 0.85 ? '⚠️  可疑（>=0.85，當初就是這個門檻把獨立主題吸進來）' :
                     sim >= 0.75 ? '注意（>=0.75）' : '正常';
        console.log(`    「${truncate_(cents[i].j.title || cents[i].j.label || '', 16)}」  vs  「${truncate_(cents[k].j.title || cents[k].j.label || '', 16)}」 = ${sim.toFixed(3)}  ${flag}`);
      }
    }
  }
}

/**
 * 把一條 thread 的設定展開成 specs[]：不規則的「burst + drive-by」時間 layout、
 * 循環句子池、按 mediaMix 分配媒介。
 *
 * 時間 layout：
 *   - 兩種模式：spanDays 太短（< 1hr）→ 全部壓進同一個 burst（測「無回返」用）
 *               spanDays 夠長 → 用 VISIT_SIZE_CYCLE 跑出「3 筆 burst / 單發 /
 *               2 筆 / 4 筆 burst / ...」的不規則 visit 序列；visit 間距也按
 *               VISIT_GAP_WEIGHTS 變化（短間隔 + 長間隔交錯）
 *   - 同 visit 內間距 6 min（4 筆 burst 跨 18 min，仍 < returnGapMinutes=20）
 *   - 跨 visit 間距下限 60 min，保證每個 burst 都被算成獨立回返
 *
 * 完全決定性 —— 相同 thread 設定每次跑時間結構一致。
 */
const VISIT_SIZE_CYCLE = [3, 1, 2, 4, 1, 2];        // 多筆 burst 與單發交錯
const VISIT_GAP_WEIGHTS = [1, 2, 1, 3, 1, 2];       // 短間隔與長間隔交錯
const WITHIN_VISIT_STEP_MS = 6 * 60000;
const MIN_INTER_VISIT_MS = 60 * 60000;

function buildSpecsForThread_(thread) {
  const pool = SIM_SENTENCE_POOLS[thread.topic];
  if (!pool || !pool.length) throw new Error(`no sentence pool for topic "${thread.topic}"`);
  const mediaTypes = expandMediaMix_(thread.mediaMix || { text: thread.count });
  const dayMs = 86400000;
  const endMs = Date.now() - (thread.endOffsetDays || 0) * dayMs;
  const spanMs = thread.spanDays * dayMs;
  const startMs = endMs - spanMs;

  // 短 span：壓進同一個 burst（給 underqualified 的「無回返」線用）
  if (spanMs < MIN_INTER_VISIT_MS * 2) {
    const out = [];
    for (let i = 0; i < thread.count; i++) {
      const ts = new Date(startMs + i * 5 * 60000).toISOString();
      out.push({ ts, type: mediaTypes[i % mediaTypes.length], text: poolText_(pool, i) });
    }
    return out;
  }

  // 不規則 visit 配置
  const visitSizes = [];
  let remaining = thread.count, cycleIdx = 0;
  while (remaining > 0) {
    const size = Math.min(VISIT_SIZE_CYCLE[cycleIdx % VISIT_SIZE_CYCLE.length], remaining);
    visitSizes.push(size); remaining -= size; cycleIdx++;
  }
  const visits = visitSizes.length;
  let weightSum = 0;
  const gapWeights = [];
  for (let v = 0; v < visits - 1; v++) {
    const w = VISIT_GAP_WEIGHTS[v % VISIT_GAP_WEIGHTS.length];
    gapWeights.push(w); weightSum += w;
  }
  // unit = 平均單位 gap，下限為 MIN_INTER_VISIT_MS 保證 visits 不黏在一起
  const unit = weightSum > 0 ? Math.max(MIN_INTER_VISIT_MS, spanMs / weightSum) : 0;
  const visitStarts = [startMs];
  for (let v = 0; v < visits - 1; v++) {
    visitStarts.push(visitStarts[v] + gapWeights[v] * unit);
  }

  const out = [];
  let recIdx = 0;
  for (let v = 0; v < visits; v++) {
    const base = visitStarts[v];
    const size = visitSizes[v];
    for (let k = 0; k < size; k++) {
      const ts = new Date(base + k * WITHIN_VISIT_STEP_MS).toISOString();
      out.push({
        ts,
        type: mediaTypes[recIdx % mediaTypes.length],
        text: poolText_(pool, recIdx)
      });
      recIdx++;
    }
  }
  return out;
}

function poolText_(pool, i) {
  const base = pool[i % pool.length];
  return i >= pool.length ? `${base}（第 ${Math.floor(i / pool.length) + 1} 次回返）` : base;
}

/** Expand a mediaMix object like {text:6, image:2} into a flat array of types. */
function expandMediaMix_(mix) {
  const out = [];
  for (const k in mix) {
    for (let i = 0; i < mix[k]; i++) out.push(k);
  }
  // Shuffle deterministically so distribution doesn't all clump at start.
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.length ? out : ['text'];
}

// ============================================================================
// Raw 紀錄插入（場景式 + 隨機式共用）
// ============================================================================

/**
 * 插入一筆 spec 為真實 record（含 embedding、transcript、timeline 更新）。
 * spec 接受兩種時間：{ts: ISO 字串} 或 {daysAgo, hour}（舊隨機式用）。
 */
function insertSimRecord_(scope, s) {
  const id = newId_();
  const dayMs = 86400000;
  let ts;
  if (s.ts) {
    ts = s.ts;
  } else {
    const tsMs = Date.now() - (s.daysAgo || 0) * dayMs;
    const d = new Date(tsMs);
    const tsAtHour = new Date(Utilities.formatDate(d, TIME_ZONE, 'yyyy-MM-dd') +
                              'T' + String(s.hour || 0).padStart(2, '0') +
                              ':' + String(Math.floor(Math.random() * 60)).padStart(2, '0') + ':00+08:00');
    ts = tsAtHour.toISOString();
  }

  const record = {
    id, ts,
    userId: 'simulated',
    type: s.type,
    text: s.text,
    quoteToken: null
  };

  if (s.type !== 'text' && s.type !== 'sticker') {
    record.fileName = `sim_${s.type}_${id}.${s.type === 'image' ? 'jpg' : s.type === 'audio' ? 'm4a' : s.type === 'video' ? 'mp4' : 'pdf'}`;
    record.mimeType = s.type === 'image' ? 'image/jpeg' : s.type === 'audio' ? 'audio/m4a' : s.type === 'video' ? 'video/mp4' : 'application/pdf';
    record.mode = 'auto';
  }
  if (s.type === 'sticker') {
    record.stickerPackageId = '11537';
    record.stickerId = '52002744';
    record.stickerUrl = 'https://stickershop.line-scdn.net/stickershop/v1/sticker/52002744/iPhone/sticker.png';
  }

  record.embedding = geminiEmbed_(s.text);
  appendEmbeddingRecord_(scope, record);
  saveTranscript_(scope, id, s.text, ts);
  try { appendToTimeline_(scope, record); } catch (e) { console.warn('timeline append:', e && e.message); }
}

// ============================================================================
// 清資料
// ============================================================================

/**
 * 全清測試資料 —— 砍 embeddings.jsonl / contexts.jsonl / journeys.jsonl /
 * transcripts 整個資料夾 / meta 上的 pins/notified/throttle/lastIngestTs。
 * 用於測試前重置到乾淨狀態。Drive 中的 summaries 不動（_context.md /
 * _journey.md，會在下次 /story 重產）。
 *
 * ⚠️ 不可逆。記得確認 OWNER_LINE_USER_ID 是測試帳號，再跑。
 */
function wipeAllForTesting() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  if (!owner) throw new Error('OWNER_LINE_USER_ID 未設定');
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  console.log(`=== wipeAllForTesting on ${scope.key} ===`);

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    // embeddings.jsonl
    try {
      const f = chatEmbeddingsFile_(scope);
      const before = (f.getBlob().getDataAsString() || '').split('\n').filter(l => l.trim()).length;
      f.setContent('');
      console.log(`  embeddings.jsonl: wiped ${before} records`);
    } catch (e) { console.warn('  embeddings wipe failed:', e && e.message); }

    // contexts.jsonl / journeys.jsonl
    try { saveContexts_(scope, []); console.log('  contexts.jsonl: cleared'); }
    catch (e) { console.warn('  contexts wipe failed:', e && e.message); }
    try { saveJourneys_(scope, []); console.log('  journeys.jsonl: cleared'); }
    catch (e) { console.warn('  journeys wipe failed:', e && e.message); }

    // transcripts/
    try {
      const folder = chatSubFolder_(scope, FOLDERS.TRANSCRIPTS);
      const files = folder.getFiles();
      let n = 0;
      while (files.hasNext()) { files.next().setTrashed(true); n++; }
      console.log(`  transcripts/: trashed ${n} files`);
    } catch (e) { console.warn('  transcripts wipe failed:', e && e.message); }

    // meta —— 清掉所有與升格/通知/節流相關的衍生狀態，保留 type/id/name 等身分欄位
    updateChatMeta_(scope, m => {
      delete m.recordPins;
      delete m.notifiedContextIds;
      delete m.notifiedJourneyIds;
      delete m.lastContextUpgradeAt;
      delete m.lastIngestTs;
      delete m.lastNotifiedAt;
      return m;
    });
    console.log('  meta: cleared pins/notified/throttles/lastIngestTs');
  } finally {
    lock.releaseLock();
  }

  console.log('=== 完成。可接著跑 seedScenario("...") 或 runScenarioPipeline("...") ===');
}

/** 只砍 simulated 紀錄（保留真實資料）。隨機式測試後用這個。 */
function wipeSimulatedData() {
  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  if (!owner) throw new Error('OWNER_LINE_USER_ID 未設定');
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const file = chatEmbeddingsFile_(scope);
    const lines = (file.getBlob().getDataAsString() || '').split('\n');
    const kept = [];
    let removed = 0;
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const r = JSON.parse(ln);
        if (r.userId === 'simulated') { removed++; continue; }
        kept.push(ln);
      } catch (_) {
        kept.push(ln);
      }
    }
    file.setContent(kept.join('\n'));
    console.log(`Wiped ${removed} simulated records. ${kept.length} real records kept.`);
    return removed;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// 隨機式（舊版，留給「想看一坨雜訊」的場合）
// ============================================================================

/**
 * 隨機式：問 Gemini 產 N 筆雜訊紀錄、灌入 OWNER 聊天室。
 * 多半用於 UI 邊界、視覺壓測；要驗 pipeline 行為請用 runScenarioPipeline()。
 *
 *   simulateLearningData();          // 60 筆 / 30 天
 *   simulateLearningData(100, 60);   // 100 筆 / 60 天
 */
function simulateLearningData(n, days) {
  n = n || 60;
  days = days || 30;

  const owner = getProp_(PROP.OWNER_LINE_USER_ID);
  if (!owner) throw new Error('OWNER_LINE_USER_ID 未設定，先 setOwner("U....") 或加 bot 好友。');
  const scope = { type: 'user', id: owner, key: `user_${owner}`, userId: owner };

  console.log(`Generating ${n} simulated records over ${days} days...`);
  const specs = generateSimSpecs_(n, days);
  console.log(`Got ${specs.length} valid specs from Gemini.`);

  let inserted = 0;
  for (const s of specs) {
    try {
      insertSimRecord_(scope, s);
      inserted++;
      if (inserted % 10 === 0) console.log(`  inserted ${inserted}/${specs.length}`);
      Utilities.sleep(150);
    } catch (e) {
      console.warn('skip record:', e && e.message);
    }
  }
  console.log(`Done. Inserted ${inserted} records into ${scope.key}.`);
  return inserted;
}

/** Ask Gemini for N record specs as JSON. Returns array of valid specs (may be < N). */
function generateSimSpecs_(n, days) {
  const prompt = [
    `請扮演一位台灣的教育工作者 / 研究者，最近 ${days} 天在 LINE 上記錄自己的學習歷程。`,
    `請產生 ${n} 筆紀錄，輸出嚴格 JSON array：`,
    '',
    '[',
    '  {"daysAgo": 29.5, "hour": 9, "type": "text", "text": "..."},',
    '  {"daysAgo": 28.2, "hour": 14, "type": "image", "text": "白板上寫著..."},',
    '  ...',
    ']',
    '',
    '要求：',
    `1. daysAgo: 0 ~ ${days} 之間的小數（0=現在；${days}=${days} 天前）`,
    '2. hour: 0-23 整數，代表當天的小時',
    '3. type: text / image / audio / video / file / sticker 其中之一',
    '4. text: 該筆紀錄的內容（image/audio/video 是 Gemini 對該媒體的描述／轉錄；file 是檔案摘要；sticker 是「[貼圖] 開心、慶祝」格式）',
    '5. 每筆 30-150 字繁體中文，第一人稱「我」口吻，符合教育工作者寫筆記的調性',
    '6. 主題群組分布：',
    '   - AI / LLM / Gemini 探索（20%）',
    '   - 形成性評量 / 教學設計 / 課室觀察（30%）',
    '   - 教育讀書筆記 / 學習理論（20%）',
    '   - 教育研究方法 / 反思（15%）',
    '   - 日常生活 / 雜記 / 心情（15%）',
    '7. 類型分布：60% text、15% image、10% audio、5% file、5% sticker、5% video',
    '8. 時間分布：部分日子集中 5-8 筆（密集 session，hour 相近），部分日子空缺',
    '9. 文字具體：寫出實際概念 / 書名 / 人物 / 數字，不要空話',
    '',
    '直接輸出 JSON array，不要說明、不要 markdown code fence。'
  ].join('\n');

  let response;
  try {
    response = geminiGenerate_([{ text: prompt }], {
      systemInstruction: '你是學習歷程模擬器。請嚴格輸出 JSON。',
      temperature: 0.7,
      maxOutputTokens: 16384
    });
  } catch (e) {
    throw new Error('Gemini 生成失敗：' + (e && e.message || e));
  }

  const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON parse failed; first 500 chars:', cleaned.slice(0, 500));
    throw new Error('Gemini 回應不是有效 JSON：' + e.message);
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini 回應不是 array');

  const validTypes = new Set(['text', 'image', 'audio', 'video', 'file', 'sticker']);
  return parsed.filter(s =>
    s && typeof s === 'object' &&
    typeof s.text === 'string' && s.text.length > 5 &&
    typeof s.daysAgo === 'number' && s.daysAgo >= 0 &&
    validTypes.has(s.type)
  );
}
