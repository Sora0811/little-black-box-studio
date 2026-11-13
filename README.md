# 小黑盒 Discord 角色工作室 v0.1

在 Windows 啟動本機工作室，建立性格或匯入角色卡，選擇模型並在網頁試聊。安裝 Node.js 並準備一個可用的 Ollama 或 OpenAI-compatible 模型服務即可使用網頁。Discord 為選配：頁面會引導你設定頻道 webhook，並可托管自動回覆。

## 快速開始

1. 將候選版解壓縮到可寫入的資料夾，準備 Node.js 20 以上。
2. 在 Windows 雙擊 `start.cmd`。也可在專案資料夾執行 `npm start`，依終端機顯示的網址開啟頁面。預設為 `http://127.0.0.1:7310`。使用網頁無須先執行 npm 安裝。**請保持這個視窗開啟**：關閉它會同時停止網頁與 Discord 自動回覆。
3. 填寫角色名稱、描述與性格，或按「載入範例」試用合成角色栗燈。也可匯入 V2/V3 JSON、含 `chara` 或 `ccv3` 資料的 PNG，以及附加 JSON 世界書。
4. 選擇模型服務（本機 Ollama 或遠端 OpenAI-compatible），填入網址與模型名稱，按「套用設定」。網頁只使用表單填寫的內容，不會代為安裝或偵測模型。
5. 送出「我想看潮汐表」試聊。用完可關閉終端機停止服務。

## 設定

| 項目 | 用法 |
| --- | --- |
| Ollama | 網址預設 `http://127.0.0.1:11434`，也可填完整的 `/api/chat` 網址。模型名稱須為服務端已載入的名稱。 |
| OpenAI-compatible | 填服務基底網址（可帶 `/v1`）或完整 `/v1/chat/completions` 網址，再填服務提供的模型名稱。 |
| 模型 API 金鑰 | 金鑰只從啟動程式的環境讀取，不寫進設定檔。`RP_MODEL_API_KEY`＋`RP_MODEL_KEY_ENDPOINT` 由網頁、CLI 與自動回覆共用；`RP_WEB_MODEL_API_KEY`＋`RP_WEB_KEY_ENDPOINT` 是舊名稱，仍可用。端點須與填入的模型網址完全相符（忽略結尾斜線）才會附上金鑰，避免把金鑰送到別的服務。遠端金鑰請用 HTTPS。 |
| Web 連接埠 | 啟動前可設定 `RP_WEB_PORT`。例如 PowerShell 執行 `$env:RP_WEB_PORT = '7311'`，再執行 `npm start`。 |
| 歷史 | 成功的網頁試聊存於 `data/web-history/`，同一卡片內容與世界書組合會讀回同一份對話。模型切換會沿用歷史。可下載角色卡 JSON 保留編輯結果。附加世界書請保留原檔。重新整理頁面後表單需重新輸入；已寫入的 `config.local.json` 不受影響，CLI 與自動回覆可直接沿用。 |
| CLI／Bridge | 複製 `config.example.json` 成 `config.local.json` 後填寫本機值。可指定角色卡、世界書、模型溫度、回覆上限、上下文預算與歷史位置。網頁使用表單及自己的預設值。 |

### 選配 Discord

網頁下方的「Discord 連線」會帶你完成三項檢查：頻道 webhook、bot token、頻道與 intent。全部通過後按「寫入並啟動自動回覆」，工作室會在背景啟動 bridge，關掉 cmd 視窗才一起停止。設定同時寫成 `config.local.json`，CLI 可直接沿用。這裡只驗證你貼上的內容，不會替你建立 webhook 或 bot。

- **A｜手動發送**。CLI 已保留預覽、明確送出、提及清理和失敗重試。webhook 以 `wait=1` 取得 messageId，逾時或 5xx 會先確認頻道再決定重送。
- **B｜自動回覆**。由網頁托管，讀取頻道需要 bot token 與 Message Content intent；網頁會實際讀一則訊息確認 intent 是否生效。訊息往返、游標、單實例鎖定與失敗恢復沿用 REST Bridge。
- **Token 與設定檔**：webhook 網址寫在 `config.local.json`，bot token 寫在 `data/bridge.env`，兩者都在 `.gitignore` 內。不要上傳或分享。
- Tupperbox 路徑仍是 legacy：公開的 TupperboxLegacy 沒有 `modules/external-proxy.js`，需要未發布的修補版，且要自備 Postgres、Redis 與角色成員 ID。沒有那個修補時請改用 webhook。

完整步驟與手動 CLI 設定見 [Discord 設定](docs/discord.md)。

## 常見故障

| 症狀 | 檢查方式 |
| --- | --- |
| 啟動視窗找不到 Node.js | 在新終端機執行 `node --version`，確認版本及 PATH。 |
| 連接埠已被使用 | 關閉前一個工作室，或改用 `RP_WEB_PORT`。使用終端機顯示的 127.0.0.1 網址。 |
| 網頁開不了 | 查看啟動視窗是否仍在運作。可在同一網址加上 `/api/health`，正常時會顯示版本和目前是否生成中。 |
| 模型連不到、回覆 HTTP 404 | 確認模型服務已啟動、選對服務類型、模型已安裝，並檢查基底網址及 API 路徑。網頁請求拒絕轉址。 |
| 模型回覆 HTTP 401／403 | 檢查金鑰、網址是否與 `RP_MODEL_KEY_ENDPOINT`（或舊的 `RP_WEB_KEY_ENDPOINT`）一致，以及服務帳號的模型存取權。 |
| 上下文超出或模型回覆為空 | 縮短角色卡／世界書，或改用支援所需上下文與輸出的模型。CLI 可調整上下文和回覆上限。 |
| PNG 匯入失敗 | 確認原檔包含未被圖片工具移除的卡片資料。也可使用 JSON 匯出。 |
| Discord 回傳 401／403 | webhook 路徑：401 代表網址的 token 失效或被刪（重新複製），403 代表 webhook 無權在該頻道發言。Tupperbox 路徑：401 先查代理 token，403 檢查成員和頻道授權。 |
| Discord 回傳 404 | webhook 已被刪除或網址不完整，重新建立並更新憑證。 |
| 讀不到頻道訊息內容 | bot 沒開 Message Content intent（Developer Portal → Bot → Privileged Gateway Intents）。 |

## 架構與限制

`web/` 提供同源表單、試聊介面與 Discord 引導，`src/web.js` 在 127.0.0.1 提供 HTTP，並托管 `tools/bridge.mjs` 子程序；關閉啟動視窗會一併停止兩者。網頁沿用 `src/` 的角色卡解析、世界書觸發、提示預算、模型和歷史模組。CLI／REST Bridge 透過 `src/delivery.js` 選擇發送方式（頻道 webhook 或 Tupperbox 代理），並保留送出狀態和重試行為。Web 試聊每次處理一個生成請求、等候完整回覆，匯入與請求上限為 8 MiB。網頁尚未提供角色庫、頭像管理或獨立的打包執行檔。現有核心 CLI 仍可透過 `npm run cli -- --help` 使用。

## 安全與授權

工作室供單機使用。請維持 127.0.0.1，避免公開轉發或與他人共用此服務。使用遠端模型時，角色資料、觸發的世界書內容、歷史和訊息會送到所選服務。歷史以明文保存。清除對話會重設目前角色組合的紀錄，也可在停止工作室後自行管理 `data/`。不要把憑證放在角色卡、網址、公開設定或提交中。

本專案及隨附的 rp-engine 核心採 [MIT 授權](LICENSE)。Discord 發送預設只用 Discord 官方的頻道 webhook，沒有額外依賴。選配的 TupperboxLegacy 有自己的 MIT 授權，程式與依賴由使用者另外安裝。

## 開發測試

```powershell
npm ci --offline
npm test
```

測試使用合成角色及本機模擬服務，不需要 Discord、模型帳號或金鑰。
