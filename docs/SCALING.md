# 擴展性備忘 — 紀錄筆數規模上來時的瓶頸與對策

目前架構是「單一 chat 對一份 `embeddings.jsonl`、所有運算 in-memory」。對 MVP 完全夠用，但筆數爆量時會撞到不同瓶頸。先把分析記下來，之後實際撞牆再依序處理。

## 各操作的成本曲線

| 操作 | 1K 筆 | 10K 筆 | 100K 筆 | 瓶頸 |
| --- | --- | --- | --- | --- |
| **寫入新紀錄** | <1s | 5–10s | >60s (超時) | `appendEmbeddingRecord_` 每次 `setContent` 整檔重寫 — O(N) per append |
| **`/search`** | 1–2s | 5–10s | 慢但堪用 | `topKByQuery_` cosine 過全部 — O(N·D) |
| **`/themes` K-means** | ~10s | ~100s | 不可行 | O(N · k · D · iter)，未做 sub-sampling 前 |
| **`/week` `/month` 總結** | OK | OK | 觸 token 上限 | 所有紀錄塞單一 Gemini prompt |
| **`/me` dashboard** | <1s | 2–3s | 10+s | 整檔讀入算統計 |

D = 768（embedding 維度），k = 2–8（focus 群數），iter = 20。

## 三層解法

### 🅐 短期（不動架構）

| 改動 | 範圍 | 狀態 |
| --- | --- | --- |
| `/themes` 預設限 90 天，新增 `all` 表示不限制 | Focus.gs `resolveFocusRange_` | ✅ 已做 |
| K-means sub-sampling：N > 2000 時抽 1000 筆跑迭代，最後 O(N) 一次性分派 | Focus.gs `kmeansCluster_` | ✅ 已做 |
| `/search` 預先過濾時間段（例如 `/search foo last30`） | 未做 | 等需要時做 |

### 🅑 中期（檔案分片）

把 `embeddings.jsonl` 按月分檔：

```
chat-folder/
  embeddings/
    2026-05.jsonl
    2026-06.jsonl
```

- **append 只動當月檔** → O(月內筆數) 而非 O(N)
- **`/today` `/week` `/month` 只 load 對應月份的 shard** → 節省 IO
- **`/search` / `/themes` 仍會掃全部，但分片後 GAS 的 in-memory cache 行為較好**

範圍：`DriveStore.gs` 改 ~30 行；上層 API 不變。觸發時機：寫入單筆超過 5s 或筆數過 5K。

### 🅒 長期（真 vector DB）

筆數 10K+，K-means 即使有 sub-sampling 也不夠用，且 `/search` 完整掃描變慢：

| 方案 | 說明 | 成本 |
| --- | --- | --- |
| Vertex AI Vector Search | GCP 託管 ANN | 付費 |
| Pinecone / Weaviate | 第三方向量 DB | 付費 |
| BigQuery + cosine UDF | SQL 化檢索 | GCP 付費 |
| SQLite via Apps Script | hack，不推薦 | 免費但維護爛 |

超出免費 MVP 範圍；到這規模應重新審視整體架構。

## 已做的 sub-sampling 機制

`src/Focus.gs:kmeansCluster_` 流程：

1. 若 `N > FOCUS_SAMPLE_THRESHOLD (2000)`：Fisher-Yates 隨機抽 `FOCUS_SAMPLE_SIZE (1000)` 筆
2. 在 sample 上跑 K-means 迭代（≤ 20 iter，或收斂提前停）
3. 最後拿收斂的 centroids，對**全部** N 筆做一次 O(N·k·D) 的分派

複雜度從 `O(N · k · D · iter)` 降到 `O(S · k · D · iter + N · k · D)`，S = 1000 為上限。N=10000 時：
- 之前 ~100s；之後 ~10s（5s sample iter + 5s 終次分派）。

## 觀察指標（撞牆指標）

下面情況請考慮升級到 🅑：

- `/me` dashboard 載入 > 3s
- 上傳媒體後寫入 step > 5s（GAS Executions 看 doPost 持續時間）
- `embeddings.jsonl` 單檔 > 30 MB

下面情況考慮 🅒：

- 上述指標翻倍且 🅑 已上線
- Gemini context window 在 `/month` 全月總結時打到上限

## 不做的優化（已考慮過排除）

- **Embedding 量化 (int8 / binary)**：壓 jsonl 大小但要改 cosine 算法，性價比低
- **MongoDB / Firestore**：GAS 連線麻煩，不如直接上 GCP-managed 向量 DB
- **預計算群組快取**：群組會隨新紀錄變動，cache invalidation 成本不見得低於重算
