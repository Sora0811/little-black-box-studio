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

export function slugify(name) {
    const slug = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return slug || 'character';
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

    const provider = model?.provider;
    if (!['ollama', 'openai'].includes(provider)) throw new SetupError('請選擇模型服務。');
    const modelName = String(model?.model ?? '').trim();
    if (!modelName) throw new SetupError('請先填寫模型名稱。');
    const endpoint = String(model?.endpoint ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(endpoint)) throw new SetupError('模型網址須為 HTTP 或 HTTPS。');

    const mode = bridge.mode === 'prefix' ? 'prefix' : 'natural';
    const allowUserIds = [...new Set((bridge.allowUserIds ?? []).map((id) => String(id).trim()))];
    for (const id of allowUserIds) {
        if (!/^[1-9]\d{16,19}$/.test(id)) throw new SetupError('允許的使用者 ID 須為 Discord 數字 ID。');
    }
    const token = String(discord.botToken ?? '').trim();

    const dataDir = path.join(projectDir, 'data');
    const cardDir = path.join(dataDir, 'cards');
    fs.mkdirSync(cardDir, { recursive: true });

    const slug = slugify(name);
    const cardPath = path.join(cardDir, `${slug}.json`);
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
            prefix: mode === 'prefix' ? String(bridge.prefix ?? DEFAULTS.bridge.prefix) : DEFAULTS.bridge.prefix,
            allowUserIds,
            channelId,
            botTokenFile: tokenFile ? relative(tokenFile) : null,
        },
    };

    const configPath = path.join(projectDir, 'config.local.json');
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

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
