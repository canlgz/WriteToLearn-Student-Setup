# 學習歷程 schema v2 — 從「裝飾過的脈絡」到「軌跡物件」（提案）

> ⚠️ **狀態：討論中 · 尚未實作 · 非權威規格。**
> 權威規格仍以 `context-to-journey.md` §零 為準。本文是設計提案，
> 待討論收斂 → 實作 → 使用者驗收 OK 後，才把確定的部分收進 §零。
> 來源：2026-06-02 session 一連串「engagement vs learning」「位移偵測」討論的收束。

## 0. 一句話問題

現在 `journey = 一個脈絡 + 幾張「有出現轉折」的貼紙`。學習歷程的靈魂——
**「你從 A 理解 → 走到 B 理解，可能跨主題，有形狀、有驅力」**——在 schema 裡**沒有任何欄位**。
偵測得再準也沒地方放。這份提案讓 journey 物件**長出那些欄位**，演算法（含位移偵測）才有著陸點。

**不動的前提**：
- 脈絡（cluster）維持 **1:1、不准 merge**（154-blob 的疤，別揭）。
- 跨主題用**邊（edge）**表示，**永不搬動 cluster 成員**。
- markers 保留，但**改角色**：從「歷程本身」降為「支持 spine／edge 的證據」。
- 縱向訊號不足就**不硬編**（spine 抽不出 → 維持 watch，不捏造）。

---

## 1. 現有 schema（as-is）

```jsonc
{
  "id": "...", "contextId": "...",          // 1:1 指向一條脈絡
  "label": "...", "title": "...", "summary": "...",
  "keywords": { "category": "...", "tags": [...] },
  "basedOnUpdatedAt": "...",
  "markers": [                               // ← 目前「歷程」幾乎就等於這個 list
    { "type": "後設反思", "evidence": "...原話...", "confidence": 0.95, "detectedAt": "..." }
  ],
  "status": "journey"                        // journey | watch
}
```

**侷限**：markers 是**並列清單**，不是軌跡；沒有「從→到」、沒有形狀、沒有跨主題邊、沒有驅力。
而 marker 型別裡偏偏有「跨主題整合」——但 1:1 釘死，結構上根本跨不了主題（最尖的內在矛盾）。

---

## 2. v2 schema（提案）

```jsonc
{
  "id": "...", "contextId": "...",           // 不變：仍 1:1 指向 cluster
  "label": "...", "title": "...", "summary": "...",
  "keywords": { "category": "...", "tags": [...] },
  "basedOnUpdatedAt": "...",

  // ── 新增 1：軌跡主幹（v1 必做、最高槓桿）─────────────────
  "spine": {
    "from": "AI 是幫我省時間的工具",          // T1 的框法（baseline）
    "to":   "AI 在改寫『原創/創作』的定義",    // T2 的框法
    "type": "reframe",                       // reframe|abstraction-up|stance-reversal|question-closed|integration|know-to-do
    "confidence": 0.78,
    "fromRecordId": "a1f07c33",              // 錨：哪則代表「這裡」
    "toRecordId":   "c5e4a3d1",              // 錨：哪則代表「那裡」
    "detectedAt": "..."
  },

  // ── 新增 2：跨主題的邊（v1 必做、解內在矛盾）───────────────
  // 跨主題整合「不併群」：在兩條脈絡之間生一條邊，cluster 成員不動。
  "edges": [
    {
      "toContextId": "eb634c75",             // 連到另一條脈絡（如「形成性評量」）
      "kind": "integration",
      "evidence": "審查標準被 AI 逼高，跟我課堂評量『標準該多高』是同一個問題",
      "confidence": 0.71,
      "detectedAt": "..."
    }
  ],

  // ── 新增 3：階段／形狀（v1.1、可為空）───────────────────
  "phases": [
    { "phase": "open",        "recordIds": ["a1f07c33"], "ts": "..." },
    { "phase": "struggle",    "recordIds": ["4c9a8e15"], "ts": "..." },
    { "phase": "turn",        "recordIds": ["93f5c1e8"], "ts": "..." },
    { "phase": "consolidate", "recordIds": ["c5e4a3d1"], "ts": "..." }
  ],

  // ── 新增 4：驅力（v1.1、可為空）─────────────────────────
  "trigger": {
    "kind": "reading",                       // reading|contradiction|conversation|exploration|action
    "ref": "TIPO 簡報 / 專利衝擊投影片",
    "evidence": "上午查了 TIPO，找 AI 與專利審查的公開說明",
    "explorationId": null
  },

  // ── 保留但改角色：markers = spine/edge 的「證據庫」，不再是歷程本身 ──
  "markers": [
    { "type": "後設反思", "evidence": "...", "confidence": 0.95, "supports": "spine", "detectedAt": "..." },
    { "type": "跨主題整合", "evidence": "...", "confidence": 0.71, "supports": "edge:eb634c75", "detectedAt": "..." }
  ],

  "status": "journey"                        // 不變
}
```

---

## 3. 每個欄位：怎麼產生 · 誰寫 · 餵到 story 哪

| 欄位 | 新? | 是什麼 | 怎麼產生 | 誰寫（函式/路徑） | 餵到 `_journey.md` 哪 |
|---|---|---|---|---|---|
| `contextId` | 既有 | 1:1 指向的脈絡 | clustering | `ContextUpgrade` | （錨，不直接顯示） |
| `label/title/summary` | 既有 | 命名＋一句摘要 | LLM | `detectContextMarkers_` | 卡標題 |
| `keywords` | 既有 | 大類＋細類 chip | LLM | `detectContextMarkers_` | chip row |
| `markers[]` | **改角色** | 轉折證據（原話＋型別＋分數＋`supports`） | 即時評鑒／背景偵測 | 補一個轉折 / `JourneyDetect` | 證據引用（支撐 spine/edge） |
| `status` | 既有 | watch / journey | 升格閘（改兩軸，見 §4） | `JourneyDetect` | — |
| **`spine`** | ✅ v1 | 這條歷程的位移主幹（從→到） | 開卡抽 baseline(T1) ＋ draft 對照(T2)；背景則早/晚窗對照 | 補一個轉折即時評鑒 / `detectDisplacement_`(新) | **主線那句「你從 X 走到 Y」** |
| **`edges[]`** | ✅ v1 | 跨主題整合連結（不併群） | 「跨主題整合」marker 觸發 → 找**最相符的他群** context，過 confidence 閘才連 | `JourneyDetect`（新 edge pass） | 「這段跟你另一條『Z』接起來了」 |
| **`phases[]`** | v1.1 | 起/卡/轉/收 時間骨架 | records 按時間切 ＋ marker/spine 錨點落位 | 背景 | 學習單元結構（分段） |
| **`trigger`** | v1.1 | 觸發位移的驅力 | LLM 從 spine 前後文找；或補充時直接問 | 背景 / 補一個轉折 | 「因為讀了…／卡在…」一句 |

---

## 4. 升格閘改寫（context → journey）：兩軸取代「有 marker 就過」

| | 現在 | v2 |
|---|---|---|
| candidate → context | 三條件（密度/回返/跨媒介） | **不變** |
| context → journey | 偵測到 ≥1 marker | **`spine` 為真（真的移動）∧ 至少一條 marker 形狀像樣（≥0.60）** |
| 跨主題 | （無法表示） | 形成 `edge`（獨立於升格，自己的 confidence 閘） |

打掉的假陽性：**「寫了漂亮反思句但什麼都沒變」**（marker 高、spine 空）→ 不升格、留 watch。
（spine 偵測法見 `context-to-journey.md` §0.6.9 旁註與本 session 討論：baseline(T1) 對照 draft(T2)，
LLM 出位移分＋fromTo，配便宜結構檢查做**非對稱上修**，不下扣。）

---

## 5. 「補一個轉折」卡在 v2 的角色（偵測即介入）

開卡 → 抽 `spine.from`（baseline）並**攤給使用者看**：
> 「你最早對 X 是這樣寫的：『…』。**現在呢？跟那時比，變了嗎？**」

- 即時評鑒對象 = `draft` **相對** baseline 的位移（不是 digest+draft 黏一坨判 marker）。
- 達標升格時：`spine.to` = 使用者剛寫的、`spine.from` = 他自己最早的話 → **from→到由學習者親筆**（「適當」）。
- 鷹架（卡住時）給**對比骨架**：「我原本以為 ___，現在我覺得 ___，因為 ___」。

---

## 6. 跨主題邊（edge）的「不 blob」護欄

| 規則 | 為什麼 |
|---|---|
| edge 只**連結**，**永不搬動** cluster 成員 | 維持 1:1、不重演 154-blob |
| edge 有自己的 `confidence` 閘（嚴於升格） | 錯連的代價小（一條線），但仍要擋亂連 |
| edge 是**有向**的（A 的整合句指向 B） | 保留「誰在整合誰」，可雙向各記各的 |
| 同一對 (A,B) 去重 | 避免每輪 sweep 重複長邊 |

---

## 7. 落地分期（建議）

- **v1（高槓桿、先做）**：`spine` ＋ `edges` ＋ 升格閘兩軸 ＋ 補一個轉折卡改「給你看最早的話」。
- **v1.1（補形狀與因果）**：`phases` ＋ `trigger`（都可為 null，不阻塞 v1）。
- **story v2**：`_journey.md` 主線改由 `spine` 驅動，跨主題段由 `edges` 生，驅力由 `trigger` 帶。

## 8. 已知風險／前置依賴

1. **上游 clustering 不乾淨 → spine/edge 都是噪音**。混群時「位移」可能只是滑到別子題。位移偵測**先決於** cluster 乾淨度。
2. **薄脈絡無 T1** → `spine` 抽不出 → 維持 watch、退回現行 marker 模式，**不捏造 baseline**。
3. **LLM 對位移會橡皮圖章** → A 軸需便宜結構檢查（draft 對 baseline 真的有對比/否定/抽象），非對稱上修。
4. **遷移**：既有 journeys 沒有 spine/edges → 欄位可為 null；背景 sweep 漸進回填，不一次性重算。

## 9. 用現有資料舉一個具體例（AI 研習班那批）

脈絡「AI 與專利審查」（5/26–5/28）：
```jsonc
"spine": { "from": "AI 是省時間的工具", "to": "AI 在改寫『原創/創作』的定義", "type": "reframe", "confidence": 0.78 },
"edges": [ { "toContextId": "<形成性評量/標準那條>", "kind": "integration",
             "evidence": "審查標準被 AI 逼高，跟課堂評量『標準該多高』同一問題", "confidence": 0.71 } ],
"trigger": { "kind": "reading", "ref": "TIPO 簡報 / 專利衝擊投影片" }
```
→ story 主線：**「你從『把 AI 當工具』走到『AI 在改寫創作的定義』；而且這跟你一直在想的『課堂評量標準』接上了。」**
（對照現狀：現在只會說「這條脈絡有後設反思、行動指向兩張貼紙」。）
