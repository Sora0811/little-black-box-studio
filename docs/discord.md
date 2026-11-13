# 選配 Discord 設定

先從工作室完成試聊。Discord 是選配，有兩條路徑：

| 路徑 | 需要什麼 | 引導方式 |
| --- | --- | --- |
| **webhook（預設）** | 一個頻道 webhook 網址；自動回覆另需 bot token | 網頁「Discord 連線」，三項檢查 |
| Tupperbox 代理（legacy） | 已套用外部代理修補的 TupperboxLegacy、Postgres、Redis、代理 token | 手動，見文末 |

webhook 路徑不需要 Tupperbox、資料庫或 Redis。先用測試頻道，不要在正式頻道做第一次。

## 用網頁完成（建議）

`start.cmd` 啟動後，頁面下方有「Discord 連線」。它只驗證你貼上的內容，不會替你建立 webhook、bot 或訊息。

### 1. 頻道 webhook

Discord 頻道設定 → 整合 → Webhook → 新增 Webhook，複製網址（需要「管理 Webhook」權限）。貼進欄位按「檢查」。

檢查會呼叫 `GET /webhooks/{id}/{token}`：不發訊息、不需要 bot，回應就含 `channel_id`，所以頻道 ID 會自動填入。網址本身就是憑證，拿到的人都能以該角色發言；不要貼到公開的地方，要撤銷就刪掉該 webhook。

### 2. Bot token（只有自動回覆需要）

Developer Portal → 你的應用程式 → Bot：

1. Reset Token，複製 token。
2. 開啟 **Message Content Intent**（特權 intent）。沒開的話，REST 讀到的 `content` 是空的。
3. 邀請 bot 進伺服器，給「檢視頻道」與「讀取訊息歷史」。送出訊息走 webhook，不需要「傳送訊息」。

貼上 token 按「檢查」，會用 `GET /users/@me` 確認是 bot 且 token 有效。

### 3. 頻道與 intent

按「檢查」後，工作室會讀取該頻道最近 20 則訊息：

- 看得到文字 → 通過。
- 只讀到空內容 → 顯示「Message Content Intent 沒開」。
- 頻道沒有訊息 → 請先送一則文字訊息再檢查。

同時會列出最近發言的人，勾選允許回覆的對象；沒勾的人發言會被忽略。

### 4. 寫入並啟動

按「寫入並啟動自動回覆」後，工作室會：

1. 把角色卡存到 `data/cards/`。
2. 寫出 `config.local.json`（含 webhook 網址）與 `data/bridge.env`（含 bot token），兩者都在 `.gitignore` 內。
3. 在同一個程序樹啟動 `tools/bridge.mjs`，頁面顯示狀態與輸出。

**請保持 cmd 視窗開啟**：關閉它會停止網頁與自動回覆。想暫停回覆按「停止自動回覆」即可，不必關視窗。

「只寫入設定」不會啟動 bridge，適合只想用 CLI 手動發送的人；寫出的 `config.local.json` 兩邊共用。只想手動發送時，webhook 檢查通過即可寫入，不需要 bot token；要自動回覆才需要完成 bot token 與頻道檢查。

### 完成清單

頁面底部全部打勾才算完成：

- 角色卡與模型已套用
- 網頁試聊成功
- webhook 檢查通過
- bot token 檢查通過
- 頻道可讀，且 intent 已開
- 自動回覆執行中

還要在真頻道確認：訊息以角色名出現、頭像正確、`@everyone` 沒有實際 ping、重啟後不重複回覆。

## 只用 CLI（不開網頁）

```powershell
$env:DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/.../...'
npm run cli -- --config config.local.json --message "我想看潮汐表"          # 只預覽
npm run cli -- --config config.local.json --message "我想看潮汐表" --send   # 真的送出
```

也可以把網址寫進 `discord.webhookUrlFile`（第一行，`#` 開頭可註解）。設定檔最小內容：

```json
{
  "discord": {
    "provider": "webhook",
    "channelId": "123456789012345678"
  }
}
```

`channelId` 是字串。歷史檔依角色名與頻道分開存放。同一個 webhook 想讓不同角色有不同頭像時填 `discord.avatarUrl`（https 圖片網址）。

失敗時內容留在 `data/outbox/`。webhook 以 `wait=1` 送出，成功一定拿得到 messageId；逾時或 5xx 會先回頻道確認，再決定是否重送。

## 限制

- 訊息是 webhook 身分（套用角色名與頭像），沒有 Tupperbox 的成員清單、別名標籤或訊息記錄。
- 同一個 webhook 的訊息在 Discord 端共用同一個身分；要完全分開就每個角色各建一個 webhook。
- 回覆超過 2000 字元（UTF-16 計算）會截斷，這是 Discord 的上限。
- 網頁試聊的歷史存在 `data/web-history/`，Discord 用的是 `data/history/`，兩邊不共用。

## 方案二：Tupperbox 代理（legacy）

只有在已經有可用的 TupperboxLegacy 外部代理時才走這條。**公開的 TupperboxLegacy 目前沒有 `modules/external-proxy.js`，本專案用的是未發布的修補版**；沒有那個修補，這條路徑無法啟動。

1. 複製 `config.example.json` 為 `config.local.json`，填入 `model`、`character.card`、`discord.memberId` 及字串格式的 `discord.channelId`，並把 `discord.provider` 設為 `tupperbox`。
2. 確認 `discord.endpoint` 指向代理。代理須為單叢集（`CLUSTERS=1`），以 `PROXY_API_PORT` 設定連接埠。代理的 `PROXY_API_GRANTS` 須為 JSON 陣列，每項含角色擁有者 `ownerId`、成員 `memberId` 與頻道 `channelId`。代理端使用 64 位十六進位 `PROXY_API_TOKEN`。以程序環境變數 `TUPPERBOX_API_TOKEN` 或受保護的 `discord.tokenFile` 提供代理憑證。
3. 先執行 `npm run cli -- --config config.local.json --message "我想看潮汐表"`。確認預覽後才加 `--send`。失敗時檢查 outbox；重送前確認頻道未出現該訊息。
4. 自動回覆需另外提供有權讀取頻道訊息內容的 bot（同上方第 2 步），並設定 `bridge.allowUserIds`。
5. Bridge 可先執行 `npm run bridge -- --config config.local.json --status`，再用 `--once` 試跑。

代理路徑的 502 代表代理轉發失敗，Discord 可能已收到，重送前請自行確認頻道。
