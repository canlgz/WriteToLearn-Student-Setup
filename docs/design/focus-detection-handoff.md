# 聚焦偵測（點線面 / 跨主題整合）— 接續開發交接

> 接手第一件事：`git checkout claude/ui-consistency-IxExB`（或從它切新分支）。本 session 全部成果
> （UI 一致性大整理、URL 縮圖、/info、/today /story 改版、記寫回執、聚焦偵測…）都在這條分支。
> 接手時 HEAD ≈ `e704388`。`./deploy.sh` 會自動對齊「最新 claude/* 分支」，所以**新分支要從
> `claude/ui-consistency-IxExB` 切出**，deploy 才會抓到聚焦偵測的碼。

## 一句話目標
在記寫當下，用**零 LLM、純向量的數據科學**偵測「使用者把多條思路接起來、形成跨主題整合」的時刻，
即時給回饋。使用者用**點線面**定義：

- **點** = 一筆記寫（記錄）
- **線** = 點隨時間串成的一條發展中脈絡（＝同主題 k-means 群、成員 ≥2）
- **面** = 多條線**交織** = **跨主題整合**轉折 = 脈絡升成**學習歷程**的那一刻

## 已定案的判準（★下一步要實作）
目前程式裡的達標是 `面 = 線≥2 且 (回返+橋接)≥FOCUS_INTERWEAVE_MIN(3)`——但實測發現它會在「淺交織」
（好市多↔天氣，回返3、橋0）就達標。使用者**已定案改成**：

```
面 = 線≥2  且  橋接(bridges) ≥ 1     ← 真正把兩條較遠的線接起來才算
```

實測（好市多現代豐足 ↔ 大濛戒嚴困苦 的諷刺對比）驗證：**橋接=深度跨域整合的指紋**——淺交織橋0、
真正對比兩個遠領域時橋才亮(=1)。改成「要求橋接≥1」會在**對比那一筆**達標（#11），而非瑣碎的 #7。
**這個改動尚未寫進程式，是接手後的第一個 coding 任務。**（改 `handleTestMessage_` 的 `faceOk`：
`subst≥SUBSTANCE_MIN && linesN>=2 && (sg.bridges||0)>=1`。）

## 程式位置（全部在 /test 環境，零風險、不碰正式記寫）
- `src/Handlers.gs`
  - `handleTestMessage_`：/test 每筆的主流程（embed→加權狀態→四指標→k-means 結構→面判準→回卡＋寫 log）。
  - `testStructure_`：對 buffer 跑 cosine k-means(k=2,3)，回 `{domFrac, within, lines, returns, bridges}`。
    - `lines`＝成員≥2 的群數；`returns`＝時序中某群被中斷後又出現（行為交織）；
    - `bridges`＝某筆對「最近兩群心」cosine 差 < `FOCUS_BRIDGE_GAP` ＝夾在兩線間的整合句（語義交織）。
  - 數學 helper：`testUnit_`/`testDot_`/`weightedDensity_`/`focusWeight_`/`testKmeans_`/`testWeightedPairwise_`。
  - `appendTestLog_` / `handleTestEnter_`(重設語意＋複寫 log) / `handleTestEnd_` / `handleTestLog_`。
  - `maybeFocusDetect_`（正式路徑版、**目前停用** `FOCUS_DETECT_ENABLED=false`）：定案後把點線面準則 port 到這裡。
- `src/Config.gs` 的 `FOCUS_*` 常數：`FOCUS_DETECT_ENABLED(false)`、`FOCUS_SUBSTANCE_MIN(14)`、
  `FOCUS_INTERWEAVE_MIN(3)`、`FOCUS_BRIDGE_GAP(0.06)`、`FOCUS_RECENT_K(3)`、`FOCUS_OUTLIER_K(1)`、
  `FOCUS_LEN_CAP(200)`…（密度/n_eff/核心已降為「參考」、不再 gate）。

## /test 測試環境（校準用）
- `/test` 進入（自動重設語意＋複寫 `focus_test_log.jsonl`）、`/test end` 離開、`/test log` 取連結。
- 模式內**只回報、不記錄、不進脈絡**；每筆即時顯示四指標＋面判準，並逐筆寫進 Drive 的
  `focus_test_log.jsonl`（chat 資料夾、固定檔名、每次 /test 自動複寫）。
- **Claude 直接讀 Drive 分析（不必使用者給連結）**：Drive MCP 連到 `guanze.liao@gmail.com`，
  chat 資料夾 id＝`1Ct19gGT8JUO-9ZFqxcPyO16kJWKt5m9u`。流程：`search_files(title='focus_test_log.jsonl')`
  → 取 file id → `download_file_content(fileId)` 回 base64 → 解碼即整份 jsonl。
  （`read_file_content` **不支援** text/plain，要用 `download_file_content`。）

## 接手後的工作清單（依序）
1. **★實作定案準則**：`面 = 線≥2 且 橋接≥1`（改 `handleTestMessage_` 的 faceOk），/test 再驗一輪。
2. **存成轉折**：把每次「橋接(跨主題整合)」存進 journey 的 `markers`（型別=跨主題整合、帶橋接記錄＋
   它接起的兩條線），讓**網頁學習歷程現況**(`Report.gs`)能視覺化「點→線→橋→面」。
3. **事後重判**：因 `embeddings.jsonl` 已持久化，同一套 point-line-plane 可離線跑在任何過去脈絡/時間段
   ——做一支「對既有脈絡 retroactively 找跨主題整合」的診斷，與現有 LLM 轉折偵測(`JourneyDetect.gs`)互補。
4. **Port 到正式路徑**：校準滿意後，把準則從 /test 搬到 `maybeFocusDetect_`（設 `FOCUS_DETECT_ENABLED=true`、
   `FOCUS_OBSERVE=false`）＋與背景「記寫回執」`maybePushWriteReceipt_` 整合（即時面偵測 ＋ 背景 LLM 命名）。
5. **收掉暫時診斷**：定案後移除 `/test`、`/dreset`、`DENSITY_ECHO_DEBUG`、`maybeEchoDensity_`、本 log 機制。

## 設計原則備忘
- Gemini 短中文 cosine 壓在 0.5–0.7，**絕對密度門檻(0.6)對日常細主題沒鑑別力**——已證實，故密度降為參考。
- 真正鑑別「成面」的是**結構**（k-means 的線/回返/**橋接**），不是單一密度數字。
- 權重 `w=√min(字數,200)`：短碎句權重低、長轉錄飽和不獨吞；圖片/檔案轉錄走同一公式自動納入。
- 數學恆等式：單位向量加權群內平均 cosine = `(|S_w|²−W2)/(W1²−W2)`；故只存累加和不爆 cache。
