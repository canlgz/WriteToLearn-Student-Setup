# write-to-learn bot — CLAUDE.md

LINE bot on Google Apps Script + Drive. Captures heterogeneous messages, embeds
them, and turns them into retrievable 脈絡 and, eventually, 學習歷程.
Source in `src/*.gs` (clasp). Deploy: `./deploy.sh` (clasp push + deploy to a
fixed /exec). No local run; verify on a real LINE device.

## 部署工作流（務必遵守）

使用者本機固定用：`cd line-bot-gas-drive-rag && ./deploy.sh`
（`deploy.sh` = 自動 fetch＋對齊最新分支 → `clasp push -f` → `clasp deploy` 到固定 /exec）。

- **deploy.sh 已自動對齊分支（2026-06-04 起）**：每次 deploy 會先 `git fetch`、把工作樹
  `checkout -B` 到 origin 上「最近更新的 `claude/*` 分支」再部署，並印出**部署了哪個分支
  ＋ commit SHA**。所以使用者**不必再手動 `git pull` 或切分支**——無腦 `./deploy.sh` 就部到
  Claude 最新的碼。覆蓋：`./deploy.sh <分支>` 指定分支、`./deploy.sh .` 部目前工作樹。
  *背景*：Claude Code on the web 每 session 開新 `claude/*` 分支，而舊流程的 `git pull` 只更新
  「當前分支」，導致每換一個對話視窗就部署到舊碼（縮圖/新指令都沒上、deploy 還 ✅）。已修。
- **仍須**：凡有改動程式碼的 session，結束時主動明講程式碼在哪條 `claude/*` 分支（讓使用者
  知道 `./deploy.sh` 會抓到的就是它；若刻意要部別條，提醒用 `./deploy.sh <分支>`）。
- `clasp deploy` 若受 Apps Script 版本數上限阻塞，**deploy.sh 現在會攔下失敗並印出修法**
  （到 script.google.com「部署 ▸ 管理部署作業」刪舊版本再重跑）；`clasp push` 不受此限。

## 核心概念（五層架構 + 兩組升格判準）

完整設計：**`docs/design/context-to-journey.md`**（實作決策以該文件為準；**權威模型見該文件 §零**，舊 §一～§五為設計沿革，衝突以 §零 為準）。

**文件維護紀律（務必遵守 · 2026-05-30 改為「實作優先」）**：流程＝**討論 → 確認要實作 → 實作（commit + push）→ 使用者驗收 OK → 才把該規格寫進 `docs/design/context-to-journey.md`**（更新 §零 最新原則與規格；必要時 §八 build log 補帶日期紀錄）。**不再「先改文件再實作」**（太耗時）。要點：(a) 程式碼先落地、使用者實機驗收；(b) 驗收 OK 後同一條工作分支補一筆「文件對齊」commit，讓設計文件追上現行真相、不漏記；(c) 驗收沒過就改碼，別先寫文件。

資料流：**雙軸 + 三段升格**（過去寫成「五層」是把同一物件的不同狀態當作不同層；澄清後實際只有兩條物件鏈、加三段狀態演進）：

- **時間軸**（`敘事片段` / episodes）：純時間切（`groupBySession_`，30 分 gap），UI 用。**不持久化**。
- **語義軸**（`脈絡` / contexts）：背景 k-means 跑全語料，**每個 record 都歸到一個 cluster**，每個 cluster 持久化到 `contexts.jsonl`，status 隨三段升格演進：
  1. `candidate`＝**候選脈絡**：未過三條件
  2. `context`＝**候選歷程**：過三條件、但 `journeys.jsonl` 還沒抓到轉折（或 status='watch'）
  3. `journey`（在 `journeys.jsonl`）＝**學習歷程**：候選歷程被偵測到至少一個轉折

⚠️ **關鍵釐清**：三段升格是**同一個 cluster（同一份 records）的狀態演進**，**不是聚合**。`歷程.contextId` 永遠 1:1 指向一條 `context`，那條 context 也永遠是一個 cluster。語義軸上沒有「主題群組是脈絡的下層」這種包含關係——「主題群組」這詞只是 cluster 還沒升格時的 UI 暱稱。

⚠️ **`/themes` 不跑自己的 k-means**：直接讀 `contexts.jsonl`、過濾「視窗內有記錄」的脈絡，每張卡 = 一條脈絡（三狀態之一）。不要再加「ad-hoc k-means」這層——之前因雙 k-means 造成 27 vs 14 對不齊、字面承諾與實際發生不符等坑，已合掉。

「記寫脈絡」＝走過 candidate → context；「學習歷程」＝再升到 journey（脈絡出現轉折）。

**脈絡三條件（3→4）**：語義密度（群內 cos 均 ≥0.60；**群間距已不當關卡也不當合併規則**——絕對距離在 Gemini 短中文 embedding 不可靠，只在卡上顯示參考）＋意向回返性（不同時段主動回返 ≥3 次；間隔 ≥20 分算一次、首末跨 ≥1h）＋跨媒介協同（≥2 種媒介；非文字媒介靠**語義鄰近**歸戶）。分群：`pickContextK_`（較細 ≈n/8）、決定性、成員**不 union**。**脈絡每次採「當次乾淨分群」**：matched 復用既有 id（保 journey 連結），unmatched **直接丟棄、不 carry-forward**——所以不會有重複紀錄/同主題碎成多條/肥大 blob；**歷程靠「重連到最相符的新群」保存**（凍結的歷程不會因重分群消失，見 `upgradeContexts_` 末段 re-link）。機器把不同主題湊成一條時，可在卡上按**「分開」**人工修正（must-not-link，釘 `meta.recordPins`，之後重分群一律尊重——見 `handleContextSplit_`）。閾值在 `Config.gs` `CONTEXT_CRITERIA`，待實測校準（已校：密度 0.75→0.60、回返 gap/span 拆成 20 分/1h、跨媒介改語義鄰近、分群改決定性+細化+去 union、群間距退出判定、升格只進不退、加人工分開）。

**歷程四種轉折標記（4→5）**：概念重述／跨主題整合／行動指向／後設反思。無標記者只記為「持續關注」，不升格。

**journeySeams**：`bridged`／`skipped`／`pending`（pending 隨新訊息/新 summary 重評，勿過早凍結）。

**Story 兩版**：`_context.md`（在想什麼，日記語氣）／`_journey.md`（學到什麼，標出轉折種類，學習單元結構）。

### 現況（五層模型 blocks 1–5 已落地，細節見設計文件 §八）
- ✅ 命名對齊（敘事片段=時間、主題群組=語義）。
- ✅ 層 4/5 已持久化：`contexts.jsonl`（candidate/context）、`journeys.jsonl`（journey/watch），背景升格 + 轉折偵測。
- ✅ `Journey.gs` 已重寫：`/journey` 只讀持久化歷程；舊 on-demand 手動編織（episode 節點＋接縫）已整個移除。`/themes` 按鈕改為「升格進度／還缺什麼」卡（`contextGapReport_`）。
- ✅ `/story` 雙版（`_context.md` / `_journey.md`）。
- ✅ 背景有新成形脈絡/歷程時，主動 push 通知（`notifyNewUpgrades_`，1對1、按 id 去重、只在有新東西時推，省推播額度）。
- ✅ `/journey` 卡片升級（同一通 `detectContextMarkers_` 取得）：分頁（`/recall` 同樣式 pager）、新→舊排序、LLM **摘要**（≤60 字一句中文）取代逐字 evidence 引用、跨媒介 hero 縮圖＋媒介組成 row、**關鍵字** chip（1 個大類 `JOURNEY_KEYWORD_CATEGORIES`：教學/研究/閱讀/反思/札記/生活/規劃/進修；+ 0-2 自由細類 ≤6 字）4 層共用同一字彙。
- ✅ **`/themes` 統一 k-means**（雙 k-means 整併）：取消 /themes 自己的 transient k-means + Gemini 標題，改成直接讀 `contexts.jsonl`、過濾「視窗內有記錄」的持久脈絡。每張卡 = 一條持久脈絡，狀態三選一視覺化：🌳 學習歷程 / 🌿 候選歷程 / 🌱 進行中脈絡；三條件 ✅/⬜ inline、按鈕依狀態給（候選歷程才有「補一個轉折」、進行中脈絡只有「看敘事片段」、學習歷程有「歷程現況」）。按大類 → 狀態 → 視窗筆數排序，分頁同 `/recall` pager。`/themes` 上「看升格進度」按鈕及其 `handleJourneyCluster_` 不再被呼叫（dead code，留著不刪以防舊卡 postback 反咬）。**這修掉 27 vs 14 對不齊、字面承諾與實際發生不符等問題**。
- ✅ 敘事片段卡移除密度條（`buildEpisodeBubble_`）：session 內節奏在 raw record 列表自然可見，密度條只在脈絡層級才有意義。
- ✅ **記寫時間分布條 strip（`episodeTimelineStrip_`）**：所有有時間軸的卡（/themes、/recall、/journey 升格進度、/補一轉折、看原始、/ask 引用）統一規則。三狀態 `◯` 空 / `●` 同範圍非本卡 / `✓` 本卡聚焦；kilo/mega 12 格 lg cell-based edge-to-edge，micro 8 格 md cell-based；compact mode 在 `mineBuckets≤2 且 otherRecords>20` 時把 `●` 退回 `◯`；strip 統一放 body 最末。標題與關鍵字一律 `大類｜關鍵字1+關鍵字2`。**完整規則見 `docs/design/context-to-journey.md` §九、§十**。
- ✅ **UI 一致性整輪〔2026-06-09 驗收〕**（詳 `docs/design/context-to-journey.md` §0.6.12）：三狀態「一張臉」`stateBadge_`（單一真相、icon **🧵→🌳**＝🌱發芽→🌿長葉→🌳成樹、L0/L1 不再二分壓成 🌿）、類路徑麵包屑 `breadcrumbTrail_`（補最深的卡）、**/journey＝🌳 學習歷程成就牆**（候選歷程濃縮成一張入口卡 `buildCandidateEntryCard_`、瀏覽全狀態回 /themes）、歷程「完整視圖」統一命名**「歷程現況」**（網頁版仍「瀏覽歷程現況」區隔）、/themes header **深度色階**（L0 亮藍→L2 深藍）、背景 push「🔔 背景自動整理」簽名、**背景智慧合併主動推卡告知＋一鍵取消**（`notifyMergedJourneys_` / `undoJourneyMerge_`，`meta.mergeExclude` 擋再併回）。`🧵` 釋出後僅留給「🧵 這是同一件事嗎？」（對話串）。
- ⏳ 剩：敘事片段層關鍵字、「展開相關主題」(歷程→子主題輪播)、閾值實測校準、補轉折入口瘦身（P2-F 其二，暫緩）、Flex 實機驗收。

## 目前進度（接續開發看這裡）
完整 build log、已確認的操作化預設見 **`docs/design/context-to-journey.md` §八**。
**五層模型 blocks 1–5 全部完成**：
- block 1 持久化骨架 `ContextStore.gs`
- block 2 脈絡升格 `ContextUpgrade.gs`（背景 k-means → Jaccard 配對 → 三條件 → candidate/context）
- block 3 轉折偵測 `JourneyDetect.gs`（每 `context` 一次 LLM 判四標記 → journey/watch）
- block 4 `/journey` 改寫 `Journey.gs`（只讀持久化歷程；舊手動編織＋接縫已移除）
- block 5 雙版 story `ContextStory.gs`（`/story` 產 `_context.md` / `_journey.md`）
block 2/3 掛在 `backgroundSweep` 並各自節流。診斷（editor 直接跑）：`runContextUpgradeNow`、`runJourneyDetectNow`。
下一步 = **實測校準閾值 + 實機驗收**（非新建功能）。
⚠️ 部署阻塞：Apps Script 已達 200 版本上限，需先刪舊版本才能 `clasp deploy`。
還原點 branch：`snapshot/pre-context-journey`。
