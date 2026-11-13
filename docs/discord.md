# 選配 Discord 設定

先從工作室完成試聊。Discord 是選配，且有兩條路徑：

| 路徑 | 需要什麼 | 額外程序 |
| --- | --- | --- |
| **webhook（預設）** | 一個頻道 webhook 網址；自動回覆另需 bot token | 無 |
| Tupperbox 代理（legacy） | 已套用外部代理修補的 TupperboxLegacy、Postgres、Redis、代理 token | Tupperbox 與資料庫 |

兩條路徑都不要在正式頻道做首次測試。webhook 路徑不需要 Tupperbox、不需要資料庫，也不需要 Redis。

## 方案一：頻道 webhook

角色的訊息以頻道 webhook 送出，跟 Tupperbox 底層做的事一樣：同一個 webhook 可以換名字與頭像，訊息會標成 webhook 張貼。

### 1. 取得 webhook 網址

在測試頻道的「頻道設定 → 整合 → Webhook → 新增 Webhook」，複製網址。網址長這樣：

```text
https://discord.com/api/webhooks/<id>/<token>
```

需要對該頻道有「管理 Webhook」權限。**這個網址就是憑證**：拿到的人都能以該角色發言。不要貼進角色卡、設定檔的提交版本或對話紀錄。要撤銷就刪掉該 webhook。

### 2. 放憑證

三選一，優先序為環境變數 → 檔案 → 設定檔：

```powershell
$env:DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/.../...'
```

或建立一個只有你能讀的檔案（第一行放網址，`#` 開頭可註解），設定 `discord.webhookUrlFile`。設定檔本身請放在 `config.local.json`，不要提交。

### 3. 設定

```json
{
  "discord": {
    "provider": "webhook",
    "channelId": "123456789012345678",
    "avatarUrl": null
  }
}
```

`channelId` 是字串（snowflake），歷史檔會依角色名與頻道分開存放。同一個 webhook 想讓每個角色有不同頭像時，填 `avatarUrl`（https 圖片網址），否則沿用 webhook 本身的頭像。`avatarUrl` 只影響顯示，不影響訊息內容。

不需要 `memberId`、`endpoint` 或 `token`；留著也不會用到。

### 4. 手動發送（CLI）

```powershell
npm run cli -- --config config.local.json --message "我想看潮汐表"          # 只預覽
npm run cli -- --config config.local.json --message "我想看潮汐表" --send   # 真的送出
```

失敗時內容會留在 `data/outbox/`。webhook 以 `wait=1` 送出，成功一定拿得到 messageId；逾時或 5xx 會先回頻道確認訊息是否已到，才決定重送，所以 CLI 的 `--retry` 只在確認未送出後使用。

### 5. 自動回覆（Bridge）

Bridge 用 REST 讀頻道，需要一個 bot：

1. 在 Discord Developer Portal 建立應用程式與 bot，開 **Message Content Intent**（特權 intent；沒開的話讀到的訊息內容是空的）。
2. 邀請 bot 進入伺服器，給「檢視頻道」、「讀取訊息歷史」。送出訊息走 webhook，不需要「傳送訊息」權限。
3. 以 `DISCORD_BOT_TOKEN` 或 `bridge.botTokenFile` 提供 token。
4. 設定 `bridge.allowUserIds`（允許觸發的使用者 ID 字串陣列）與 `bridge.channelId`（或 `discord.channelId`）。

```powershell
npm run bridge -- --config config.local.json --status   # 只看狀態
npm run bridge -- --config config.local.json --once     # 跑一輪
npm run bridge -- --config config.local.json            # 常駐
```

`startFrom` 預設 `latest`，第一次執行會先記下當前最新訊息，測試者要在那之後才送訊息。`mode` 可為 `prefix`（預設前綴 `!devil`）或 `natural`（白名單使用者的一般訊息都觸發）。webhook 送出的訊息本身帶 `webhookId`，Bridge 會跳過，不會回覆自己。

### 限制

- 訊息會顯示為 webhook（套用角色名與頭像），不是真正的成員，所以不會有 Tupperbox 的成員清單、別名標籤或訊息記錄功能。
- 同一個 webhook 的訊息在 Discord 端共用同一個身分；要完全分開，就每個角色各建一個 webhook。
- 角色長回覆超過 2000 字元（UTF-16 計算）會截斷；這是 Discord 的上限。

## 方案二：Tupperbox 代理（legacy）

只有在已經有可用的 TupperboxLegacy 外部代理時才走這條。**注意：公開的 TupperboxLegacy 目前沒有 `modules/external-proxy.js`，本專案用的是未發布的修補版**；沒有那個修補，這條路徑無法啟動。

1. 複製 `config.example.json` 為 `config.local.json`，填入 `model`、`character.card`、`discord.memberId` 及字串格式的 `discord.channelId`，並把 `discord.provider` 設為 `tupperbox`。
2. 確認 `discord.endpoint` 指向代理。代理須為單叢集（`CLUSTERS=1`），以 `PROXY_API_PORT` 設定連接埠。代理的 `PROXY_API_GRANTS` 須為 JSON 陣列，每項含角色擁有者 `ownerId`、成員 `memberId` 與頻道 `channelId`。代理端使用 64 位十六進位 `PROXY_API_TOKEN`。以程序環境變數 `TUPPERBOX_API_TOKEN` 或受保護的 `discord.tokenFile` 提供代理憑證。
3. A 路徑先執行 `npm run cli -- --config config.local.json --message "我想看潮汐表"`。確認預覽後才加 `--send`。失敗時檢查 outbox。重送前確認頻道未出現該訊息，避免 Discord 已接收但回應遺失造成重複。
4. B 路徑需另外提供有權讀取頻道及其訊息內容的 Discord bot（步驟同方案一第 5 點）。`bridge.allowUserIds` 為允許觸發的使用者 ID 字串陣列。
5. Bridge 可先執行 `npm run bridge -- --config config.local.json --status`，再用 `--once` 試跑。

代理路徑的 502 代表代理轉發失敗，Discord 可能已收到，重送前請自行確認頻道。

## 驗收

兩條路徑都需要真實頻道驗收：確認訊息以角色名出現、頭像正確、提及沒有實際 ping、回覆長度與換行正常，以及 Bridge 不會回覆自己的訊息。網站無需啟動這些程序。
