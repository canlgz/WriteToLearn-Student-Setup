# 從記寫脈絡到學習歷程 — 資料模型設計

> 本文件是 write-to-learn bot 的核心設計理路。後續所有實作決策請以此為準。精簡版見 `CLAUDE.md` 的「核心概念」。
> 狀態：blocks 1–5 + 主題群組新模型（block 5+，§八 2026-05-31）+ 探索敘事段/inline suggestion/score-gated /ask/freshness UX（§八 2026-06-02）+ **轉折成形卡/轉折評鑒 v2（§0.6.9，2026-06-02）** + **點線面視覺化/補充·提醒分流/落差收進主題/icon·用字（§0.6.10，2026-06-07）** + **補密度忠實凝聚·ABC 防灌水·升格密度聚焦補償·回返/改名/改歸/提醒 UX（§0.6.11，2026-06-07 續）** + **UI 一致性/智慧合併（§0.6.12）·推播合宜·命中問答·pin 契約·貼圖情緒·分享回執（§0.6.13＋I）·目前記事(/now)·ask 歸戶線索群·改歸亮✨·定案頁內確認·歷程卡摘要完整（§0.6.14）（2026-06-09~10，分支 `claude/sleepy-thompson-TRkeg`）** 已落地（前一輪「語意密度灌水」已知未決於此輪解決）；剩**閾值實測校準 + 實機驗收 + 部署**。
>
> ⚠️ **權威模型見 §零（雙軸 + 三段升格），那是現行程式碼的真相。** §一～§五是早期「五層」設計稿，名詞與判準與現況有出入（「五層」是把同一物件的不同狀態誤當不同層），保留作沿革，**有衝突一律以 §零 為準**。

---

## 零、權威總覽：雙軸 + 三段升格（現行真相）

> 本節 2026-05-30 依現行程式碼逐函式核對後寫成，是「目前做法」的單一真相。之後優化／更新先改這裡。
> **維護紀律**：與使用者討論出的新修正／新決策一經同意，即更新本節為最新原則與規格（必要時 §八 補帶日期紀錄），讓本文件永遠等於現行真相。

### 0.1 先破迷思：不是 5 個依序的階段

「訊息流 → 敘事片段 → 主題群組 → 脈絡 → 歷程」直覺像一條直線，**但實際不是**。真相是 **2 條軸 + 3 段狀態**：

- **訊息流** ＝ 底料（所有 record 的原子，`embeddings.jsonl`）。
- **敘事片段** ＝ 把 record 用**時間**切的視圖（時間軸）。
- **主題群組／脈絡／歷程** ＝ 把 record 用**語義**聚的**同一條物件鏈的三個狀態**（語義軸），**不是**三層包含關係。

```
          ┌──────────── 訊息流（records / embeddings.jsonl）────────────┐
          │  每則訊息 → 轉譯 → embedding → 一筆 record（時間戳＋向量＋媒介）│
          └───────────────────────────┬───────────────────────────────┘
                                       │  同一批 record，被兩種方式組織：
        ┌──────────────────────────────┴──────────────────────────────┐
        ▼ 時間軸（UI、不持久化）                    語義軸（持久化、背景 k-means）▼
   ┌──────────────────┐                  ┌────────────────────────────────────────┐
   │ 敘事片段 episodes │                  │  一個 cluster ＝ 一條物件，status 演進： │
   │ groupByEpisode_   │                  │   ① 主題群組（進行中脈絡） candidate       │
   │ 30 分 gap 切時段  │                  │        ↓ 過三條件                        │
   │「這半小時做了啥」 │                  │   ② 脈絡（候選歷程）     context        │
   └──────────────────┘                  │        ↓ 偵測到轉折                       │
                                         │   ③ 學習歷程             journey        │
                                         └────────────────────────────────────────┘
```

⚠️ **關鍵**：③ 不是 ② 的聚合，② 也不是 ① 的聚合——**從頭到尾就是同一個 cluster、同一份 records，只是 status 往上跳**。`歷程.contextId` 永遠 1:1 指向一條脈絡，那條脈絡永遠是一個 cluster。語義軸上**沒有**「主題群組是脈絡的下層」這種包含關係；「主題群組」只是 cluster 還沒升格時的 **UI 暱稱**。

### 0.2 五個名詞逐一定義

| 名詞 | 是什麼 | 軸 | 持久化 | 程式/檔案 |
|---|---|---|---|---|
| **訊息流** | 原始 record（時間戳＋向量＋媒介）。裸連結/收藏（`isCollectionRecord_`）排除在升格語料外，仍儲存、仍可 /recall | 底料 | ✅ `embeddings.jsonl` | Handlers 攝取 |

> **訊息形式：外部連結（`type:'link'`）**〔2026-05-30 驗收〕：貼含 `http(s)://` 網址的文字訊息（Drive/地圖另有專屬處理除外）入庫時 `record.type = 'link'`，是真正的訊息形式、不是顯示層 hack。判定＝`handleText_` 偵測 `/https?:\/\//`。卡片顯示「🔗 外部連結」（`typeLabel_`/`EPISODE_TYPE_ICON` 加 `link`）。**升格判準上 link 算一種獨立媒介**（`CONTEXT_MEDIA_TYPES` 含 `link`，故「連結＋寫文字」可滿足跨媒介≥2）；裸連結仍由 `linkBookmark`/`isCollectionRecord_` 排除升格（預設收藏）。
>
> **連結預覽（縮圖／標題／說明）· 共同方法（2026-06-05 對齊）**：`fetchFirstUrlPreview_` 用 `facebookexternalhit` crawler UA + `Accept-Language: zh-TW` 抓頁，存 `record.urlPreview`（標題＋說明同時併入 `record.text` 與 embedding 輸入→`/recall`、`/ask` 找得到）。抓取前洗掉追蹤參數（`mibextid`/`fbclid`/`igsh`/`utm_*`，只影響抓取用 URL）。快取鍵 `urlpv7_`（24h；改規則就升版讓舊壞快取失效）。**為何要這麼多功夫**＝LINE 原生預覽是「完整瀏覽器（會跑 JS）＋被網站信任的爬蟲身分」，我們是「機房 IP 的純文字 HTTP 抓取」；兩個落差衍生兩層問題，各有對策：
>
> - **fast-path**：YouTube 走 oEmbed（`fetchYoutubeOembed_`）；抖音/TikTok 走 `fetchTiktokOembed_`（短鏈先 `resolveRedirects_`（`followRedirects:false` 讀 `Location`，≤5 跳）解成 `www.tiktok.com/@user/video/<id>`；官方 oEmbed 從機房 IP 被擋 403，故實走 og 後備）。
> - **A 層 · 縮圖載不出（拿得到 og:image、但 LINE Flex hero 顯示不出）→ 共同方法＝一律 Drive re-host**。`previewThumbnail_` 把**所有** og:image 交給 `rehostImageToDrive_`：GAS 用 crawler UA 下載圖→存進 Drive（`thumb-cache/`，ANYONE_WITH_LINK）→回 `drive.google.com/thumbnail?id=…&sz=w800`（保證 JPEG、轉 WebP、限寬，與 /journey、/recall hero 同款端點，LINE 必載得出）。以 og:image url 為 key 快取 fileId 復用、失敗回 ''（不放破圖）；`thumb-cache/` 由 `backgroundSweep` 每天清 >14 天舊檔。**覆蓋 IG/FB 公開貼文、抖音、新聞、部落格——不必逐站加 host 或實測**。`extractOgImage_` 多來源擇一：og:image(:secure_url/:url)、twitter:image(:src)、`<link rel=image_src>`、JSON-LD `image`/`thumbnailUrl`；HTML 掃前 200KB。（沿革：曾試 oEmbed-UA、不截斷直連、weserv 代理皆失敗——TikTok/IG 的圖 CDN 只服務白名單 crawler UA，唯「GAS 自己下載再轉存」過得了，見 §八。）
> - **B 層 · 整頁連 og 都抓不到（站方擋機房 IP/非瀏覽器，或 og 靠 JS 才生）→ 通用後備 microlink**。自家抓取四個失敗出口（fetch 例外／4xx／登入牆／無 og）統一 `metadataApiFallback_`→`fetchPreviewViaMetadataApi_`（microlink：雲端 headless 瀏覽器、會跑 JS、繞過多數 server 封鎖）。免費端點 `api.microlink.io` 以 IP 計額度（GAS 共用 IP 可能不穩）；設 Script Property `MICROLINK_API_KEY` 改走 `pro.microlink.io`（每 key 自有額度，較穩）。**垃圾頁偵測** `isJunkPreviewText_`（自家＋microlink 共用）：登入牆 ＋ Cloudflare 挑戰頁（`attention required`/`just a moment`/`cloudflare`…）一律丟掉→乾淨退「外部連結」，不顯示假預覽也不污染向量。
> - **逐站現況**：YouTube ✅ oEmbed；抖音/IG/FB 公開貼文/一般新聞部落格 ✅（A 層 re-host，已實機驗收 IG/抖音）；**MSN** ✅ 文字、但**縮圖放棄**（og:image 不在 HTML＝靠 JS 生圖、文章 id≠圖片 id 無法組；使用者決策不為它打 microlink）；**Dcard** ❌ Cloudflare 擋（自家與 microlink 免費端點皆過不了）→ 乾淨退「外部連結」，內文要付費 microlink/Dcard API（未做）；**FB share/p 登入牆** ❌ 伺服器端無解，使用者可手動貼展開後 `/posts/…` 網址。
> - **診斷**：`/urldiag <任意連結>`（亦 `/ttdiag`，開發暫用）在 LINE 內逐步回報 解轉址→抓頁 code＋HTML 字數＋是否含 og:image→縮圖網址→下載圖 code/CT/bytes→Drive 縮圖，**不用進 editor** 就能定位卡在哪層。
>
> **各訊息形式縮圖（hero）**：`buildSearchBubble_`（/recall、看原始紀錄、脈絡原始記錄共用）頂部放代表縮圖——image/video/**file（PDF/Office，Drive `thumbnail?id=` 產頁面縮圖）** 用 Drive 端點、sticker 用貼圖圖、外部連結用 `urlPreview.thumbnail`。純文字無縮圖。
| **敘事片段** | 純時間切（30 分 gap）的時段視圖，給人瀏覽「何時做了什麼」。每次即算 | 時間軸 | ❌ | `groupByEpisode_` |
| **主題群組** | 背景 k-means 出的一個 cluster，**還沒過三條件**（`status:'candidate'`）。「主題群組」是它沒升格時的 UI 暱稱 | 語義軸 | ✅ `contexts.jsonl` | `upgradeContexts_` |
| **脈絡（context）** | **同一個 cluster** 過了三條件（`status:'context'`）。＝記寫脈絡成形 | 語義軸 | ✅ 同檔，status 變 | `evaluateContextCriteria_` |
| **學習歷程（journey）** | **同一個 cluster** 又被偵測到 ≥1 種轉折（`status:'journey'`）。無轉折＝`watch`（持續關注、不升格） | 語義軸 | ✅ `journeys.jsonl`（`contextId` 1:1 指回脈絡） | `detectContextMarkers_` |

### 0.3 兩軸正交（多對多）— 這就是時間/語義對不齊的本質

record 是兩軸共用的原子，所以：

- **一個敘事片段（時段）裡可以混多條脈絡** ← 同一坐下寫了不同主題（例：21:25 五筆橫跨數個語義群）。
- **一條脈絡橫跨多個敘事片段** ← 反覆回到同一主題，散在很多天的不同時段。

因此 `/themes` 密集區段（時間）與 `/journey` 歷程（語義）**對不齊是正常的**，它們量的是不同軸；不該期待一一對應。

### 0.4 兩組升格判準（就是那兩個箭頭）

**① 主題群組 → ② 脈絡**（`candidate → context`，需**同時**過三條件，閾值在 `Config.gs CONTEXT_CRITERIA`）：

| 條件 | 現行門檻 | 量法 |
|---|---|---|
| 語義密度 | 群內平均 cosine ≥ `semanticDensityMin`（0.60） | `avgPairwiseCosine_`（>2000 對抽樣，seeded 決定性） |
| 意向回返 | ≥ `returnVisitsMin`（3）次，且首末跨 ≥ `returnSpanHoursMin`（1h） | 群內 record 依時間切，間隔 ≥ `returnGapMinutes`（20 分）算新一次回返 |
| 跨媒介 | ≥ `mediaKindsMin`（2）種 | {text,audio,image,video,file}（排貼圖/位置）；非文字媒介靠語義鄰近 `attachNearbyMedia_` 歸戶 |

> 群間距（`clusterSeparation`）只在卡上**顯示參考**，已**不**當升格關卡（短中文 embedding 絕對距離不可靠）。
> 邊緣淘汰已**停用**（block 5 新模型下，分群權威是 LLM 議題標籤而非向量距離；舊 `recordFitMin=0.55` 邏輯保留迴圈骨架但永不淘汰，見 ContextUpgrade.gs:226 註解）。

### 0.4.1 主題群＝同 (大類, 議題標籤) 〔block 5 新模型，取代 k-means〕

升格判準（§0.4 三條件）的「群」指什麼？block 5 之後不再是 k-means cluster，改為：

- **大類**：8 固定值 `JOURNEY_KEYWORD_CATEGORIES = ['教學','研究','閱讀','反思','札記','生活','規劃','隨想']`。LLM 以**敘事片段（30 分 gap）為單位**判 `record.category`（`Category.gs:classifyEpisodeCategories_`），**判一次永不重判**（穩定的地基）。
- **議題標籤**：在大類桶內，LLM 判 ≤8 字名詞片語（如「形成性評量」「家庭時光」）寫進 `record.topicLabel`（`Topic.gs:classifyEpisodeTopics_`），判一次永不重判。同桶現有標籤當菜單，**能歸現有就原字沿用**以收斂、不發散。
- **群** = 同 `(category, topicLabel)` 的 record 集合。`upgradeContexts_` 純 CPU group-by，決定性、巨無霸免疫（桶內議題切分，不會把教學＋生活湊一條）。
- **未議題化暫不成群**：背景還沒判到議題的 record 不進任何群（避免整個大類塌成 `__cat__大類` catch-all blob，實測曾造成「AI工具應用 53 筆」混測試/連結/退群）。等議題判好、`lastClassifyAt` 觸發重分群再納入。**注意「未議題化」是暫態、不是永久**：即使 LLM 額度用完，2.5/2.6 也會給暫定 (大類,議題)（`*Prov`，見 §0.5 〔2026-06-09 修〕），不會讓 record 永久未議題化卡在「等待整理」。
- **向量輔助分類（C'）**：大類＋議題兩階皆吃「最近現有脈絡」的提示（`Focus.gs:nearestContextHints_`）餵給 LLM：「這則語意最接近現有主題 X (sim 0.86)，若確實延續就沿用其大類/議題、若只是表面相近則照內容」。FLOOR `CONTEXT_HINT_SIM_FLOOR=0.55`。讓「夾在無關訊息中的延續句」被認對的機率提升（治本 5/30 退群片段裡的 AI 後續被歸到「生活/群組退出」問題）。
- **手動 must-not-link pin**（"分開"，`handleContextSplit_`）：拆開的 record 之後重分群絕不再湊回（pin 值為自訂群 key、非 `m:`）。
- **手動 must-link pin**（auto-merge，4.5/4.6 內部用 `m:targetCtxId`）：被合併歷程的 records 全部釘到目標 context；下次 upgrade 把這群抽出 (cat, label) 群、單獨成 cluster、Jaccard 配回 target。**§0.5 4.5/4.6 已加同大類硬閘**（跨類不合）。
- **手動改歸**（§0.6.3 詳）：使用者「📌 改歸主題」直接覆寫 `record.category` + `topicLabel` + `topicLocked=true`，立即重分群。

舊 k-means 設計（`pickContextK_`/`mergeCloseClusters_`/邊緣淘汰）已淘汰，沿革見 §八 block 2 校準史。

### 0.4.2 重分群觸發閘（gate）〔2026-05-31 修〕

`maybeUpgradeContexts_` 的「無新資料就跳過」閘：

- 舊行為：`lastIngestTs <= lastUpgrade` → 跳過。**只看新訊息**。
- 問題：一筆先前未判、稍後背景才補上 (category, topicLabel) 的 record，會因為「沒有新訊息進來」永遠等不到重分群、折不進它該屬的主題（即使 /themes 入口的 `ignoreThrottle` 也擋不住這道閘）。
- 修法：閘改看 `max(lastIngestTs, lastClassifyAt) <= lastUpgrade`。`maybeClassifyCategories_` / `assignTopicsForScope_` 寫入後呼叫 `markClassificationAdvanced_(scope)` bump `lastClassifyAt`。背景晚補的分類也能自然折進主題、不必等下一則新訊息。

**② 脈絡 → ③ 學習歷程**（`context → journey`，偵測到 ≥1 種轉折）：

- 四種轉折任一：**概念重述／跨主題整合／行動指向／後設反思**（`detectContextMarkers_` 一通 LLM 同時取 標題＋摘要＋關鍵字＋四轉折）。
- 無轉折 → `status:'watch'`（持續關注、不升格、不計入歷程數）。
- **升格只進不退**：已是 journey 的，之後就算沒抓到轉折也保留歷程身分。

### 0.5 背景管線（time-driven sweep，每 ~5 分一輪）

```
新訊息 → embed → embeddings.jsonl
  └─[2.5] maybeClassifyCategories_   按敘事片段成批判 8 大類（吃向量提示）→ record.category
                                      判一次永不重判；bump meta.lastClassifyAt
  └─[2.6] maybeAssignTopics_         在大類桶內按片段判議題標籤（吃向量提示＋現有標籤菜單）
                                      → record.topicLabel；判一次永不重判；bump lastClassifyAt
  └─[block2] maybeUpgradeContexts_ → upgradeContexts_
        以 (大類, 議題標籤) **純 CPU group-by**（取代舊 k-means）；未議題化暫不成群；
        手動「分開」/auto-merge pin 各自成群
        → Jaccard 配對既有脈絡（保 id/journey 連結）→ 算三條件 → 寫 candidate/context
        → 末段把脈絡已 drop 的 journey re-link 到重疊最高的新群
  └─[block3] maybeDetectJourneys_ → detectJourneys_
        每條 status='context' 跑一次 LLM → 標題/摘要/關鍵字/四轉折 → journey/watch
        載入即去重、存檔再去一次重（防 multi-journey-per-context 雜訊；見 §0.4.3）
  └─[4.5] mergeOverlappingJourneys_   〔2026-06-11 關閉〕journey↔journey 自動合併已停（不碰🌳學習歷程，見 §0.6.15-D）
  └─[4.6] absorbCandidatesIntoJourneys_  〔2026-06-11 改規則〕只在非歷程脈絡(🌱進行中＋🌿候選歷程)間、少筆併多筆、target 名稱不變、絕不碰🌳學習歷程（§0.6.15-D）
  └─[5]  notifyNewUpgrades_          有新脈絡/歷程才 push（按 id 去重、省額度）
```

節流：block2 每 scope 每 `CONTEXT_UPGRADE_MIN_INTERVAL_MS`（3h）一次、且自上次升格後有新訊息**或新分類**才跑（gate 詳見 §0.4.2，純 CPU）；2.5/2.6 / block3 受每日上限 `JOURNEY_DETECT_DAILY_MAX`（測試期暫調 1000，穩定後回 50~100）。使用者主動指令（`/journey`、`/themes`）入口會 `ignoreThrottle` 即時對齊。

**〔2026-06-09 修·驗收〕額度只封背景、且分類有 CPU 兜底**（修「等待整理一直無法完成」）：那份每日額度本意是封**背景** LLM 成本，但 (a) 它也被**前景補充評鑑**（`computeS1LLMScores_` 每打一輪都 bump、補充升格 `detectContextMarkers_`）吸；(b) 基礎分類（2.5/2.6）的純 CPU 後備（`fillEpisodeCategoryFallback_`/`fillEpisodeTopicFallback_`，本可保證每筆都拿到標籤）卻被關在同一道額度閘後面。猛測補充→額度歸零→`maybeClassifyCategories_`/`assignTopicsForScope_` 第一行 return、連 CPU 後備都跑不到→新記錄永遠卡「尚未歸類／等待整理」，要等午夜重置、反覆發生。修法**(2+1)**：① 前景補充不再 `bumpJourneyDetect_`（前景由打字節奏＋Gemini RPD 自然封頂）；② 額度用完時分類改跑**純 CPU 後備給「暫定標籤」**（`categoryProv`/`topicProv`，`bulkSet*` 新增 `provisional` 參數），絕不卡等待整理；額度回來後 `needs()`（`!label || prov`）把暫定的一併**重判升正式並清旗標**（暫定不進議題菜單、手動改歸也清旗標）。一輪 sweep 內 2.5→2.6 級聯，新記錄即使額度=0 也當輪拿到暫定大類＋議題、折進脈絡。

### 0.5.1 一脈絡一歷程不變性〔2026-05-31 修〕

`歷程.contextId` 應 1:1 指向脈絡（§0.1 圖示），但歷史 merge/absorb 殘留可能讓單一 contextId 有多條 journey。不同 caller 取「第一筆 (.find)」vs「最後一筆 (forEach 覆寫)」會得到不同結果——實測 L0 列名「行政院AI班研習與反思」、L2 詳情卡卻顯示「AI模型應用與研習營反思」就是這樣來的。

- 統一 helper：`ContextStore.gs:pickJourneyForContext_(journeys, cid)` 優先序 `status='journey' > markers 多 > updatedAt 新 > createdAt 早`（穩定 id）。
- 全系統取代 `.find(j=>j.contextId===cid)` / `forEach(j=>map[j.contextId]=j)`：Focus.gs / Handlers.gs / Journey.gs / JourneyDetect.gs 全改用 `pickJourneyForContext_` / `journeysByContext_`。
- 寫入端去重：`detectJourneys_` 載入時 + 存檔前各去一次重；`mergeOverlappingJourneys_` / `absorbCandidatesIntoJourneys_` 存 `survivingJourneys` 前去重。歷史雜訊隨下一次相關函式執行自動清乾淨。

### 0.6 各指令讀哪條軸

| 指令 / UI | 讀什麼 | 軸 | 備註 |
|---|---|---|---|
| 敘事片段（`replyEpisodes_`） | 即時 `groupByEpisode_` | 時間 | 列當天**所有**時段（含 1 筆） |
| `/themes` L0 大類輪播（`replyThemeCategories_`） | 讀 `contexts.jsonl` 按大類聚合 | 語義 | 詳見 §0.6.2 |
| `/themes` L1 主題清單（`replyThemeCategory_`） | 同上、單大類筆數降序 | 語義 | 詳見 §0.6.2 |
| `/themes` L2 主題詳情（`replyThemeTopic_`） | 單脈絡詳情 | 語義 | 詳見 §0.6.2 |
| 📌 改歸主題（`rec_pick_topic` / `ep_pick_topic`） | 寫 `record.category` + `topicLabel` | 語義 | 詳見 §0.6.3 |
| `/journey`（`Journey.gs`） | 讀 `journeys.jsonl` | 語義 | 只列持久化歷程＋候選；舊手動編織已移除 |
| `/portfolio`（舊 `/story` 留別名）（`replyStory_`＋`ContextStory.gs`） | 已定案優先的學習歷程 | 語義 | 學習歷程總冊：文字精華 PDF ＋網頁完整版（`Report.gs:serveCompendium_`）。詳 §0.6.15-A |
| `/explore`（`Exploration.gs`） | 讀寫 `explorations.jsonl` + `record.explorationId` | **儀式** | 使用者宣告的敘事段，詳見 §0.6.6 |
| `/ask`（`Handlers.gs:runAndReplyAsk_`） | top-K records + score-gated 三檔 prompt | 語義 | 詳見 §0.6.8 |
| inline suggestion（純文字 ack 階段） | 比 record 與進行中脈絡 cosine | 語義 | 詳見 §0.6.7 |

> ⚠️ 歷史坑：`/themes` 曾自己跑一套 transient k-means，與背景 k-means 雙軌 → 27 vs 14 對不齊。現已整併：`/themes` 只讀 `contexts.jsonl`。**block 5 後再進一步**：分群本身也淘汰 k-means、改 (大類, 議題標籤) group-by（§0.4.1），全系統只有一套決定性分群。

### 0.6.1 敘事片段三層導航（時間軸 UI）〔2026-05-30 驗收〕

純時間軸視圖、三層下鑽、全部即時計算（不持久化）：

| 層 | 函式 | 內容 | 主題標籤 | 互動 |
|---|---|---|---|---|
| **L0 月索引** | `replyEpisodeIndex_` | 今日 row + 各月 row：每列「N 天・M 段＋媒介組成＋筆數」 | **無**（純訊息流類型/數量，刻意不放主題） | 點月 → L1 |
| **L1 月內日視圖** | `replyEpisodeMonthDays_` | **一天一張卡的輪播＋頁控**（`buildDayCard_`）。每卡：日期＋段數、**整天彙總標題**（不前綴大類）、媒介組成＋筆數、「📂 看當日各段」 | **有**（整天彙總） | 翻頁／點日卡 → L2 |
| **L2 日內段視圖** | `replyEpisodes_` | 每段一張卡的輪播（`buildEpisodeBubble_`）：時間範圍、**片段重點**（純標題、不前綴大類，避免與卡上「📂 目前歸類」逐筆大類混淆）、摘要、代表縮圖、「看原始紀錄」 | **有**（每段） | 看原始紀錄 → raw |

- **日卡彙總標籤**（L1）：整天 record 跑**一通 LLM**（`dayNarrativeGenerate_`，沿用 `synthNarrativeFromBlock_` 的「大類：／標題：／脈絡：」與 `JOURNEY_KEYWORD_CATEGORIES` 八大類），按 **`日 + 當日 records hash`**（`dayHash_`）快取 6h；翻頁只為當頁日卡算（`EPISODE_NARRATIVE_BUDGET` 封頂），未生成的先顯示「主題標籤整理中」骨架。
- **段卡標籤＋縮圖**（L2）：`episodeNarrativeGenerate_`（≥2 筆才生，按 episode hash 快取 6h）；段卡頂部 hero 縮圖（`episodeHeroFragment_`）優先序 image→video→file(PDF/Office)→`urlPreview.thumbnail`（連結），純文字段無縮圖。
- **原始記錄卡標頭**：用**該筆記錄時間**（`MM/dd HH:mm`）取代無資訊的 `No.N`；footer 仍有到秒完整時間。
- **分頁**：L1 用 `searchPageSize_`(4/6/10)＋`buildPaginationBubble_`，postback `action=episodes_month&m=&p=`。
- **切段**：同一天內、相鄰 record 間隔 > `SESSION_GAP_MINUTES`(30 分) 斷段（`groupByEpisode_`）；跨午夜由日界硬切（現況）。

### 0.6.2 /themes 三層導航（語義軸 UI）〔2026-05-31 驗收〕

純語義軸視圖、三層下鑽，全部讀持久脈絡（不自己跑分群）：

| 層 | 函式 | 內容 | 互動 |
|---|---|---|---|
| **L0 大類輪播** | `replyThemeCategories_` / `buildThemeCategoryCard_` | **一卡一大類**（8 大類+其他）：icon＋大類名、N 主題·M 筆、🌳🌿🌱 狀態組成、卡內**前 5 名主題列**（≥2 筆才入；全是單筆時退而顯示前 5 筆）；footer「全部 N 主題」/「🌱 N 單筆」 | 點主題列 → L2；點全部 → L1；點單筆 → singles list |
| **L1 主題清單** | `replyThemeCategory_` | 某大類底下所有主題逐列，按筆數降序、同筆數升格高者先；**單筆段以「— 單筆主題 —」分隔**；分頁 12 列/頁 | 點主題 → L2；返回大類 → L0 |
| **L2 主題詳情** | `replyThemeTopic_`（複用 `buildContextCard_` whole 模式） | 單脈絡詳情卡：狀態 🌱/🌿/🌳＋三條件 ✅/⬜＋還缺什麼＋代表片段＋**記寫時間分布 strip**（X 軸＝主題全生命期）＋按鈕（全部敘事片段／改名／補一筆／補轉折／歷程現況） | 全部敘事片段 → 加分頁的敘事片段輪播；改名/補轉折等照舊 |

- **單筆主題視圖**（`replyThemeCategorySingles_`）：L0 卡「🌱 N 單筆」按鈕進入，列該大類所有 1 筆主題，按時間新→舊；點任一條看那一筆。
- **全部敘事片段**（`replyContextEpisodes_`）：L2 詳情卡按鈕進入。
  - 麵包屑＝「**大類 > 主題名**」（用 `themeNormCategory_(context.category)` 與 `context.userTitle||journey.title||context.label`，與 L2 詳情卡同口徑，避免 L0 ↔ L2 ↔ 麵包屑名字不一致——後者源頭見 §0.5.1）。
  - 不再硬截 `EPISODE_MAX_CARDS=10`（會造成「主題卡 53 筆」對不上輪播可見筆數，且 altText 不顯示給使用者完全隱形），**改用 `paginateFlexCards_` 分頁**：所有段都成卡、依 50KB carousel 上限動態分頁，**翻完所有頁加總 = 主題卡的 records.length**。pager bubble 帶「N 段 / Y 頁」。
  - 每張敘事片段卡底有**記寫時間分布 strip**（X 軸＝此脈絡完整生命期，✓ 本段／● 同主題他段／◯ 空 bucket；§九 規格）。
- **L2 詳情卡的大類來源**：用 `context.category`（＝L0 分桶大類）。舊版用 `journey.keywords.category` 會與 L0 分桶錯位（從教學進來、詳情卻標規劃），已修。
- **底層舊路徑**（時間範圍選單 `replyFocusMenu_` / 扁平卡 `replyFocusRun_` / k-means 一族）保留供歷史 postback 不失效，新路徑不再呼叫。
- **Freshness 與「我剛寫的去哪了」UX**〔2026-06-02 驗收〕:對應使用者「寫完後進 /themes 找不到剛寫的、懷疑漏掉」的痛。三層配合:
  - **L0/L1/L2 ✨ 徽記**: `makeContextFreshFn_(contexts)` 以「**本次坐下**」為錨——全語料最新 record ts ± 90 分窗(`CONTEXT_FRESH_SITTING_MS`),且最新一筆需在 3 小時內(`CONTEXT_FRESH_GATE_MS`)才生效(語料閒置時整片無 ✨,避免隔天打開亂閃)。比固定 24h 窗緊得多,且 drill-down / 立即整理 之間穩定。
  - **大類卡 preview 排序**: fresh-bit 優先 → 同 fresh 內按 `lastTs` 新→舊 → 非 fresh 按 count 大→小;preview 候選 = `≥2 筆 OR fresh`(fresh 單筆不該被 ≥2 過濾掉)。確保「剛動過的主題自然置頂」。
  - **大類在 carousel 排序**: 含 fresh 的大類往左,一進 /themes 第一張就是「剛動過的」大類。
  - **intro 卡狀態行依 pending 切換**: `pending > 0` → 「預計下次更新:MM/DD HH:mm」(下個 5 分背景 sweep) + 黃色按鈕「🔄 N 筆等待整理 / 點此立即分類+整入主題」(整塊 box action,送 `themes_refresh` postback);`pending = 0` → 「上次更新時間:MM/DD HH:mm」(`max(context.updatedAt)`,值在沒折到新東西時維持舊時間,**誠實**反映真正最後一次有變動,不會每次進 themes 都「剛剛」)。
  - **「立即整理」postback (`themes_refresh`)**: 一鍵跑 `maybeClassifyCategories_` + `maybeAssignTopics_` + `maybeUpgradeContexts_(true)` 後重渲染 L0。對「剛寫完想立刻看到 / 等不及背景 sweep」的情境。
  - **`pendingForThemes` 計算**: `records.filter(r => r.embedding && !isCollectionRecord_(r) && (!r.category || !r.topicLabel || !contextRecordIds.has(r.id))).length`,/me 與 /themes intro 共用同邏輯(/me 顯示「🔄 處理中 N 筆」line)。

### 0.6.3 改歸主題（手動 must-link override）〔2026-05-31 驗收〕

機器分類有限時的硬保證：使用者用「📌 改歸主題」一鍵把 record 的 (category, topicLabel) 覆寫成目標主題、設 `topicLocked=true`、立即重分群。

- **入口（可見性）**：`/recall` 結果卡與「看原始紀錄」每張卡（`buildSearchBubble_` body）顯示「📂 大類｜議題」目前歸類；後者 footer 加「**📌 改歸主題**」鈕（`opts.reclassify`，連結/收藏記錄不顯示因不進主題）。`/recall` 卡頂亦列**命中筆目前歸類前 2**「📂 目前歸類：大類｜議題、…」一眼看出有沒有被歸錯。
- **每筆改歸**：postback `rec_pick_topic` → `replyRecordTopicPicker_` 列現有主題（**依語意相近排序**：record embedding ↔ 主題 centroid cosine 降序，顯示相似度%）→ 點選 → `rec_link_topic` → `handleRecordLinkTopic_` 寫入＋ bump `lastClassifyAt`＋ `lastContextUpgradeAt=null`＋ 跑 `maybeUpgradeContexts_`＋ 回傳更新後 L2 詳情卡。
- **整段改歸**：「看原始紀錄」掛 quick-reply「**📌 整段改歸主題**」→ `ep_pick_topic` → `replyEpisodeTopicPicker_`（用整段平均向量排序）→ `ep_link_topic` → `handleEpisodeLinkTopic_` 把整段（自動排除收藏/連結）改到同一主題、立即重分群。
- **共用 helper**（`Focus.gs`）：`rankContextsBySim_` / `paginateTopicPicker_` / `buildTopicPickerBubble_` / `setRecordsCategoryTopic_`（單筆版 delegate to bulk）。
- **未做（已知邊角）**：改歸時不主動清相關 `m:` pin。若 record 被 auto-merge pin 釘住、又被使用者改歸到不同主題，下次 upgrade 仍會把它跟著 pin 群走（pin 優於 (cat, label)）。實機踩到再修。

### 0.6.4 三狀態的學習者用詞〔2026-05-31〕

對使用者顯示的 status 用詞統一：

| status（內部） | 顯示名 | icon | 學習者意涵 |
|---|---|---|---|
| `candidate` | **進行中脈絡** 〔2026-05-31 改名〕 | 🌱 | 還在累積；下一步＝補一筆寫得更聚焦、隔幾天回返、加個照片/語音 |
| `context` | **候選歷程** | 🌿 | 三條件齊備、差一個轉折就成歷程；下一步＝補一個轉折（重述／整合／行動／反思） |
| `journey` | **學習歷程** | 🌳 | 已成形；可看「歷程現況」 |

舊名「進行中脈絡」（=candidate）改稱「進行中脈絡」，因為「候選」聽起來像被動等待，「進行中」更貼近學習者「正在寫」的當下感。`status='candidate'` 欄位內部名稱不動（與程式碼相容）。

**「進行中脈絡」與「候選歷程」要不要合併？** 〔使用者問題；建議：**保留兩階**〕

兩階的差異是**可指示的不同行動**：
- 進行中脈絡（candidate）下一步＝三條件（語義密度／回返／跨媒介）；按鈕「補一筆撐到候選歷程」「明天提醒回返」根據缺哪條件動態給。
- 候選歷程（context）下一步＝寫一個轉折；按鈕「補一轉折成歷程」。

合併成單一「進行中」狀態的話：下一步建議變混合條件式（要先判三條件齊不齊才決定推哪個按鈕），認知負擔不變、只是換個包裝。學習者反而失去「我已經累積夠了、差一個轉折就成歷程」這個有具體成就感的里程碑——它是 candidate→context 升格的精神信號。

**結論**：**保留三狀態**，靠下列方式減低混淆：
1. 已完成的命名（進行中脈絡 / 候選歷程 / 學習歷程）。
2. L0/L1/L2 卡片上的「等一個轉折」「還缺：…」hint 維持具體，避免使用者要去理解三條件的細節。
3. UI 配色一致：🌱 暖橘（在累積）→ 🌿 中藍（差一個轉折）→ 🌳 綠（成形）。

如未來實機回饋仍覺兩階多餘，再考慮 L0/L1 只顯示「進行中 N + 學習歷程 N」兩格、L2 詳情卡保留三狀態 hint 的折衷。

**〔2026-06-09 落實·一張臉〕** 三狀態的 icon／顯示名／色集中在單一函式 `stateBadge_(status)`（icon 沿用 `THEME_STATUS_ICON`、色沿用 `themeStatusColor_`），全系統顯示狀態一律走它。修掉先前「同一個 `status='context'`（候選歷程）在 /journey 卡是 ⏳、新進展通知裡是『🌱 新成形脈絡』、L2 又是 🌿」的**四面孔**問題；L0/L1 也不再二分把候選歷程＋進行中脈絡壓成一個 🌿，三狀態各自顯示 🌱/🌿/🌳（與 /me、L2 同口徑）。**icon 改 🧵→🌳**：原 journey 用 🧵（縫線）與 🌱🌿 的植物隱喻斷層，改 🌳 收成連貫的「發芽→長葉→成樹」成熟階梯（綠色不變）；🧵 釋出後僅留給曖昧輕提示卡「🧵 這是同一件事嗎？」＝同一條對話串，不再撞號。

### 0.6.5 卡片導航：類檔案路徑的麵包屑〔2026-05-31 提案 · 2026-06-09 實作〕

使用者回饋：「LINE 對話拉長易迷失，特別是卡片」。要求每張卡上的資訊都有導航作用、類似檔案路徑、簡潔具體。

**現況各卡的麵包屑（不一致）：**
- /themes L0：`🗂 主題群組 · 大類總覽`（無 trail）
- /themes L1：`📚 教學 / 主題列表（按筆數排序）`（無 trail）
- /themes L2 詳情：`📚 教學・主題詳情` + title（無 trail）
- /themes L3 全部敘事片段：`教學 > 行政院AI班研習與反思`（兩段 trail，有方向感）
- /recall 結果卡：`🔍 回想「query」 > 敘事片段`（query + 層名）
- 原始紀錄：`敘事片段 > 原始記錄 > 看完整內容`（層名串）

**TODO 規格（待實作）：** 統一成 `根 > L1 > L2 [> 目前]` 的「檔案路徑」風格，最後一段為當前位置粗體。
- /themes L0：`🗂 主題群組` (root, 無 trail)
- /themes L1：`🗂 主題群組 ›` + 大類粗體
- /themes L2 詳情：`🗂 主題群組 › 教學 ›` + 主題名粗體
- /themes L3 敘事片段：`🗂 主題群組 › 教學 › AI推動實務研習 ›` + 「敘事片段」粗體
- /themes L4 原始紀錄：`… › 敘事片段 ›` + 「`11:23 文字`」粗體（最後段帶該筆 type icon）

`/recall` 自成一棵：`🔍 回想「X」 ›` + 「敘事片段」/「原始記錄」/「看依據」。

實作時抽 `breadcrumbTrail_(segments, currentLabel)` helper（與 `breadcrumbKicker_` 整合），全卡頂部共用。

**〔2026-06-09 實作〕** `breadcrumbTrail_(parts, currentLabel, tier)`（`Handlers.gs`）：以 span 組「`根 › L1 › …›` 灰字 ＋ 目前位置粗體」，`tier` 帶 header 底色對應的字色（深底＝headerSub/headerText 白；淺底傳 `{headerSub:muted, headerText:ink}`）。補在原本「沒有我在哪」的最深卡：/journey 總覽卡＋候選歷程入口卡（`／journey › …`）、歷程現況導覽卡（`／journey › 主題名 › 🧭 歷程現況`）、逐段瀏覽卡（`歷程現況 › 敘事片段 N/M`）、/themes L2 詳情卡 kicker（`📚 教學・主題詳情` → `🗂 主題群組 › 📚 教學 › 主題詳情`）。與 P2-E 的 header 深度色階（§九）互為佐證。

### 0.6.6 探索敘事段（儀式軸 / `/explore`）〔2026-06-02 驗收〕

第三條軸**「儀式軸」**——但**不是與時間/語義並列的獨立軸**,而是**敘事片段的一種模式**:

| 模式 | 觸發 | 命名 | 持久化 | 內部結構 |
|---|---|---|---|---|
| **自由敘事段** (episode) | 30 分 gap 自動切 | 無 | ❌ view-time 算 | 一段就是一段 |
| **探索敘事段** (exploration) | 使用者主動 `/explore` 宣告 | 有 (label) | ✅ `explorations.jsonl` | 可包多個自由敘事段(休息再來) |

兩者解決時間軸與語義軸都切不出的事件級辨別:同節課內跳兩主題會被語義軸拆開、中間沒休 30 分但其實是兩節課會被時間軸黏住。使用者主動宣告 → record 繼承 `record.explorationId`(成員歸屬的單一真相)。

**對其他軸的影響(刻意零侵入)**:
- **語義軸**: 完全零影響。`record.category` / `topicLabel` / 聚類 / 升格判定都不知道 `explorationId` 存在,exploration 不會把 records 鎖進獨立 sandbox、不會強行聚成一條脈絡、不會干擾跨 exploration 主題形成。**explorationId 純 metadata**。
- **時間軸**: 自由敘事段照常切,只是 record 多帶 explorationId 欄位。

**生命週期** (`Exploration.gs`):
- `/explore <名> [分]` 開始 — 沒給時長預設 `EXPLORATION_DEFAULTS.durationMinutes`(45 分);同時最多 1 段
- record 入站時 `activeExploration_(scope)` 寫 `record.explorationId`(text/sticker/location/media 各路徑;media 在 pending 入站當下記下,避免處理時 exploration 已關而歸錯)
- `/explore end` 手動結束 / 到時惰性自動關閉(`activeExploration_` 在過期時就地呼 `closeExploration_`)
- **空白探索自動刪除**: 按錯沒寫任何東西 → 從 jsonl 整列刪掉、不發 push、不留延遲告知,避免雜訊堆積
- 到期前單次提醒(`EXPLORATION_EXPIRY_WARN`,5 分前 push 1 次,`lesson.warnedAt` 去重)
- 自動關閉 push 可能漏看 → meta `pendingExplorationClosedNotice` 標記,下次傳訊息 ack 前置「📕 上一節 X 於 14:25 自動結束」(強制觸發 ack 一次)

**進行中體感**:
- 文字 ack 前綴「📚 X 進行中」(只在原本就會回 ack 那則,不破壞 idle 節流)
- bot 每次 reply 末尾 quick reply 補位「離開 X」按鈕(送 `/lesson end`,僅在會 reply 時掛,不打破節流)
- 開始/結束兩張 flex 卡: 開始(depth.l1 鐘響感)+結束(depth.l2 收束感) 視覺對比

**改名與調時長**:`/explore rename <新名>`、`/explore +15`/`-10`(也吃 `延長 N` `縮短 N`);縮短到 ≤ 已過時間 → 立即結束;改時長後 `warnedAt` 重置(可在新到期前再 warn 一次)。

**檢索**:
- `/explore list [關鍵字]`: 過去探索清單,分頁(`EXPLORATION_LIST_PER_PAGE = 8`)+ label 模糊比對(substring,大小寫不敏感)。預設按 startTs 降序
- `/explore`(沒進行中時): 直接列 list,有進行中則顯示狀態
- `/recall lesson:X`: query 解析 `lesson:` token → 過濾 `record.explorationId === lid`;沒給 query 時直接 open lesson view
- `replyExplorationView_`: 結束卡上「📂 看本節課所有記寫」CTA → 用既有 `groupByEpisode_` 切該 lesson 內 records 成 episode carousel、第 0 張為總覽卡(overview)
- `replyExplorationRaw_`: lesson view 內「看原始紀錄」走 lesson-scoped path(避免被同 30 分內 lesson 外記錄拉走 startTs 邊界)

**儀式來源標示**(三層、互不蓋台):
- raw record 卡 body: `📚 來自:<exploration label>`(該筆 record 寫的時候是哪節 exploration)
- episode 卡 body: `📚 屬於:X` 或 `📚 屬於:X、Y`(1-2 個)/`📚 跨 N 探索`(3+,無 50% 閾值)
- L2 脈絡詳情卡 body: `📚 主要發生於:X`(該脈絡 ≥ 50% 成員屬同一 exploration)
- /episodes 索引層級(L0 索引卡 / 今日卡 / 月份卡 / 月內各日卡): `📚 N 探索`(distinct count > 0 才顯示)

**/me 整合**(刻意不另開「儀式軸」section):
- 「敘事片段」行末加`(含探索 N 段·M 分)`(因為 exploration 是敘事段的一種模式,概念上同層)
- 進行中時獨立一行「探索進行中 📚 X 剩 N 分」(強提示「你還在這段裡」)

**內部資料遷移**(舊命名 lesson 全棧 rename → exploration):
- `migrateLessonToExploration_(scope)` idempotent + per-execution cache + LockService
- 第一次 `activeExploration_` 被呼叫時自動跑: records.lessonId → explorationId、lessons.jsonl 內容搬到 explorations.jsonl(舊檔丟 trash)、4 個 meta key 改名、設 `meta.lessonsMigratedToExplorations = true`
- postback 與 dispatch 都保留 `/lesson`、`/課`、`lesson_view`/`lesson_raw`/`lesson_list` 為 alias,聊天紀錄裡的舊卡片仍可點

### 0.6.7 inline suggestion(當下協作)〔2026-06-02 驗收〕

純文字 record 寫入時、ack 階段順帶提示「**↳ 像在延續『X』?**」+ `[併進去]` `[改選別條]` quick reply。**預設沉默、不點＝背景照常 100% 一致**。

**核心發現**(實作幾乎零新碼):
- 「**改選別條**」= 直接重用 `replyRecordTopicPicker_`(Focus.gs,依語意相近排序的脈絡選單),其列已發 `action=rec_pick_topic` postback
- 「**併進去**」= 發跟選單列同一個 postback `action=rec_link_topic&rid=&cid=`,落 `handleRecordLinkTopic_`(覆寫 record (大類, 議題標籤) + 立即重分群)。兩按鈕天然行為一致,不需要新 handler。
- 不需動 pin: 現聚類是 group-by (category, topicLabel),邊緣淘汰已停用(`fitMin=-2`),覆寫標籤就足以「釘死」

**判定條件**(`maybeSuggestMerge_` @ Exploration.gs):
- `SUGGEST_MERGE_MODE !== 'off'`、`record.type === 'text'`、非裸連結、非引述補充、有 embedding
- top1 cosine ≥ `SUGGEST_MERGE_THRESHOLDS[mode]`: `soft = 0.85`(預設)/ `on = 0.72`/ `off`
- 排除已凍結 journey 的脈絡
- 去重: per 脈絡 per 敘事片段。`CacheService` key `sug_${scope.key}`,TTL = `EPISODE_GAP_MS/1000`(30 分)。**cache 自然過期＝換了敘事片段**(複用 `captureWasIdle_` 同款 idle-as-timer)。換主題(cid 變)照樣提示

**lesson-aware**(在 exploration 中):
- 優先比 exploration 內 mini 聚類(`recomputeExplorationMiniClusters_` 背景 sweep 內跑、k=clamp(round(n/4),1,4) 較細、centroid 持久化進 exploration row)
- mini 群最後仍解析成真實 context id(透過 mini 群多數 record → context 反查),避免「併進一個還不存在的脈絡」
- ack 文案: mini 分支「像在延續**今天前面講的**『X』?」,全域分支「像在延續『X』?」

**Ack 改造**(打破節流的唯一情境):
- 有 sug → 無論 wasIdle 都回(suggestion 即 ack)
- 無 sug → 維持原 `captureWasIdle_` 30 分節流
- lesson 進行中三按鈕共存: `[併進去] [改選別條] [離開 X]`(後者由 `suggestMergeQuickReply_` 末位塞 leave item)

### 0.6.8 /ask 三檔信心(score-gated)〔2026-06-02 驗收〕

從 one-shot RAG(`top-K → 一次 LLM → 解析「引用:1,3」`)升級為 **cosine 分數驅動三檔 prompt**。解兩個痛點: (a)「LLM 自由發揮信心、自信地編造」,(b)「線索給了不知道下一步」。

**校準閾值**(基於 OWNER 真實 96 脈絡的 `criteria.semanticDensity` 實測):

| 群組 | n | mean | median | min | max |
|---|---|---|---|---|---|
| 已升格脈絡 (status='context') | 16 | **0.672** | **0.665** | 0.586 | 0.760 |
| 群間距 (clusterSeparation) | 96 | 0.187 | 0.186 | 0.056 | 0.323 |

`Config.gs`:
- `ASK_SCORE_HIGH = 0.65`(≥ 升格脈絡 median 凝聚度)
- `ASK_SCORE_LOW = 0.50`(對齊 `mediaAttachCosMin = 0.55` 下限)
- `ASK_USE_SCORE_GATE = true`(緊急退場 flag)

**三檔流程**:

| 檔 | top1 score | UI breadcrumb | LLM 任務 |
|---|---|---|---|
| **HIGH** | ≥ 0.65 | 🎯 信心高·0.XX | 直接答 + 引用(既有 prompt + 「top1=X.X 可直接答」hint) |
| **HEDGED** | 0.50–0.65 | 🤔 信心中·0.XX·含推測 | 審慎答 + 強制「**推測:**」前綴標出推論部分;紀錄裡看到的可不加前綴 |
| **LOW** | < 0.50 | 💡 找不到/還沒成形 | **不答結論**;呼 `replyAskCluesAnnotated_` 走線索註解路徑 |

**LLM-decline fallback**(關鍵設計):即使 score 在 HIGH 檔,只要 LLM 自評「不足以回答」(query phrasing 太具體、records 提主題沒列細節),**仍走 LOW 同款 `replyAskCluesAnnotated_`**,不再死在舊 gap card——避免「top1=0.88 卻給孤兒線索」死路。Header 文案依 score 切兩種:
- top1 ≥ LOW: 💡 找到相關線索,但答案還沒成形(誠實標 high relevance + LLM 無法綜合)
- top1 < LOW: 💡 找不到直接答案(語料根本沒寫過)

**`replyAskCluesAnnotated_` 結構**(LLM 註解 + 兩列下一步):
- LLM 接收線索區塊,每行加 `score=0.XX` 前綴讓 LLM 看到差異
- prompt 規則: 「優先以高分線索為基礎、高分 relation 要更聚焦、低分標『相關度有限』」
- 輸出 JSON `{ annotations: [{id, relation}], next_questions: [...≤2], next_recalls: [...≤3] }`
- UI overview 卡兩列、不同視覺權重:
  - 💬 **換句話再問一次(/ask)**: 完整問句、垂直堆 question-bar、強視覺(THEME.cta);點 chip → 送 `/ask <完整問句>` 重新跑 score-gated。**LLM 必須產出「換句話的完整問句」,不能重複使用者原問法**(那樣只是原地踏步),要把「語料沒寫到的詞」替換成「語料實際出現的詞」(例: 原問「西班牙訪學」→ 「瑞典訪學的經驗如何?」因 records 都是瑞典)
  - 🔍 **搜原始記錄(/recall)**: 名詞短詞、水平 chip 排、弱視覺(THEME.depth.l1.accent);點 chip → 送 `/recall <關鍵字>` 列原始記錄。優先從高分線索的 topicLabel/大類抽取(那是 records 自己的標籤,搜得到對的東西)
- 每張 clue 卡 body 多一行 `✦ <一句註解>`(THEME.stage.gap 配色)
- 退場: LLM 失敗 → 降級為舊 `replyAskGap_`(純 clue 卡無註解、不卡住)

**Anti-scope**:`enterAskMode_`/`handleAskTurn_` 多輪 refine 模式不動(那是「人問人答」UX 層,跟 LLM 答題分檔正交)。

### 0.6.9 轉折成形卡 + 轉折評鑒(候選歷程 → 學習歷程的品質把關)〔2026-06-02 收尾〕

「補一個轉折」(候選歷程 watch → journey)從「四種轉折通通攤給使用者選、有補就升格」升級為**有鑑別度的評鑒工具 + 引導式鷹架**。對應使用者要求:**補充內容要具鑑別度、能支持學習歷程成立**;且把關不可靠「有寫就過」。

**入口流程**(`handleContextSupplementEntry_`,carousel 兩卡):
- **轉折成形主卡**(`buildTransitionSuppIntroBubble_`):四項轉折的「目前分數」% 進度條(`startScores`=對脈絡現有內容跑評鑒,候選歷程通常四項偏低)+ ✨ 標**建議起點** + 「✨ 為什麼建議補 X」原因。**關鍵釐清**:四項 % 是「你現有內容的分數」(都低=還沒補),✨ 建議是「依脈絡累積樣態」(另一維度,**不是看那四個分數**)——卡上明說,解掉「四項同分卻建議某項」的困惑。
- **脈絡現況卡**(`buildTransitionStatusBubble_`):三條件 ✅/⬜ + 代表片段 + time-strip。

**CPU × LLM 融合**(建議起點與診斷):
- **CPU markerGap**(`computeMarkerGap_` @ JourneyDetect.gs,純 CPU,Phase 2):依脈絡特徵(概念重複跨片段、群心鄰近度、未閉合探問、span×回返×低反思詞)為四種轉折各算「最該補的程度」,top1=`markerGap.type`,存進 journey watch 列。
- **LLM 診斷**(`diagnoseContextTransitions_`,一次 call):看代表片段,出四項「目前缺什麼」具體診斷 + LLM 建議起點 + 引導題目。
- **融合**:`finalSuggest = llmSuggest || cpuSuggest`(LLM 看內容更貼實況為主);CPU/LLM 一致→「⭐ 強烈建議」、分歧→以 LLM 為主+CPU 那項標「特徵也指這」。建議原因=`diagnoses[finalSuggest]`(退回 `markerGap.evidence`)。

**評鑒 v2(multi-signal composite,`src/TransitionEval.gs`)** — 取代單一 LLM 寬鬆判斷:
- **S1 = LLM rubric**(`computeS1LLMScores_`):Gemini + 嵌入 anchor exemplars(`buildAnchorRubric_` 取自校準集 0%/30%/60%/85% 範例)的 prompt,出四項 0-1 分數。
- **S2 = 結構特徵**(`structGatedScore_`,純 CPU,**型別閘 + 強度分級**):每種轉折定義「結構必要條件」(概念重述=展開結構 OR 個人視角;跨主題整合=關係詞 OR 配對+跨域;行動指向=個人未來定錨;後設反思=後設動詞 OR 自我指涉),過閘才算+按強度給分,不過閘封頂 0.08。型別閘防誤報(論述≠行動、單主題≠整合、對事物的發現≠後設)。
- **合成(非對稱)**:`final = S1 + max(0, S2−S1)·EVAL_S2_BOOST(0.6)`。S2 只**上修**(比 S1 高時拉一部分)、**漏接不下扣**(比 S1 低時不動)。治本「未收錄句型拖低高品質補充」,對任何未來句型通用——**取代「為每個案例補 regex 句型」的無底洞**。
- **三條通用原則**(2026-06-02 抽出,取代補句型):①合成非對稱 ②型別閘取代句型窮舉 ③長度地板可被強標記豁免。

**即時評鑒 + 升格門檻**(凝聚卡,`askPushTurnAndRefine_` supplement 分支):
- 每寫一段,評鑒對象=`contextDigest + draft`(現有內容+你補的,跟主卡同一把尺→數值連續往上動)。
- 顯示四項 % + topType + **方向對照**(你寫的最高項 vs `finalSuggest`:「正中建議方向」/「你往 X 寫、原建議 Y——都可以」)。
- **門檻 `SUPPLEMENT_EVAL_THRESHOLD`(0.60)**:`canSave = topScore ≥ 0.60`(任一轉折達標即可送,不被建議項鎖死——使用者寫成別種也算)。未達標「補進脈絡」按鈕鎖住 🔒 + server 端 `handleSuppSave_` 再驗一次防呆。
- **天花板鷹架**(Phase 3-B):寫 ≥3 輪、topScore 連續卡 0.40~0.60、無進展(<0.05)→ `generateScaffoldHint_` 給「可套用、帶 ___ 留白的句型骨架」(只給結構不替想內容)。形成性評量精神:過程中給鷹架、不只判分。

**升格(`finishTransitionSupplement_`)— 一致性**:
- **移除 cos 歸屬閘**(舊 `SUPPLEMENT_RELATEDNESS_MIN`):使用者從該脈絡的「補一個轉折」進來,歸屬已由行動決定;cos 硬擋違背「向量只參考、不當淘汰閘」(§0.4),且與背景 label group-by 打架(前景擋下、背景撿回去升格→「說沒過卻偷偷升格」矛盾)。歸屬交給 label、品質交給評鑒閘。
- **升格 markers = 凝聚卡評鑒達標的項**(不再用 `detectContextMarkers_` 另判),`evidence`=補充原文、`confidence`=評鑒分數——升格理由與你補充時看到的評鑒**一致**。`detectContextMarkers_` 仍跑但只生 title/summary/keywords。
- **去重**:當場升格的 journey id 記進 `meta.notifiedJourneyIds`,背景 `notifyNewUpgrades_` 不重複推「🌱 新進展」。
- 慶祝卡(`buildPromotedJourneyBubble_`):轉折 icon + 可點「📖 看完整歷程」+「剛剛做了什麼/接下來」說明。

**研究級驗證(`src/Calibration.gs`)** — design-once 後客觀量化,不靠迭代試:
- 校準集 `TRANSITION_CALIBRATION`:每類 ~20 anchor exemplars(0.05~0.92 分數段,作者依操作化指標給 ground truth)。三用:LLM rubric anchors + 驗證 ground truth + 使用者手冊範例。
- editor 三層報告(寫 `_reports/*.json`,Drive MCP 可讀,免 copy console):`runEvalCalibration`(MAE/Pearson r/±10%命中)、`runEvalReliability`(test-retest SD)、`runEvalValidity`(用 journeys markers.evidence 當 gold 算 sensitivity)。
- **校準結果**(OWNER mock):三輪迭代後四類 MAE 0.06~0.08、r>0.93、門檻 0.60 鑑別度乾淨(空話擋在 0.6 下、好補充過得了)。已知 limitation:S1/S2 共同盲點案例(精煉自話被 LLM 判低)合成救不滿,要靠加 anchor。

**閾值**:`SUPPLEMENT_EVAL_THRESHOLD=0.60`(`Config.gs`)、`EVAL_S2_BOOST=0.6`(`TransitionEval.gs`);`SUPPLEMENT_RELATEDNESS_MIN=0.45`(`Config.gs`,DEPRECATED、已無人引用);`EVAL_COMPOSE_MAXBIAS`(舊 max-bias 合成參數,已被非對稱合成取代、程式碼已移除、非僅 deprecated)。

### 0.6.10 一輪定案：點線面視覺化 + 補充/提醒分流 + 落差收進主題 + icon/用字〔2026-06-07 驗收〕

本輪密集實機回饋驅動，全程貫穿三原則：**機器提案、人拍板／時間可信、語意不可信／無痕靜默**。權威規格如下（衝突一律以本節為準）。

**(A) 片段「點線面」角色標（歷程現況網頁・時間軸）**
每個敘事片段標頭標一個角色（純時間判定）：`● 歷程起點`＝第一段（線還沒成形）；`↩ 回返 · 隔Nh`＝之後每段（線在此成形、附距上段 gap）；`★ <轉折種類>`＝該片段時間範圍內偵測到轉折（橋接；直接寫轉折種類，本報告只有一條線、不用「交錯」框）。橋接歸位用 `journeyKeySet_`（與 ✕ 守門同一套 evidence→record 比對），配不上現存記錄就不標。

**(B) 片段內節奏＋聚焦（歷程現況網頁・`episodeMicroRhythmHtml_`）** 只在片段 ≥5 筆且 ≥2 分鐘才畫，兩層：
- 上＝**聚焦趨勢折線**：每筆對「本片段群心」cosine（越高越貼核心）；**重要轉折**＝局部極值且擺幅 ≥0.06、取前 2，折線上琥珀標記＋下方列數據「★ 聚焦轉折：HH:MM ↓0.42（岔開）/↑0.88（回核）」。
- 下＝**記寫時間分布**：仿卡片 `episodeTimelineStrip_`，12 格 cell、每格一點、點大小/深淺＝該格筆數（空/1/爆發），含媒介的格紫色。caption 帶整段聚焦度。
- 聚焦數據**只在網頁呈現、不推播**（`FOCUS_DETECT_ENABLED=false`；`/test` 診斷模式已退場）。

**(C) 孤兒轉折**：升格只進不退會保留舊 marker，但若該轉折 evidence 對不上本脈絡任何**現存**記錄（被移除或重新分群移走）＝孤兒。網頁「偵測到的轉折」標 `⚠ 對應記錄已不在本脈絡`、不再當成立轉折；偵測時自動剔除（保留 prev.markers 前先 `groundedMarkerTypes_` filter），下次 sweep 後資料自清。

**(D) 跨媒介改嚴格**：媒介只算**本脈絡自己成員**的類型；拿掉「語意鄰近 attach 別群媒介」（短中文 cosine 不可靠、隱形＋字面與實際不符）。`attachNearbyMedia_` 留存但無人呼叫。

**(E) 記寫延續提醒（只候選歷程）**＝一個概念、兩個觸發：
- **A 即時歸戶確認（記寫當下・無痕靜默的例外、使用者同意）**：新記錄與某候選歷程群心 cosine ≥ `CONTINUITY_RT_COS_MIN`(0.64) → 當場確認「這段是不是『X』？」；按「是」→ 歸進該脈絡＋下 must-link pin（`m:<cid>`，重分群不拆走）。高門檻＋每條冷卻＋可靜音＋`CONTINUITY_RT_ENABLED` 可關。
- **B 背景「差轉折→轉折形成卡」**（`maybePushContinuityNudge_`）：回到候選歷程、停筆 settle 後 push 轉折形成卡。每脈絡每日一次＋全域節流＋FRESH 窗。
- 候選脈絡（缺回返/媒介）不走這套；缺回返仍是使用者主動排的「之後提醒我回返」。

**(F) 補充模式分流（依目標脈絡 status、端到端一致）**
- **進行中脈絡 candidate（三缺一）→ 脈絡補充卡**：打字＝補一筆、**不評轉折**、補了即可送 → `finishCandidateSupplement_` 重判三條件。
- **候選歷程 context（缺轉折）→ 轉折形成卡**：打字跑四種轉折評鑒、達門檻才送、升格成歷程。
- 入口/逐輪顯示/送出/媒體四環節都按 status 分流（`askPushTurnAndRefine_` 以 `status==='context'` 決定是否評轉折）。
- **補充模式收所有型態、不離開**：圖/音/檔→入脈絡並當一個 turn 累積進凝聚卡；貼圖→「[貼圖]…」turn；只有按「離開補充模式」才退出（不再因媒體清掉 session）。提問（/ask）模式才限文字/貼圖構思。
- **未達標不踢出**：重建 session、留在補充模式，回**「補充結果／建議」Flex 卡**（`buildSuppResultBubble_`，tone 配色＋還缺/建議分區＋續寫/離開 footer）；所有補充結果回覆統一走此卡。
- **按鈕依缺項命名**：缺密度/媒介→「補一筆顧密度／顧媒介」；缺回返→「之後提醒我回返」。不用「補一筆撐到候選歷程」這種看不出要做什麼的結果式說法。

**(G) 落差分析全面收進「本主題內」（`computeJourneyGap_`）**
- crossTopic 重新框為「把**本主題自己的子面向**（如會員制／退貨／供應鏈）連成整體（跨子主題整合）」；只有清單裡真有語意相關的既有主題才順帶提，**嚴禁發明清單外主題**（修掉「風險管理／AI應用」這種憑空冒出）。
- missing/thoughtNotThrough/gapSummary/meaningfulSummary 一律講「本主題內現況 vs 有意義歷程的**具體欠缺**」（哪個子面向沒想透/沒連起來/沒反思到上層），不用「未連結其他學術主題」外部框。
- `linkedTopics` 後處理嚴格 ⊆ 真實主題清單；快取版本 `g5→g7`（既有歷程下次開即重算）。概念通透＝鑽深單一子面向；跨子主題＝把多個子面向連成整體（兩者不重疊）。

**(H) icon 唯一化（實體識別 icon 互不重複）＋用字**
- 敘事片段＝`📜`；記寫型態 文字＝`📝`（其餘 🔗🖼️🎤🎬📄😀📍 不變）；轉折 後設反思＝`🔭`（🪞 專屬「反思」類）；類別「其他」/未分類＝`🗄️`（🗂 專屬主題群組）；探索＝`🎒`/已結束＝`📦`；學習素材＝`🔖`；脈絡現況＝`🧶`。學習歷程🧵/候選歷程🌿/候選脈絡🌱、教學類📚 不變。
- 用字統一：**語意**（不用「語義」）。

### 0.6.11 補密度可玩性收尾 + 升格判準聚焦補償 + 多個 UX 修正〔2026-06-07 續・同分支 `claude/sleepy-thompson-TRkeg`〕

接續 §0.6.10 同日續做。權威規格如下（衝突以本節為準）。

**(A) 補密度凝聚＝忠實保留使用者補充（`synthesizeDensityDraft_`）**
凝聚是「**會被存成一筆記錄的那段**」——使用者這次補充的每個具體事實與用詞（人名/地名/物件/數字/事件）**必須原樣出現、一則不漏**（漏掉＝使用者寫的東西真的被丟）。**〔2026-06-09 再收緊·驗收〕不再餵既有記錄當「銜接背景」**：實機回報凝聚出來「太多前面記寫訊息的影子、看不出自己剛寫的原話」。根因是 (a) 函式仍把既有核心記錄餵給 LLM 當背景、LLM 還是大量揉進去；(b) 呼叫端註解仍寫舊 steering 哲學「凝聚基於既有記錄重組、使用者的話只當收斂方向」，與忠實優先矛盾、行為跟著舊註解走。改為**只忠實於原文**：**單則補充→原樣保留、完全不過 LLM**（零影子）；**多則→一通 LLM 只做「把使用者自己寫的幾段接成一段＋補最少連接詞」**，鐵則只能用使用者的字、一句不漏、不得加入背景或使用者沒寫的內容（temperature 0.2）。既有記錄仍載入但只給 `suppTurnFocus_` 算聚焦度（B/C），不進凝聚內容。
- 演進史（避免重蹈）：先前「凝聚只用既有核心記錄重組、把補充當 steering 丟掉內容」＋「產數版挑群心 cosine 最高的」，反而專挑掉使用者周邊新細節（住宿/伴手禮）→ 整段不見。已**移除該量化挑選與 turnFocus steering**，2026-06-09 再**移除既有記錄當背景素材**，改純忠實。
- 誠實取捨：補充偏離核心時，忠實保留會讓密度上升較少；密度真正槓桿仍是「補真正扣核心的新內容」或把離題成員「分開」。

**(B) 補密度 A/B/C（把「補充當下的聚焦程度」當權重）**
- A/B 量化：對補充當下那則算 `focus=cos(turn,群心)`、`novelty=1−max cos(turn,成員)`（`suppTurnFocus_`/`suppFocusAgg_`，增量算一則、省 embedding）。
- **B 即時回饋**：凝聚卡顯示「越補越扣核心 ↑／有點發散 ↓・聚焦 N%」（`buildConvergeBubble_` focusNote），純提示、不阻擋。
- **C 防灌水＝放在「密度度量本身」**（`avgPairwiseCosine_` 去近重複 `dedupeVectorIdx_`，`DENSITY_DEDUP_COS=0.92`，只在小群跑）：逐字重複/反覆灌同段被收斂成一份代表、撐不高密度。放度量＝**前景背景一致**、不會「前景說沒過、背景偷偷升格」（避免重蹈舊 cos 閘覆轍）。

**(C) 補充一律保留、不消失（修「candidate 補充下次背景掃描就不見」的資料遺失 bug）**
`attachRecordToCandidate_` 附入時即把補充 record 的 (category, topicLabel) 鎖成本脈絡成員代表標籤＋`topicLocked`（與轉折補充 `finishTransitionSupplement_` 同法）。否則背景 `upgradeContexts_` 以 (category,topicLabel) group-by 重分群時會把它抽走、`recordIds` 被 fresh cluster 覆寫 → 補的內容消失。未達標也保留（**移除原本會擋下不附入的前景 C 閘**——和「補了該留」相違）；近重複時結果卡給**非阻擋**提示「換個新角度」。

**(D) 升格「語意密度」聚焦補償（方案 A・`densityConditionMet_`）**〔回應「facet 多但同一主題的脈絡（如德國行：學術討論＋住宿＋伴手禮）pairwise 永遠到不了 0.60」〕
- 規則：`density ≥ semanticDensityMin(0.60)` **或**（`density ≥ densityFloorForFocus(0.52)` **且** `coreFrac ≥ densityFocusCoreFracMin(0.80)`）。
- `coreFrac`＝對群心 cosine ≥ `densityFocusFitMin(0.50)` 的成員**比例**（`clusterCoreFrac_`）。用「**比例**」而非「平均」是關鍵：平均 cos-to-centroid 與 pairwise 是同一量（群心向量長度）的單調變換、拿來補償＝偷偷調低門檻；唯有「比例」能分「**單核發散**（同主題多面向）」vs「**多核混雜**」——前者大多數成員仍繞單一核心 coreFrac 高、後者群心兩頭不到岸 coreFrac 低。對齊「時間/聚焦可信、語意絕對值不可信」。
- `densityConditionMet_` 是全系統「密度過了沒」的**單一真相**：升格閘（前景 `contextGapReport_`/`attachRecordToCandidate_`＋背景 `evaluateContextCriteria_`/淘汰重算）與卡片/網頁顯示**全走它**，前景背景一致。criteria 帶 `coreFrac`/`densityViaFocus`；靠聚焦達標時卡片/網頁標「未到 0.60，但成員多扣同一核心 聚焦 X%＝靠聚焦達標」。
- 備案（未採）：B＝對群內跑 k-means、有一塊子主題夠扎實（須佔過半防灌水）也算；C＝A、B 兩者 OR。本輪選 A（最穩、不引入 k-means），實機若 coreFrac 仍卡再上 B。

**(E) 回返條件可讀性**（回應「這麼久了回返怎還沒過」）
- 三條件 chip 顯示實際次數：`✅ 密度`／`⬜ 回返 2/3`／`✅ 媒介 2/2`（`criteriaStatusRow_`）。
- 「還缺」訊息分清「**次數 vs 跨度**」且顯示目前次數：「意向回返目前 2 次，再回到這主題 1 次（首末跨度已夠，只差次數）」（`criteriaHintText_`）。
- 門檻維持 `returnVisitsMin=3`（一次坐下狂寫只算 1 次、補充也撐不出回返——回返是時間可信的行為訊號，刻意不能一次刷滿）。

**(F) LINE URI action 防呆（`safeActionUri_`）** — 修「看原始紀錄」整則 Flex 被退 400 `Invalid action URI`
外部連結 action.uri 一律過 `safeActionUri_`：只放行可見 ASCII＋`http(s)/tel/mailto/line` scheme＋長度 ≤1000，砍尾端句讀（**不砍 `)`/`]` 以免誤傷維基式網址**），不合格回 null → 呼叫端略過該 action（單一壞網址不再拖垮整則訊息）。網址抽取 `\S+ → [\x21-\x7e]+`（遇中文/全形即停，網址後黏中文也能取回乾淨 ASCII）。套用所有「使用者來源網址」的 action（看原始紀錄連結鈕/hero、明細卡、地圖、hero 片段、連結選擇泡泡）；Drive/座標等程式構造的 URL 不受影響。

**(G) 主題改名（`handleContextRenameInput_`）**
- 離開鈕對應模式：rename 用 `renameModeQuickReply_`「放棄改名」（`dialogLeaveQuickReply_` 按 mode 分流；rename 不再殘留「離開/ask模式」——非 supplement 一律給 ask 標籤的舊 bug）。
- **改名同步逐筆歸類**：除 `userTitle`/`label` 外，一併 `setRecordsCategoryTopic_(成員, 同 category, 新名)`（topicLock 保持同群），逐筆卡片「📂 大類｜議題」顯示一致。分類器本就「沿用現有議題清單」（Topic.gs），未來同主題新筆會歸回新名、不分家。

**(H) 改歸主題選單排除「自己原本的主題」（`rankContextsBySim_` 加 `excludeIds`）**
依語意相近排序時，最相近往往就是記錄現屬主題（改歸到自己＝no-op、佔位、易誤點）。每筆改歸排除「含該 rid 的現屬脈絡」；整段改歸排除「成員重疊最多且過半」的現屬脈絡（精準鎖定這段的家、不誤排只含零星一兩筆的別條）。

**(I) 回返提醒 UX（`cand_remind`）**
- **已排入就標示、不重複點**：卡片改顯示「🔔 已排入提醒・約 MM/dd HH:mm 提醒你回來寫」狀態列取代按鈕（`getCandidateReminder_`）；`handleCandidateRemind_` 冪等（已升格→告知不用提醒、已排過→回原時間不重排）。
- **升格前自動取消**：`sweepDueReminders_` 每次掃描順手把「脈絡已非 candidate（升格）或不存在」的提醒**直接刪掉、不等到期**（同 scope contexts 快取、只讀一次）；前景升格（`attachRecordToCandidate_` 達標→context）即時 `clearCandidateReminder_`。

**(J) 記寫回執卡（write receipt・`maybePushWriteReceipt_` / `buildWriteReceiptBubble_`）**
背景在你**停筆 settle 後**主動回報「剛寫的這段被怎麼自動整理了」。不在寫作當下（隔一段時間才推），與「🎯 聚焦」即時推播（已關 `FOCUS_DETECT_ENABLED=false`）、升格通知、回返邀請是不同 push，共用「每段一次」去重。
- **觸發（全成立才推、保守）**：最新敘事片段 ≥ `RECEIPT_MIN_RECORDS`(6) 筆；停筆 ≥ `RECEIPT_SETTLE_MS`(10 分)；該段未回執過（`meta.lastReceiptEpisodeStart` 按片段起點去重，每段最多一次）；該段語意集中度 ≥ `RECEIPT_DENSITY_MIN`(0.60)；且 ≥ `RECEIPT_DOMINANT_FRACTION`(半數) 落在同一條**進行中脈絡(candidate)**。只認 candidate（context/journey 升格由 `notifyNewUpgrades_` 負責、不雙推）。
- **〔2026-06-07 改更安靜・只報高價值〕**：再加一關——該脈絡三條件達標數 ≥ `RECEIPT_NEAR_UPGRADE_MIN_CONDITIONS`(2)＝**差一條件成候選歷程**才推；純整理好但離成形還遠的不打擾、不標記（留待後輪有進展再說）。總開關 `RECEIPT_ENABLED`。對齊「無痕靜默、少打擾」：只在「這條快成形了、就差一步」這種高價值時機才出聲。
- **卡片內容（資訊完整）**：歸類（大類｜議題）、形成/併入哪條進行中脈絡、這段集中度＋媒介組成、**這條脈絡整體規模（總筆數＋時間跨度）**、**三條件進度（`criteriaStatusRow_`：✅密度／⬜回返 2/3／✅媒介 2/2）＋還缺什麼（`criteriaHintText_`，因只在差一條件時推、會明指差哪條）**、這段記寫時間分布 strip；footer 一顆「📂 看歸到的主題（含敘事片段）」直達 L2 詳情。

**(K) 改歸主題的後續修正**
- **選單排除「自己原本的主題」**（`rankContextsBySim_` 加 `excludeIds`）：依語意相近排序時最相近往往就是現屬主題（改歸到自己＝no-op、佔位、易誤點）。每筆改歸排除「含該 rid 的現屬脈絡」；整段改歸排除「成員重疊最多且過半」的現屬脈絡。
- **確認訊息名稱對齊卡片**（`handleRecordLinkTopic_`／`handleEpisodeLinkTopic_`）：訊息原用 `after.userTitle||after.label`、漏 `journey.title`，當 raw label（如「人脈連結」）≠ 顯示名（journey.title「德國演講與學術交流」）時，訊息報 raw label、與同時出現的卡片對不上。改成同卡片口徑 `userTitle → journey.title → label`、大類用 `themeNormCategory_(after.category)`。

**(L) 歷程顯示一律以「使用者改名」為主標、自動名退為副標**（`journeyTitleParts_(context, journey)→{main,sub}`）
使用者改名(`userTitle`)＝權威、**升格不覆蓋**（資料層本就不覆蓋，這是顯示對齊）；自動 `journey.title` 退為副標「依現況內容：…」、只在與主標不同時顯示。套用 /journey 卡、現況初步評估導覽卡、報告頁封面＋瀏覽器標題、主題詳情卡。

**(M) 「正在背景重新對齊／整理中」永遠卡住修 + 開頁即對齊**
網頁 `pending = context.updatedAt > journey.basedOnUpdatedAt`。`detectJourneys_` 對已凍結 journey 不重判（升格只進不退），但 carry-forward 沒推進 `basedOnUpdatedAt` → 改歸/補一筆後 `pending` 永遠 true、banner 不消、定案被鎖。修：(a) carry-forward 時凍結 journey 仍把 `basedOnUpdatedAt` 對齊到目前 `context.updatedAt`（凍結＝最終態、零 LLM）；(b) 抽成純 CPU `alignFrozenJourneyStamps_`，在開 `/journey`（`replyJourneyOverview_`）與報告頁（`doGet` 算 pending 前）各呼叫一次 → 開頁當下就清、不必等背景 sweep。

**(N) 敘事片段卡稀疏卡內容自適應**（`buildEpisodeBubble_`）
carousel 等高，筆數少的卡原本每筆硬截 28 字/2 行被拉高後一堆留白。改依筆數自適應：1 筆 ≤600 字/16 行（近全文）、2–3 筆 ≤160/6、4–5 筆 ≤80/3、6–8 筆 ≤36/2；改用 `aggregatedText||text`（含補充後完整內容）。

**(O) 歷程現況各片段一律示意記寫時間分布＋註明無聚焦原因**（`episodeMicroRhythmHtml_`）
原本筆數<5 或時間<2 分整段回空 → 有的片段有圖、有的全空又沒說明。改：時間分布 strip 一律畫（span=0 退化成一句說明）；聚焦趨勢仍需筆數 ≥5、時間 ≥2 分、可分析文字 ≥3，不畫時明寫原因（筆數/時間/可分析文字哪項不足）。

**(P) /me 儀表板三狀態用詞對齊**：原「形成脈絡 N（候選 N）」用詞與三狀態相反，改「🌱 進行中脈絡 N／🌿 候選歷程 N／🧵 學習歷程 N」與 /themes、/journey 同口徑；/help 卡③同步補三狀態流程＋可在卡片「補一筆／補轉折／改名／改歸／排提醒」。

**(Q) 曖昧輕問卡「這是同一件事嗎？」對稱化（`handleThreadKeep_`）**＋更名
- 原「同一件事」只清提示、不動作（靠背景預設綁串），但兩段已被分到不同脈絡時等於沒生效——與「新的一件事」會主動拆開不對稱。改成**主動合併**：把「這則所在敘事片段、從這則起的後段」全部併入「前一段」的 (大類, 議題)、`topicLock` 鎖住、立即重分群 → 後段真的歸進前段那條脈絡。前一段還沒分類時退回單純維持。
- 卡片更名「拿不準是不是同一件」→「**這是同一件事嗎？**」；「同一件,沒事」鈕改「✓ 同一件事（併進前段）」、說明改「按同一件事會把這段併進前一段；不理＝背景自行歸戶」（不再宣稱「預設先當同一件」，因忽略≠合併）。

**(R) 移出片段（✕）：移出當下即時「找新家」（一通 LLM），不靠背景重判**
原本 ✕ 移出只清 topicLabel＋記軟性 `recordExclude`，靠背景重判找新家。但記錄語意本就屬原主題，背景在
**同一大類桶**內找不到別的家（LLM／同串收斂／多數決都會繞回原議題），會出現兩種壞結果：判回原議題＝
`upgradeContexts_` 又併回原脈絡（35↔36 循環）；或硬擋回原議題後**留 unlabeled ＝永遠卡在「等待整理」**。
〔本輪幾次嘗試：pin 自成一群（太孤立、找不了新家）→ 硬性排除＋collapse 還原個別判（仍會卡在 only-原議題
的情形）都不夠，最後定案如下。〕
**定案：移出當下就用一通 LLM 直接給它新家**（`rehomeDroppedRecord_`）：**① 先用向量找「最相近的既有脈絡」**
（排除原脈絡 cid／原議題），cosine ≥ `REHOME_JOIN_COS`(0.50) 就**直接歸進那條現有主題**（含跨大類，如把研究
類的圖歸到教學既有的「AI研習營」，不會無謂造新）；**② 向量沒有夠相近的既有家才用 LLM** 判 (大類, 議題)
（硬性排除原議題、能歸現有就歸、否則造新）。`topicLock` 鎖住 → **馬上落地、不卡、回不到原脈絡**。`dropRecordFromContext_` 末段呼叫它、`bump
lastContextUpgradeAt=null`，drop handler 接著 `maybeUpgradeContexts_(true)` 讓新家當下成形。
- `recordExclude` 保留（放回 undrop 要靠它還原原議題）；記錄已 topicLock，背景不會再重判它。
- 已**回退**先前為了「背景重判找新家」加的 `classifyEpisodeTopics_` 硬砍／collapse 還原與 `fillEpisodeTopicFallback_`
  留 unlabeled（那是卡住「等待整理」的元兇）；背景分類恢復原狀，移出的新家改由 drop 當下的 LLM 負責。
- 要再換家：用「改歸主題」（同樣即時、可跨大類）。放回（undrop）還原原議題＋移回原脈絡照舊。
- `recordExclude` 只在「真的歸到非原議題」後才清（落在別家＝settled）；還沒落定就持續排除。
- `setRecordsCategoryTopic_`（改歸）清掉該筆 pin、undrop（放回）清 pin＋還原議題——改歸/放回是更明確的意圖。

**(S) 背景智慧合併·跨大類（`absorbCandidatesIntoJourneys_` 擴充）**
原本「候選→吸進既有歷程」只在**同大類**、且候選 ≥2 筆才做，所以「移出造新出的單筆重複主題」（如研究的
「AI人才研習」）併不回教學既有的「AI研習營」。擴充：
- 候選門檻 ≥2 → **≥1**（單筆造新的重複也能被併回）。
- 大類閘改成：**同大類**用一般門檻 `JOURNEY_MERGE_LLM_GATE_MIN`(0.75)；**跨大類**要 cosine ≥
  `JOURNEY_ABSORB_CROSSCAT_COS`(0.85，此空間「相關」多落 0.55–0.75，0.85 屬很高、保守預過濾)。
- **一律過 LLM「同一主題?」gate（`checkSameThreadLLM_`）＋ drift guard** 才真的合——避免誤判靠 LLM，
  cosine 只當門檻限縮 LLM 呼叫量；LLM 失敗＝不合（保守）。共用每日 LLM 上限（`bumpJourneyDetect_`）封頂。
- 被吸收 records 用 `setRecordsCategoryTopic_(…, keepPins=true)` 對齊到目標脈絡的 (大類,議題)（卡片顯示一致），
  並 pin `m:<目標>`（must-link、不被重分群拆走）。`keepPins` 新增參數：對齊標籤但保留剛下的 m: pin。
- 閾值（0.85 / 0.75）待實測校準。已存在的造新重複（如本例 AI人才研習）若 cosine 未達 0.85，仍可手動「改歸主題」。
**新增/異動參數**（`Config.gs`）：`DENSITY_DEDUP_COS=0.92`；`CONTEXT_CRITERIA.{densityFocusCompensate:true, densityFloorForFocus:0.52, densityFocusFitMin:0.50, densityFocusCoreFracMin:0.80}`；`SUPP_FOCUS_WEIGHT_ENABLED/SUPP_FOCUS_CORE_MIN(0.35)/SUPP_NOVELTY_MIN(0.12)/SUPP_FOCUS_TREND_EPS(0.04)`；`RECEIPT_ENABLED=true/RECEIPT_NEAR_UPGRADE_MIN_CONDITIONS=2`（記寫回執改只報「差一條件」高價值時機）。**全部待實測校準**。

### 0.6.12 UI 一致性整輪 + 背景智慧合併告知/取消〔2026-06-09 驗收 · 分支 `claude/sleepy-thompson-TRkeg`〕

起於使用者「邊做邊修、暈頭轉向」，先做了一輪「記寫脈絡→學習歷程」全流程 UI 一致性檢視（前後卡片的符號/路徑/命名是否一致、資訊精簡但完整、不迷失），再逐項實作。權威規格如下（衝突以本節為準）。

**(A) 背景智慧合併·主動告知＋一鍵取消**（`notifyMergedJourneys_` / `undoJourneyMerge_`）。`absorbCandidatesIntoJourneys_`（§0.6.11 S）把重複主題併回既有歷程＝機器自動動了使用者資料，原本無聲。改：absorb 真的併了就把每筆細節寫進 `meta.pendingMergeUndo`（細節）＋`pendingMergeNotices`（token），`backgroundSweep` 在 absorb 後呼叫 `notifyMergedJourneys_` 推一張卡（哪條重複主題→併進哪條歷程、移入幾筆、是否跨大類），每筆附「↩️ 取消這次合併」。取消＝還原被吸收 records 的 (大類,議題)+pin、設 `meta.mergeExclude[rid][journeyId]`（背景不再自動把這些 record 併回同一歷程，以穩定的歷程 id+record id 為鍵、撐得過重分群）、放行立即重分群（脈絡成員由 (大類,議題)+pin 決定、`upgradeContexts_` 重算，不必手動改 contexts.jsonl）。`absorbCandidatesIntoJourneys_` 內層比對前先過 `recordExcludedFromJourney_` 跳過。還原資料 14 天 TTL（`MERGE_UNDO_TTL_MS`）。

**(B) 三狀態一張臉**（P0-A）：見 §0.6.4〔2026-06-09 落實〕。`stateBadge_` 單一真相、icon 🧵→🌳、L0/L1 改三狀態不二分。

**(C) 類路徑麵包屑**（P0-B）：見 §0.6.5〔2026-06-09 實作〕。`breadcrumbTrail_` 補到最深的卡。

**(D) /journey ＝學習歷程成就牆**（P1-C）：/journey 只放 🌳 學習歷程卡（intro + 每條一張）；候選歷程不再每條各佔一張（與 /themes L2 重複、把 /journey 糊成第二個 themes），改成最後一張 `buildCandidateEntryCard_`「候選歷程入口」濃縮卡（列幾條可直接「補一個轉折」、footer 一顆鈕 `theme_home` 回 /themes 看全部三狀態）。職責切開：**/journey＝我成形了哪些歷程、/themes＝依主題瀏覽全部三狀態並補**。舊 `buildCandidateBubble_` 留作沿革、不再呼叫。

**(E) 歷程「完整視圖」統一命名「歷程現況」**（P1-D）：同一個 in-LINE `journey_story` 目的地原本有現況初步評估／完整故事／看完整歷程／看已定案歷程四種名。一律「歷程現況」（入口鈕＋目的地 header/麵包屑/altText/分頁＋/help+Router+Report 文字）。**區隔保留**：網頁完整報告鈕仍叫「📖 瀏覽歷程現況」（uri、不同目的地）；已定案唯讀狀態仍叫「已定案歷程」（狀態變體）。

**(F) header 深度色階＋背景 push 簽名**（P2-E）：見 §九「深度色階」。/themes 鑽愈深底愈暗（L0 亮藍→L1 中藍→L2 深藍）；`notifyNewUpgrades_`／`notifyMergedJourneys_` 共用「🔔 背景自動整理」小字簽名。

**(G) /themes 子層 intro 去重**（P2-F·其一）：🌱/🌿/🌳 圖例與導覽語只在 L0 教一次；L1／單筆 intro 卡移除重複圖例、兩行導覽併一行。（P2-F 第二點「補轉折入口瘦身」暫不做。）

### 0.6.13 背景推播合宜守則 + 命中/問答呈現 + pin 契約根治 + 貼圖情緒層〔2026-06-10 驗收 · 分支 `claude/sleepy-thompson-TRkeg`〕

一輪長對話累積的多項優化，權威規格如下（衝突以本節為準）。

**(A) 背景主動推播「合宜守則」**（`proactivePushAllowed_`，LineClient.gs）：所有「機器主動找你」的學習推播（曖昧/記寫回執/延續/新進展/智慧合併/回返提醒）共用一道守門——① `meta.proactivePushMuted` 全關 ② 夜間靜默 `PROACTIVE_QUIET_START_HOUR=22`–`END=8`（`inQuietHours_`）③ 全域冷卻 `PROACTIVE_PUSH_GLOBAL_COOLDOWN_MS=10min`（每 scope 一輪一張、杜絕一次噴多張）。被擋的**不 claim 去重鍵**、下輪再評估、不丟失。reorg 類（新進展/合併）再加 `userSettledForReorg_`（距 `lastIngestTs` ≥ `REORG_SETTLE_MS=10min` 才推、不打斷打字）。回返提醒排程與到期都過 `clampOutOfQuiet_`（落夜間順延到早上＋隨機 0–60 分）。總開關在 /me（學習狀態卡）一行 toggle＋新進展卡 footer 🔕。回返提醒 icon 🔁→📅（解與「概念重述轉折 🔁」撞號）。

**(B) /recall 命中呈現**：① **命中置中開窗＋高亮**（`matchSnippet_` 以命中詞為中心開窗、`snippetComponentFromMatch_` 用 Flex span 變色粗體；純語意命中退回前綴）② 命中訊號 `🔤 字詞命中`／`🧠 語意相近`＋相關度 `高/中/低`（`relevanceLabel_`，裸 cos 沒語意）③ **敘事片段卡＝焦點命中框**：挑最高分那筆給較長高亮片段、其餘依時間序收合成「┄ 前面還有 N 筆命中 ┄／┄ 後面還有 M 筆命中 ┄」（取代任意時間序前 3 筆）。

**(C) /ask 問答人格（與 /recall 各具特色）**：答案為主、證據為輔。① 答案卡＝暖紫「助理」身分（`THEME.ask.answerBg`、`💬 問答`）＋**信心橫幅**（🎯 可直接回答綠／🤔 部分為推測琥珀／🔎 多為推測——整段皆推測時誠實降版）② **推測 vs 依據分層**：`askAnswerSegments_` 把模型標的「推測：／（不確定）」行用琥珀＋🔎、紮實依據正常墨；推測標記移到**共用規則·全模式開**（不再只中信心）③ **行內引用溯源**：prompt 要模型每句嵌 `[n]`，渲染成 ①②③ 彩色 chip 對齊**依據卡**（暖紙「證物」身分 `THEME.ask.evidenceBg`、麵包屑 `💬 問答 ▸ 依據①`、序號取代裸 cosine）；依據依「行內出現序」重排 ④ **順著問**（`追問：`）：答案 footer 1–2 個可點追問 ⑤ **原始筆記優先**：檢索後把舊「探問」Q&A 記錄（text 以「🔍 探問：」開頭）排序分打折 `ASK_QA_RECORD_PENALTY=0.9`（只調選依據、不調信心閘門）⑥ 線索卡分數標籤分三檔（≥`ASK_SCORE_HIGH` 高相關／`LOW`–`HIGH` 中等相關·窄帶可能巧合／<`LOW` 沒寫過）。版面＝答案卡＋依據卡**同一條輪播**（不斷兩則）。

**(D) 脈絡補充·密度迴圈**：① 凝聚卡（`askPushTurnAndRefine_` supplement 分支）回饋行改顯示**真語意密度** `語意密度 0.46 → 0.53 / 0.60 往上↑`（補這 draft 後密度往哪走，比聚焦% 直接）② 提交結果卡（`buildSuppResultBubble_`）顯示密度 delta；intro 卡顯示「這條的核心」（`nearestToCentroid_`）引導 ③ **密度真槓桿＝分開**：混雜脈絡補很難拉高（密度＝全體 pairwise 平均），`contextOutliers_` 點名離核心最遠的幾筆＋「🔀 分開混到的（核心密度估 0.48→0.59）」一鍵分開 ④ **§B 密度排除貼圖/地點**：`avgPairwiseCosine_` 只算 `CONTEXT_MEDIA_TYPES`（文字/圖/語音/影片/檔/連結），貼圖（情緒）/地點（錨點）非語意內容、不稀釋密度（`contextGapReport_` 與 `evaluateContextCriteria_` 兩路都排）。

**(E) 轉折成形卡修正**：① **已達標項直接指向該項**——現有內容某轉折已達 `SUPPLEMENT_EVAL_THRESHOLD` 時，建議覆寫為「指向最高達標項·補一句寫明就升格」＋達標橫幅，不再像「都還沒補」推別種（修「後設反思 60%✓ 卻建議行動指向 55%」矛盾）② startScores 按「成員 id MD5 指紋」**快取 6h**（同內容回到卡片給相同分數，內容變了才重算——修「下次進來分數又不同」）。

**(F) pin × 重分群契約根治**（三 bug 同族，皆「pin 與 `upgradeContexts_` 重分群的契約沒對齊」）：① **分開只釘「分出去的」、核心不釘**（`handleContextSplit_`）——釘核心會成封閉群、害新記錄/改歸/補轉折升格句併不進來、長同名殘留；分出的已改名+鎖標籤。`auditSplitPins(clear)`（ContextUpgrade.gs editor 診斷）盤點/清理現存封閉群 pin。② **改歸接上目標 pin 鍵**（`handleRecordLinkTopic_`）：目標成員若共享 pin 鍵，把改歸的這筆 must-link 釘到同鍵，否則 label-group 併不進被釘的目標（修「改歸到歷程卻沒生效、留在原名」）。③ **智慧合併釘「整群」**（`absorbCandidatesIntoJourneys_`）：原只釘移入筆→重分群把「被釘的小群」與「沒釘的目標 label group」拆兩塊→目標被洗回原樣、移入筆自成同名候選→下一輪又併→無限重併＋每輪一張重複通知（夜間靜默累積到早上一次推＝卡內/跨卡重複）。改釘 `unionRecordIds`（目標原成員＋移入）同一把 m: 鍵；undo 記 `pinnedRecordIds` 整群還原；佇列＋顯示去重。`meta.mergeRepeatLog` 記合併指紋＝**重併哨兵**：同指紋 n≥2＝沒固定住，通知卡亮紅字＋/me「合併自檢」⚠️（免 editor 自檢）。

**(G) /me 拆兩張精編卡**（`buildDashboardBubble_` 回 carousel）：① 📊 學習狀態（記寫脈絡／🌳歷程現況含合併自檢／🔥熱度／背景提醒開關）② ⚙️ 系統與帳號（Gemini 用量/LINE 額度/成員/我的預算/Drive）。一般成員無系統區→只回 ①。

**(H) 貼圖情緒層**（貼圖＝對某筆記寫的當下階段性情緒，一張貼圖掛一筆）：① **捕捉**（`handleSticker_`）：情緒掛到「引述那句優先，否則 6h 窗內最近一句內容」（`resolveStickerEmotionTarget_`）的 `record.reactions`＋自身標 `emotionFor`；引述貼圖**不再當內容補充**（不設 quotedRecordId、不 reconcile 進 aggregatedEmbedding——情緒不汙染內容語意）② **零 LLM emoji**：`stickerEmoji_` 啟發式對映表涵蓋約 40 情緒族（喜悅/愛/驕傲/期待/放鬆/悲傷/孤獨/焦慮恐懼/壓力/憤怒/厭惡/驚訝/困惑/疲累/尷尬羞愧/決心/道歉…），入庫存 `record.stickerEmoji`；中文片語（給 /recall 搜尋）`stickerPhraseCached_` **每個 stickerId 只算一次**（持久存 ScriptProperties），之後完全零 LLM ③ **LINE 呈現**：歷程現況瀏覽卡折疊貼圖進對應句（`😄 當下心情：…`）、導覽卡＋/episodes 段落卡「心情軌跡 😢→🤔→👍（N 次）」（`journeyEmotionArc_`）、節奏條下 12 格對齊「心情落點」（`emotionCellsRow_`）、記錄清單折疊（`foldStickersForDisplay_`：貼圖不自成卡、宿主卡型別標「文字＋貼圖」＋原貼圖圖片＋心情列**以 emoji+情緒詞去重**）④ **網頁版**（Report.gs）：貼圖出原圖＋emoji、每則型別徽章、節奏圖疊心情軌跡 emoji 列 ⑤ **舊資料一次性回填**（`backfillStickerEmotions_`，掛 backgroundSweep 2.65）：背景跑一次補 emoji/emotionFor/reactions（零 LLM、落 `meta.stickerEmotionBackfillAt` 旗標後永不重跑；只處理無 emotionFor 者避免重掛）。**⚠️ 這是一次性遷移工具，正式驗收完成後連同 hook 移除**。

**(I) 分享回執**（定案歷程開放分享給多人 → 訪客唯讀＋回執 → 建立者收彙整通知，commits `d7c8dc6`→`70c0472`）：① 定案後才可「開放分享」，產 `shareToken`（與 owner 的 `reportToken` **完全分離**；訪客頁 `serveSharedJourney_` 不含任何建立者操作）；訪客唯讀瀏覽＋填名字（＋一句留言）回執（`reportAckFormHtml_` → `recordJourneyAck_`，存 `journey.acks`）。② **省 push**：每筆回執不即時推，進 `meta.pendingAckNotices` 佇列，`backgroundSweep` 的 `notifyPendingAcks_` 彙整成一張卡推一次（走 §0.6.13-A 合宜守門）；/me 學習狀態卡「📩 N 筆新回執」徽章免費 pull（`ack_inbox`→`replyAckInbox_`，看過即清）。③ 回執名單 Flex（`buildAcksBubble_`，新→舊＋最近回執相對時間，per-journey 與跨歷程匯總共用）；歷程卡標「📩 已開放分享 · N 人回執」點進看（`journey_acks`）。④ 網頁訪客頁封面標「👤 建立者：<姓名>」（`ownerDisplayName_`，快取 `meta.ownerDisplayName`／可用 Script Property `OWNER_DISPLAY_NAME` 覆寫）。⑤ `/shares` 管理員一覽（`replyShares_`）：列所有分享過的歷程＋回執數。停止分享 `share=0` 連結即失效、名單保留。



| 舊（§一 五層） | 新（§零 雙軸三段） |
|---|---|
| 層1 訊息流 | 訊息流（底料） |
| 層2 敘事片段 | 敘事片段（時間軸視圖） |
| 層3 主題群組 | 語義軸 cluster · status=`candidate`（進行中脈絡） |
| 層4 形成脈絡 | 語義軸 cluster · status=`context`（候選歷程） |
| 層5 學習歷程 | 語義軸 cluster · status=`journey` |

要點：舊層 3/4/5 不是三個物件、也不是包含關係，而是**同一個 cluster 的三段 status**。

---

### 0.6.14 目前記事(/now) + /ask 歸戶線索群 + 改歸亮✨ + 定案頁內確認 + 歷程卡摘要完整〔2026-06-10 驗收 · 分支 `claude/sleepy-thompson-TRkeg`〕

承 §0.6.13 同分支續做，一輪實機回饋（衝突以本節為準）。

**(A) `/today` → `/now`「目前記事」+ 卡片強化**（commits `760a92e`、`17ff2cc`）：① 指令 `/now` 為正式名、`/today` 保留相容別名；卡片標題「今日總結」→「目前記事（第 N 次）」、麵包屑「／now › 目前記事」；/help、/info、rich menu 同步。實作：`replySummary_` 加 `displayName` 參數，只驅動對外標題/麵包屑/PDF 標題；`label` 仍「今日」（LLM 提示、記寫時間分布 strip 標題、檔名、第 N 次計數鍵全不變）。② **產出時間（年月日時分）**：卡底 `🕒 產出時間 yyyy/MM/dd HH:mm（第 N 次）`，與視窗範圍區隔。③ **🎭 今日心情・聚焦凸顯面板**：`summarizeRecentDays_` 系統提示由四段擴為五段，新增「## 今日心情・聚焦」——先從當日紀錄的語感/用詞/語氣讀出書寫當下心情與態度（具體情緒詞），再判聚焦程度（高度聚焦某主題／多線並行／發散探索）；`extractMarkdownSection_` 抽該段、在卡上用 surface 底色面板凸顯。④ **心情軌跡**：sticker 情緒弧線（`journeyEmotionArc_`）＋密度條正下方同 12 格/同視窗對齊的情緒列（`emotionCellsRow_` 加 winStart/winEnd 參數）。⑤ **PDF 建立者**：meta 區塊加「建立者：<displayName>」（`ownerDisplayName_`，群組/取不到時略過）、產出時間改年月日時分；第五段「今日心情・聚焦」隨 markdown 進 PDF。零新增 LLM 呼叫（折進原本那次摘要）。

**(B) `/ask` 問答與補充歸到「線索群的主題」**（commit `f4982b4`）：問題根因——`recordAskQA_` 寫出的「🔍探問…💡…」記錄無 category/topicLabel/lock，背景分類器獨立判它的議題、常落「隨想」大桶，與它依據的線索群分家；敘事片段又純按時間切，時間相近的兩筆不同主題探問被併成「A＋B」一條。修法：新增 `dominantTopicOfHits_`（在 `cited`／`clues` 線索群裡對 (大類,議題標籤) 投票取主導，平手取相關度高者）；成功 /ask 自動寫回的 Q&A、與補充強化的記錄，當下即用 `setRecordsCategoryTopic_` 歸到線索群主題＋`topicLocked`（背景分類器跳過已鎖者），不丟背景獨立重判。補充強化在答案卡/線索卡/gap 卡產生時把線索群主題快取 `askhome_<key>`、進補充模式帶進 dialog state、存檔（無 contextId）時歸戶；只做歸戶、不走升格評鑒。線索群尚無標籤 → 回 null 退回背景自行歸戶（安全降級）。⚠️ 只對修好後**新產生**的 Q&A 生效，舊記錄仍在原桶、要歸正用「📌 改歸主題」。

**(C) 改歸 → 目標主題亮 ✨「本次有變動」**（commit `7c9f79d`）：✨（`makeContextFreshFn_`）原只在脈絡 `lastTs` 落 90 分「本次坐下」窗、或 `rehomedSignatures` 有標記時亮；手動改歸走 `setRecordsCategoryTopic_`，兩者皆未碰（移入記錄 ts 多半舊、踩不進 lastTs 窗），故改歸後目標主題不亮。修法：`setRecordsCategoryTopic_` 成功寫入後（`!keepPins`）順手標 `rehomedSignatures[大類|議題標籤]=now`（與「移出重歸」同 sig 格式、同 3h fresh 窗、含過期修剪），讓 /themes 對目標主題亮 ✨、計入大類「✨ N 本次」。涵蓋所有使用者主動置放路徑（逐筆/整段改歸、分開新群、改名、網頁移出重歸/還原、§0.6.14-B 的 /ask 歸戶）；背景智慧合併（`keepPins=true`、自有通知）刻意排除。**只亮目標主題、被搬走一筆的原主題不亮**（✨＝有新東西可看；原主題只是少一筆、沒新內容）。

**(D) 網頁定案改頁內兩段式確認＋防二次點選**（commit `5259fe1`）：移除瀏覽器原生 `confirm()`（會硬塞「An embedded page at …googleusercontent.com says」長網址前綴、無法以文字改掉，且純連結無防重複點擊）。改頁內確認：第一顆「✅ 定案封存」只展開乾淨確認面板（`askFinal`）；真正送出的「確定定案」鈕按下即自我鎖死（`goFinal`：`dataset.go` 旗標＋`pointer-events:none`＋文字轉「封存中…」）防二次點選；附「取消」。送出仍走 `&finalize=1`（`target=_top`），`finalizeJourney_` 冪等、定案後頁面也不再有按鈕。停止分享（破壞性）與解除定案（測試）維持原 confirm。

**(E) /journey 歷程卡摘要完整呈現**（commit `3a5ce16`）：摘要本就硬上限 80 字（`detectContextMarkers_` 的 `truncate_(…,80)` ＋ LLM「≤60 字一句」），卡片裝得下，移除 `maxLines:3`、`wrap` 整句顯示，不再 3 行截成「…」。副作用：摘要長的卡比短的略高（carousel 取最高對齊），可接受。

**(F) 「提交給管理者」一度實作後撤回**（commits `173f1d0`→`5d3f969` 加入、`3751ebc` 移除，淨效果零）：曾在已定案歷程卡加「📤 提交給管理者」＋ owner 網頁收件匣清單（`view=submissions`）。應使用者決定取消——要交給 bot owner，直接把分享回執連結貼給他即同效，不另做一套。記此以免日後誤以為功能還在。

### 0.6.15 學習歷程總冊（/portfolio）＋ 落差量尺重寫（四軸·與偵測對齊·獎勵深度）＋ 背景智慧合併改規則〔2026-06-11 驗收 · 分支 `claude/sleepy-thompson-TRkeg`〕

權威規格如下（衝突一律以本節為準）。

**(A) `/story` → `/portfolio`「學習歷程總冊」**（取代舊「雙版故事」）：原 `_journey.md` 與 /journey 歷程現況高度重疊、`_context.md` 意義不大，改造成「把（已定案優先的）所有學習歷程合成的一本」。`/portfolio` 為正式名、`/story` 留相容別名。
- **入口卡**＝「裝幀總冊」封面（`buildPortfolioBubble_`，深皮革色書封＋📚＋書名＋「共 N 篇·M 篇已定案」＋封面照 hero＋「收錄篇章」目次），與 /now 海軍藍導航卡刻意區隔。footer 兩鈕：**🌐 瀏覽總冊（完整版）**＋**📖 文字精華版 PDF**。
- **完整呈現＝網頁總冊**（`Report.gs:serveCompendium_`，doGet `view=compendium`）：封面 → 卷首語（LLM 1 通，`summarizeCompendiumPreface_`）→ 學習地圖（純 CPU：大類分布＋轉折型態分布）→ 收錄目次（錨點）→ 各篇完整章節（重用單篇歷程現況的渲染器：落差/語意地圖/三條件/節奏+點線面/轉折，去定案分享）。每章 `break-before:page` 可瀏覽器列印。**PDF 退為文字精華版**（敘事＋轉折 evidence＋落差文字，走既有 markdown 路徑；`summaryHtml_` 不嵌圖表，故視覺完整版只走網頁）。
- 收錄範圍：定案優先（鎖定最終版＝可存檔/繳交）；無定案時收目前所有歷程的「現況」並標未定案、提示去定案。舊 `summarizeContextStory_`/`_context.md` 已移除。

**(B) 落差量尺重寫（`computeJourneyGap_`/`gapScoreFromLevels_`，版本 g7→g9）**——治「最高才 52%、看不出忠實距離」。四維改成**＝系統四種學習轉折**（概念深化/跨主題整合/行動指向/後設反思，**取代**舊 displacement/conceptDepth/crossTopic/metaReflection 的錯位四維），各評**連續 0~1 發展程度**：
- **與偵測對齊（治根）**：把該歷程「已偵測且 grounded 的轉折」餵進 prompt 當基準——已成立的軸發展程度不應為 0（治「同一條歷程兩套 LLM 各打各的、整合維與偵測打架，5/6 條被歸 0」）。
- **整合維鬆綁**：本主題子面向整合即給分，不再因「沒連外部主題」歸 0；`linkedTopics` 改純顯示用、不影響分數。
- **聚合改「獎勵深度」曲線**：`score = 100·(加權線性/100)^GAP_AGG_GAMMA`（γ=0.6）。資料驅動定案（純 CPU 比對校準集作者整體判斷：線性 MAE 14.9→曲線 5.2、r 0.981；sorted weights 雖 2.8 但忽略軸別、易過擬合故不取）。意義＝**強項做深就接近滿分、不必四軸都滿**，治線性對「深而窄」系統性低估。權重 `GAP_DIM_WEIGHTS=30/25/20/25`、γ 皆集中常數。
- **呈現**：網頁落差圖長條改「四軸發展度（你的強項在哪）」——每段染該軸淡色底（~15% alpha）看得出哪軸是哪段、顯示發展%、總分非各段相加（caption/gnote 白話說明獎勵深度）。/journey 導覽卡：用字「**佔**『有意義學習歷程』約 N%」（非「離」，分數＝已達成度）、四轉折發展度排 **2×2 格**（label 全形補等寬、同欄點對齊）、評估收進一個 surface 面板。

**(C) 落差量尺驗證骨架（`GapCalibration.gs`）**：作者標 gt（四軸連續 0~1）＋獨立 gtHolistic 的校準集 13 例（含「深而窄」探針）；`runGapCalibration`（效度：LLM等級vs公式GT、公式vs作者整體、端到端；＋鑑別度）、`runGapMonotonicity`（深化↑/灌水≈）、`runGapReliability`。掛 action 白名單 `gap.calibration`/`gap.monotonicity`/`gap.reliability`——**免 editor**：開發端寫 `_cmd.txt`→`backgroundSweep` 執行→報告寫 `_reports/gap_*.json`。注意：**聚合是否得當純 CPU 可驗**（公式吃 gt vs gtHolistic，無需 LLM/部署）；LLM 是否判對「每軸發展程度」才需跑 `gap.calibration`。

**(D) 背景智慧合併改規則**（`absorbCandidatesIntoJourneys_` 重寫、`mergeOverlappingJourneys_` 關閉）：
- **只在「非學習歷程」的脈絡間合併**：🌱進行中脈絡＋🌿候選歷程（偏好🌿為目標）；**絕不併入🌳學習歷程**（「已是歷程、再併入新的不好」）。**少筆併入多筆**（source 由小到大、target 筆數更多、同線靠 cosine+LLM gate）。**target 名稱(label)維持不變、不重判改名**。journey↔journey 自動合併整個關閉。
- **取消還原鍵**改用 target 主題簽名（`category|label`，穩定、撐過重分群）；取消合併沿用「**同名硬分開**」（同 (大類,議題) 時改名＋must-not-link pin，讓它真的自成一條）。
- **呈現**：/themes 被併入的脈絡卡亮 **✨**（`rehomedSignatures` 同式 sig）＋標「(相對時間)背景智慧合併·併入了『X』(名稱不變)」（`meta.contextMergeNotes`，14 天）。通知卡列**全部**（不再截 6）、含合併時間、文案「併入既有脈絡(名稱不變)」。**網頁歷程現況/總冊移除「🔀 背景併入的主題」section**（歷程不再是合併目標）。

**(E) Rich menu 重設計（`RichMenu.gs`）**：舊 1200×405/4 區、指令過時（/search /stats）。改 2500×1686「write-to-learn 三相導航」（2×3 卡＋底列 3 顆）：① 隨手寫＝🎒 探索寫(/explore，開鍵盤預填) / 📌 目前記事(/now)；② 查脈絡＝🧶 看脈絡(/themes) / 💬 問一下(/ask 預填)；③ 生歷程＝🌳 學習歷程(/journey) / 📚 學習總冊(/portfolio)；底列＝🔍 回想(/recall 預填)·🧭 我的(/me)·ℹ️ 說明(/help)。**帶參數指令用 postback `inputOption:'openKeyboard'+fillInText` 預填**、不帶參數用 message。圖＝使用者自製原圖（Drive `richmenu-custom.png`→ cover 縮 2500×1686、JPEG <1MB、嵌 base64；上傳 content-type image/jpeg）；`tools/gen_richmenu.py` 為 emoji 版後備產生器。部署免 editor：白名單 action **`richmenu.setup`**（`_cmd.txt` 觸發）→ `deleteAllRichMenus()+setupRichMenu()`。

---

## 一、五層資料架構

> ⚠️ 本節（及 §二～§五）為早期「五層」設計稿，與現況有出入，**以 §零 為準**。保留作沿革。

bot 的資料流是**五層**，不是兩層。請在程式碼註解與文件中明確區分。

| 層 | 名稱（設計用語） | 是什麼 | 現有程式碼對應 | 現況 |
|---|---|---|---|---|
| 1 | **訊息流** | 使用者隨手輸入的異質訊息（文字/語音/圖片/貼圖/檔案/位置），未結構化 | `embeddings.jsonl` 每筆 record | ✅ 已有 |
| 2 | **敘事片段** | 以時間 + Session 切割的時序單位，有粗結構、未語義歸納 | `groupBySession_`（即時計算） | ⚠️ 見下方落差 |
| 3 | **主題群組** | 同一語義場域的訊息縫成一個主題 = **脈絡的最小單位** | k-means 群聚（`Focus.gs` /themes） | ⚠️ 命名衝突 |
| 4 | **形成脈絡（context）** | 滿足下方三條件、從候選升格的主題群組 | `ContextUpgrade.gs` → `contexts.jsonl` | ✅ block 2 |
| 5 | **學習歷程（journey）** | 脈絡中出現下方四種轉折標記之一才升格 | `JourneyDetect.gs` → `journeys.jsonl`；`Journey.gs` 渲染 | ✅ block 3/4 |

> 命名慣例：正式層級名＝**訊息流／敘事片段／主題群組／形成脈絡／學習歷程**（流→片→群→線→面，維度遞進），**僅用於並列各層時**（如 /me 五列、本表）以利區分；內文與多數 UI 仍口語用「脈絡」「學習歷程」。

舊定義對照：
- 「記寫脈絡 = 沿時間把異質訊息縫成主題群組」= 第 **2→3** 層。
- 「學習歷程 = 記寫脈絡 + 補上片段之間的接縫」= 第 **3→5** 層。

### ⚠️ 與現有程式碼的落差（多數已於 blocks 1–5 解除，見 §八）

1. ✅ **命名衝突**（已對齊）：層2=敘事片段、層3=主題群組（全 UI）。原先：`groupBySession_` 時間群組曾叫「主題群組」(/episodes)、k-means 群聚曾叫「主題」(/themes)，與本模型對調，現已校正。
2. **timeline 已被移除**（仍為現況）：層 2「敘事片段（timeline）」原本持久化在 `timelines/*.md`，已於先前移除（`appendToTimeline_` 現在只更新 `meta.lastIngestTs`）。層 2 的概念目前只活在即時的 `groupBySession_`。
3. ✅ **層 4、5 已持久化**（block 1–3）：脈絡 `contexts.jsonl`（candidate/context）、歷程 `journeys.jsonl`（journey/watch），背景升格 + 轉折偵測流程已建立。
4. ✅ **`Journey.gs` 已重寫**（block 4）：`/journey` 只讀持久化歷程；舊的時間-episode on-demand 手動編織（含接縫 UI）已**整個移除**（與五層模型衝突）。

---

## 二、脈絡成立的三條件（第 3→4 層升格）

一個主題群組要升格為脈絡，需**同時**滿足三條件。閾值為初值，待實測校準（見 `Config.gs` `CONTEXT_CRITERIA`）。

- **語義密度**：群聚內部 cosine similarity 平均 > `0.75`，且與最近群聚的距離 ≥ `0.15`。
- **意向回返性**：使用者在**不同時段主動回到**同一關注點 ≥ `3` 次（兩則間隔 ≥ `returnGapMinutes`＝20 分才算「新一次回返」；連續輸入算同一次、不灌水），且首末總跨幅 ≥ `returnSpanHoursMin`＝1 小時。**「算一次回返的間隔」與「總跨幅」是兩個獨立參數**：前者抓真實回返節奏（課堂/田野隔 ~20 分回來就算），後者只是輕量散布守門。
- **跨媒介協同**：該主題至少跨越 `2` 種訊息媒介（文字/語音/圖片/貼圖/…）。

用途：過濾純粹的隨意測試輸入（如先前資料中的「雅雯女巫」「庫藏股」），避免把噪音當探究。

---

## 三、學習歷程的四種轉折標記（第 4→5 層升格）

脈絡要升格為學習歷程片段，需至少偵測到下列**一種**轉折標記。每種都要有可被 LLM 判別的偵測 prompt。

- **概念重述**：從「初次接收某概念」到「用自己的話重新表述」。線索：同一概念出現 ≥ 2 次，第二次起的表述形式（句法/用詞）與第一次明顯不同，且含使用者自己的延伸。
- **跨主題整合**：主動把兩個分離關注點接上的時刻。線索：「他們之間有關係嗎」「這跟那個有沒有關連」「其實是因為……」等連結語句，或一則訊息同時引用兩個不同主題的關鍵字。
- **行動指向**：探問從「這是什麼」轉為「我接下來該怎麼做」「我要……」「預約了……」等含未來時態與決定的表述。
- **後設反思**：跳出當下任務、反思自己處於哪個學習階段。如「我還在提問階段嗎」「我是不是該……」「我發現我一直在……」。

**沒有任何轉折標記的脈絡，只記為「持續關注」，不升格為學習歷程。** Story 不可把所有片段都當成學習。

### 偵測 prompt 草案（待打磨）

每種標記一個輕量分類 prompt，輸入 = 脈絡內依時間排序的訊息，輸出 = `{marker: 概念重述|跨主題整合|行動指向|後設反思|無, evidence: <引用片段>, confidence: 0-1}`。

- **概念重述**：「以下同一脈絡的訊息中，是否有同一概念被提及至少兩次，且後一次是使用者用自己的話重新表述（句法/用詞不同）並加入個人延伸？是→引出前後兩句對照。」
- **跨主題整合**：「以下訊息中，是否有使用者主動把兩個原本分離的主題連起來的句子（連結語句，或同一句引用兩主題關鍵字）？是→指出被連起的兩主題。」
- **行動指向**：「以下訊息中，探問是否從『這是什麼』轉為含未來時態/決定的行動表述（我要…、預約了…、接下來該…）？是→引出該句。」
- **後設反思**：「以下訊息中，是否有使用者跳出任務、觀察自己學習狀態的句子（我還在…階段、我是不是該…、我發現我一直在…）？是→引出該句。」

---

## 四、journeySeams 三元化

> 狀態（2026-05）：**目前未實作**。原本掛在「舊的 on-demand episode 編織」上，該編織已隨 block 4 移除，連帶刪掉 `SEAM_STATES` 與 seam store。以下為設計保留；未來若要做「脈絡↔脈絡之間」的接縫，再依此重建（節點應為層3/層4，不是層2 episode）。

`meta.json` 的 `journeySeams` 由二元擴為三元：

- `bridged`：已確認應縫合，且已產生接縫敘事。
- `skipped`：已確認不需縫合，視為不同主題。
- `pending`：相鄰但判準尚不足以決定，等後續訊息進來再回頭評估。

**避免過早凍結 bridged/skipped。** `pending` 應在每次新訊息進來、或產生新 summary 時**重新觸發判斷**。

---

## 五、Story 分兩種版本

> ⚠️ **已被取代（2026-06-11）**：雙版故事（`_context.md`／`_journey.md`）已改造成 `/portfolio`「學習歷程總冊」（網頁完整版＋文字精華 PDF），`_context.md` 路徑移除。以 §0.6.15-A 為準，本節保留作沿革。

`_story.md` 目前把所有片段攤平、混雜脈絡與歷程。拆成：

- **脈絡敘事**（`_context.md`）：只重述發生了什麼，回答「我這陣子在想什麼」。語氣＝流動式第一人稱日記感。
- **歷程敘事**（`_journey.md`）：只保留有轉折標記的片段，明確標出每個轉折屬哪一種（概念重述/跨主題整合/行動指向/後設反思），回答「我這陣子學到了什麼」。語氣＝明確的「學習單元」結構：每個轉折 before/after 對照、學到什麼、下一步可能。

---

## 六、可調參數（待實測校準）

集中於 `Config.gs`，初值如下（見 `CONTEXT_CRITERIA` / `JOURNEY_MARKERS`）：

| 參數 | 初值 | 意義 |
|---|---|---|
| `semanticDensityMin` | 0.75 | 群聚內 cosine 平均下限 |
| `clusterSeparationMin` | 0.15 | 與最近群聚的最小距離 |
| `returnVisitsMin` | 3 | 意向回返次數下限 |
| `returnGapMinutes` | 20 | 兩則間隔 ≥ 此值才算「新一次回返」（連續輸入算同一次） |
| `returnSpanHoursMin` | 1 | 首末回返總跨幅下限（小時，輕量散布守門） |
| `mediaKindsMin` | 2 | 跨媒介種類下限 |

---

## 七、待釐清問題（實作前需定，勿自行詮釋）

見 `CLAUDE.md` 開發筆記與下次討論；摘要：

1. 命名衝突要不要全面對齊（改 /episodes、Journey、help 的「主題群組」用語）？
2. 層 4/5 是否持久化成正式物件（脈絡/歷程 store）？這是「即時計算 → 持久化 + 背景升格」的架構轉向，屬重寫等級。
3. 升格判定的**時機**：每次 ingest？每次 /themes？背景 trigger？
4. 「意向回返」「同一概念」「主動」如何操作化（靠 embedding 配對 + LLM 判別）？
5. 貼圖/位置算不算「媒介」（貼圖語義弱）？
6. 轉折標記偵測的 LLM 成本與額度（每脈絡一次 call）。
7. `pending` 重評需要背景 summary 排程嗎（目前 summary 是查詢時即時算）？

---

## 八、實作進度與後續（build log）

開發分支 `claude/fix-image-upload-s5acn`；還原點 branch `snapshot/pre-context-journey` @ `e05d2ff`（記寫脈絡完成、改造之前）。

**已完成**
- ✅ **目前記事(/now) + /ask 歸戶線索群 + 改歸亮✨ + 定案頁內確認 + 歷程卡摘要完整（2026-06-10 驗收，分支 `claude/sleepy-thompson-TRkeg`，commits `760a92e`→`3a5ce16`）**：權威規格見 §0.6.14。承同分支續做：
  - `/today`→`/now`「目前記事」＋卡片產出時間(年月日時分)/🎭今日心情・聚焦凸顯/心情軌跡/PDF 建立者（§0.6.14-A）。
  - /ask 問答與補充歸到「線索群的主題」、不再被分類器獨立判進隨想（§0.6.14-B）。
  - 改歸進某主題 → 目標主題亮 ✨（§0.6.14-C）。
  - 網頁定案改頁內兩段式確認＋防二次點選（§0.6.14-D）。
  - /journey 歷程卡摘要完整呈現、不再「…」（§0.6.14-E）。
  - 「提交給管理者」一度實作後依使用者決定撤回（§0.6.14-F，淨效果零）。
- ✅ **分享回執（2026-06-10，分支 `claude/sleepy-thompson-TRkeg`，commits `d7c8dc6`→`70c0472`）**：權威規格見 §0.6.13-I。定案歷程開放分享（`shareToken` 與 reportToken 分離）→ 訪客唯讀＋回執 → 建立者收彙整通知（省 push：`notifyPendingAcks_` 彙整推＋/me「📩 N 新回執」徽章）；回執名單 `buildAcksBubble_`、歷程卡「📩 N 人回執」、網頁訪客頁封面「👤 建立者：姓名」、`/shares` 管理員一覽。
- ✅ **背景推播合宜守則 + 命中/問答呈現 + pin 契約根治 + 貼圖情緒層（2026-06-10 驗收，分支 `claude/sleepy-thompson-TRkeg`，commits `fe97c70`→`b66d7ee`）**：權威規格見 §0.6.13。一輪長對話、密集實機回饋累積：
  - **背景推播合宜守則**（§0.6.13-A）：`proactivePushAllowed_` 統一守門（夜間靜默/停筆才推/一輪一張/總開關），回返提醒 `clampOutOfQuiet_` 順延、icon 🔁→📅。
  - **/recall 命中呈現**（§0.6.13-B）：命中置中開窗＋span 高亮、🔤/🧠＋相關度、敘事片段卡焦點命中框（最高分置中＋前後筆數收合）。`matchSnippet_`/`snippetComponentFromMatch_`。
  - **/ask 問答人格**（§0.6.13-C）：暖紫答案＋信心橫幅、推測 vs 依據分層上色（全模式開）、行內 `[n]`→①② chip 溯源對齊暖紙依據卡、順著問、原始筆記優先 `ASK_QA_RECORD_PENALTY=0.9`、線索卡分數分三檔；答案+依據同一輪播。與 /recall 各具特色（記錄 vs 答案）。
  - **脈絡補充密度迴圈**（§0.6.13-D）：凝聚卡顯示真語意密度 delta；密度真槓桿改「分開離核心 outliers」（`contextOutliers_`＋一鍵分開帶路改名）而非一直叫補；§B 密度排除貼圖/地點。
  - **轉折成形卡**（§0.6.13-E）：已達標項直接指向該項（修 60%✓ 卻建議別種）、startScores 按內容指紋快取 6h（修分數每次浮動）。
  - **pin × 重分群契約三 bug 根治**（§0.6.13-F，本輪最重要工程修復）：分開不釘核心（`auditSplitPins` 清理）、改歸接目標 pin 鍵、智慧合併釘整群（終結無限重併＋重複通知；Node 模擬驗證新舊行為）＋`mergeRepeatLog` 重併哨兵（/me 自檢＋通知卡 ⚠️，免 editor）。
  - **/me 拆兩卡**（§0.6.13-G）：學習狀態 / 系統與帳號。
  - **貼圖情緒層**（§0.6.13-H）：貼圖＝對某筆記寫的階段性情緒；零 LLM emoji（~40 情緒族啟發式＋片語每款只算一次快取）；LINE 折疊/心情軌跡/落點＋網頁版出原圖/型別/節奏疊情緒；舊資料一次性回填 `backfillStickerEmotions_`（**正式驗收後移除**）。
  - **待辦**：閾值實測校準續；正式驗收完成後移除一次性回填；合併修復觀察數日（/me 合併自檢應保持 ✅）。
- ✅ **補密度可玩性收尾 + 升格判準聚焦補償 + 多個 UX 修正（2026-06-07 續，分支 `claude/sleepy-thompson-TRkeg`）**：權威規格見 §0.6.11。承 §0.6.10 同日續做、一輪密集實機回饋：
  - **補密度凝聚改忠實**（`synthesizeDensityDraft_`）：使用者補充的具體事實/用詞原樣保留、一則不漏；既有核心記錄只當銜接背景。修掉先前「凝聚把使用者的話丟掉（住宿/伴手禮全不見）」——根因是把補充當 steering＋「挑群心最近版」專挑掉周邊新細節，已移除該量化挑選。
  - **補密度 A/B/C**：A/B 量化補充當下 focus/novelty；B 凝聚卡即時回饋「越補越扣核心↑/發散↓・聚焦 N%」（不阻擋）；**C 防灌水改放密度度量本身**（`avgPairwiseCosine_`＋`dedupeVectorIdx_` 去近重複 `DENSITY_DEDUP_COS=0.92`）→ 前景背景一致、逐字重複撐不高密度。
  - **修「candidate 補充下次掃描就消失」資料遺失 bug**：`attachRecordToCandidate_` 附入即 topicLock 成本脈絡標籤（同轉折補充），重分群不再洗掉。一律保留、不踢出（移除前景擋下不附入的閘）。
  - **升格「語意密度」聚焦補償（方案 A）**：`density≥0.60` 或（`≥0.52` 且 `coreFrac≥0.80`）。`coreFrac`＝對群心夠近的成員**比例**（非平均，平均與 pairwise 單調等價＝偷偷降門檻；比例才分得出「單核發散 vs 多核混雜」）。`densityConditionMet_` 成全系統單一真相，升格閘＋所有卡片/網頁顯示一致。讓「facet 多但同一主題」的脈絡（德國行學術＋招待）也能成形。
  - **回返可讀性**：三條件 chip 顯示「回返 2/3・媒介 2/2」；「還缺」分清次數 vs 跨度、顯示目前次數（門檻維持 3）。
  - **LINE URI 防呆**（`safeActionUri_`）：修「看原始紀錄」整則 Flex 被退 400 Invalid action URI（連結後黏中文→uri 夾 CJK）。
  - **改名**：rename 模式離開鈕「放棄改名」（不再殘留「離開/ask模式」）；改名同步把成員逐筆 topicLabel 一起改（卡片歸類顯示一致、不分家）。
  - **改歸主題選單排除自己原本的主題**（`rankContextsBySim_` excludeIds）。
  - **回返提醒 UX**：已排入就標「已排入提醒・約 MM/dd HH:mm」不重複點（`handleCandidateRemind_` 冪等）；升格前自動取消（`sweepDueReminders_` 掃到非 candidate 直接刪、前景升格即時清）。
  - **記寫回執改更安靜＋卡片更完整**（§0.6.11 J）：回執（停筆後「剛寫的這段被怎麼整理了」）原本只要正面歸戶就推；改成**只在「差一條件成候選歷程」高價值時機**才推（`RECEIPT_NEAR_UPGRADE_MIN_CONDITIONS=2`，總開關 `RECEIPT_ENABLED`），對齊少打擾。卡片補上「這條脈絡整體規模＋三條件進度＋還缺什麼」，一眼知道差哪步。
  - **多個一致性／卡住修（§0.6.11 K–P）**：改歸選單排除自己、改歸確認訊息名稱對齊卡片；歷程顯示一律以使用者改名為主標、自動名退副標（`journeyTitleParts_`）；「正在背景重新對齊」永遠卡住修＋開 /journey/報告頁即對齊（`alignFrozenJourneyStamps_`）；敘事片段稀疏卡內容自適應、各片段一律示意時間分布＋註明無聚焦原因；`/me` 三狀態用詞對齊、`/help` 卡③補三狀態流程與卡片可操作項。
  - **解掉前一輪「已知未決」**：語意密度灌水/罰真實 elaboration → 由「C 度量去近重複（防灌水）＋ 聚焦補償（救被離題拖低/facet 多的真主題）＋ 補充一律保留」三招合解。閾值待實測校準。
- ✅ **點線面視覺化 + 補充/提醒分流 + 落差收進主題 + icon/用字定案（2026-06-07，分支 `claude/sleepy-thompson-TRkeg`）**：權威規格見 §0.6.10。一輪密集實機回饋，貫穿「機器提案、人拍板／時間可信、語意不可信／無痕靜默」：
  - 片段角色標（歷程起點/回返/橋接）、片段內節奏＋聚焦（cell 點分布＋聚焦折線＋重要轉折數據）、聚焦不再推播改畫網頁、`/test` 退場。
  - 孤兒轉折 ⚠＋偵測自清（`groundedMarkerTypes_`/`journeyKeySet_`）；跨媒介改嚴格（只算本脈絡成員、拿掉 `attachNearbyMedia_` 呼叫）。
  - 記寫延續提醒（只候選歷程）：A 即時歸戶確認（無痕靜默例外、`CONTINUITY_RT_*`）＋ B 背景候選歷程→轉折卡（`maybePushContinuityNudge_`）。
  - 補充模式按 status 分流（脈絡補充卡 vs 轉折卡）、收所有型態不離開、未達標留模式＋「補充結果／建議」Flex 卡（`buildSuppResultBubble_`）、按鈕依缺項命名（顧密度/顧媒介）。
  - 落差分析 crossTopic/missing/summaries 全收進「本主題內具體欠缺」、跨頂層主題只用真實清單不發明、`linkedTopics ⊆` 清單（快取 g5→g7）。
  - icon 唯一化（敘事片段📜/文字📝/後設反思🔭/其他🗄️/探索🎒・📦/學習素材🔖/脈絡現況🧶）、用字 語義→**語意**。
  - ~~**已知未決**：語意密度當升格硬關卡仍可被「重複關鍵字」灌水、也會罰真實 elaboration~~ → **已於 2026-06-07 續輪解決**（§0.6.11）：C 度量去近重複防灌水 ＋ 聚焦補償（coreFrac，救被離題拖低/facet 多的真主題）＋ 補充一律保留。閾值待實測校準。
- ✅ **連結預覽「共同方法」一般化 + 歷程卡高度/分頁（2026-06-05，分支 `claude/clever-mayer-IxExB`）**：權威規格見 §0.2 連結預覽段、§九/§十。接續 06-04 抖音那條，使用者逐站丟連結（IG/MSN/Dcard…）驗，逼出「不要逐站測、要共同方法」的體悟：
  - **A 層縮圖一般化**：`previewThumbnail_` 拿掉逐站 host 名單，**所有 og:image 一律 `rehostImageToDrive_`**（GAS 下載→Drive→`drive.google.com/thumbnail`）。IG 實機驗收 ✅。`extractOgImage_` 多來源（og:image 變體／twitter:image／`<link image_src>`／JSON-LD）+ HTML 掃 200KB。`thumb-cache/` 由 `backgroundSweep` 每天清 >14 天（補掉 06-04 的 TODO）。
  - **B 層通用後備 microlink**：自家四個失敗出口（fetch 例外／4xx／登入牆／無 og）統一 `metadataApiFallback_`→microlink（headless 瀏覽器、會跑 JS）。`isJunkPreviewText_` 偵測登入牆＋**Cloudflare 挑戰頁**（Dcard 實測：自家＋microlink 免費端點皆撞 Cloudflare、回「Attention Required」，會污染語義→一律丟掉乾淨退外部連結）。`MICROLINK_API_KEY`（Script Property）可換 pro 端點。
  - **逐站定案**：IG/抖音/FB 公開貼文/一般新聞 ✅ re-host；**MSN** 文字 ✅、縮圖放棄（`/urldiag` 證實 HTML 43KB shell 無 og:image＝靠 JS 生圖、文章 id≠圖片 id，使用者決策不打 microlink）；**Dcard** Cloudflare 擋→乾淨外部連結（內文未做）。診斷 `/ttdiag`→一般化成 `/urldiag <任意連結>`。
  - **歷程現況瀏覽卡（§九相關）**：使用者回報某段記錄多就把卡拉超長、各卡不均。改成**依「估計卡高」切卡**（`storyRowLines_` 估行數＝時間列＋內容折行＋轉折標籤；`chunkStoryRecords_` greedy 累加到 `STORY_MAX_LINES` 換卡；每則內容截 `STORY_ROW_TEXT_MAX=160`），一張卡可放很多短則或少數長則但高度一致；同段切多卡標「· 第p/共n頁」。**加頁面控制列**：拿掉舊 11 張硬上限，全部卡丟 `paginateFlexCards_`、頁碼列 `buildPaginationBubble_` 另發一則，postback `story_browse_page&cid&p`→`replyJourneyStory_({page})` 重繪（純翻頁、不改資料）。
  - **部署陷阱根治**：06-04 那條「前 4 版沒上線」的分支陷阱→把 `deploy.sh` 改成**每次先 `git fetch`、自動 `checkout -B` 到 origin 最近更新的 `claude/*` 分支再部署**（印出分支＋SHA；deploy 失敗印確切修法）。使用者以後無腦 `./deploy.sh` 即可，不必 `git pull`/切分支。CLAUDE.md 部署章節已同步。
- ✅ **抖音／TikTok 連結縮圖（2026-06-04 驗收，分支 `claude/clever-mayer-IxExB`）**：權威規格見 §0.2 連結預覽段。痛點＝抖音短鏈記成「外部連結」、無語義也無縮圖。實作脈絡與**踩過的坑**（避免日後重蹈）：
  - 思路對、但**前 4 版都沒上線**：使用者固定用 `git pull && ./deploy.sh`，而 `git pull` 只更新「當前所在分支」；本 session 提交在 `claude/clever-mayer-IxExB`，使用者的工作樹卻停在早期 commit → `clasp push` 一直推舊碼、`clasp deploy @528` 成功但內容是舊的。表徵＝「縮圖一直沒變」「`/ttdiag` 回未知指令」。**這就是 CLAUDE.md 部署章節警告的分支陷阱的真實案例**。修法＝`git checkout -B claude/clever-mayer-IxExB origin/…` 對齊工作樹再部署。順手把 `deploy.sh` 改成 deploy 成功時印出已部署 git SHA（`✅ … git: <sha>`）、失敗時印出確切修法，讓「以為部署了其實沒」當場現形。
  - **oEmbed 從機房 IP 被擋 403**（Apps Script／WebFetch 實測皆 403）→ 不可靠；改走 og 後備（crawler UA 抓正規頁 og meta）。
  - **縮圖空白的真因**：TikTok og:image 只服務白名單 crawler UA（facebookexternalhit），故第三方代理（試過 weserv）抓會 403、LINE Flex hero 直連也載不出（但 LINE 原生預覽用自家 crawler 抓得到）。試過 oEmbed-補-UA、縮圖網址不截斷直連、weserv 轉 JPEG 代理——全失敗。**最終解**＝GAS 用 crawler UA 自己下載圖（`/ttdiag` 實測 200 / image/jpeg / ~499KB）→ 轉存 Drive → 回 `drive.google.com/thumbnail`（本專案既有的 hero 端點，驗證過 LINE 載得出）。
  - 新增 `resolveRedirects_`／`rehostImageToDrive_`／`thumbCacheFolder_`／`driveThumbUrl_`／`fetchTiktokOembed_`／`replyTiktokDiag_`（`/ttdiag`），改 `Handlers.gs`、`deploy.sh`。**TODO**：`thumb-cache/` 會累積檔案，日後可在 `backgroundSweep` 加定期清理；`/ttdiag` 為開發暫用，校準完可移除。
- ✅ **轉折成形卡 + 轉折評鑒（候選歷程→學習歷程的品質把關，2026-06-02 收尾）**：權威規格見 §0.6.9,本 entry 列實作脈絡與 commit。從使用者痛點「補一個轉折太被動、有寫就升格、無鑑別度」一路改到「有鑑別度的評鑒工具 + 引導式鷹架」:
  - **Phase 1/2/3**:cos 閘(後移除)、`computeMarkerGap_` 四指標純 CPU 算「最缺哪種轉折」(`src/JourneyDetect.gs`)、轉折成形卡 carousel(主卡 markerGap+LLM 題目 / 脈絡現況卡)+ 即時評鑒門檻 `SUPPLEMENT_EVAL_THRESHOLD=0.60` + Phase 3-B 天花板鷹架 `generateScaffoldHint_`。
  - **評鑒 v2 multi-signal**(`src/TransitionEval.gs`):S1 LLM(anchor exemplars)× S2 結構(`structGatedScore_` 型別閘),非對稱合成 `final=S1+max(0,S2−S1)·0.6`。從「為每個案例補 regex 句型」(overfit 無底洞)抽出三條**通用原則**:①合成非對稱(S2 漏接不下扣)②型別閘取代句型窮舉 ③長度地板可豁免。
  - **研究級驗證**(`src/Calibration.gs`):校準集 `TRANSITION_CALIBRATION`(每類~20 anchor,作者給 ground truth),三層 editor 報告 `runEvalCalibration`/`runEvalReliability`/`runEvalValidity`(寫 `_reports/*.json`,Drive MCP 直接讀、免 copy console)。三輪迭代:MAE 0.22→0.09→0.07、r>0.93、門檻 0.60 鑑別度乾淨(空話擋下、好補充過得了)。改 prompt/pattern 後跑全套驗證才升版,不再 LINE 試一次就動。
  - **CPU×LLM 融合**:`diagnoseContextTransitions_`(LLM 看內容出四項診斷+建議+題目)與 CPU markerGap 融合(`finalSuggest=llmSuggest||cpuSuggest`,一致→⭐強烈建議、分歧→以 LLM 為主+CPU 標「特徵也指這」);凝聚卡方向對照(你寫的 vs 建議)。
  - **多個一致性修復**:(a) 移除 cos 歸屬閘(`SUPPLEMENT_RELATEDNESS_MIN` DEPRECATED)——違背「向量只參考」+ 與背景 label group-by 打架造成「前景說沒過、背景偷偷升格」;(b) 升格 markers 改用凝聚卡評鑒達標的項(不再 `detectContextMarkers_` 另判),升格理由與補充時看到的評鑒一致;(c) 背景重複推播去重(當場升格 id 記進 `notifiedJourneyIds`);(d) 空 text 修 LINE 400;(e) 升格慶祝卡 `buildPromotedJourneyBubble_`(可點看歷程+說明在算什麼)。
  - **主卡呈現迭代**(使用者反覆校準):四項 % 進度條(現有內容起始分,通常貼底)+ ✨ 建議起點 + 「為什麼建議」原因(明說「依累積樣態、不是看四個分數」,解「四項同分卻建議某項」困惑);與凝聚卡同一把尺(contextDigest+draft)、數值連續往上動到 0.60 升格。
  - **新增檔**:`src/TransitionEval.gs`、`src/Calibration.gs`;改 `JourneyDetect.gs`(markerGap/診斷/評鑒 helper)、`Handlers.gs`(轉折成形卡/凝聚卡/升格)、`Config.gs`(閾值)。分支 `claude/beautiful-allen-xDD4p`。**剩**:實機完整驗收 + 部署(分支需 merge 進部署分支)。
  - **mock 測試資料**:`src/TestbedSeed.gs`(seed 4 條轉折測試脈絡)+ Drive 直寫完整 mock 資料集(OWNER `Can`,合成 embedding,cos-sensitive 路徑有偏差,僅供 UI/流程演示與手冊範例)。
- ✅ 命名對齊：層2=敘事片段、層3=主題群組（全 UI）；內部 Gemini prompt 保留「主題/topic」；`/journey <主題>` 參數泛用。/me 紀錄＝五層各一列。
- ✅ block 1 持久化骨架：`ContextStore.gs`（`contexts.jsonl` 脈絡 / `journeys.jsonl` 歷程，upsert-by-id、鎖保護、schema 見檔頭）；/me 脈絡/歷程 讀真實 store（暫 0）；接縫三元 `SEAM_STATES`（bridged/skipped/pending）+ pending 渲染。
- ✅ block 2 脈絡升格（層3→4）：`ContextUpgrade.gs`。背景跑全語料 k-means（沿用 `kmeansCluster_`/`pickFocusK_`）→ 用 member-id **Jaccard 重疊**（`CONTEXT_MATCH.jaccardMin` 預設 0.3）貪婪一對一配對既有脈絡物件 → 算三條件（`evaluateContextCriteria_`）→ 寫 `status` candidate/context，整檔一次覆寫（`saveContexts_`）。掛進 `backgroundSweep()`（在既有 `chatFolderExists_` 區塊內），由 `maybeUpgradeContexts_` 節流：每 scope 最多每 `CONTEXT_UPGRADE_MIN_INTERVAL_MS`（3h）一次、且自上次升格後有新訊息才跑（無 Gemini call，純 CPU）。/me 脈絡列加「（候選 N）」。診斷：editor 直接跑 `runContextUpgradeNow`（略過節流、逐群印三條件，供閾值校準）。
  - 操作化落地細節：意向回返＝群內**所有紀錄**(含引述回覆)依時間切「間隔 ≥ `returnGapMinutes`（20 分）＝新一次回返」數其段數，且首末跨幅 ≥ `returnSpanHoursMin`（1h）——同坐下立刻引述更正(間隔短)算同一次、不灌水,隔一段時間回來補充(就算用引述)算一次真正的回返；跨媒介＝distinct type ∈ {text,audio,image,video,file}（排除 sticker/location）；語義密度＝群內平均 pairwise cosine（>2000 對時抽樣封頂）且與最近群心距離 = 1−maxCos。
  - ⚠️ 校準史：`semanticDensityMin` 0.75→0.60（Gemini embedding 對短中文相似度偏低）；意向回返原本 gap 與 span 共用 2h（課堂/田野太苛），拆成 `returnGapMinutes`(20 分) + `returnSpanHoursMin`(1h)；意向回返原本**排除**引述補充(`quotedRecordId`)，改為**納入、用 gap 把關**（隔久回來的引述補充＝真回返；`recordAskQA_` 本就無 quotedRecordId、不受影響）。
  - 配對後處置：matched→原地更新（保留 id/createdAt，供 block 5 journey 連結）；unmatched 既有 `context`→保留；unmatched 既有 `candidate`→視為過期噪音丟棄。
  - 成本守則：matched 的 `updatedAt` **只在成員真的變動（recordId 集合不同）時才更新**——`updatedAt` 是轉折偵測的變更閘（`basedOnUpdatedAt`），所以成員沒變的穩定脈絡不會被每輪重判，省 Gemini（summary 多一欄 `stable` 計穩定數）。label/criteria/firstTs 等顯示欄位仍每輪刷新。
  - 校準槓桿（皆 `Config.gs`，初值待實測）：三條件閾值 `CONTEXT_CRITERIA`、配對 `CONTEXT_MATCH.jaccardMin`、節流 `CONTEXT_UPGRADE_MIN_INTERVAL_MS`；另 k 粒度沿用 `pickFocusK_`（≤8），若脈絡過粗可在此調。
  - ⚠️〔2026-05 穩定性修正〕`kmeansCluster_` 原本用 `Math.random` 做抽樣與初始群心 → **每次重跑分群結果都不同**：`/themes` 與 `/journey` 互不一致、已升格的脈絡/歷程在下次重分群被重切→判準重算→降級，背景再把對應 journey 紀錄丟掉 ⇒「歷程不見了」。改為**決定性分群**：`seededRng_`(mulberry32)＋`recordsSeed_`(對 record ids 做 FNV-1a)＋`seededShuffleSlice_`，同一語料必得同一分群；`avgPairwiseCosine_` 的 >maxPairs 抽樣同樣改 seeded（密度→升格決策不再每次抖動）。`/themes`、`/journey`、背景共用同一 `kmeansCluster_`，自然對齊。注意：部署當下會有**一次性**重切（從舊的隨機結果切到決定性結果），之後即穩定。
  - ⚠️〔2026-05 群間距改為合併規則〕原本「群間距 ≥ `clusterSeparationMin`」是**擋升格的關卡**，反而懲罰使用者最投入的大主題：一個大主題(如「教學」)被 k-means 切成用詞相近的兩半(教學反思 sep 0.05、教學計畫 sep 0.05)→ 兩半互為最近鄰、群間距雙雙不足 → 雙雙升不了格；反而孤立的小品(5 筆 Gemini sep 0.20)輕鬆升格，與「學習歷程」直覺相反。改為：`upgradeContexts_` 在 k-means 後先跑 `mergeCloseClusters_`(Focus.gs)——把群心距 < `clusterSeparationMin` 的群**貪婪合併**成一條(同閾值)，再判升格。於是群間距從「封鎖」變「**決定脈絡粒度的合併依據**」：太近＝同一條脈絡(合併)，夠遠＝各自獨立。合併後殘餘群必然彼此 ≥ 門檻，故 `evaluateContextCriteria_` 的 separation 子條件自然恆過(保留作顯示)。`/themes` 仍是細粒度即時探索視圖，但 `看進度` 以 record-id 重疊映射回合併後的持久化脈絡，故一致。
- ✅ block 3 轉折偵測（層4→5）：`JourneyDetect.gs`。對每個 `status==='context'` 脈絡跑一次 Gemini，**同一通 LLM 一次拿四樣**：標題（≤14 字）＋**摘要（≤60 字一句中文，客觀敘述此脈絡發生了什麼學習／思考／行動，給卡片直接顯示，取代舊版逐字引用 200 字 evidence 的長引號）**＋**關鍵字 `{category, tags[]}`：1 個「大類」從 `JOURNEY_KEYWORD_CATEGORIES`（教學／研究／閱讀／反思／札記／生活／規劃／進修）擇一 + 0-2 個「細類」自由名詞片語 ≤6 字（4 個層級——敘事片段／主題群組／脈絡／歷程——共用同一字彙，避免層間對不齊；改清單只動 `JOURNEY_KEYWORD_CATEGORIES`）**＋四種轉折標記（概念重述／跨主題整合／行動指向／後設反思），JSON 一次解析 → `journeys.jsonl`：有標記＝`status:'journey'`、無標記＝`status:'watch'`（持續關注、不升格、不計入歷程數）；row 多帶 `summary`、`keywords` 欄位。`maybeDetectJourneys_` 掛在 block 2 之後；重判條件＝「內容變動（`basedOnUpdatedAt !== context.updatedAt`）OR 缺 title OR 缺 summary OR 缺 keywords」→ 沒變且都齊就不花 LLM；缺欄的舊紀錄會在下次背景 sweep / `runJourneyDetectNow` 自動回填、且**升格只進不退**（已是 journey 的回填不會掉回 watch）。script 級每日上限 `JOURNEY_DETECT_DAILY_MAX`（50）。`countJourneys_` 改為只數 `status:'journey'`。診斷：editor 跑 `runJourneyDetectNow`（強制重判、逐條印標記）。
  - ⚠️〔2026-05-29 巨無霸歷程卡三連修〕`/journey` 出現一張 154 筆、語義密度 0.57 的「教學策略與評量方法探索」blob，把教學設計／評量／課程設計／繪本／論文／甚至家庭旅行全混進同一張卡。三段根因＋修法（皆在 `claude/serene-edison-wcqnE`，commit `15ad812`/`cd18b4e`/`4789954`）：
    1. **真因＝journey-merge 的 strong-path**（`JourneyDetect.gs:shouldMergeJourneyPair_`）：`cos ≥ JOURNEY_MERGE_CENTROID_STRONG(0.90)` 直接合、**跳過 LLM gate**。Gemini 短中文窄帶裡同領域不同子題（formative／鷹架／備課／論文）群心也常 ≥0.90 且 drift<0.04，於是 `backgroundSweep` 每輪（步驟 4.5 `mergeOverlappingJourneys_`）無聲再併、把 records pin 成 `m:<ctxId>` → 下次 `upgradeContexts_` 被迫整群留一起（pin 繞過 k-means），雪球成 blob。**證據**：`meta.json.recordPins` 有 ~130 筆全指向同一 `m:` 群；清掉 pin 後 k-means 自然切成 21 群、最大僅 30 筆、各群密度 >0.60。此 strong-path 曾被 P1（`69450cc`）修掉，又被整批 revert（`4a3cf86`）帶回來。**修法（`15ad812`，重新套用 P1）**：移除 strong-path，`cos≥0.90` 改與 0.75~0.90 一律走 `checkSameThreadLLM_`（prompt 已明列 教學設計vs評量、繪本教學vs心理 為 DIFF）；LLM 不可用退 soft path（cos≥0.82＋時間重疊＋≤5 天跨度，長跨度教學線天然擋住）。`absorb` 本就要求 `verdict===true`，無此漏洞。**既有 blob 須 editor 跑 `runJourneyMergeRollbackNow()` 清 `m:` pin＋重分群**（部署修正後才不會被下一輪 sweep 在 ~4 分內重新黏回）。
    2. **re-link 殘留**（`ContextUpgrade.gs:upgradeContexts_` 末段）：blob 拆開後，原 journey 被 re-link 指到 19 筆的新群，卻仍掛舊 blob 的 title/summary/markers（`detectJourneys_` 對「有完整 title+summary+keywords 的 journey」一律凍結不重判）。**修法（`cd18b4e`）**：re-link 改 `contextId` 時，比照 `absorb` 清掉 title/summary/keywords/markers＋`basedOnUpdatedAt`（status 仍保 journey，走 detect 的 wasJourney 分支不降級），逼依新群重生；guard：只在新群是 `'context'`（detect 只重判 context）時才清，re-link 到 candidate 不清以免卡面空白。
    3. **標題外洩 system 人設**（`JourneyDetect.gs:detectContextMarkers_`）：sys instruction 是「你是學習轉折偵測器…」，LLM 偶爾把角色名「學習轉折偵測器」當標題吐出來。**修法（`4789954`）**：prompt 標題規則加明文禁令（不可用偵測器/轉折/分析器/助手等角色字眼、不可照抄指示）＋新增 `sanitizeJourneyTitle_` 後處理，命中 `/轉折偵測|偵測器|分析器|^你是|系統指示|^json$/` 即丟掉、退回主題化後備（摘要首句 > 脈絡 label > 未命名脈絡，後備保證非空以免 `res.title||prev.title` 回退舊污染標題）。
    - **實測結果**：154 筆 blob → 13 條各自聚焦的歷程＋2 候選，標題全乾淨無外洩。剩可觀察項：兩張繪本卡（研究向 vs 教學向）仍分開，屬邊緣案例，交由背景 LLM-gated merge 判 SAME/DIFF（不會再塌成 blob）。
- ✅ block 4 journey 改寫：`Journey.gs`。`/journey`（無參數）進來**先就地對齊**：呼叫 `maybeUpgradeContexts_(scope, true)`（新增 `ignoreThrottle` 參數，繞過 3h 節流；無新資料仍跳過、純 CPU），把當前語料剛成形/變動的脈絡立即持久化，避免「`/themes` 即時看到達標、`/journey` 卻找不到」的時間差（轉折偵測仍走背景）。然後出 **兩段總覽**：先列已升格歷程（status `journey`，藍卡＋轉折標記＋證據），再列**候選歷程**＝凡 `status:'context'` 但尚未升格的脈絡（**源自 contexts.jsonl，不再只看 watch 紀錄**）——含「已判讀、暫無轉折」(有 watch 紀錄，標『持續關注』) 與「剛成形、背景還沒判讀」(無紀錄，標『判讀中』) 兩種，故 `/themes` 顯示三條件已達的脈絡，`/journey` 必能找到、不被背景判讀時點藏起來（修掉舊版只列 watch、漏掉未判脈絡的洞）；淡色卡，雙鈕：①「看敘事片段」→ `replyContextEpisodes_`（該脈絡自己的紀錄分段成敘事片段輪播、原始紀錄下鑽亦限定該脈絡 `replyContextRaw_`，不被同日他群污染）②「補一個轉折」→ `handleContextSupplementEntry_`（watch 缺的是轉折而非條件，故進補充模式但用 `buildTransitionSuppIntroBubble_` 引導寫四種轉折之一；session 帶 `contextId`）；按脈絡紀錄數排序）；
  - **即時升格**：補充提交（`handleSuppSave_`）若 session 帶 `contextId`，走 `finishTransitionSupplement_`：把新紀錄直接掛上該脈絡（`recordIds`＋bump `updatedAt`）、對「這一條」跑單次 `detectContextMarkers_`（鏡像 detectJourneys_ 的 journey-record 形狀，`basedOnUpdatedAt`＝bump 後的 updatedAt，背景不會重複判），有轉折就**當場** watch→journey 並回「🎉 已升格」，無則回提示更具體。主動寫的轉折不必乾等 3h 節流的背景 sweep（背景之後仍會以 k-means 重新歸戶、保持一致）。升格歷程**依活動時間新→舊排列**（取所屬脈絡 `lastTs`，取代舊的轉折數排序）、候選最多 3 張接在後面；整串**分頁**（`sendJourneyOverviewPage_`）**沿用 /recall 同一套分頁呈現**：每頁卡數由 `searchPageSize_` 依總數縮放（4／6／10），頁碼卡用通用元件 `buildPaginationBubble_`（頁碼視窗 + « first ‹ pre next › last »）**另發一則訊息**接在輪播下方（`lineReplyMessages_`，0-based），postback `action=journey_page&p=N` → `handleJourneyPage_` 重繪、不重跑升格以免換頁時集合變動；故再多歷程也不會撞 carousel 上限 12 而被靜默丟棄；單頁時不發頁碼卡。**卡片內容升級（跨媒介可視化 + 關鍵字分層）**：每張歷程／候選卡 (`buildJourneyOverviewBubble_`／`buildCandidateBubble_`) 現在會（a）以 `journey.summary`（或 watch.summary）取代逐字 evidence 長引號當主敘述；（b）加上**媒介組成 row**（`📝N 🖼️N 🎤N 🎬N 📄N` — 沿用 `EPISODE_TYPE_ICON`，與 /recall episode bubble 同樣式）；（c）有 image／video 紀錄時以**最新一張**作為 hero 縮圖（`drive.google.com/thumbnail?id=…&sz=w600`，4:3 cover，點擊跳原檔），讓跨媒介的脈絡可直接看見；（d）**關鍵字 chip row**（`大類 · 細類1 · 細類2`，`keywordChipsRow_`）放在 marker icons 下方，第一眼就能定位這條歷程的領域。記錄載入：`sendJourneyOverviewPage_` 整輪 `loadEmbeddingRecords_` 一次、用 id-map 配給；bubble 採 lazy build，只實建當頁的卡片，避免換頁時做白工。**`/themes` 主題群組卡 (`Focus.gs:buildFocusBubble_`) 同步升級**：對每個 cluster 找最大重疊的持久脈絡（線性掃 `loadContexts_`），若該脈絡已有 journey/watch 紀錄 → 借用 `keywords` 顯示同一份 chip row（4 層字彙對齊）；若已升格成歷程，header 副標加「🧵 已升格成歷程」標記，讓 /themes 一眼看出哪些群已是歷程、不必每張都點「看升格進度」。兩者皆空才回文字提示（`buildWatchOverviewBubble_`）。`/journey <主題>` 比對既有歷程→該歷程細節，比不到→提示「尚未升格」並導向 /journey、/themes。**舊的 on-demand 手動編織（episode 節點＋接縫 bridged/skipped/pending）整套移除**（`replyJourneyAdhoc_` / `replyJourneyForThread_` / `synthesizeJourney_` / `buildJourneyBubble_` / `handleSeamSkip_` / seam store / `SEAM_STATES` 全刪；`ask_supplement` 為共用，保留但去掉接縫參數）。
- ✅ 升格進度卡（測試輔助）：`contextGapReport_`（`ContextUpgrade.gs`）算單一主題群組距三條件還缺什麼；`/themes` 群卡片按鈕改為「🌱 能不能成脈絡？看進度」→ `handleJourneyCluster_` 出進度卡（三條件 ✅/⬜＋「還缺：再回返 N 次／再加 N 種媒介」）。`runContextUpgradeNow` 也逐群印 `還缺:`。
- ✅ 主動通知：`notifyNewUpgrades_`（掛在 sweep 升格/偵測之後）。背景一旦有**新成形的脈絡或歷程**，就 push 一則摘要給使用者（1對1限定）。用 `meta.notifiedContextIds/notifiedJourneyIds` 累積去重：每個 id 只報一次，閾值邊界抖動不會洗版、不浪費推播額度；沒有新東西就不推。
- ✅ block 5 雙版 story：`ContextStory.gs` + 改寫 `replyStory_`。`/story` 由五層物件產兩份：`_context.md`（脈絡敘事·在想什麼，第一人稱日記）與 `_journey.md`（歷程敘事·學到什麼，每個轉折一個 before→after 學習單元、標出種類）；各存 md＋PDF，回一張卡/版。首次自足：脈絡空則先跑 `upgradeContexts_`（純 CPU），無歷程則跑有上限的 `detectJourneys_`。舊的時間視窗 `summarizeStoryStyle_` / `parseStoryArg_` 已移除。

- ✅ **主題群組新模型（block 5+，2026-05-31 收尾）**：把分群權威從 k-means cluster 換成 LLM 判定的 (大類, 議題標籤)。權威規格見 §0.4.1 / §0.5 / §0.6.2 / §0.6.3 / §0.5.1，本 entry 只列 commit/落地：
  - **block 1 八大類重劃**：`JOURNEY_KEYWORD_CATEGORIES = ['教學','研究','閱讀','反思','札記','生活','規劃','隨想']`（原「進修」改「隨想」）。
  - **block 2 大類歸戶**（`Category.gs`）：`classifyEpisodeCategories_` 按敘事片段成批判，存 `record.category`、判一次永不重判。受每日 LLM 上限保護。`backfillCategoriesForScope_` 一鍵補齊舊資料。
  - **block 3a 議題標籤**（`Topic.gs`）：`classifyEpisodeTopics_` 在大類桶內按片段判 ≤8 字名詞片語，存 `record.topicLabel`；同桶現有標籤當菜單原字沿用以收斂、不發散。
  - **block 3b upgradeContexts_ 改 (大類,議題標籤) group-by**（`ContextUpgrade.gs`）：純 CPU、決定性、巨無霸免疫。**未議題化暫不成群**（避免 catch-all blob，實測曾造成 53 筆假主題混測試/連結/退群）。邊緣淘汰停用。
  - **block 4a 遠端重建**：`rebuild` 命令清 `m:` pin + 衍生資料、用新模型重建脈絡/歷程。命令佇列白名單。
  - **block 5 /themes 三層 UI**（`Focus.gs`，§0.6.2）：L0 大類輪播（一卡一大類）／L1 主題清單／L2 主題詳情（複用 `buildContextCard_` whole 模式）。舊時間範圍菜單與扁平卡保留供歷史 postback。
  - **A. 重分群 gate 修正**（§0.4.2）：閘改看 `max(lastIngestTs, lastClassifyAt)`，背景晚補的分類能折進主題、不必等新訊息。`markClassificationAdvanced_` bump `lastClassifyAt`。
  - **B. 改歸主題**（§0.6.3）：`/recall` 與「看原始紀錄」卡標目前 (大類|議題)；每筆「📌 改歸主題」+ 整段 quick-reply；目標候選按語意相近排序、立即重分群。helper `rankContextsBySim_` / `paginateTopicPicker_` / `buildTopicPickerBubble_` / `setRecordsCategoryTopic_`。
  - **C' 向量輔助分類**（§0.4.1）：大類＋議題兩階 LLM prompt 吃「最近現有脈絡」提示（`Focus.gs:nearestContextHints_` / `contextCentroids_`），治本「夾在無關訊息中的延續句」（5/30 退群片段裡的 AI 後續）被歸到錯誤大類。FLOOR `CONTEXT_HINT_SIM_FLOOR=0.55`。
  - **fix-1 multi-journey 全面去重**（§0.5.1）：`ContextStore.gs:pickJourneyForContext_` / `journeysByContext_`；全系統 `.find(j=>j.contextId===cid)` / `forEach 覆寫` 取代為 helper；detect / merge / absorb 存檔前去重。修「L0 列名 ≠ L2 詳情卡名」。
  - **fix-2 merge/absorb 同大類硬閘**：`shouldMergeJourneyPair_` 與 `absorbCandidatesIntoJourneys_` 加 `themeNormCategory_(A) === themeNormCategory_(B)` 守門。修「教學 91 筆含 34 筆其實不是教學類」（merge union 跨大類）。
  - **L2 全部敘事片段加分頁**（§0.6.2）：取代 `EPISODE_MAX_CARDS=10` 硬截，用 `paginateFlexCards_` 分頁；翻完總和 = 主題卡的 records.length。麵包屑改「大類 > 主題名」。每張敘事片段卡底加 strip。
  - **NUL 位元組事件**（2026-05-31）：`ContextUpgrade.gs` 分群迴圈第 111 行 key 分隔字元混入一個 NUL 位元組，使整檔被當 binary——grep 計數失準、`Edit` 的 `old_string` 一律比不中，於是 3 個宣稱修好「未議題化暫不成群」的 commit（b71f164/bd0e7b5/eecad02）只改到註解、邏輯沒套上、commit 名實不符。最終用 Node 逐位元組替換才真正套上（5bd64e0）。教訓：CJK 檔遇到搬不動的 `Edit` 要立刻檢查 NUL（`fs.readFileSync` + charCodeAt 掃），別反覆嘗試同樣的 `old_string`。

- ✅ **儀式軸/探索敘事段 + inline suggestion + score-gated /ask + freshness UX(2026-06-02 收尾)**:本輪實作對齊 §0.6.6 / §0.6.7 / §0.6.8 與 §0.6.2 freshness 段。從第一批 `/lesson` 設計到最終 `/explore` 全棧 rename:
  - **儀式軸 → 探索敘事段(/explore)**:從討論「lesson 第三軸」起頭,逐步發現「lesson 不是另一條獨立軸,是敘事片段的一種模式」(刻意對齊 /me 視覺),最終全棧 rename: `src/Lesson.gs` → `src/Exploration.gs`(git mv 保留歷史)、`LESSONS_FILE` → `EXPLORATIONS_FILE`、`record.lessonId` → `explorationId`、~40 個 function 名、4 個 meta key 改名。一次性 idempotent 遷移 `migrateLessonToExploration_` 寫進 `activeExploration_` 開頭、首次互動自動跑、後續 no-op。postback (`lesson_view`/`lesson_raw`/`lesson_list`) 與 dispatch (`/lesson`/`/課`) 保留 alias 不失效。內部仍對齊「lesson」一詞於少數註解(描述舊概念脈絡時)與 migration code(必要)。實機驗證: Drive MCP 讀 meta.json 確認 `lessonsMigratedToExplorations: true`、records 改名、explorations.jsonl 新建、舊 lessons.jsonl trashed,42 筆 record 欄位 in-place rename 成功。
  - **空白探索自動刪除**:按錯沒寫東西就關掉的 lesson 會堆雜訊,改為 `closeExploration_` 偵測 0 records → 整列從 jsonl 刪、不發 push、不留延遲告知。`replyExplorationsList_` 防禦性 lazy-prune 舊資料(老 view 帶 0 records 也消失)。
  - **/explore 體感升級**:開始/結束 flex 卡(depth.l1 鐘響 vs depth.l2 收束)、`/explore list` 分頁(`EXPLORATION_LIST_PER_PAGE=8`)+ 關鍵字模糊比 label、改名 (`/explore rename`)、調時長 (`/explore +15`/`-10`/`延長 N`/`縮短 N`,縮到 ≤已過 → 即刻結束)、`EXPLORATION_EXPIRY_WARN` 到期前單次提醒、`pendingExplorationClosedNotice` 延遲告知 fallback。
  - **儀式來源標示三層**(對齊「探索是 metadata、不分離 sandbox」設計):raw 卡 `📚 來自:X`(`buildSearchBubble_` 透 opts.scope)、episode 卡 `📚 屬於:X` 或 `📚 跨 N 探索`(新 helper `explorationLineForEpisode_` 無閾值,1/2/3+ 切文案)、L2 脈絡卡 `📚 主要發生於:X`(沿用 50% 閾值 `dominantExplorationLineForCard_`)、/episodes 索引/月份/日卡 `📚 N 探索`(`distinctExplorationCount_`)。
  - **inline suggestion**:在純文字 ack 上提示「↳ 像在延續『X』?」+ `[併進去] [改選別條]`。兩按鈕重用既有 `rec_link_topic`/`rec_pick_topic` postback(零新 handler);閾值三檔 `SUGGEST_MERGE_MODE = soft(0.85)/on(0.72)/off`;per-脈絡 per-敘事片段 dedup (`CacheService` TTL=`EPISODE_GAP_MS`);exploration 中優先比 lesson 內 mini 聚類(`recomputeExplorationMiniClusters_` 背景 sweep 內跑,k=clamp(round(n/4),1,4));lesson 中 quick reply 末位塞「離開 X」三按鈕共存。
  - **/themes Freshness UX**(§0.6.2 補):「我剛寫的去哪了」問題的多層回應。✨ 徽記用「本次坐下」錨(全語料 max lastTs ± 90 分,且最新一筆在 3h 內才生效)而非固定 24h 窗;preview 排序強制 fresh 置頂 + lastTs 新→舊;大類在 carousel 也按 fresh 置頂;intro 卡狀態行依 pending 切換(「預計下次更新 HH:mm」或「上次更新時間 HH:mm」用 `max(context.updatedAt)` 真實值,不是每次都「剛剛」);「N 筆等待整理」黃色按鈕本身是 postback (`themes_refresh`),點 = 跑 `maybeClassifyCategories_`+`maybeAssignTopics_`+`maybeUpgradeContexts_(true)` 後重渲染;/me 加「🔄 處理中 N 筆」line(共用 `pendingForThemes` 邏輯)。
  - **/ask score-gated**:從 one-shot 升級為 cosine 三檔。校準閾值用 Drive MCP 讀 OWNER 真實 96 條脈絡 `criteria.semanticDensity` 統計後定下 HIGH=0.65/LOW=0.50(對齊 `mediaAttachCosMin=0.55` 與 `semanticDensityMin=0.60`)。LLM-decline fallback 改走 LOW 同款 `replyAskCluesAnnotated_`(不再死在舊 gap card),解「top1=0.88 卻給孤兒線索」死路。`replyAskCluesAnnotated_` overview 卡兩列下一步: 💬 換句話再問(/ask 完整問句、強視覺、垂直堆) + 🔍 搜原始記錄(/recall 名詞、弱視覺、水平 chip);LLM prompt 強制「next_questions 必須完整問句、不能重複原問法、把語料沒寫到的詞替換成語料有的詞」(例: 西班牙→瑞典)、「next_recalls 優先從高分 topicLabel 抽」。每張 clue 卡 body 多 `✦ <註解>` 一行,LLM 看到的 block 行加 `score=0.XX` 前綴讓註解詳略 + 關鍵字選擇明確偏向高分。
  - **校準工具**(透過 Drive MCP 讀檔直接做,免寫 editor function):decode contexts.jsonl base64 → python 統計 semanticDensity 分佈、histogram、cluster size 等,基於真實數據定閾值。`AskCalibrate.gs` 暫不建(觀察期再評估)。

**已確認的操作化預設**（使用者：「按建議的預設走」）
- 升格時機 = 背景排程（掛既有 time-driven sweep）。
- 意向回返 = 群內紀錄依時間切，間隔 ≥ `returnGapMinutes`（20 分）算一次回返、首末跨 ≥ `returnSpanHoursMin`（1h）。含引述回覆（隔久回來補充＝真回返；同坐下立刻更正＝同一次）。bot 不寫 embedding 紀錄、`recordAskQA_` 無 quotedRecordId，故不需特別排除。〔原預設「排除引述補充、gap/span 共用 2h」已於實測校準調整，見上方 build log。〕
- 跨媒介 = 排除貼圖與位置，只算 文字 / 語音 / 圖片 / 影片 / 檔案。
  - 〔2026-05 校準〕原本只數**同一 k-means 主題群組成員**的媒介，但圖片/語音的 embedding 來自 Gemini 描述文（風格／用詞與隨手文字差異大），常被硬分到別群，導致同主題的媒介算不進來、`跨媒介` 永遠卡在 1。改為**語義歸戶**：非文字媒介若與本群群心 cosine ≥ `CONTEXT_CRITERIA.mediaAttachCosMin`（預設 0.55），即計入本群跨媒介（即使 k-means 把它分到隔壁群）；成員媒介仍無條件計入。實作 `attachNearbyMedia_`，`evaluateContextCriteria_` 與 `contextGapReport_` 共用；後者多收一個 `corpusMedia`（全語料非文字媒介）參數，呼叫端（`upgradeContexts_` / `handleJourneyCluster_` / `runContextUpgradeNow`）負責備好。`mediaAttachCosMin` 待用 `runContextUpgradeNow` 的 `media=` 逐群數字校準。
- 轉折偵測 = 每進行中脈絡一次 LLM call、背景跑、每日設上限。
- pending 重評 = 併進背景 sweep。

**五層模型 blocks 1–5 + 主題群組新模型（block 5+）全部落地。** 後續為校準與驗收，不是新建：
- **實測校準**：`CONTEXT_CRITERIA` 三條件閾值、`CONTEXT_MATCH.jaccardMin`、k 粒度（脈絡是否過粗）、轉折偵測 prompt 命中率。先用 `runContextUpgradeNow` / `runJourneyDetectNow` 對真實/模擬語料看數字再調。
- **實機驗收（需先解部署阻塞）**：`/me` 脈絡（候選 N）與歷程數、`/journey` 一覽與細節卡、`/story` 雙版 PDF。Flex 無法在本機預覽，須部署後 LINE 實機看。
- **未做（刻意）**：脈絡↔脈絡之間的接縫（§四）目前未實作——舊的 episode 接縫已隨手動編織移除，`SEAM_STATES` 常數也刪了；未來若要做脈絡間接縫再重建。stale 已升格脈絡的修剪也還沒做（unmatched `context` 保留不刪）。

**⚠️ 部署阻塞**：該 Apps Script 已達 **200 版本上限**，`./deploy.sh` 的 `clasp deploy` 會失敗（`clasp push` 本身成功）。需先到 script.google.com 刪舊版本，才能讓 /exec 部署更新。

---

## 九、UI：記寫時間分布條（strip）

每張代表「某時段紀錄」的卡片，body 最末（footer 之前）統一放一條時間軸 strip，呈現「**本卡的紀錄在所屬範圍裡的位置**」。實作集中在 `Handlers.gs:episodeTimelineStrip_`，三個渲染狀態：

- `◯` 空 bucket（淡灰、`THEME.faint`、字級降一階＝退到背景）
- `●` 同範圍但**不屬於本卡聚焦集**的紀錄（深藍、`THEME.cta`）
- `✓` 本卡**聚焦集**的紀錄（綠、`THEME.success`）

✓/● 都是「位置線索」、不是「筆數」——同一 bucket 內多筆紀錄會合併成一個 glyph，筆數看卡上明文（「本視窗 N 筆／全脈絡 N 筆」「命中 N 筆」）。

### 9.1 各卡型的對應

|卡|X 軸|✓（聚焦）|●（同範圍其他）|strip head 前綴|
|---|---|---|---|---|
|`/themes` 主題群組卡|此脈絡 firstTs..lastTs|本視窗紀錄|視窗外同脈絡紀錄|`所選主題群組`|
|`/recall` 敘事片段卡|此敘事片段 startTs..endTs|命中紀錄|同片段非命中紀錄|`所選敘事片段`|
|`/journey 升格進度` 卡|此脈絡 firstTs..lastTs|`snap.ids` 對應紀錄|脈絡其他紀錄|`所選主題群組`（預設）|
|`/補一轉折` 引導卡|此脈絡紀錄起訖|（無 highlight，全部當聚焦）|—|`所選主題群組`（預設）|
|看原始紀錄（micro）|該記錄所屬片段 startTs..endTs|這一筆|同片段其他筆|`所選紀錄`|
|`/ask` 引用紀錄（micro）|全語料 firstTs..lastTs|這一筆引用|（compact mode：壓掉）|`所選紀錄`|

Strip head 文字格式：`{headPrefix} ┃ {subLabel} 的記寫時間分布`（無 subLabel 退回 `記寫時間分布`）。

### 9.2 視窗 vs 全卡的切分（`highlight` 參數）

`episodeTimelineStrip_({ records, otherRecords, highlight, ... })` 三個來源各自貢獻 ✓/●：

- 有 `highlight`（fromTs/toTs）：把 `records` 切兩半，視窗**內**→ ✓（`mineIn`），視窗**外**→ `●`（`mineOut`）。`/themes` 與 `/journey 升格進度` 走這條。
- 有 `otherRecords`：直接全部當 ●（先過 X 軸範圍過濾）。`/recall`、`看原始`、`/ask` 走這條。
- 兩者並存時 `mineOut` 與 `others` 都顯示為 ●，視覺上同色合流。

✓ 數對應卡上明示的「聚焦筆數」（本視窗 N 筆／命中 N 筆／單筆紀錄）。

### 9.3 Bucket 數量、字級、佈局

- **kilo / mega 卡**：12 個 bucket，cell-based（每格 `flex:1`，edge-to-edge 撐滿卡寬）。✓/● 字級 `lg`、`◯` 字級 `sm`，全部 `weight: 'bold'`。
- **micro 卡**：8 個 bucket（caller 傳 `cardSize: 'micro'`），同樣 cell-based。✓/● 字級 `md`、`◯` 字級 `xs`，仍 `weight: 'bold'`。

⚠️ **不要用「12 格 + 小字級」塞 micro 卡**：跑過兩種失敗——(a) cell-based + xxs 在 LINE Desktop 把 glyph 壓回看不出形狀的小點；(b) span-based 在 micro 寬度下被「…」截斷。「micro = 8 格 + cell-based + md」是兩邊都驗證過能渲染的組合。

⚠️ **不要用 span-based 模式**（`type: 'text', contents: [span…]`）放整條 strip：早期版本 micro 用過、會被 wrap:false + 寬度不足截斷；當前實作只走 cell-based。

### 9.4 Compact mode（壓掉密集 ●）

當 (a) 本卡只佔 ≤2 個 bucket **且** (b) `otherRecords.length > 20`，把 `others` 的 `●` 退回 `◯`，只留 ✓ 位置。設計理由：`/ask` 引用一張 micro 卡 + 全語料當 others 時，●會聚合成密集帶、跟「命中 N 筆」對不上號，沒資訊量。`mineOut`（/themes 視窗外）**永不 compact**——那是本卡自己的紀錄、筆數有意義。

### 9.5 編排位置統一

所有 strip 都放 body 最末、footer 之前，前面接 `{ type: 'separator', margin: 'sm' }`。讀卡邏輯：「先看內容、再看時間位置」。/themes 早期版本把 strip 放在 summary 與 代表片段之間，已移到最末對齊其他卡。

### 9.6 標題與關鍵字的統一格式

跟 strip 不直接相關但同步收斂：卡上凡是顯示「大類 + 關鍵字主題」的地方都用 `大類｜關鍵字1+關鍵字2` 格式（無空白、`｜` 全形、`+` 連接細類）。動到的點：

- `keywordChipsRow_`（/themes、/journey、`/補一轉折`、`/journey 升格進度` 共用）
- `episodeNarrativeGenerate_` 的 LLM prompt（要 Gemini 用 `+` 連，不用「與」「、」），與 `/recall`、`/episodes` 標題渲染
- LLM 必須從 `JOURNEY_KEYWORD_CATEGORIES`（教學／研究／閱讀／反思／札記／生活／規劃／進修）擇一當大類

舊 6 小時 cache 內的 episode narrative 可能還是 `與` 連——cache 過期後自動 roll。

### 9.7 卡片 header 深度色階〔2026-06-09〕

讓 header 底色承載「鑽到第幾層」，與麵包屑（§0.6.5）互為佐證。`/themes` 三階：**L0 大類總覽 → `depth.l1`（亮藍 #3a6ea5）**、**L1 主題清單 → `depth.l2`/`cta`（中藍 #1a4480）**、**L2 主題詳情（`buildContextCard_` whole）→ `depth.l3`（深藍 #0e2a4d）**。鑽愈深底愈暗。例外：進行中脈絡的 L2 仍用 `surfaceSoft` 淺底（「還沒成形」讀起來較輕，刻意不進色階）；故 `buildContextCard_` 的字色判斷用「`headerBg !== surfaceSoft`」（是否深底）而非「`=== cta`」，免得深底配深字看不見。`cta` 與 `depth.l2` 同 hex 不再是問題：header 走 depth 色階＝層級語義、`cta` 留給按鈕/強調，硬改 hex 反而波及所有按鈕，不動。

**背景主動 push 簽名**：`notifyNewUpgrades_`（綠 header）與 `notifyMergedJourneys_`（藍 header）都在 header 頂加一行小字「🔔 背景自動整理」——一眼認出是背景主動通知、不是回覆卡。

---

## 十、UI：列表卡分頁的尺寸守則（`paginateFlexCards_`）

`/themes`、`/journey` 等列表把多張卡塞進 LINE Flex carousel 時，**LINE 對 carousel 的 JSON 大小限制是 50 KB（UTF-8 bytes）**。`Handlers.gs:paginateFlexCards_` 在 `searchPageSize_(total)` 給的「卡數上限」之外，再以 **48 KB 安全線** 做動態縮頁——任一頁會超過就把 pageSize 往下調，直到所有頁都塞得進。

⚠️ **量大小一定要算 UTF-8 byte 長度、不要用 JS string `.length`**：JSON.stringify 的結果裡中文字一個 char 但 UTF-8 是 3 bytes，用 string length 會低估 3 倍、漏判過大。`utf8ByteLength_` 處理這件事。

策略確定後 pageSize 是純函式（同樣資料 → 同樣 pageSize），所以分頁跨 hop 穩定，不會因換頁重算而跳。
