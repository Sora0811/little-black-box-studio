import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
    character: {
        card: 'examples/characters/lighthouse.json',
        world: null,
        userName: 'User',
    },
    model: {
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'YOUR_MODEL_NAME',
        temperature: 0.7,
        maxTokens: 320,
        contextBudget: 8192,
        timeoutMs: 180000,
    },
    prompt: {
        // null = built-in "Write {char}'s next reply..." instruction
        systemPrompt: null,
        postHistoryInstructions: null,
        includeFirstMessage: true,
        includeExamples: false,
    },
    worldInfo: {
        enabled: true,
        scanDepth: 2,
        budgetPercent: 25,
        budgetCapTokens: 0,
        recursive: false,
        wholeWord: false,
        maxRecursionSteps: 2,
        caseSensitive: false,
    },
    history: {
        dir: 'data/history',
        maxTurns: 20,
    },
    discord: {
        provider: 'tupperbox',
        endpoint: 'http://127.0.0.1:8787',
        memberId: 1,
        channelId: null,
        maxLength: 2000,
        sanitizeMentions: true,
        timeoutMs: 20000,
        token: null,
        tokenFile: null,
    },
    outbox: {
        dir: 'data/outbox',
    },
    // Optional Discord bridge (tools/bridge.mjs). Disabled by absence of use.
    bridge: {
        mode: 'prefix',            // prefix | natural
        prefix: '!devil',
        allowUserIds: [],          // Discord user ids that may talk to the character
        pollIntervalMs: 4000,
        maxMessagesPerPoll: 20,
        startFrom: 'latest',       // latest: ignore the backlog on first run
        verifyWindow: 20,
        stateFile: 'data/bridge-state.json',
        lockFile: 'data/bridge.lock',
        pendingDir: 'data/bridge-pending',
        botTokenFile: null,        // dotenv file holding DISCORD_TOKEN
    },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function merge(base, override) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override ?? {})) {
        out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
    }
    return out;
}

function envNumber(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function envString(name) {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? undefined : raw;
}

function readTokenFile(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split(/\r?\n/);

        // dotenv style. Explicit proxy token names first: a Tupperbox bot.env also
        // contains DISCORD_TOKEN, which must never be used as the proxy credential.
        const entries = [];
        for (const line of lines) {
            const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (!match) continue;
            const value = match[2].replace(/^['"]|['"]$/g, '').trim();
            if (value) entries.push({ key: match[1], value });
        }

        const preferred = ['TUPPERBOX_API_TOKEN', 'PROXY_API_TOKEN'];
        for (const key of preferred) {
            const found = entries.find((entry) => entry.key === key);
            if (found) return found.value;
        }

        // A bare 64-hex token file is accepted; other named tokens are not guessed.
        const first = lines.find((line) => line.trim() && !line.trim().startsWith('#'))?.trim();
        if (first && !first.includes('=')) return first;
        return null;
    } catch {
        return null;
    }
}

function applyEnv(config) {
    const next = structuredClone(config);

    next.character.card = envString('RP_CARD') ?? next.character.card;
    next.character.world = envString('RP_WORLD') ?? next.character.world;
    next.character.userName = envString('RP_USER_NAME') ?? next.character.userName;

    next.model.provider = envString('RP_MODEL_PROVIDER') ?? next.model.provider;
    next.model.endpoint = envString('RP_MODEL_ENDPOINT') ?? next.model.endpoint;
    next.model.model = envString('RP_MODEL_NAME') ?? next.model.model;
    next.model.temperature = envNumber('RP_MODEL_TEMPERATURE') ?? next.model.temperature;
    next.model.maxTokens = envNumber('RP_MODEL_MAX_TOKENS') ?? next.model.maxTokens;
    next.model.contextBudget = envNumber('RP_CONTEXT_BUDGET') ?? next.model.contextBudget;

    next.discord.endpoint = envString('RP_TUPPERBOX_ENDPOINT') ?? next.discord.endpoint;
    next.discord.memberId = envNumber('RP_MEMBER_ID') ?? next.discord.memberId;
    next.discord.channelId = envString('RP_CHANNEL_ID') ?? next.discord.channelId;

    next.history.dir = envString('RP_HISTORY_DIR') ?? next.history.dir;

    next.bridge.mode = envString('RP_BRIDGE_MODE') ?? next.bridge.mode;
    next.bridge.prefix = envString('RP_BRIDGE_PREFIX') ?? next.bridge.prefix;
    next.bridge.pollIntervalMs = envNumber('RP_BRIDGE_INTERVAL_MS') ?? next.bridge.pollIntervalMs;

    return next;
}

export function resolveToken(config, configDir) {
    if (config.discord.token) return { token: String(config.discord.token), source: 'config' };

    const tokenFile = envString('TUPPERBOX_TOKEN_FILE') ?? config.discord.tokenFile;
    if (tokenFile) {
        const resolved = path.resolve(configDir, tokenFile);
        const token = readTokenFile(resolved);
        if (token) return { token, source: `file:${path.basename(resolved)}` };
    }

    const fromEnv = envString('TUPPERBOX_API_TOKEN');
    if (fromEnv) return { token: fromEnv, source: 'env' };

    return { token: null, source: 'none' };
}

export function loadConfig(configPath = 'config.json', options = {}) {
    const file = path.resolve(configPath);
    let raw = {};
    if (fs.existsSync(file)) {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } else if (configPath !== 'config.json') {
        throw new Error(`Config file not found: ${file}`);
    }

    const configDir = path.dirname(file);
    let config = merge(DEFAULTS, raw);
    config = applyEnv(config);

    // Local overlays keep secrets out of the tracked config file.
    const localPath = path.resolve(configDir, 'config.local.json');
    if (fs.existsSync(localPath)) {
        const local = JSON.parse(fs.readFileSync(localPath, 'utf8').replace(/^\uFEFF/, ''));
        config = merge(config, local);
    }

    const resolve = (value) => (value ? path.resolve(configDir, value) : null);
    config.character.card = resolve(config.character.card);
    config.character.world = resolve(config.character.world);
    config.history.dir = resolve(config.history.dir);
    config.outbox.dir = resolve(config.outbox.dir);

    if (options.card) config.character.card = path.resolve(options.card);
    if (options.world) config.character.world = path.resolve(options.world);
    if (options.memberId !== undefined) config.discord.memberId = options.memberId;
    if (options.channelId !== undefined) config.discord.channelId = options.channelId;

    validateConfig(config);

    const { token, source } = resolveToken(config, configDir);
    config.discord.token = token;
    config.discord.tokenSource = source;

    return { config, configDir, configPath: file };
}

export function validateConfig(config) {
    const problems = [];

    if (!config.character.card) problems.push('character.card is required');
    else if (!fs.existsSync(config.character.card)) problems.push(`character.card not found: ${config.character.card}`);
    if (config.character.world && !fs.existsSync(config.character.world)) {
        problems.push(`character.world not found: ${config.character.world}`);
    }

    if (!['ollama', 'openai'].includes(config.model.provider)) {
        problems.push(`model.provider must be "ollama" or "openai" (got ${config.model.provider})`);
    }
    if (!config.model.endpoint) problems.push('model.endpoint is required');
    if (!config.model.model) problems.push('model.model is required');
    if (!(config.model.maxTokens > 0)) problems.push('model.maxTokens must be positive');
    if (!(config.model.contextBudget > 0)) problems.push('model.contextBudget must be positive');

    if (!Number.isInteger(config.discord.memberId) || config.discord.memberId <= 0 || config.discord.memberId > 2147483647) {
        problems.push('discord.memberId must be a positive integer up to 2147483647');
    }
    if (config.discord.channelId && !/^[1-9]\d{16,19}$/.test(String(config.discord.channelId))) {
        problems.push('discord.channelId must be a Discord snowflake string');
    }
    if (!(config.worldInfo.scanDepth >= 0)) problems.push('worldInfo.scanDepth must be >= 0');
    if (!(config.worldInfo.budgetPercent >= 0 && config.worldInfo.budgetPercent <= 100)) {
        problems.push('worldInfo.budgetPercent must be between 0 and 100');
    }
    if (!(config.history.maxTurns >= 0)) problems.push('history.maxTurns must be >= 0');

    if (problems.length) {
        const error = new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
        error.code = 'CONFIG_INVALID';
        throw error;
    }

    return true;
}

export { DEFAULTS };
