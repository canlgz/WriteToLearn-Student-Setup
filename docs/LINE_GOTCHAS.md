# LINE Messaging API — 維護紀錄

> 這是維護者參考資料，不是學生安裝步驟。學生遇到問題請先查看 [學生完整安裝指南](STUDENT_INSTALL.md) 的故障排除。

寫 LINE Bot 時遇到的 silent failure / 結構限制，列在這邊備忘。每一條都是實際被 LINE API 退 400 並花時間 debug 才找到的。

---

## Flex Message

### 1. 顏色必須 6 位數 hex（最隱蔽的雷）

LINE 拒絕 `#RGB` 縮寫，必須 `#RRGGBB`（或含 alpha 的 `#RRGGBBAA`）。

```js
// ❌ 整個 Flex 訊息會被 400 拒收
{ type: 'text', text: 'pre.', color: '#444' }

// ✅
{ type: 'text', text: 'pre.', color: '#444444' }
```

錯誤訊息：
```json
{ "message": "invalid property",
  "property": "/body/contents/2/contents/0/color" }
```

### 2. Flex Carousel 至少要 2 張 bubble

單張 bubble 不能包在 carousel 裡。

```js
// ❌ 單張包成 carousel → 400
{ type: 'carousel', contents: [singleBubble] }

// ✅ 單張直接送
const contents = bubbles.length === 1
  ? bubbles[0]
  : { type: 'carousel', contents: bubbles };
```

### 3. Button 的文字大小不能直接控制

`button` 元件只有 `height: 'sm' | 'md'`，字級綁死。要更小（例如 `xs`）就改用 `box + 內含 text`，把 `action` 放在 box：

```js
// 細節控制版（box 模擬按鈕）
{
  type: 'box',
  layout: 'vertical',
  backgroundColor: '#2ea043',
  cornerRadius: 'md',
  paddingAll: 'sm',
  action: { type: 'postback', label: '...', data: '...' },
  contents: [
    { type: 'text', text: '看完整內容', size: 'xs', color: '#ffffff', align: 'center' }
  ]
}
```

### 4. bubble size 值

`nano` `micro` `kilo` `mega`（預設）`giga`。寬度依序遞增。`hecto` `deca` 部分文件提過但**不要用**，新版可能拒收。

### 5. text 字級值

`xxs` `xs` `sm` `md` `lg` `xl` `xxl` `3xl` `4xl` `5xl`。不要寫 `tiny` `huge` 之類。

### 6. button postback 必須有 `label`

```js
action: {
  type: 'postback',
  label: '按鈕標籤',     // ← 必須，否則 400
  data: '...',
  displayText: '...'
}
```

但 **text 元件的 action** 是 optional label。為一致性建議都加。

---

## Reply Token

### 7. Reply token 一次性

每個 event 的 `replyToken` 只能用一次。若 `lineReply_` 失敗想 retry，token 已作廢——要用 `linePush_` 補發（push 用 userId，不需要 token）。

### 8. Reply token 有效期 ~30 秒

Gemini 處理慢時可能會超時。長處理建議：先 reply 一個「處理中」訊息（消耗 token），結果用 push 推。

### 9. 不要 `muteHttpExceptions: true` 又不檢查 response code

```js
// ❌ 錯誤被吞掉
UrlFetchApp.fetch(url, { ..., muteHttpExceptions: true });

// ✅ 一定要看 response code
const res = UrlFetchApp.fetch(url, { ..., muteHttpExceptions: true });
if (res.getResponseCode() >= 400) {
  console.error(res.getResponseCode(), res.getContentText());
}
```

---

## Quick Reply / Postback

### 10. Quick Reply label 上限 20 字符（中文也佔 1 字）

LINE doc 寫 20 chars，CJK 算 1 字符 。

### 11. Postback `data` 上限 300 byte

URL 編碼後算 byte。中文字 URL 編碼後 = 9 byte / 字，所以 query 太長要截斷。

---

## Webhook 行為

### 12. GAS Web App 收不到 LINE webhook header

→ 無法驗 signature。只能靠 webhook URL 保密 + 自己的 OWNER 白名單。

### 13. LINE 同一批 event 可能放在一個 webhook POST，也可能分多個 POST

- 多檔上傳：每張圖各一個 event，可能分到不同 doPost
- GAS doPost 可能並行執行 → 需要 LockService 序列化共用資源（Drive 資料夾建立、meta.json 更新）

### 14. 一個 reply 最多 5 個 message

`messages: [...]` 上限 5 個。要超過用 push 分批。

---

## Drive 權限（不是 LINE，但常一起搞錯）

### 15. LINE in-app browser 沒有你的 Google 登入 session

點 Drive 連結會跳登入。要讓使用者直接看到內容：

```js
file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
```

短期方便，但 URL 等於公開（不可猜但只要洩漏就被存取）。

---

## Diagnosis 工具

寫 Flex 時記得放 `linePush_` 把 4xx 錯誤推回自己的 LINE：

```js
if (code >= 400) {
  const owner = PropertiesService.getScriptProperties().getProperty('OWNER_LINE_USER_ID');
  if (owner) linePush_(owner, `⚠️ LINE 拒絕（${code}）：${body.slice(0, 400)}`);
}
```

這樣不用每次都翻 Apps Script Executions log。錯誤訊息會直接告訴你哪個欄位（`/body/contents/N/...`），對照 JSON 結構就知道改哪。
