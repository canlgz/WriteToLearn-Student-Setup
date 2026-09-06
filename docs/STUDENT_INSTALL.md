# WriteToLearn 學生完整安裝指南

本指南會帶你建立一套只屬於自己的 WriteToLearn。請依序完成，**不要共用**老師或同學的 LINE token、Gemini API key、Apps Script 專案或 Drive 資料夾。

預計時間：45–60 分鐘。完成後請保留此頁，日後更新與除錯都會用到。

## 0. 安裝前檢查

- [ ] 我已準備 Google 帳號、LINE 帳號、手機 LINE App 與電腦。
- [ ] 我可以建立 Gemini API key；若學校帳號受限制，改用個人 Google 帳號。
- [ ] 我已安裝 [Node.js LTS](https://nodejs.org/)，終端機輸入 `node --version` 會顯示 v20 或更高版本。
- [ ] 我了解：這套 Bot 呼叫 Gemini；免費額度是否足夠取決於 Google 的帳戶與用量政策。不要將 API key 給任何人。

## 1. 建立 LINE Messaging API channel

### 1.1 建立 Provider 與 channel

1. 開啟 [LINE Developers Console](https://developers.line.biz/console/)，用自己的 LINE 帳號登入。
2. 選 **Create a new provider**；名稱可填「我的 WriteToLearn」。若已有 Provider，選它即可。
3. 按 **Create a Messaging API channel**。
4. 依畫面填寫必填欄位；Channel name 建議填 `我的 WriteToLearn`。電子郵件填自己的；隱私權政策／服務條款若沒有網站，可依 LINE 畫面允許的方式略過或填課程提供的頁面。
5. 同意條款並建立。不要建立 LINE Login channel；本專案要的是 **Messaging API channel**。

### 1.2 取得 LINE 憑證與調整開關

在剛建立的 channel 內：

1. 到 **Basic settings**，找到並暫存 **Channel secret**。本版 GAS 因平台限制不會讀取 HTTP header 驗簽，但仍應妥善保存，不要公開。
2. 到 **Messaging API** 分頁，找到 **Channel access token** 區塊，優先 Issue **Channel access token v2.1** 並自行設定到期日；若你的帳號畫面沒有此選項，再使用 long-lived token。複製並暫存，這個值稍後會寫入 Apps Script。
3. 同一頁將 **Auto-reply messages** 與 **Greeting messages** 都關閉，避免 LINE Official Account 的自動回覆／歡迎訊息與 Bot 回覆重複。
4. 先不要填 Webhook URL，也**先不要加 Bot 好友**；要等第 5 節部署完成後，第一次加好友的 `follow` 事件才會自動認領你的 owner 身分。

完成標記：

- [ ] 我有自己的 Channel access token，且沒有貼到聊天群組、截圖或 GitHub。
- [ ] 我已關閉 Auto-reply messages 與 Greeting messages。

## 2. 建立 Gemini API key

1. 開啟 [Google AI Studio API keys](https://aistudio.google.com/app/apikey)。
2. 按 **Create API key**；建議新建或選擇自己的 Google Cloud project，讓課程用量與其他工作分開。
3. 複製 API key 並暫存。請勿提交到 GitHub、寫進 `.gs` 檔或傳給其他人。

完成標記：

- [ ] 我有自己的 Gemini API key。

## 3. 建立自己的 Apps Script 專案並上傳程式

### 3.1 取得這份程式碼

1. 在本 repository 的頁面按 **Code → Download ZIP**，解壓縮到容易找到的資料夾；或用 Git clone：

   ```bash
   git clone https://github.com/canlgz/WriteToLearn-Student-Setup.git WriteToLearn
   cd WriteToLearn
   ```

2. 開啟終端機，切換到剛解壓縮／clone 的 `WriteToLearn` 資料夾。

### 3.2 用 clasp 建立自己的 Apps Script 專案

在該資料夾依序執行：

```bash
npm install --global @google/clasp
clasp login
clasp create --type standalone --title "My WriteToLearn" --rootDir src
clasp push
```

說明：

- `clasp login` 會開啟瀏覽器，請選擇**自己要擁有這套 Bot 的 Google 帳號**並同意授權。
- `clasp create` 會建立一個全新的 Apps Script 專案，並在本機產生 `.clasp.json`。此檔只識別你的專案，已被 `.gitignore` 排除，絕對不要上傳。
- `clasp push` 會把 `src/` 的所有 `.gs` 檔及 `appsscript.json` 上傳。看到 `Pushed ... files.` 才算成功。

若 `clasp` 顯示找不到指令，關閉並重開終端機後再試；或將每個 `clasp` 改寫為 `npx @google/clasp`。

### 3.3 開啟自己的專案

執行：

```bash
clasp open-script
```

瀏覽器會開啟你剛建立的 Apps Script 專案。確認左側檔案清單至少包含 `Main.gs`、`Config.gs`、`Setup.gs`、`LineClient.gs` 與 `appsscript.json`。

完成標記：

- [ ] 我已用自己的 Google 帳號建立 Apps Script 專案。
- [ ] `clasp push` 成功，且編輯器可看到程式檔。

## 4. 填入私密設定並完成首次授權

### 4.1 儲存 Script Properties

在 Apps Script 編輯器：**Project Settings（齒輪）→ Script properties → Add script property**。新增以下兩筆；Key 必須完全相同：

| Key | 填入內容 |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | 第 1 節取得的 LINE long-lived Channel access token |
| `GEMINI_API_KEY` | 第 2 節建立的 Gemini API key |

不要手動填 `DRIVE_ROOT_FOLDER_ID`、`OWNER_LINE_USER_ID` 或 `WEB_APP_EXEC_URL`；後續流程會建立或設定它們。

### 4.2 建立資料夾並測試 Gemini

1. 回編輯器，在上方函式下拉選單選 `setupDriveFolder`，按 **Run**。
2. 第一次執行會出現 Google 授權畫面。選自己的帳號，依指示允許 Drive、外部請求與排程權限。若出現「Google hasn’t verified this app」，這是你自己的 Apps Script 專案，依畫面進入 Advanced 並允許即可。
3. 按 **Execution log**，確認有 `Created folder:` 或 `Existing folder:`，並能開啟自己的 `LineBot-Journal` Drive 資料夾。
4. 將函式切換為 `setupSmokeTest`，按 **Run**。Execution log 應有 `Embedding dims: 768` 以及 Gemini 的回覆。

若出現「找不到模型」或模型 404：在函式下拉選單執行 `listGeminiModels`，從 log 找一個支援 `generateContent` 的 `gemini-...` 名稱；回到本機的 `src/Config.gs`，把 `GENERATION: 'gemini-2.5-flash'` 改成該名稱，儲存後執行 `clasp push`，再重跑 `setupSmokeTest`。不要把 API key 放進程式碼。

完成標記：

- [ ] 我的 Drive 已出現 `LineBot-Journal` 資料夾。
- [ ] `setupSmokeTest` 成功，顯示 768 維 embedding 與 Gemini 回覆。

## 5. 部署 Web App，並接上 LINE webhook

### 5.1 部署 Apps Script Web App

1. Apps Script 右上按 **Deploy → New deployment**。
2. 齒輪的 deployment type 選 **Web app**。
3. 設定：

   | 欄位 | 選項 |
   | --- | --- |
   | Execute as | **Me**（你自己的帳號） |
   | Who has access | **Anyone** |

4. 按 **Deploy**，若要求授權請完成。
5. 複製結尾為 **`/exec`** 的 Web app URL。不要用 `/dev`；它只供登入中的開發者測試，LINE 無法呼叫。
6. 回到 **Project Settings → Script properties**，新增 `WEB_APP_EXEC_URL`，Value 填剛複製的完整 `/exec` URL。

### 5.2 把 Webhook URL 填回 LINE

1. 回到 LINE Developers Console → 自己的 Messaging API channel → **Messaging API**。
2. 在 **Webhook settings → Webhook URL** 貼入完整 `/exec` URL，按 **Update**。
3. 按 **Verify**。成功會顯示 `Success`；LINE 的測試請求沒有訊息事件，這是正常的。
4. 將 **Use webhook** 切為 **ON**。

若 Verify 失敗，先確認網址是 `/exec`、部署存取權是 `Anyone`，再重新部署並更新 URL。詳見第 7 節。

### 5.3 第一次加好友與自動認領 owner

1. 在手機 LINE 掃 Messaging API 頁面的 QR code，將 Bot 加為好友。若你在第 1 節已經加過，請先封鎖／刪除 Bot，再重新加回來，讓 LINE 重新送出 `follow` 事件。
2. Bot 應回傳歡迎卡，並顯示「已將你設為主人（OWNER）」。這一步會自動把你的 LINE user ID 存入 Script Properties；**不需要**從 log 找 user ID，也不需要手動改程式。
3. 再傳 `哈囉`，它應回覆已記錄文字的訊息。

> 為何要鎖定 owner？你的 Bot 有 API 使用成本與私人學習資料；第一個在 webhook 啟用後加好友的人會成為 owner。請在課堂中只讓學生用自己的 Bot 掃碼，不要先讓其他人加好友。

完成標記：

- [ ] LINE Webhook Verify 成功，Use webhook 為 ON。
- [ ] Bot 對我傳的 `哈囉` 有回應。
- [ ] 歡迎卡顯示我已被設為 OWNER。

## 6. 完成驗收

請在 LINE 逐項測試：

- [ ] 傳文字：`今天讀了 transformer attention`，收到記錄回覆。
- [ ] 傳一張筆記照片，收到 OCR 或描述摘要。
- [ ] 傳 10–30 秒語音，收到逐字稿摘要。
- [ ] 傳 `/now`，看到今天的重點。
- [ ] 傳 `/recall transformer`，看到自己的相關紀錄。
- [ ] 傳 `/help`，看到指令說明。

選做：在 Apps Script 編輯器執行 `setupRichMenu`，為自己的 Bot 建立下方選單。執行一次即可；若想重設先執行 `deleteAllRichMenus`。

## 7. 常見問題

| 現象 | 先檢查 |
| --- | --- |
| `clasp: command not found` | Node.js 是否已安裝；重開終端機；或改用 `npx @google/clasp ...`。 |
| `Unknown command "clasp open"` | 使用現行指令 `clasp open-script`。 |
| `clasp push` 失敗 | 確認自己位於 repository 根目錄、已 `clasp login`，且 `.clasp.json` 存在。 |
| `Missing Script Property` | Key 名稱是否完全相同、沒有多餘空白；填完後再重跑函式。 |
| `setupSmokeTest` 出現 403／模型錯誤 | API key 是否有效；到 AI Studio 確認 key 所屬專案與 API 存取；執行 `listGeminiModels`，依第 4.2 節更新 `src/Config.gs` 的模型名稱後 `clasp push`。 |
| LINE Verify 失敗 | URL 必須以 `/exec` 結尾；Web App access 選 `Anyone`；重新部署後要更新 LINE Console 的 URL。 |
| Bot 沒回覆 | LINE 的 Use webhook 是否 ON；Apps Script 的 Executions 是否出現 `doPost`；Script Properties 是否正確。 |
| 媒體訊息失敗 | LINE 的媒體連結會過期，請上傳後盡快選處理方式；單檔請小於 10 MB。 |
| Bot 沒顯示 OWNER 歡迎卡 | 確認 Use webhook 已 ON；先封鎖／刪除 Bot，再掃 QR code 重新加好友。 |
| 朋友也能用我的 Bot | 檢查自己是否先在 webhook 啟用後加入 Bot；也不要把 token 或 `/exec` URL 公開。 |

## 8. 日後更新程式

在本機 repository 內：

```bash
git pull
clasp push
```

之後在 Apps Script **Deploy → Manage deployments**，編輯既有 Web app deployment 並建立新版本。不要重複建立 New deployment，這樣可保持 `/exec` URL 不變，也不必重新設定 LINE webhook。

`LINE_CHANNEL_ACCESS_TOKEN`、`GEMINI_API_KEY`、`.clasp.json` 和部署 URL 都是每個學生自己的，不會因 `git pull` 被覆寫。
