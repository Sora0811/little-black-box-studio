# 選配 Discord 設定

先從工作室完成試聊。選配 Discord 需要已配置外部 HTTP 代理的 TupperboxLegacy，以及你可管理的測試頻道。不要在正式頻道做首次測試。

1. 複製 `config.example.json` 為 `config.local.json`，填入 `model`、`character.card`、`discord.memberId` 及字串格式的 `discord.channelId`。
2. 確認 `discord.endpoint` 指向代理。代理須為單叢集（`CLUSTERS=1`），以 `PROXY_API_PORT` 設定連接埠。代理的 `PROXY_API_GRANTS` 須為 JSON 陣列，每項含角色擁有者 `ownerId`、成員 `memberId` 與頻道 `channelId`。代理端使用 64 位十六進位 `PROXY_API_TOKEN`。以程序環境變數 `TUPPERBOX_API_TOKEN` 或受保護的 `discord.tokenFile` 提供代理憑證。
3. A 路徑先執行 `npm run cli -- --config config.local.json --message "我想看潮汐表"`。確認預覽後才加 `--send`。失敗時檢查 outbox。重送前確認頻道未出現該訊息，避免 Discord 已接收但回應遺失造成重複。
4. B 路徑需另外提供有權讀取頻道及其訊息內容的 Discord bot。透過 `DISCORD_BOT_TOKEN` 環境變數或 `bridge.botTokenFile` 傳入 bot 憑證。設定 `bridge.allowUserIds` 為允許觸發的 Discord 使用者 ID 字串陣列。
5. Bridge 可先執行 `npm run bridge -- --config config.local.json --status`，再用 `--once` 試跑。預設 `startFrom: "latest"` 會先記下當前最新訊息。測試者應在建立基準後送出新訊息。預設前綴為 `!devil`，也可選 `mode: "natural"`，由白名單使用者的一般訊息觸發。省略 `--once` 即持續輪詢。

兩條路徑均需真實頻道驗收。網站無需啟動這些程序。
