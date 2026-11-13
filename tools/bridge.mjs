#!/usr/bin/env node
/**
 * Discord bridge runner.
 *
 *   node tools/bridge.mjs --config config.private-2.json            # 常駐
 *   node tools/bridge.mjs --config config.private-2.json --once     # 跑一輪就結束
 *   node tools/bridge.mjs --config config.private-2.json --status   # 只看狀態
 *
 * The bridge reads the channel over REST (never a gateway session) and replies
 * through the configured delivery provider: a channel webhook (`webhook`) or the
 * Tupperbox proxy (`tupperbox`). The bot token never appears in logs or JSON
 * output; only its source is reported.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { loadCard } from '../src/card.js';
import { mergeBooks } from '../src/worldbook.js';
import { generateReply } from '../src/model.js';
import { createSender, historyMemberId } from '../src/delivery.js';
import { createDiscordApi } from '../src/discord-api.js';
import { createBridge, resolveBridgeConfig } from '../src/bridge.js';
import { acquireLock, readLock, LockBusyError } from '../src/bridge-lock.js';
import { log, setLogLevel } from '../src/logger.js';

const HELP = `rp-engine Discord bridge

用法：
  node tools/bridge.mjs [--config <path>]            常駐輪詢
  node tools/bridge.mjs --once                       跑一輪後結束
  node tools/bridge.mjs --status                     顯示狀態（不發送）

選項：
  --config <path>    設定檔（預設 config.private-2.json）
  --log-level <lvl>  error | warn | info | debug
  --json             以 JSON 輸出（--once / --status）
`;

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { args.help = true; continue; }
        if (arg === '--once') { args.once = true; continue; }
        if (arg === '--status') { args.status = true; continue; }
        if (arg === '--json') { args.json = true; continue; }
        if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`Option ${arg} needs a value`);
        args[key] = value;
        i += 1;
    }
    return args;
}

/**
 * The bot token is separate from the proxy token: it is only ever read from the
 * environment or from a dotenv file, and only its source is reported.
 */
export function readDiscordToken(configDir, config, bridgeCfg) {
    const fromEnv = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
    if (fromEnv) return { token: fromEnv.trim(), source: 'env' };

    const candidates = [bridgeCfg.botTokenFile, config.discord.tokenFile].filter(Boolean);
    for (const candidate of candidates) {
        const file = path.resolve(configDir ?? '.', candidate);
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const match = /^\s*(?:export\s+)?DISCORD_TOKEN\s*=\s*(.*)\s*$/.exec(line);
            if (match) return { token: match[1].replace(/^['"]|['"]$/g, '').trim(), source: `file:${path.basename(file)}` };
        }
    }
    return { token: null, source: 'none' };
}

function buildContext(configPath) {
    const { config, configDir } = loadConfig(configPath);
    const bridgeCfg = resolveBridgeConfig(config);
    const paths = {
        statePath: path.resolve(configDir, bridgeCfg.stateFile),
        pendingDir: path.resolve(configDir, bridgeCfg.pendingDir),
        lockFile: path.resolve(configDir, bridgeCfg.lockFile),
    };
    return { config, configDir, bridgeCfg, paths };
}

function makeBridge(ctx, { selfUserId, api: providedApi = null }) {
    const { config, configDir, bridgeCfg, paths } = ctx;
    const card = loadCard(config.character.card);
    const extraBook = config.character.world
        ? JSON.parse(fs.readFileSync(config.character.world, 'utf8').replace(/^\uFEFF/, ''))
        : null;
    const book = mergeBooks(card.book, extraBook);
    const { token, source } = readDiscordToken(configDir, config, bridgeCfg);
    if (!token && !providedApi) {
        throw new Error('找不到 Discord bot token（設 DISCORD_BOT_TOKEN，或讓 bridge.botTokenFile / discord.tokenFile 指向含 DISCORD_TOKEN 的檔案）');
    }

    const api = providedApi ?? createDiscordApi({ token, baseUrl: bridgeCfg.apiBase });
    const verify = async (content, afterId) => {
        const messages = await api.getMessages(bridgeCfg.channelId, { after: afterId, limit: bridgeCfg.verifyWindow });
        const wanted = String(content).trim();
        return messages.some((message) => String(message.content ?? '').trim() === wanted);
    };

    const bridge = createBridge({
        config,
        card,
        book,
        api,
        generate: generateReply,
        send: async (content) => createSender({ config, card, channelId: bridgeCfg.channelId })(content),
        verify,
        statePath: paths.statePath,
        pendingDir: paths.pendingDir,
        selfUserId,
        historyMemberId: historyMemberId(config, card),
        logger: log,
    });

    return { bridge, api, tokenSource: source };
}

function print(payload) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(HELP);
        return 0;
    }

    const configPath = args.config ?? 'config.private-2.json';
    if (args['log-level']) setLogLevel(args['log-level']);
    else if (args.once || args.status || args.json) setLogLevel('error');

    if (args.status) {
        const ctx = buildContext(configPath);
        const { bridgeCfg, paths } = ctx;
        const state = fs.existsSync(paths.statePath)
            ? JSON.parse(fs.readFileSync(paths.statePath, 'utf8').replace(/^\uFEFF/, ''))
            : null;
        const pendingFiles = fs.existsSync(paths.pendingDir)
            ? fs.readdirSync(paths.pendingDir).filter((name) => name.endsWith('.json'))
            : [];
        print({
            provider: ctx.config.discord.provider,
            webhookSource: ctx.config.discord.webhookSource,
            mode: bridgeCfg.mode,
            prefix: bridgeCfg.mode === 'prefix' ? bridgeCfg.prefix : null,
            channelId: bridgeCfg.channelId,
            allowUserIds: bridgeCfg.allowUserIds,
            pollIntervalMs: bridgeCfg.pollIntervalMs,
            startFrom: bridgeCfg.startFrom,
            lastMessageId: state?.lastMessageId ?? null,
            processedTracked: state?.processed?.length ?? 0,
            pending: pendingFiles.length,
            lock: readLock(paths.lockFile),
            stateFile: paths.statePath,
            pendingDir: paths.pendingDir,
        });
        return 0;
    }

    const ctx = buildContext(configPath);
    const { bridgeCfg, paths } = ctx;

    let lock;
    try {
        lock = acquireLock(paths.lockFile, { staleMs: Math.max(bridgeCfg.pollIntervalMs * 5, 30000) });
    } catch (error) {
        if (error instanceof LockBusyError) {
            print({ ok: false, code: error.code, message: error.message, holder: error.holder });
            return 2;
        }
        throw error;
    }

    const cleanup = () => {
        try { lock.release(); } catch { /* already gone */ }
    };
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    try {
        // Identify the bot once so its own messages are ignored even if it ever posts directly.
        const boot = makeBridge(ctx, { selfUserId: null });
        const me = await boot.api.getMe().catch((error) => {
            log.warn(`Could not identify the bot user (${error?.code ?? error?.message}); continuing without self-filter.`);
            return null;
        });

        if (args.once) {
            const run = me?.id ? makeBridge(ctx, { selfUserId: me.id, api: boot.api }) : boot;
            const report = await run.bridge.pollOnce();
            lock.heartbeat();
            print({ ok: !report.stopped, mode: bridgeCfg.mode, botTokenSource: run.tokenSource, selfUserId: me?.id ?? null, ...report });
            return report.stopped ? 2 : 0;
        }

        log.info(`Bridge started (mode=${bridgeCfg.mode}, channel=${bridgeCfg.channelId}, interval=${bridgeCfg.pollIntervalMs}ms)`);
        let consecutiveErrors = 0;

        for (;;) {
            const startedAt = Date.now();
            try {
                // Rebuild each cycle so a config edit (for example a mode switch) applies without a restart.
                const cycle = makeBridge(buildContext(configPath), { selfUserId: me?.id ?? null });
                const report = await cycle.bridge.pollOnce();
                lock.heartbeat();
                consecutiveErrors = 0;
                if (report.handled > 0) log.info(`Replied to ${report.handled} message(s)`);
                if (report.stopped) log.warn('Cycle stopped early; the pending record is retried next cycle.');
                if (report.baseline) log.info(`Baseline set at message ${report.lastMessageId}; only newer messages are answered.`);
            } catch (error) {
                consecutiveErrors += 1;
                log.error(`Poll cycle failed: ${error?.message ?? error}`);
                if (consecutiveErrors >= 5) log.error('Five consecutive failures; still retrying. Check the token and channel access.');
            }

            const elapsed = Date.now() - startedAt;
            await new Promise((resolve) => { setTimeout(resolve, Math.max(bridgeCfg.pollIntervalMs - elapsed, 500)); });
        }
    } finally {
        cleanup();
    }
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        if (process.argv.includes('--json')) {
            process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message }, null, 2)}\n`);
        } else {
            log.error(error.message);
        }
        process.exitCode = 1;
    });
