# 維護者參考：舊版 Setup Guide

> **學生請不要使用本頁。** 請改依 [學生完整安裝指南](STUDENT_INSTALL.md) 操作；該指南已依現行 clasp 與 LINE 的流程校正，並包含自動認領 owner 的正確順序。本頁保留給維護者核對舊版設定紀錄。

完整佈署步驟。預估 20–30 分鐘。

## 1. 申請 LINE Messaging API channel

1. 進入 [LINE Developers Console](https://developers.line.biz/console/)。
2. 建立 Provider → 建立 Messaging API channel。
3. **Basic settings** 頁面記下：
   - Channel secret
4. **Messaging API** 頁面：
   - 點 Issue 取得 Channel access token (long-lived)
   - 關閉「Auto-reply messages」（避免 LINE 自動回的歡迎訊息蓋掉你的回覆）
   - 開啟「Webhooks」（稍後再填 URL）
5. 用 LINE 手機 App 掃 QR code 加 Bot 好友。

## 2. 申請 Gemini API key

1. 進入 [Google AI Studio](https://aistudio.google.com/app/apikey)。
2. 建立 API key（建議建立新 GCP project 隔離用量）。
3. 記下 key。

## 3. 建立 Apps Script 專案

### 方式 A：網頁手動

1. 進入 [script.new](https://script.new) 建新專案。
2. 把 `src/` 內每個 `.gs` 檔的內容貼到 Apps Script 編輯器對應的新檔。
3. 在「專案設定 → 顯示 `appsscript.json`」勾選後，把 `src/appsscript.json` 貼到清單裡的 `appsscript.json`。

### 方式 B：用 clasp（推薦）

```bash
npm i -g @google/clasp
clasp login
clasp create --type standalone --title "LINE Learning Journal" --rootDir src
# 把產生的 .clasp.json 中的 scriptId 貼進這個 repo 的 .clasp.json
clasp push
```

## 4. 設定 Script Properties

Apps Script 編輯器 → 左下角齒輪「Project Settings」→ 拉到底「Script Properties」→ Add Script Property，加入：

| Key | Value |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | 步驟 1 取得 |
| `GEMINI_API_KEY` | 步驟 2 取得 |

> `DRIVE_ROOT_FOLDER_ID` 和 `OWNER_LINE_USER_ID` 之後會自動 / 手動填入。

## 5. 建立 Drive 資料夾 + 測試 Gemini

在編輯器，從上方下拉選擇函式：

1. 跑 `setupDriveFolder` → 第一次會跳出 OAuth 授權頁，按通過即可。執行記錄會顯示 Drive 資料夾的 URL，順手打開確認。
2. 跑 `setupSmokeTest` → 應該看到 `Embedding dims: 768` 和一段 Gemini 回覆。

> **關於那次授權**：因為 `appsscript.json` 已宣告完整 scopes（含 `script.scriptapp`），這一次同意就涵蓋了「建立排程 (trigger)」的權限。之後**第一次收到訊息時，背景自動轉錄排程（每 5 分鐘）會自行安裝**——使用者上傳圖片／語音後若 5 分鐘內沒選處理方式，系統會自動以預設處理並把結果 push 給他。**全新部署不需要手動裝排程**；`installBackgroundSweep` 只是手動後備。
>
> （僅限「既有專案在加入此 scope 之前就授權過」的情況，才需要在編輯器手動執行一次 `installBackgroundSweep` 重新同意，補上新權限。）

## 6. 部署為 Web App

1. 編輯器右上「Deploy → New deployment」。
2. 類型選 **Web app**。
3. Execute as：**Me**；Who has access：**Anyone**。
4. Deploy → 複製 `/exec` 結尾的 URL。

> **固定 `/exec`（推薦，之後最省事）**：第一次部署後，到「部署 ▸ 管理部署作業」複製這個 Web app 部署的 **Deployment ID**，存進專案根目錄的 `.deployment-id` 檔（已 gitignore）。之後改程式只要本機跑 `./deploy.sh`（需先裝 clasp、設好 `.clasp.json`），它會 push + 更新「同一個」部署 → `/exec` URL 不變、LINE webhook 不必重設。
>
> 若你都用網頁手動改碼：每次請**更新既有 deployment 的版本**（不要每次都 New deployment，否則 URL 會變、得重設 webhook）。

## 7. 設定 LINE Webhook

1. 回 LINE Developers Console → Messaging API 分頁 → Webhook URL 貼上 `/exec` URL。
2. 按 Verify（會送一筆空 events 過去，預期 200）。
3. 確認 Use webhook 是 **ON**。

## 8. 鎖定擁有者

1. 用你的 LINE 傳「哈囉」給 Bot。Bot 應該回 `✓ 已記錄文字…`。
2. 回編輯器 → 執行 → 記錄。最後一筆 doPost 的 log 裡可看到 `source.userId`（也可以加一行 `console.log(JSON.stringify(ev))` 觀察）。
3. 在編輯器執行 `setOwner("U....")` 把你的 userId 鎖進 Script Properties，之後其他人傳訊息就會被忽略。

## 9. 設定下方選單（Rich Menu）

選單圖與點擊區都在 `src/RichMenu.gs`。設定方式擇一：

- **編輯器**：選函式 `setupRichMenu` 執行一次（建立選單、上傳圖、設為所有人的預設）。要重設先跑 `deleteAllRichMenus`。
- **不開編輯器**：在 Drive 的 chat 資料夾放一個檔名 `_cmd.txt`、內容寫 `richmenu.setup`，下一輪背景排程（每 5 分）會自動重建（白名單動作，見 `src/Report.gs` 的 `runWhitelistedAction_`）。

想換成自己的選單圖：把一張 **2500×1686、< 1 MB** 的 PNG/JPEG base64 後填進 `RICHMENU_PNG_BASE64`、點擊區改 `RICHMENU_DEF.areas`（`tools/gen_richmenu.py` 是用 Pillow 產圖＋自動寫回的範例腳本）。

## 10. 驗證

傳這些測試訊息：

- 文字：「今天讀了 transformer attention」→ 應回 `✓ 已記錄文字`
- 圖片：手寫筆記照片 → 應回 OCR / 描述前 120 字
- 語音：對著手機講 30 秒 → 應回逐字稿前 120 字
- PDF：丟一個學習 PDF → 應回摘要前 120 字
- `/now` → 目前記事（今日重點）；`/recall transformer` → 相似紀錄
- `/themes` 主題群組 → `/journey` 學習歷程 → `/portfolio` 學習歷程總冊

## 故障排除

| 症狀 | 可能原因 |
| --- | --- |
| Bot 沒回應 | 看 GAS 執行記錄；最常見是 `OWNER_LINE_USER_ID` 設錯或 Script Properties 沒填 |
| `Missing Script Property: GEMINI_API_KEY` | 沒填或拼錯 key |
| Gemini 403 | API key 對應的 GCP 專案未啟用 Generative Language API |
| LINE Webhook Verify 失敗 | Web App 部署時 access 沒選 Anyone，或 URL 沒選 `/exec` 版本 |
| 媒體訊息一直失敗 | LINE 媒體 5 分鐘後過期，下載失敗；或檔案太大（>10 MB）|
