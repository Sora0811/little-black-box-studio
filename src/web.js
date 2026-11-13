import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeCard, readCardFromPng } from './card.js';
import { DEFAULTS, modelApiKeyFor } from './config.js';
import { mergeBooks } from './worldbook.js';
import { buildPrompt } from './prompt.js';
import { generateReply, ModelError } from './model.js';
import { loadHistory, appendMessages, ensureFirstMessage, saveHistory, resetHistory } from './history.js';
import { stripCharacterPrefix } from './macros.js';
import { createDiscordChecker, CheckError } from './discord-check.js';
import { createBridgeSupervisor, SupervisorError } from './bridge-supervisor.js';
import { writeSetup, SetupError } from './setup-writer.js';

const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
    ['/sample.json', ['../examples/characters/lighthouse.json', 'application/json']],
].map(([route, [file, type]]) => [route, [readFileSync(new URL('../web/' + file, import.meta.url)), type]]));
const maxBody = 8 * 1024 * 1024;

class InputError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    if (Number(req.headers['content-length']) > maxBody) throw new InputError('檔案或資料超過 8 MiB。', 413);
    let size = 0;
    const chunks = [];
    // Keep the stream open long enough to return a 413 on chunked requests.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBody) throw new InputError('檔案或資料超過 8 MiB。', 413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function decodeJson(bytes) {
    try {
        return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new InputError('JSON 格式錯誤。');
    }
}

function validateCard(raw, metadata) {
    try {
        return normalizeCard(raw, metadata);
    } catch {
        throw new InputError('角色卡必須包含角色名稱與描述。');
    }
}

function modelSettings(input) {
    if (!['ollama', 'openai'].includes(input?.provider)) throw new InputError('請選擇模型服務。');
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if (!model || model.length > 200) throw new InputError('請輸入有效的模型名稱。');
    let url;
    try {
        url = new URL(input.endpoint);
    } catch {
        throw new InputError('請輸入有效的模型網址。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new InputError('模型網址須為 HTTP 或 HTTPS，且不能包含帳密、查詢字串或片段。');
    }
    const endpoint = url.href.replace(/\/+$/, '');
    const apiKey = input.provider === 'openai' ? modelApiKeyFor(endpoint) : null;
    if (apiKey && url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new InputError('使用 API 金鑰時，遠端模型網址須使用 HTTPS。');
    }
    return { ...DEFAULTS.model, provider: input.provider, endpoint, model, apiKey: apiKey ?? undefined, redirect: 'error' };
}

const modelErrors = {
    MODEL_UNREACHABLE: '連不到模型服務，請確認服務已啟動、網址正確，且沒有轉址。',
    MODEL_TIMEOUT: '模型逾時，請確認模型服務狀態。',
    MODEL_BAD_RESPONSE: '模型回傳格式不符，請檢查服務類型與網址。',
    MODEL_EMPTY_REPLY: '模型沒有回傳可顯示的台詞。',
};

export function createStudio({
    historyDir = path.resolve('data/web-history'),
    projectDir = process.cwd(),
    discordBaseUrl = 'https://discord.com/api/v10',
    checker = null,
    supervisor = null,
} = {}) {
    const discord = checker ?? createDiscordChecker({ baseUrl: discordBaseUrl });
    const bridge = supervisor ?? createBridgeSupervisor({ projectDir });
    const configPath = path.join(projectDir, 'config.local.json');
    let busy = false;
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const origin = 'http://' + req.headers.host;
        const localPort = req.socket.localPort;
        const localHost = req.headers.host === '127.0.0.1:' + localPort || req.headers.host === 'localhost:' + localPort;
        if (!localHost) {
            return json(res, 403, { error: '請使用啟動時顯示的本機網址。' });
        }
        try {
            if (req.method === 'GET' && assets.has(req.url)) {
                const [body, type] = assets.get(req.url);
                res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
                return res.end(body);
            }
            if (req.method === 'GET' && req.url === '/api/health') {
                return json(res, 200, { ok: true, version: '0.1.0', generating: busy, bridge: bridge.status().status });
            }
            if (req.method === 'GET' && req.url === '/api/bridge') {
                return json(res, 200, bridge.status());
            }
            const postRoutes = new Set([
                '/api/import', '/api/history', '/api/reset', '/api/chat',
                '/api/discord/webhook', '/api/discord/bot', '/api/discord/channel',
                '/api/setup', '/api/bridge/start', '/api/bridge/stop',
            ]);
            if (req.method !== 'POST' || !postRoutes.has(req.url)) {
                return json(res, 404, { error: '找不到頁面。' });
            }
            if (req.headers.origin !== origin) return json(res, 403, { error: '請從工作室頁面送出。' });

            const type = req.headers['content-type']?.split(';')[0];
            if (type !== 'application/json' && !(req.url === '/api/import' && type === 'image/png')) {
                throw new InputError('不支援此資料格式。', 415);
            }
            const bytes = await readBody(req);
            if (req.url === '/api/import') {
                let raw;
                if (type === 'image/png') {
                    try {
                        raw = readCardFromPng(bytes).card;
                    } catch {
                        throw new InputError('PNG 裡沒有可讀取的 V2 / V3 角色卡。');
                    }
                } else {
                    raw = decodeJson(bytes);
                }
                validateCard(raw);
                return json(res, 200, { card: raw });
            }

            const input = decodeJson(bytes);

            // --- read-only Discord checks and setup, all secrets stay in memory
            if (req.url.startsWith('/api/discord/')) {
                try {
                    if (req.url === '/api/discord/webhook') {
                        return json(res, 200, await discord.checkWebhook(input?.url));
                    }
                    if (req.url === '/api/discord/bot') {
                        return json(res, 200, await discord.checkBot(input?.token));
                    }
                    return json(res, 200, await discord.checkChannel({ token: input?.token, channelId: input?.channelId }));
                } catch (error) {
                    if (error instanceof CheckError) {
                        return json(res, 200, { ok: false, error: error.message, code: error.code });
                    }
                    throw error;
                }
            }

            if (req.url === '/api/setup') {
                if (bridge.status().status === 'running') {
                    throw new InputError('自動回覆執行中，請先按「停止自動回覆」再修改設定。', 409);
                }
                validateCard(input?.card);
                const autostart = Boolean(input?.autostart);
                if (autostart && !String(input?.discord?.botToken ?? '').trim()) {
                    throw new InputError('啟動自動回覆需要 bot token；只想產生設定檔請按「只寫入設定」。');
                }
                if (autostart && !(input?.bridge?.allowUserIds ?? []).length) {
                    throw new InputError('請至少勾選一位允許回覆的使用者。');
                }
                const result = writeSetup({
                    projectDir,
                    card: input.card,
                    world: input?.world ?? null,
                    model: input?.model,
                    discord: input?.discord ?? {},
                    bridge: input?.bridge ?? {},
                });
                const warnings = [];
                if (process.env.RP_MODEL_API_KEY || process.env.RP_WEB_MODEL_API_KEY) {
                    const endpoint = String(input?.model?.endpoint ?? '').trim();
                    warnings.push(modelApiKeyFor(endpoint)
                        ? '偵測到模型 API 金鑰：只會送到目前填寫的模型網址，不會寫進設定檔。'
                        : '偵測到模型 API 金鑰，但與目前模型網址不符，因此不會送出。請確認 RP_MODEL_KEY_ENDPOINT（或舊的 RP_WEB_KEY_ENDPOINT）。');
                }
                if (process.env.DISCORD_WEBHOOK_URL) {
                    warnings.push('偵測到 DISCORD_WEBHOOK_URL：自動回覆會優先使用環境變數的 webhook，不是剛寫入的設定。');
                }
                if (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN) {
                    warnings.push('偵測到 DISCORD_BOT_TOKEN／DISCORD_TOKEN：自動回覆會優先使用環境變數的 token。');
                }
                if (!autostart) {
                    return json(res, 200, {
                        ok: true,
                        configPath: result.configPath,
                        cardPath: result.cardPath,
                        worldPath: result.worldPath,
                        preview: result.preview,
                        warnings,
                        bridge: bridge.status(),
                    });
                }
                try {
                    bridge.start(result.configPath);
                } catch (error) {
                    if (error instanceof SupervisorError) throw new InputError(error.message, 409);
                    throw error;
                }
                return json(res, 200, {
                    ok: true,
                    configPath: result.configPath,
                    cardPath: result.cardPath,
                    worldPath: result.worldPath,
                    preview: result.preview,
                    warnings,
                    bridge: bridge.status(),
                });
            }

            if (req.url === '/api/bridge/start' || req.url === '/api/bridge/stop') {
                if (req.url === '/api/bridge/stop') {
                    return json(res, 200, { ok: true, bridge: await bridge.stop() });
                }
                try {
                    bridge.start(configPath);
                } catch (error) {
                    if (error instanceof SupervisorError) throw new InputError(error.message, 409);
                    throw error;
                }
                return json(res, 200, { ok: true, bridge: bridge.status() });
            }

            const card = validateCard(input?.card);
            const book = mergeBooks(card.book, input.world);
            const id = createHash('sha256').update(JSON.stringify([input.card, input.world ?? null])).digest('hex');
            const history = { dir: historyDir, memberId: id, channelId: null, character: card.name };
            if (busy && req.url !== '/api/history') throw new InputError('正在等模型回覆，請稍後再試。', 409);
            if (req.url === '/api/reset') resetHistory(history);
            if (req.url === '/api/history') modelSettings(input.model);
            const { store, file } = loadHistory(history);
            ensureFirstMessage(store, card, { enabled: DEFAULTS.prompt.includeFirstMessage });
            if (req.url !== '/api/chat') return json(res, 200, { messages: store.messages });

            const message = typeof input.message === 'string' ? input.message.trim() : '';
            if (!message || message.length > 8000) throw new InputError('訊息須為 1 到 8000 字元。');
            const config = {
                ...DEFAULTS,
                model: modelSettings(input.model),
                prompt: {
                    ...DEFAULTS.prompt,
                    systemPrompt: card.systemPrompt,
                    postHistoryInstructions: card.postHistoryInstructions,
                    includeExamples: true,
                },
            };
            const prompt = buildPrompt({ card, book, history: store.messages, userMessage: message, config });
            if (prompt.stats.totalTokens + config.model.maxTokens > config.model.contextBudget) {
                throw new InputError('角色卡、世界書或訊息超過目前的模型上下文預算。');
            }
            busy = true;
            try {
                const result = await generateReply({ config, messages: prompt.messages });
                const reply = stripCharacterPrefix(result.text, card.name) || result.text;
                appendMessages(store, [{ role: 'user', content: message }, { role: 'assistant', content: reply }], DEFAULTS.history);
                saveHistory({ dir: historyDir, store, file });
                return json(res, 200, { messages: store.messages });
            } finally {
                busy = false;
            }
        } catch (error) {
            if (error instanceof InputError) return json(res, error.status, { error: error.message });
            if (error instanceof SetupError || error?.code === 'WEBHOOK_URL_INVALID') {
                return json(res, 400, { error: error.message });
            }
            if (error instanceof ModelError) {
                const message = modelErrors[error.code] ?? '模型服務回傳 HTTP ' + error.status + '。請檢查模型名稱與授權。';
                return json(res, 502, { error: message });
            }
            console.error('工作室處理失敗', error.code ?? error.name);
            return json(res, 500, { error: '工作室處理失敗。請檢查歷史資料是否可讀寫，並查看終端機診斷。' });
        }
    });
    server.bridge = bridge;
    return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.RP_WEB_PORT ?? 7310);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || Number(process.versions.node.split('.')[0]) < 20) {
        console.error('需要 Node.js 20 以上，RP_WEB_PORT 須為 1 到 65535。');
        process.exitCode = 1;
    } else {
        const server = createStudio();
        const shutdown = () => {
            server.bridge.stopSync();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        for (const signal of ['SIGHUP', 'SIGBREAK']) {
            try {
                process.on(signal, shutdown);
            } catch {
                // Not every platform exposes these signals.
            }
        }
        process.on('exit', () => server.bridge.stopSync());
        server.on('error', (error) => {
            console.error(error.code === 'EADDRINUSE' ? '連接埠已被使用。請關閉舊視窗或設定 RP_WEB_PORT。' : error.code);
            process.exitCode = 1;
        });
        server.listen(port, '127.0.0.1', () => {
            const url = 'http://127.0.0.1:' + port;
            console.log('');
            console.log('小黑盒 Discord 角色工作室');
            console.log('網址：' + url);
            console.log('請保持此視窗開啟；關閉視窗會停止網頁與 Discord 自動回覆。');
            if (process.platform === 'win32' && process.argv.includes('--open')) {
                const browser = spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { windowsHide: true, stdio: 'ignore' });
                browser.on('error', () => console.error('請手動開啟上方網址。'));
            }
        });
    }
}
