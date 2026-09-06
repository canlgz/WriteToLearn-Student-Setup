# WriteToLearn — 開發維護紀錄

> 這是開發交接與測試紀錄，**不是學生安裝文件**。學生請從 [README](../README.md) 的「安裝路線」開始；本文件中的分支、提交與實驗註記不需在安裝時操作。

## 一句話

LINE bot × Google Apps Script × Gemini × Drive 的個人學習歷程記錄器：
所有訊息（文字 / 圖 / 語音 / 影片 / 檔 / 貼圖）自動轉譯、embedding、可
語意搜尋；提供時間軸、總結、主題分布、用量統計等多種視角。

## 倉庫資訊

- Repo：`canlgz/line-bot-gas-drive-rag` (private)
- 主開發分支：`claude/beautiful-allen-xDD4p`（最新；舊 `claude/serene-edison-wcqnE` 已合併進此分支）
- 部署：`./deploy.sh` 一鍵（clasp push + clasp deploy）
- 設定檔（per-user，不入 git）：`.clasp.json` 含 scriptId

## 主要檔案

| 檔案 | 職責 |
| --- | --- |
| `src/Config.gs` | 常數（模型、TZ、資料夾名） |
| `src/Main.gs` | `doPost` webhook 入口、OWNER 權限 |
| `src/Router.gs` | 路由各 LINE 事件類型 |
| `src/Handlers.gs` | 訊息處理、指令分派、所有 reply 邏輯 |
| `src/ChatScope.gs` | 對話 scope → Drive 資料夾對應 + meta.json |
| `src/DriveStore.gs` | Drive IO（raw / transcripts / summaries） |
| `src/Gemini.gs` | Gemini Generation / Embedding 呼叫 + 429 中翻 |
| `src/LineClient.gs` | LINE Messaging API（reply / push / loading / carousel / flex） |
| `src/LineProfile.gs` | LINE user / group / room profile API |
| `src/VectorStore.gs` | Hybrid cosine + keyword 搜尋 |
| `src/Summary.gs` | 結構式總結 + 敘事體總結 |
| `src/Timeline.gs` | 每日 timeline.md + session 偵測 |
| `src/Focus.gs` | K-means 主題聚類 + 密集區段選單 |
| `src/Dashboard.gs` | /me 儀表板 + 待處理 picker |
| `src/Usage.gs` | Gemini token 累計 + 費用估算 |
| `src/Simulate.gs` | 假資料生成器（測試用） |
| `src/TestbedSeed.gs` | 種子四條測試脈絡，端到端驗收轉折升格 |
| `src/RichMenu.gs` | Rich Menu 一鍵設定 |
| `src/Setup.gs` | 初次部署 helpers |
| `src/Topic.gs` / `Category.gs` | 主題群 / 大類分類 |
| `src/ContextStore.gs` / `ContextStory.gs` / `ContextUpgrade.gs` | 層4 脈絡：儲存、敘事、升格 |
| `src/Journey.gs` / `JourneyDetect.gs` | 層5 學習歷程偵測、升格、補一個轉折 |
| `src/TransitionEval.gs` / `Calibration.gs` | 轉折評鑒 multi-signal + 校準集 + 三層驗證 |
| `src/Exploration.gs` | 探索敘事段（儀式軸） |
| `docs/SETUP.md` | 部署文件 |
| `docs/LINE_GOTCHAS.md` | LINE / Flex 踩雷集 |
| `docs/SCALING.md` | 規模上來的瓶頸 + 對策 |

## 已實作功能

### 訊息攝取
- **文字**：靜默記錄 + embed
- **圖片 / 語音 / 影片 / 檔案**：上傳後跳 Quick Reply [詳細 / 摘要 / 幫我決定] picker，選後才實際送 Gemini
- **貼圖**：用 LINE 提供的 `keywords` 直接 embed，當情緒訊號
- **Office 檔（pptx/docx/xlsx）**：自動轉成 PDF 再給 Gemini（原檔保留）
- **LINE typing indicator**：媒體下載期間顯示打字動畫

### 對話 scope
- 1-on-1 / group / room 各自獨立資料夾
- 資料夾名 = LINE 顯示名（user displayName / group name (N 人)）
- meta.json 紀錄類型、創建時間、成員清單、lastIngestTs

### 指令（透過 `/me` 整合多項統計）
- `/me` — 學習儀表板（單張 Flex 卡）+ `/me reset` 歸零用量
- `/today` `/week` `/month` — 4 段結構式總結（PDF）
- `/story [today|week|month|N]` — session-aware 敘事體總結
- `/timeline [today|YYYY-MM-DD]` — 當日學習脈絡 PDF
- `/search <關鍵字>` — Hybrid scoring (cosine + keyword boost)，動態 threshold
- `/themes [today|week|month|N|all]` — 主題分布
- `/help` — 指令說明

### 進階互動
- `/search` 結果：
  - Flex carousel（瘦長 micro bubble + No.編號 + 類型icon + 副檔名 + 相似度 + 完整時間 + CTA）
  - 圖片/影片帶 Drive thumbnail；語音帶「▶ 試聽」原生 audio 訊息
  - 分頁卡 `t=0.6 👉 搜尋"X"(共 N 筆 / M 頁)`，3 寬度頁碼視窗 + pre/next 循環
  - 有結果 Quick Reply 出 [↓擴大] [↑縮小]；無結果只出 [↓擴大]
  - 點任筆「看完整內容」→ replyRecordDetail_，引用原訊息（quoteToken）
- `/themes`：先盤點資料密度 → 列出可分析範圍（時間段 + 自動偵測的密集 session）→ 點選跑 K-means → Gemini 命名各群
- `/me` 待處理項：可點開列出 pending 媒體，每筆配 3 顆模式按鈕重新處理

### 系統
- 自動 OWNER 認領（第一個 follow 的人）
- follow / join 歡迎語
- LINE quote 支援（reply 引用原訊息）
- 重要錯誤 push 到 OWNER（diagnostic）
- 用量累計 + USD 費用估算

## 已知限制 / 邊界

- Gemini embedding 對「同主題不同用詞」中文不敏感（解：keyword boost）
- Flex Carousel 必須 ≥2 bubble（單張要直接送）
- 顏色必須 6 位 hex（`#444` 會被拒）
- K-means N > 2000 自動 sub-sampling
- 寫入 `embeddings.jsonl` 是 O(N) per append（5K+ 紀錄要考慮分片）
- journey-merge 的 `m:` must-link pin 是「強制留群、繞過 k-means」的——一旦錯併就會雪球成巨無霸 blob（見下）。所以 merge 的把關（LLM gate）必須嚴；錯併後須 `runJourneyMergeRollbackNow()` 清 pin 才解得開。

## 2026-05-29 修：巨無霸歷程卡（一張卡混雜不相關主題）

`/journey` 曾出現 154 筆、密度 0.57 的混合卡（教學設計＋評量＋繪本＋論文＋家庭旅行混在一起）。三連修，全在 `claude/serene-edison-wcqnE`：

1. `15ad812` — 真因＝`shouldMergeJourneyPair_` 的 `cos≥0.90` strong-path 跳過 LLM gate，每輪 sweep 無聲把同領域不同子題併成一條、pin 成 `m:`。移除 strong-path，一律走 LLM concept gate（曾被 P1 修掉又被 revert 帶回）。**既有 blob 需 editor 跑 `runJourneyMergeRollbackNow()` 清 pin＋重分群。**
2. `cd18b4e` — re-link 把舊 journey 指到新群時清掉殘留 title/summary/markers，逼 `detectJourneys_` 依新群重生（否則凍結規則讓舊 blob 描述永久留著）。
3. `4789954` — `detectContextMarkers_` 標題消毒 `sanitizeJourneyTitle_`，擋掉 LLM 把 system 人設「學習轉折偵測器」當標題外洩。

實測：154 筆 blob → 13 條聚焦歷程＋2 候選，標題乾淨。詳見 `docs/design/context-to-journey.md` §八〔2026-05-29 巨無霸歷程卡三連修〕。

## 2026-05-30 → 06-02：候選歷程 → 學習歷程的品質把關（「補一個轉折」）

加一道升格門檻在候選歷程與學習歷程之間，避免 markers 不足或同質時被機械湊滿。三個 Phase + 一次研究級評鑒重寫：

1. **Phase 1（cos 歸屬閘）→ 後撤** (`1340fef` → `107fac4`)：原本擋住「補進來的轉折跟脈絡 cos 太低」的記錄。後因前景（凝聚卡）與背景（補充升格）判準不一致而拆掉，改由評鑒分數一條尺。
2. **Phase 2 markerGap** (`eb3233b`)：每條 watch 算「最缺哪一種轉折」(概念重述 / 行動指向 / 跨主題整合 / 後設反思)，純 CPU。
3. **Phase 3 轉折成形卡 + 即時評鑒** (`b36ef91` / `5df570e` / `b36...` / `bdd3c12`)：主卡四項 % 進度條 + ✨ 建議起點 + 「為什麼建議」+ LLM 題目；連續評鑒（contextDigest + draft 同一把尺）。
4. **轉折評鑒 v2 multi-signal composite** (`ac86bb8` / `672b3c0` / `367688a`)：`src/TransitionEval.gs` S1=LLM（anchor exemplars）× S2=結構（型別閘），非對稱合成 `final = S1 + max(0, S2 − S1) × 0.6`（`EVAL_S2_BOOST`）。三條通用原則取代「補 regex 句型」。
5. **研究級驗證** (`c020642`)：`src/Calibration.gs` 校準集 `TRANSITION_CALIBRATION` + 編輯器三層報告 `runEvalCalibration / Reliability / Validity` → 寫到 `_reports/*.json` 供 AI 端直接讀。三輪校準 **MAE 0.07、r > 0.93、門檻 0.60 鑑別度乾淨**。
6. **CPU markerGap × LLM diagnose 融合** (`a68adcc`)：`diagnoseContextTransitions_` 把結構特徵與內容判讀對照。
7. **一致性修復**：
   - 升格 markers 用凝聚卡評鑒達標的項（與補充呈現一致, `0233289`）
   - 背景重複推播去重 + 當場升格回 flex 卡（`062780c`）
   - 主卡空 tag 不放 text 元件，修 LINE 400 must-be-non-empty（`a17c871`）
   - 補充升格後鎖 `(category, topicLabel)` 防背景 group-by 抽離原脈絡（`583be58`）

升格門檻 `SUPPLEMENT_EVAL_THRESHOLD = 0.60`、天花板鷹架 `generateScaffoldHint_`。詳見 `docs/design/context-to-journey.md` §0.6.9 + §八〔2026-06-02〕，手動驗收對照表 `docs/test/transition-manual-testbed.md`。

## 下一步候選

- 主題聚類視覺化（不只列卡片，畫 mind-map）
- 反思引導（AI 不給答案而拋問題）
- 跨對話搜尋（目前每個 scope 獨立）
- BigQuery / Vertex Vector Search 升級（看 SCALING.md）
- 多人協作 / 群組權限細分

## 開發指令

```bash
# 拉最新
git pull

# 本地改完 push 並部署
./deploy.sh

# 跑假資料生成（在 Apps Script 編輯器跑）
simulateLearningData()      # 60 筆 / 30 天
simulateLearningData(100, 60)  # 自訂

# 清掉假資料
wipeSimulatedData()

# Rich Menu 設定（首次 / 變動時）
setupRichMenu()
```
