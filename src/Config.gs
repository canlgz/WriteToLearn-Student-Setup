/**
 * Centralized configuration. All secrets/IDs live in Script Properties.
 * Set them via Project Settings → Script Properties, or run `initProperties()` once.
 */

const PROP = {
  LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN',
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  DRIVE_ROOT_FOLDER_ID: 'DRIVE_ROOT_FOLDER_ID',
  OWNER_LINE_USER_ID: 'OWNER_LINE_USER_ID',
  WEB_APP_EXEC_URL: 'WEB_APP_EXEC_URL'   // 固定 /exec（= LINE webhook 網址）。報告連結用它，
                                          // 不靠 ScriptApp.getService().getUrl()（會回需登入的 /dev）。
};

const MODELS = {
  // On gemini-2.5-flash during active dev/testing — cheapest by far
  // ($0.075/$0.30 per 1M) and we call it constantly while iterating.
  // It's deprecated but the shutdown was pushed to 2026-10-16, so there's
  // no rush. When the feature set settles, switch to the GA successor
  // 'gemini-3.5-flash' (or 'gemini-3.1-flash-lite' for a cheaper GA
  // option). geminiGenerate_ already picks the right thinking param by
  // model generation, so flipping this line is the only change needed.
  GENERATION: 'gemini-2.5-flash',
  EMBEDDING: 'gemini-embedding-001'
};

const EMBED_DIM = 768;
const TIME_ZONE = 'Asia/Taipei';
const FOLDERS = { RAW: 'raw', TRANSCRIPTS: 'transcripts', SUMMARIES: 'summaries' };
const EMBEDDINGS_FILE = 'embeddings.jsonl';
const CONTEXTS_FILE = 'contexts.jsonl';   // 層4 脈絡物件（升格自主題群組）
const JOURNEYS_FILE = 'journeys.jsonl';   // 層5 學習歷程片段（脈絡 + 轉折標記）
const EXPLORATIONS_FILE = 'explorations.jsonl';     // 探索敘事段 物件（使用者主動宣告的探索敘事段（課程/工作坊/讀書會等））
const SESSION_GAP_MINUTES = 30;

/**
 * Centralized colour palette. Two independent axes:
 *
 *   depth.l1 / l2 / l3 — navigation-depth tint. Drilling in
 *     (day index → episode → raw record) darkens the card's header band, so
 *     cards stacking downward in the LINE chat read as a navigation trail
 *     instead of a flat wall of same-coloured bubbles. Each tier also styles
 *     its breadcrumb kicker via `headerSub`.
 *
 *   cta / status / surface / neutrals — action buttons, state, soft panels and
 *     text. Kept constant across depths on purpose: depth is carried by the
 *     header band + the breadcrumb, not by the buttons.
 *
 * All Flex builders should reference THEME instead of hard-coded hex.
 */
const THEME = {
  depth: {
    l1: { headerBg: '#3a6ea5', headerText: '#ffffff', headerSub: '#dce8f5', title: '#1a3a5c', accent: '#3a6ea5' },
    l2: { headerBg: '#1a4480', headerText: '#ffffff', headerSub: '#aabbdd', title: '#1a3a5c', accent: '#1a4480' },
    l3: { headerBg: '#0e2a4d', headerText: '#ffffff', headerSub: '#8fb3d9', title: '#ffffff', accent: '#0e2a4d' }
  },
  // Stage accent — which moment of the ask/supplement flow a card belongs to.
  // Restrained: tints only the card title + ⋁⋁/icon, never the surface.
  stage: {
    ask: '#3a6ea5',         // 提問 — inquiry blue
    supplement: '#2ea043',  // 補充 — growth green (echoes its 🌱)
    gap: '#cc6600'          // 缺口 — caution amber (incomplete / to fill)
  },
  // Operation family — which job a command belongs to. Currently only the /help
  // board uses it; reserved as the home for cross-card operation identity.
  group: {
    context: '#1a4480',     // 脈絡 · 回頭看（today / story / episodes）
    explore: '#3a6ea5',     // 探索 · 查詢動詞（recall / ask / themes）
    account: '#7986cb'      // 帳號（me）
  },
  cta: '#1a4480',
  ctaText: '#ffffff',
  // /ask 問答身分（與 /recall 藍記錄卡刻意區隔）：答案卡＝暖紫「助理」主角、依據卡＝暖紙「證物」。
  ask: {
    answerBg: '#6b5b95',      // 答案卡表頭：暖紫（assistant 感，非 recall 藍）
    answerText: '#ffffff',
    answerSub: '#e3dcf0',
    evidenceBg: '#fff8d0',    // 依據卡表頭：暖紙底（warm paper / 證物感）
    evidenceInk: '#5d4e2a',   // 暖紙底上的深墨
    evidenceSub: '#9a7b3a'    // 暖紙底上的次要字（依據序號／麵包屑）
  },
  success: '#2ea043',
  warning: '#cc6600',       // soft alert (e.g. budget) — gentler than danger red
  audio: '#7986cb',
  danger: '#cc0000',
  dangerSoft: '#a04040',
  surface: '#eef3f8',       // soft panel — mode / gap card headers, inline note boxes
  surfaceSoft: '#eef1f5',   // secondary-action button background
  surfaceWarm: '#fff8d0',
  onDark: '#ffffff',
  ink: '#1a3a5c',           // heading text on a light surface
  text: '#222222',
  textBody: '#333333',
  textMuted: '#666666',
  textDim: '#555555',
  muted: '#888888',
  faint: '#bbbbbb'
};

/**
 * 脈絡 / 學習歷程 升格判準的可調閾值。see docs/design/context-to-journey.md.
 * 目前僅為宣告（升格邏輯尚未實作），所有初值【待實測校準】。
 */
// 主題群組 → 脈絡（第 3→4 層）：三條件需同時滿足。
const CONTEXT_CRITERIA = {
  semanticDensityMin: 0.60,   // 群聚內 cosine 相似度平均下限。Gemini embedding 對短中文相似度偏低
                              // （相關但用詞不同常落 0.55–0.65），0.75 過嚴；先降到 0.60，用
                              // runContextUpgradeNow 的「語意密度排序」找真主題/噪音的縫再校準。
  clusterSeparationMin: 0.15, // 與最近群聚的最小距離（夠遠才算獨立主題）
  returnVisitsMin: 3,         // 意向回返：不同時段主動回到同一關注點的次數下限
  returnGapMinutes: 20,       // 意向回返：兩則間隔 ≥ 此值才算「新一次回返」；< 此值＝同一次坐下（連續輸入不灌水）
  returnSpanHoursMin: 1,      // 意向回返：首末回返要橫跨的最小總時間（小時）——整體散布的輕量守門
  mediaKindsMin: 2,           // 跨媒介協同：至少跨越的訊息媒介種類數
  mediaAttachCosMin: 0.55,    // 跨媒介語意歸戶：非文字媒介（圖片/語音/影片/檔案）若與群心
                              // cosine ≥ 此值，即算進該群的跨媒介——即使 k-means 因描述文風格
                              // 把它硬分到隔壁群。媒介描述文與隨手文字常落 0.55–0.65；
                              // 用 runContextUpgradeNow 的 media= 逐群數字校準。
  recordFitMin: 0.55,         // Per-record 邊緣淘汰：k-means 把每筆都歸到一個群，但群邊緣
                              // 的紀錄與群心 cosine 可能很低。低於此值 → 升格 pass 後從該脈絡
                              // 踢出，回到 pool 等下次重分群（同時清掉它身上的 m:* 自動合併
                              // pin，否則 must-link 會把它拉回原群）。手動 pin（非 m: 前綴）
                              // 一律豁免——使用者意圖。配 mediaAttachCosMin 同帶寬，0.55 起跑。

  // 〔聚焦補償·邊緣密度〕語意密度(pairwise)的盲點：同一主題的不同面向(學術討論／住宿／伴手禮…)彼此
  // cosine 低、把 pairwise 拉下來，但它們其實都繞著同一核心。故密度落在「邊緣帶」(≥ floor 但 < min)
  // 時，若絕大多數成員都緊扣單一核心(coreFrac ≥ 門檻＝夠聚焦)，視為密度達標。真正混多主題的群其群心
  // 兩頭不到岸、coreFrac 低，拿不到補償。對齊「時間/聚焦可信、語意絕對值不可信」。注意：用「比例」
  // (coreFrac)而非「平均」——平均 cos-to-centroid 與 pairwise 是同一個量(群心向量長度)的單調變換、
  // 拿來補償等於只是調低門檻；比例才是真正獨立、能分出「單核發散」vs「多核混雜」的訊號。
  densityFocusCompensate: true,
  densityFloorForFocus: 0.52, // 密度低於此就不給聚焦補償（太散、寧缺勿濫）
  densityFocusFitMin: 0.50,   // 成員對群心 cosine ≥ 此＝「扣到核心」
  densityFocusCoreFracMin: 0.80 // 扣到核心的成員比例 ≥ 此＝夠聚焦(單一核心)，可補償邊緣密度。待實測校準
};
// 脈絡 → 學習歷程（第 4→5 層）：至少偵測到一種轉折標記。
const JOURNEY_MARKERS = ['概念重述', '跨主題整合', '行動指向', '後設反思'];

// 主題群組 ↔ 既有脈絡物件的配對（block 2 背景升格用）：member-id Jaccard 重疊度
// 下限。重疊 ≥ 此值 = 視為同一脈絡（原地更新、保留 id），否則為新候選。【待校準】
const CONTEXT_MATCH = { jaccardMin: 0.3 };
// 脈絡升格背景排程的節流：每個 scope 最多每隔這麼久才重跑一次全語料聚類升格。
// 另有「自上次升格後無新訊息則跳過」的守門，閒置聊天室完全不花成本。
const CONTEXT_UPGRADE_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;  // 3 小時
// 轉折偵測（block 3，層4→5）每日 LLM 呼叫上限（全 script 共用，跨 scope）。每個
// context 只在內容變動後重判一次，正常用量遠低於此；此為防爆衝的安全閥。
// 〔2026-05-30 測試階段暫調高〕主題群組重構需大量 LLM（大類 backfill 231 筆＋反覆驗收），
// 50 太緊會卡住 backfill；暫設 1000。功能驗收穩定後再調回合理值（約 50~100）。
const JOURNEY_DETECT_DAILY_MAX = 1000;

/**
 * /ask 三檔信心(score-gated)閾值。基於 OWNER 96 條脈絡實測校準:
 * 已升格脈絡的內聚 cosine median=0.665、min=0.586;與既有 mediaAttachCosMin=0.55、
 * semanticDensityMin=0.60 對齊。流程詳見 docs/design/context-to-journey.md。
 *
 * top1 score (queryEmbedding ↔ topRecord) 判定模式:
 *   ≥ HIGH  → 直接答 + 引用
 *   HIGH > x ≥ LOW → HEDGED:審慎答 + 「推測:」前綴標推論部分
 *   < LOW   → 不答結論;呼 replyAskCluesAnnotated_ 給 LLM 註解線索 + 下一步關鍵字
 */
const ASK_SCORE_HIGH = 0.65;
const ASK_SCORE_LOW = 0.50;
const ASK_USE_SCORE_GATE = true;   // 緊急退場 flag;設 false 走舊一條鞭路徑
// /ask 檢索「原始筆記優先」：舊「探問」Q&A 記錄（recordAskQA_ 寫回語料）的排序分懲罰係數，
// 讓依據傾向原始筆記、減少「答案的答案」漂移。只調排序/選依據，不調信心閘門。1.0＝關閉。
const ASK_QA_RECORD_PENALTY = 0.9;

/**
 * 探索敘事段 預設 + inline suggestion（當下協作）參數。see docs/design/context-to-journey.md。
 */
const EXPLORATION_DEFAULTS = { durationMinutes: 45, maxConcurrent: 1 };  // 沒給時長預設 45 分；同時最多 1 段

// exploration 到期前的單次提醒：剩下這麼多分鐘時 push 一次（背景 sweep 兜底，每段最多一次）。
// 短於 minMinutes 的 exploration 不提醒（測試/極短情境，end push 已足夠）。
const EXPLORATION_EXPIRY_WARN = { leadMinutes: 5, minExplorationMinutes: 10 };

// 〔2026-06-03 刪除〕寫時「像在延續X」建議（maybeSuggestMerge_）已整套移除：違反「無痕靜默」、
// 且短中文向量低門檻亂配。延續判斷改走背景「綁串」；之後若要回到「曖昧才輕提示」會另設新機制。

// 〔DEPRECATED 2026-06-02,已無人引用〕「補一個轉折」舊 cos 歸屬閘。移除理由:使用者從
// 該脈絡的「補一個轉折」進來,歸屬已由行動決定,不該再用 cos 重判;且 cos 硬擋違背設計
// 哲學「向量只參考、不當淘汰閘」(§0.4.1),與背景 label group-by 歸屬打架(前景擋下、
// 背景用 label 撿回去升格 → 矛盾)。歸屬交給 label、品質交給評鑒閘。常數保留供歷史參考。
const SUPPLEMENT_RELATEDNESS_MIN = 0.45;
// 補一個轉折的「評鑒分數」門檻:每次補充凝聚後 LLM 對 draft 評分(0-1),這對目標轉折的
// 貢獻度。達此值才開「補進脈絡」按鈕,擋「亂寫也升格」+ 引導使用者寫到位才送出。
// 偏寬(0.60)讓誠懇嘗試的補充可過,偏緊(0.75)會逼使用者多寫幾輪。先 0.60 看實機表現。
const SUPPLEMENT_EVAL_THRESHOLD = 0.60;

// 現況落差分數（0-100）達此值＝「有意義的學習歷程初版」里程碑（可考慮定案）。
// 〔2026-06-03〕已不再當「網頁觀看門檻」：現況永遠可看（鏡子不是考卷、不該為解鎖去湊分），
// 此值只作里程碑參考；導覽卡卡身仍顯示「離有意義約 X%」。可調。
const MEANINGFUL_JOURNEY_MIN = 60;
// 測試期旁路：true 時開放網頁「解除定案」（&unfinalize=1）。功能定版後改 false，定案＝不可逆。
// 〔註 2026-06-03〕原本還管「未達門檻的觀看鎖」，該鎖已移除，此旗標現僅管解除定案。
const JOURNEY_REPORT_TEST_BYPASS = true;

// ── 記寫綁串（thread／串）──────────────────────────────────────────
// 把連續記寫的多則綁成「同一件事」，同串 → 同大類、同議題（修「演講後/用餐/很熱情」被拆成
// 研究/人脈/生活 這種碎裂）。判「串/拆」：時間間隔為主 ＋ 語言接續/斷點訊號 ＋ 向量「只加黏、
// 不拿來切」（短中文向量看字面、會誤殺碎句）。連發預設傾向串。曖昧才輕提示＝下一階段，
// 這層只做**全靜默**綁串。門檻待實機校準。
const THREAD_TIGHT_GAP_MS = 2 * 60 * 1000;    // ≤2 分連發＝心流，「確定」同一串（除非明顯切換詞）
const THREAD_AMBIG_GAP_MS = 8 * 60 * 1000;    // 2–8 分、又沒明確延續/斷點訊號＝「曖昧」，預設 lean-chain
const THREAD_VEC_CHAIN_MIN = 0.82;            // 向量「很像→加分串」門檻；低相似一律不拿來切
// 註：綁串只在「敘事片段」內進行（CATEGORY_EPISODE_GAP_MS＝30 分為界）。判定分三段：≤TIGHT 確定串；
// 有延續訊號（接續詞/沒寫完/指涉短句/向量很像）確定串；無訊號時 ≤AMBIG 曖昧（仍 lean-chain）、>AMBIG 拆。
// 「曖昧」是「心流停了才輕問」的提示點（見 /串 的「～?」標記）。待實機校準。

// 曖昧輕提示（背景推播版 v1）：曖昧併入後、心流停了（SETTLE 內沒再寫）才推一則輕問
// 「接著的還是新的?」。只在曖昧時、且不在連發當下 → 守住「無痕靜默」。off 可整個關。
const THREAD_HINT_ENABLED = true;
const THREAD_HINT_SETTLE_MS = 8 * 60 * 1000;   // 曖昧那則之後沒再寫滿此時長＝心流停了，才推。待校準

// 記寫回執（write receipt）：寫了一段、停筆 settle 後，若這段「夠量＋夠集中＋已歸入一條進行中
// 脈絡(candidate)」（正面結果），背景推一張「你剛寫的這段被怎麼處理了」卡。保守門檻、按 episode
// startTs 去重。context/候選歷程・journey/學習歷程的升格由 notifyNewUpgrades_ 負責（不雙推）。
const RECEIPT_SETTLE_MS = 10 * 60 * 1000;   // 這段最後一筆停筆滿此時長＝心流停了才推
const RECEIPT_MIN_RECORDS = 6;              // 這段至少 N 筆才算「寫了一段」（保守）
const RECEIPT_DENSITY_MIN = 0.60;           // 群內平均 cos ≥ 此值才算「集中在一件事」（同脈絡密度尺）
const RECEIPT_DOMINANT_FRACTION = 0.5;      // 這段 ≥ 半數記錄落在同一條脈絡，才算正面歸戶
// 〔2026-06-07 改更安靜〕只在「接近升格」才回執——這段歸入的進行中脈絡已達標的三條件數 ≥ 此值
// （＝差一條件成候選歷程）。純整理好但離成形還遠的，不打擾、不標記，留待後輪。要整個關＝RECEIPT_ENABLED=false。
const RECEIPT_ENABLED = true;
const RECEIPT_NEAR_UPGRADE_MIN_CONDITIONS = 2;   // 三條件中至少已達標幾條才推（2＝差一條件）

// 回返時的輕量邀請（A：背景 push、狠節流；2026-06-06）：回到一條「候選歷程」（差一個轉折）、
// 停筆 settle 後，推一則輕邀請引導趁剛回到這條補一個轉折。只挑高槓桿時機、每脈絡每日最多一次、
// 可永久關。⚠ production（非 test）：FRESH 上限確保只對「剛剛的回返」推、不會回頭翻舊資料狂推；
// 要整個停就把 RETURN_INVITE_ENABLED 設 false。與記寫回執互斥（回執只報 candidate、邀請只報 context）。
const RETURN_INVITE_ENABLED = true;                    // 一鍵總開關
const RETURN_INVITE_SETTLE_MS = 10 * 60 * 1000;        // 這次回來停筆滿此時長＝心流停了才推
const RETURN_INVITE_FRESH_MS = 3 * 60 * 60 * 1000;     // 只對最近這段推；停筆超過此時長＝太舊，不回頭翻舊資料
const RETURN_INVITE_GAP_MS = 12 * 60 * 60 * 1000;      // 距這條上次記寫 ≥ 此值才算「有意義的回返」
const RETURN_INVITE_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 同一條脈絡兩次邀請至少間隔（≈每日一次）
const RETURN_INVITE_GLOBAL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 全域節流：跨所有脈絡，兩則延續提醒至少間隔（保守、production）

// 〔背景主動推播·合宜守則〕所有「機器主動找你」的學習推播（回執/轉折卡/曖昧/新進展/合併/回返提醒）
// 共用的時機守門，集中在 proactivePushAllowed_。對齊「無痕靜默、少打擾」。
const PROACTIVE_QUIET_START_HOUR = 22;   // 夜間靜默起（含）：22:00 起不主動推
const PROACTIVE_QUIET_END_HOUR = 8;      // 夜間靜默迄（不含）：08:00 後才恢復；落在窗內的回返提醒順延到早上
const PROACTIVE_PUSH_GLOBAL_COOLDOWN_MS = 10 * 60 * 1000;  // 跨「所有」主動學習推播：每 scope 至少間隔 10 分，杜絕一輪噴多張
const REORG_SETTLE_MS = 10 * 60 * 1000;  // 「機器重整你資料」的通知（新進展/智慧合併）也等停筆滿此時長才推、不打斷寫作

// A·記寫當下「歸戶確認」（只候選歷程）：你正在寫、點線面判出這筆很可能屬於某條既有「候選歷程」
// （與其群心 cosine ≥ 門檻）→ 當場回一張輕確認；你按「是」就把剛寫的歸進那條＋下 must-link pin。
// ⚠ 這是對「無痕靜默」的例外（記寫當下會冒出），故門檻高、每條有冷卻、可永久關。
const CONTINUITY_RT_ENABLED = true;
const CONTINUITY_RT_COS_MIN = 0.64;                  // 與候選歷程群心 cosine ≥ 此值才算「很可能屬於」（高、寧缺勿濫；短中文不可靠故偏保守）
const CONTINUITY_RT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 同一條候選歷程兩次歸戶確認至少間隔

// 〔補密度 ABC・2026-06-07〕進行中脈絡補「語意密度」時，把「補充當下記寫的聚焦程度」當權重，
// 讓「補密度」從可作弊的關卡變成「越補越扣核心、灌水沒用、真深化才升格」的良性循環：
//   A 凝聚 steering：每則補充依「離脈絡核心多近」加權，越扣核心的越主導重組（synthesizeDensityDraft_）。
//   B 即時回饋：凝聚卡顯示這幾則「越補越聚焦↑／發散↓」，使用者自己拉回核心（buildConvergeBubble_）。
//   C 防灌水＝放在「密度度量本身」（avgPairwiseCosine_ 去近重複），不是前景擋下：逐字重複/反覆灌同一段
//     被收斂成一份代表，不會機械式拉高群內密度。放度量＝前景背景一致、不會「前景說沒過、背景偷偷升格」；
//     且使用者每次「補進脈絡」一律保留、不丟（topicLocked），只是灌水那種不會幫密度往上。
// A/B 量化對「補充當下那則」算 focus=cos(turn,脈絡群心)、novelty=1−max cos(turn,既有成員)。短中文 cosine
// 偏低且「絕對值」不可信，故只當 steering/趨勢/非阻擋提示，不當硬升格閘（硬閘交給 §C 度量去重）。
const SUPP_FOCUS_WEIGHT_ENABLED = true;
const SUPP_FOCUS_CORE_MIN = 0.35;          // A 標記/提示：補充對脈絡群心 cosine 低於此＝偏離核心（凝聚時當次要、結果卡給「扣回核心」提示）
const SUPP_NOVELTY_MIN = 0.12;             // 提示用：補充對既有成員「新意」(1−最相似) 低於此＝近重複（結果卡提醒「換個新角度」；不阻擋、仍保留）
const SUPP_FOCUS_TREND_EPS = 0.04;         // B：最後一則 vs 之前平均 的聚焦差，超過此值才標 ↑/↓（否則視為持平）

// 〔C・密度去近重複〕計算群內語意密度前，先把「近乎一樣」的成員(cos ≥ 此值)收斂成一份代表，
// 讓逐字重複/反覆灌同一段無法機械式撐高密度。門檻取高(0.92)：Gemini 短中文「相異但相關」紀錄
// 多落 0.55–0.75，唯近乎逐字重複才會 ≥0.92，故幾乎不誤傷正常相異紀錄、專剋灌水。待實測校準。
const DENSITY_DEDUP_COS = 0.92;


// 〔暫時·診斷〕每筆記寫後即時 push 一則「本敘事片段語意密度變化」。已被 Tier-1 聚焦觀察
// （FOCUS_OBSERVE，顯示 n/density/avgLen/coreFrac）取代，故預設關閉、避免每筆兩則訊息。
const DENSITY_ECHO_DEBUG = false;

// 〔Tier-1 即時聚焦偵測〕純向量、零 LLM：串流維護當前敘事片段的「單位向量累加和」，每筆 O(768)
// 更新；跨過「具體×聚焦×不雜」門檻的當下即時 push 一則「這段夠聚焦、已記下」。與背景「記寫回執」
// （有 LLM、負責命名/歸類）互補。門檻可調。
const FOCUS_DETECT_ENABLED = false;                         // 〔2026-06-07 關閉推播〕聚焦不再「停筆後推一則 🎯」（使用者不要這通知）；聚焦數據改在網頁「片段內節奏」畫成趨勢（episodeMicroRhythmHtml_，不靠此旗標）。
const FOCUS_OBSERVE = false;                                // 〔已停用〕舊串流即時觀察用；聚焦改停筆後推後，此旗標與 maybeFocusDetect_ 皆不再被呼叫。
const FOCUS_MIN_N = 4;                                       // 至少幾筆才評估
const FOCUS_DENSITY_GATE = CONTEXT_CRITERIA.semanticDensityMin;  // 群內平均 cosine 門檻（對齊升格 0.60）
const FOCUS_LEN_FLOOR = 12;                                  // 平均字數下限（具體度；濾掉電報式碎句）
const FOCUS_CORE_FRAC = 0.8;                                // 核心比例下限。0.7→0.8：3 主題段(好市多/天氣/電影)核心 0.72 不再誤觸達標
const FOCUS_FIT_FLOOR = 0.45;                               // 絕對 floor（樣本不足時的後備離群門檻）
const FOCUS_RECENT_K = 3;                                   // 貼合改對「最近 K 筆」算（抓主題切換，比對全體糊質心敏感）
const FOCUS_OUTLIER_K = 1.0;                               // 相對離群：本筆貼合 < 這段平均 − K·σ → 計為離群（自我校準、不靠絕對常數）
// 長度加權：每筆權重 w=√min(字數,上限)，飽和避免長轉錄(圖片/檔案)獨吞焦點。短句/雜訊權重低。
const FOCUS_LEN_CAP = 200;                                  // 權重的字數上限（超過視同 200）
const FOCUS_SUBSTANCE_MIN = 14;                            // 實質量門檻 W1=Σw（≈ 四句 12 字：4×√12）；取代 avgLen
const FOCUS_NEFF_MIN = 3;                                   // 有效量門檻 n_eff=W1²/W2；取代純筆數
// 〔點線面判準〕面＝多線交織：線(群成員≥2)≥2 且 橋接(語意整合句)≥門檻。實測（2026-06）：好市多現代豐足
// ↔ 大濛戒嚴困苦的諷刺對比，橋接才亮(=1)；淺交織(好市多↔天氣)回返雖高、橋全程 0。故改用「橋接」當真跨域
// 整合的指紋——回返(時序中斷後重提)只是行為交織，可被瑣碎插話刷高；橋接(夾在兩遠線群心之間的整合句)才是語意交織。
const FOCUS_BRIDGE_MIN = 1;                                // 橋接下限（面達標）：≥1 條夾在兩線群心間的整合句＝真跨主題整合
const FOCUS_INTERWEAVE_MIN = 3;                            // 〔參考·已退出達標〕交織＝回返＋橋接；曾當門檻，現改橋接，此值僅供顯示對照
const FOCUS_BRIDGE_GAP = 0.06;                            // 橋接：某筆對「最近兩條線群心」cosine 差 < 此值＝夾在兩線之間的整合句

// 〔Stage 3〕exploration 內 mini 聚類：少於此筆數不跑（成不了有意義的小主題）。
const EXPLORATION_MINI_CLUSTER_MIN = 4;
// 〔Stage 4〕背景全域聚類給「同 exploration 同段」的臨門一腳加成；只在語意已達 FLOOR 邊緣才加，
// 硬性不蓋過語意（同段內跳兩主題、語意遠時仍分開）。
const EXPLORATION_AFFINITY_BOOST = 0.05;
const EXPLORATION_AFFINITY_FLOOR = CONTEXT_CRITERIA.semanticDensityMin;  // 0.60


function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Missing Script Property: ${key}`);
  return v;
}

function getPropOptional_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}
