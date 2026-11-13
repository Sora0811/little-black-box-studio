/**
 * Writes the two files the CLI and the bridge need, from what the page already
 * collected: the character card, and config.local.json (gitignored).
 *
 * The webhook URL and bot token are credentials. They go to config.local.json
 * and data/bridge.env, both excluded by .gitignore, and never to stdout or the
 * page's preview (the preview masks them).
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from './config.js';
import { parseWebhookUrl } from './webhook.js';

export class SetupError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SetupError';
        this.code = details.code ?? 'SETUP_INVALID';
    }
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function slugify(name) {
    let slug = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    if (!slug) return 'character';
    // Windows reserves these device names in every directory.
    if (RESERVED_NAMES.test(slug)) slug = `${slug}-card`;
    return slug;
}

function cardPathFor(cardDir, slug, card) {
    for (let index = 1; index <= 99; index += 1) {
        const candidate = path.join(cardDir, index === 1 ? `${slug}.json` : `${slug}-${index}.json`);
        if (!fs.existsSync(candidate)) return candidate;
        try {
            const existing = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''));
            if (JSON.stringify(existing) === JSON.stringify(card)) return candidate;
        } catch {
            // Unreadable or invalid file: keep looking instead of overwriting it.
        }
    }
    throw new SetupError('同名角色卡過多，請改用不同的角色名稱。');
}

function lockDown(file) {
    try {
        fs.chmodSync(file, 0o600);
    } catch {
        // Windows may not support POSIX modes; the file is still under data/ or config.local.json.
    }
}

function maskWebhook(url) {
    try {
        const target = parseWebhookUrl(url);
        return `https://discord.com/api/webhooks/${target.id}/…`;
    } catch {
        return null;
    }
}

export function writeSetup({
    projectDir = process.cwd(),
    card,
    world = null,
    model,
    discord = {},
    bridge = {},
}) {
    const name = String(card?.data?.name ?? '').trim();
    if (!name) throw new SetupError('請先填寫角色名稱。');

    const channelId = String(discord.channelId ?? '').trim();
    if (!/^[1-9]\d{16,19}$/.test(channelId)) throw new SetupError('頻道 ID 須為 Discord 的數字 ID。');
    const webhook = parseWebhookUrl(discord.webhookUrl);
    const webhookChannelId = String(discord.webhookChannelId ?? '').trim();
    if (webhookChannelId && webhookChannelId !== channelId) {
        throw new SetupError('頻道 ID 與 webhook 所屬頻道不同；請重新檢查 webhook，或改回它填入的頻道。');
    }

    const provider = model?.provider;
    if (!['ollama', 'openai'].includes(provider)) throw new SetupError('請選擇模型服務。');
    const modelName = String(model?.model ?? '').trim();
    if (!modelName) throw new SetupError('請先填寫模型名稱。');
    let endpointUrl;
    try {
        endpointUrl = new URL(String(model?.endpoint ?? '').trim());
    } catch {
        throw new SetupError('模型網址格式不正確。');
    }
    if (!['http:', 'https:'].includes(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password ||
        endpointUrl.search || endpointUrl.hash) {
        throw new SetupError('模型網址須為 HTTP 或 HTTPS，且不能包含帳密、查詢字串或片段。');
    }
    const endpoint = endpointUrl.href.replace(/\/+$/, '');

    const mode = bridge.mode === 'prefix' ? 'prefix' : 'natural';
    const rawAllowUserIds = bridge.allowUserIds ?? [];
    if (!Array.isArray(rawAllowUserIds)) throw new SetupError('允許的使用者清單格式錯誤。');
    const allowUserIds = [...new Set(rawAllowUserIds.map((id) => String(id).trim()))];
    for (const id of allowUserIds) {
        if (!/^[1-9]\d{16,19}$/.test(id)) throw new SetupError('允許的使用者 ID 須為 Discord 數字 ID。');
    }
    let prefix = DEFAULTS.bridge.prefix;
    if (mode === 'prefix') {
        prefix = String(bridge.prefix ?? DEFAULTS.bridge.prefix).trim();
        if (!prefix) throw new SetupError('前綴模式需要非空白的前綴。');
        if (prefix.length > 20) throw new SetupError('前綴最多 20 個字元。');
    }
    const token = String(discord.botToken ?? '').trim();
    if (/[\r\n]/.test(token)) throw new SetupError('bot token 不可包含換行。');

    const dataDir = path.join(projectDir, 'data');
    const cardDir = path.join(dataDir, 'cards');
    fs.mkdirSync(cardDir, { recursive: true });

    const cardPath = cardPathFor(cardDir, slugify(name), card);
    const slug = path.basename(cardPath, '.json');
    fs.writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`, 'utf8');

    let worldPath = null;
    if (world && typeof world === 'object') {
        worldPath = path.join(cardDir, `${slug}.world.json`);
        fs.writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, 'utf8');
    }

    let tokenFile = null;
    if (token) {
        tokenFile = path.join(dataDir, 'bridge.env');
        fs.writeFileSync(tokenFile, `DISCORD_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
        lockDown(tokenFile);
    }

    const relative = (file) => path.relative(projectDir, file).split(path.sep).join('/');

    const config = {
        character: {
            card: relative(cardPath),
            world: worldPath ? relative(worldPath) : null,
            userName: DEFAULTS.character.userName,
        },
        model: {
            ...DEFAULTS.model,
            provider,
            endpoint,
            model: modelName,
        },
        prompt: { ...DEFAULTS.prompt },
        worldInfo: { ...DEFAULTS.worldInfo },
        history: { ...DEFAULTS.history },
        discord: {
            provider: 'webhook',
            channelId,
            maxLength: DEFAULTS.discord.maxLength,
            sanitizeMentions: true,
            timeoutMs: DEFAULTS.discord.timeoutMs,
            webhookUrl: `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`,
            webhookUrlFile: null,
            avatarUrl: null,
        },
        outbox: { ...DEFAULTS.outbox },
        bridge: {
            ...DEFAULTS.bridge,
            mode,
            prefix,
            allowUserIds,
            channelId,
            botTokenFile: tokenFile ? relative(tokenFile) : null,
        },
    };

    const configPath = path.join(projectDir, 'config.local.json');
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    lockDown(configPath);

    return {
        configPath,
        cardPath,
        worldPath,
        tokenFile,
        config,
        preview: {
            ...config,
            discord: { ...config.discord, webhookUrl: maskWebhook(discord.webhookUrl) },
            bridge: { ...config.bridge, botTokenFile: tokenFile ? `${relative(tokenFile)}（已寫入 token）` : null },
        },
    };
}
