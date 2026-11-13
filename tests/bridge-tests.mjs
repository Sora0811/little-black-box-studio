#!/usr/bin/env node
/**
 * Offline bridge tests.
 *
 * Pure logic runs against injected fakes; the CLI path runs against local mock
 * Discord / proxy / model servers. No Discord traffic, no real model calls and
 * no secrets.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridge, classifyMessage, parseTrigger, resolveBridgeConfig } from '../src/bridge.js';
import { acquireLock, LockBusyError, isProcessAlive } from '../src/bridge-lock.js';
import { loadHistory } from '../src/history.js';
import { loadCard } from '../src/card.js';
import { normalizeBook } from '../src/worldbook.js';
import { DeliveryError } from '../src/tupperbox.js';
import { compareIds } from '../src/discord-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_CLI = path.join(ROOT, 'tools', 'bridge.mjs');
const CARD_JSON = path.join(ROOT, 'tests', 'fixtures', 'seraphina.json');
const CHANNEL = '1000000000000000001';
const USER = '1000000000000000002';
const OTHER_USER = '111111111111111111';
const BOT_ID = '222222222222222222';

const results = [];
let failures = 0;

function record(name, ok, detail) {
    results.push({ name, ok });
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function test(name, fn) {
    try {
        const detail = await fn();
        record(name, true, detail);
    } catch (error) {
        record(name, false, error?.message ?? String(error));
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bridge-test-'));
let dirSeq = 0;
const freshDir = () => {
    dirSeq += 1;
    const dir = path.join(TMP, `case-${dirSeq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

// --------------------------------------------------------------------- fixtures
function unitConfig(dir, bridgeOverrides = {}) {
    return {
        character: { card: CARD_JSON, world: null, userName: 'User' },
        model: {
            provider: 'ollama',
            endpoint: 'http://127.0.0.1:1',
            model: 'mock-model',
            temperature: 0.7,
            maxTokens: 120,
            contextBudget: 4096,
            timeoutMs: 5000,
        },
        prompt: { systemPrompt: null, postHistoryInstructions: null, includeFirstMessage: true, includeExamples: false },
        worldInfo: {
            enabled: true, scanDepth: 2, budgetPercent: 25, budgetCapTokens: 0,
            recursive: false, wholeWord: false, maxRecursionSteps: 2, caseSensitive: false,
        },
        history: { dir: path.join(dir, 'history'), maxTurns: 20 },
        discord: {
            provider: 'tupperbox', endpoint: 'http://127.0.0.1:1', memberId: 2,
            channelId: CHANNEL, maxLength: 2000, sanitizeMentions: true, timeoutMs: 5000,
            token: 'test-token', tokenFile: null,
        },
        outbox: { dir: path.join(dir, 'outbox') },
        bridge: {
            mode: 'prefix',
            prefix: '!devil',
            allowUserIds: [USER],
            pollIntervalMs: 1000,
            maxMessagesPerPoll: 20,
            startFrom: 'latest',
            verifyWindow: 20,
            stateFile: path.join(dir, 'bridge-state.json'),
            lockFile: path.join(dir, 'bridge.lock'),
            pendingDir: path.join(dir, 'pending'),
            botTokenFile: null,
            ...bridgeOverrides,
        },
    };
}

const card = loadCard(CARD_JSON);
const book = normalizeBook(card.book);

function createWorld() {
    let counter = 1500000000000000000n;
    const messages = [];
    const world = {
        messages,
        nextId() {
            counter += 1n;
            return String(counter);
        },
        post({ authorId = USER, content = '', bot = false, webhook = false, channelId = CHANNEL, id = null, attachments = 0 } = {}) {
            const message = {
                id: id ?? world.nextId(),
                channelId,
                authorId,
                authorBot: bot,
                username: 'tester',
                content,
                webhookId: webhook ? '777777777777777777' : null,
                timestamp: new Date().toISOString(),
                attachmentCount: attachments,
            };
            messages.push(message);
            return message;
        },
        api() {
            return {
                async getMessages(channelId, { after, limit = 50 } = {}) {
                    const list = messages
                        .filter((message) => message.channelId === channelId)
                        .filter((message) => !after || compareIds(message.id, after) > 0)
                        .slice(-limit);
                    return [...list].reverse(); // Discord returns newest first
                },
            };
        },
    };
    return world;
}

function makeHarness({ world, config, sendImpl, generateImpl, selfUserId = BOT_ID }) {
    const calls = { generates: 0, sends: [] };
    const verify = async (content, afterId) => world.messages.some(
        (message) => compareIds(message.id, afterId) > 0 && String(message.content).trim() === String(content).trim(),
    );

    const bridge = createBridge({
        config,
        card,
        book,
        api: world.api(),
        generate: async (params) => {
            calls.generates += 1;
            if (generateImpl) return generateImpl(params, calls);
            return { text: `回覆 ${calls.generates}`, provider: 'mock', model: 'mock', elapsedMs: 1, usage: {}, finishReason: 'stop' };
        },
        send: async (content) => {
            calls.sends.push(content);
            if (sendImpl) return sendImpl(content, calls, world);
            const posted = world.post({ authorId: BOT_ID, bot: true, webhook: true, content });
            return { messageId: posted.id, channelId: CHANNEL };
        },
        verify,
        statePath: config.bridge.stateFile,
        pendingDir: config.bridge.pendingDir,
        selfUserId,
        logger: null,
    });

    return { bridge, calls };
}

function historyOf(config) {
    const { store } = loadHistory({
        dir: config.history.dir,
        memberId: config.discord.memberId,
        channelId: config.bridge.channelId ?? config.discord.channelId,
        character: card.name,
    });
    return store.messages;
}

// ------------------------------------------------------------------- unit tests

await test('prefix mode answers only prefixed messages', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil 你好' });
    world.post({ content: '你好' });
    world.post({ content: '!DEVIL 再來一次' });
    world.post({ content: '' });

    const { bridge, calls } = makeHarness({ world, config });
    // startFrom latest would baseline on first run, so pre-seed the cursor.
    bridge.state.lastMessageId = '1500000000000000000';
    const report = await bridge.pollOnce();

    assert.equal(calls.sends.length, 2, 'only the two prefixed messages should be answered');
    assert.equal(report.handled, 2);
    assert.equal(parseTrigger('!devil hi', config.bridge), 'hi');
    assert.equal(parseTrigger('devil hi', config.bridge), null);
    return `replies=${calls.sends.length}, skipped=${report.skipped}`;
});

await test('natural mode answers ordinary messages in the channel', async () => {
    const dir = freshDir();
    const config = unitConfig(dir, { mode: 'natural' });
    const world = createWorld();
    world.post({ content: '你在嗎？' });
    world.post({ content: '今天過得如何' });

    const { bridge, calls } = makeHarness({ world, config });
    bridge.state.lastMessageId = '1500000000000000000';
    const report = await bridge.pollOnce();

    assert.equal(calls.sends.length, 2);
    assert.equal(report.handled, 2);
    return `replies=${calls.sends.length}`;
});

await test('switching mode in config changes behaviour without a code change', async () => {
    const dir = freshDir();
    const world = createWorld();
    world.post({ content: '你好' });

    const prefixConfig = unitConfig(dir);
    const first = makeHarness({ world, config: prefixConfig });
    first.bridge.state.lastMessageId = '1500000000000000000';
    const before = await first.bridge.pollOnce();
    assert.equal(before.handled, 0, 'prefix mode must ignore a bare message');

    world.post({ content: '你在嗎' });
    const naturalConfig = unitConfig(dir, { mode: 'natural' });
    const second = makeHarness({ world, config: naturalConfig });
    // Same state file, new mode: the already-seen message stays skipped.
    const after = await second.bridge.pollOnce();

    assert.equal(after.handled, 1);
    assert.equal(second.calls.sends.length, 1);
    return 'prefix=0 → natural=1 on the next message';
});

await test('bot, webhook, other user and other channel messages are ignored', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil bot', authorId: BOT_ID, bot: true });
    world.post({ content: '!devil hook', authorId: BOT_ID, bot: true, webhook: true });
    world.post({ content: '!devil stranger', authorId: OTHER_USER });
    world.post({ content: '!devil elsewhere', channelId: '1180000000000000000' });
    world.post({ content: '!devil self', authorId: BOT_ID, bot: true });

    const { bridge, calls } = makeHarness({ world, config });
    bridge.state.lastMessageId = '1500000000000000000';
    const report = await bridge.pollOnce();

    assert.equal(calls.sends.length, 0);
    assert.equal(report.handled, 0);
    assert.equal(classifyMessage({ id: '1', authorId: OTHER_USER, channelId: CHANNEL, content: '!devil hi' }, config.bridge).skip, 'not_allowed');
    assert.equal(classifyMessage({ id: '1', authorId: USER, channelId: CHANNEL, content: '!devil hi', webhookId: '1' }, config.bridge).skip, 'webhook');
    return `skipped=${report.skipped}`;
});

await test('a restart does not answer the same message twice', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil 第一次' });

    const first = makeHarness({ world, config });
    first.bridge.state.lastMessageId = '1500000000000000000';
    await first.bridge.pollOnce();
    assert.equal(first.calls.sends.length, 1);

    const restarted = makeHarness({ world, config });
    const report = await restarted.bridge.pollOnce();
    assert.equal(restarted.calls.sends.length, 0);
    assert.equal(report.handled, 0);

    const state = JSON.parse(fs.readFileSync(config.bridge.stateFile, 'utf8'));
    assert.ok(state.lastMessageId);
    return `cursor=${state.lastMessageId}`;
});

await test('duplicate delivery of the same message id is answered once', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    const message = world.post({ content: '!devil 重複' });
    world.messages.push({ ...message }); // same id twice in one poll response

    const { bridge, calls } = makeHarness({ world, config });
    bridge.state.lastMessageId = '1500000000000000000';
    const report = await bridge.pollOnce();

    assert.equal(calls.sends.length, 1);
    assert.equal(report.handled, 1);
    return 'one reply for a duplicated id';
});

await test('a timed-out delivery is confirmed in the channel and not resent', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil 測試逾時' });

    let attempt = 0;
    const { bridge, calls } = makeHarness({
        world,
        config,
        sendImpl: (content) => {
            attempt += 1;
            if (attempt === 1) {
                world.post({ authorId: BOT_ID, bot: true, webhook: true, content });
                throw new DeliveryError('Tupperbox 請求逾時', { code: 'DELIVERY_TIMEOUT' });
            }
            const posted = world.post({ authorId: BOT_ID, bot: true, webhook: true, content });
            return { messageId: posted.id, channelId: CHANNEL };
        },
    });
    bridge.state.lastMessageId = '1500000000000000000';
    const report = await bridge.pollOnce();

    assert.equal(calls.sends.length, 1, 'no second post after a confirmed delivery');
    assert.equal(report.replies[0].verified, true);
    assert.equal(historyOf(config).length, 2);
    return 'verified once, history committed once';
});

await test('a failed delivery keeps one pending record and resends the same text', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil 失敗後重試' });

    const failing = makeHarness({
        world,
        config,
        sendImpl: () => { throw new DeliveryError('unauthorized', { code: 'DELIVERY_FAILED', status: 401 }); },
    });
    failing.bridge.state.lastMessageId = '1500000000000000000';
    const first = await failing.bridge.pollOnce();

    assert.equal(first.stopped, true);
    assert.equal(failing.calls.sends.length, 2, 'one attempt plus one retry');
    const pending = failing.bridge.pending();
    assert.equal(pending.length, 1);
    const cursorAfterFailure = failing.bridge.state.lastMessageId;

    const recovering = makeHarness({ world, config });
    const second = await recovering.bridge.pollOnce();

    assert.equal(recovering.calls.sends.length, 1);
    assert.equal(recovering.calls.sends[0], pending[0].payload.content, 'the pending text is resent verbatim');
    assert.equal(recovering.calls.generates, 0, 'no new generation for the pending record');
    assert.equal(recovering.bridge.pending().length, 0);
    assert.equal(historyOf(config).length, 2);
    return `cursor ${cursorAfterFailure} kept, resend without regenerating`;
});

await test('first run baselines at the newest message instead of answering the backlog', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const world = createWorld();
    world.post({ content: '!devil 舊訊息一' });
    const newest = world.post({ content: '!devil 舊訊息二' });

    const { bridge, calls } = makeHarness({ world, config });
    const first = await bridge.pollOnce();
    assert.equal(first.baseline, true);
    assert.equal(calls.sends.length, 0);
    assert.equal(bridge.state.lastMessageId, newest.id);

    world.post({ content: '!devil 新訊息' });
    const second = await bridge.pollOnce();
    assert.equal(second.handled, 1);
    return `baseline=${newest.id}`;
});

await test('startFrom=all processes the backlog when asked', async () => {
    const dir = freshDir();
    const config = unitConfig(dir, { startFrom: 'all' });
    const world = createWorld();
    world.post({ content: '!devil 一' });
    world.post({ content: '!devil 二' });

    const { bridge, calls } = makeHarness({ world, config });
    const report = await bridge.pollOnce();
    assert.equal(report.handled, 2);
    assert.equal(calls.sends.length, 2);
    return 'backlog=2';
});

await test('a second instance is refused while the lock is held', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    const first = acquireLock(config.bridge.lockFile, { pid: process.pid, isAlive: () => true });
    assert.throws(() => acquireLock(config.bridge.lockFile, { pid: process.pid + 1, isAlive: (pid) => pid === process.pid }), LockBusyError);
    first.release();
    const second = acquireLock(config.bridge.lockFile, { pid: process.pid + 1, isAlive: () => true });
    second.release();
    return 'busy refused, release allows reacquire';
});

await test('a lock left by a dead process is taken over', async () => {
    const dir = freshDir();
    const config = unitConfig(dir);
    fs.mkdirSync(path.dirname(config.bridge.lockFile), { recursive: true });
    fs.writeFileSync(config.bridge.lockFile, JSON.stringify({ pid: 999999, heartbeatAt: new Date().toISOString() }));
    const lock = acquireLock(config.bridge.lockFile, { pid: process.pid, isAlive: (pid) => pid !== 999999 });
    lock.release();
    assert.equal(isProcessAlive(999999), false);
    return 'stale lock replaced';
});

await test('bridge config rejects an invalid mode and empty allow list', async () => {
    assert.throws(() => resolveBridgeConfig({ bridge: { mode: 'sometimes', allowUserIds: [USER], channelId: CHANNEL } }), /mode/);
    assert.throws(() => resolveBridgeConfig({ bridge: { mode: 'prefix', allowUserIds: [], channelId: CHANNEL } }), /allowUserIds/);
    return 'validation active';
});

// ---------------------------------------------------------------- CLI end-to-end
function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

function readBody(request) {
    return new Promise((resolve) => {
        let raw = '';
        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => resolve(raw));
    });
}

function runBridge(args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BRIDGE_CLI, ...args], {
            cwd: ROOT,
            env: { ...process.env, ...env },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => {
            let json = null;
            try { json = JSON.parse(stdout); } catch { /* ignore */ }
            resolve({ code, stdout, stderr, json });
        });
    });
}

const integration = await (async () => {
    const world = createWorld();
    const discordCalls = [];
    const proxyCalls = [];
    const modelCalls = [];

    const discord = await startServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        discordCalls.push(url.pathname);
        if (url.pathname === '/users/@me') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ id: BOT_ID, username: 'mockbot', bot: true }));
            return;
        }
        const match = /^\/channels\/(\d+)\/messages$/.exec(url.pathname);
        if (!match) {
            response.writeHead(404).end('{}');
            return;
        }
        const after = url.searchParams.get('after');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const list = world.messages
            .filter((message) => !after || compareIds(message.id, after) > 0)
            .slice(-limit)
            .reverse();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(list.map((message) => ({
            id: message.id,
            channel_id: message.channelId,
            author: { id: message.authorId, username: 'mock', bot: message.authorBot },
            content: message.content,
            webhook_id: message.webhookId,
        }))));
    });

    const proxy = await startServer(async (request, response) => {
        const raw = await readBody(request);
        proxyCalls.push(raw ? JSON.parse(raw) : null);
        const body = raw ? JSON.parse(raw) : {};
        const posted = world.post({ authorId: BOT_ID, bot: true, webhook: true, content: body.content, channelId: body.channelId });
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messageId: posted.id, channelId: body.channelId }));
    });

    const model = await startServer(async (request, response) => {
        const raw = await readBody(request);
        modelCalls.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'mock-model', message: { role: 'assistant', content: '測試回覆' }, done_reason: 'stop' }));
    });

    return { world, discord, proxy, model, discordCalls, proxyCalls, modelCalls };
})();

function writeBridgeConfig(dir, overrides = {}) {
    const config = unitConfig(dir, { startFrom: 'all', apiBase: integration.discord.url, ...overrides });
    config.model.endpoint = integration.model.url;
    config.discord.endpoint = integration.proxy.url;
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return file;
}

await test('CLI --once replies through the proxy and is idempotent on rerun', async () => {
    const dir = freshDir();
    integration.world.post({ content: '!devil 端到端測試' });
    const configFile = writeBridgeConfig(dir);

    const first = await runBridge(
        ['--once', '--config', configFile, '--json'],
        { DISCORD_BOT_TOKEN: 'test-bot-token', DISCORD_API_BASE: integration.discord.url },
    );
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(first.json.handled, 1);
    assert.equal(integration.proxyCalls.length, 1);

    const second = await runBridge(
        ['--once', '--config', configFile, '--json'],
        { DISCORD_BOT_TOKEN: 'test-bot-token', DISCORD_API_BASE: integration.discord.url },
    );
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.equal(second.json.handled, 0);
    assert.equal(integration.proxyCalls.length, 1, 'no duplicate post on rerun');
    return `first=${first.json.handled}, second=${second.json.handled}`;
});

await test('CLI --status reports mode, cursor and pending without sending', async () => {
    const dir = freshDir();
    const configFile = writeBridgeConfig(dir);
    const before = integration.proxyCalls.length;
    const status = await runBridge(['--status', '--config', configFile], { DISCORD_BOT_TOKEN: 'test-bot-token' });
    assert.equal(status.code, 0);
    assert.equal(status.json.mode, 'prefix');
    assert.equal(status.json.pending, 0);
    assert.equal(integration.proxyCalls.length, before);
    return `mode=${status.json.mode}, lock=${status.json.lock ? 'held' : 'free'}`;
});

await test('CLI refuses a second concurrent instance', async () => {
    const dir = freshDir();
    const configFile = writeBridgeConfig(dir);
    const lockFile = path.join(dir, 'bridge.lock');
    const lock = acquireLock(lockFile, { pid: process.pid, isAlive: () => true });
    const run = await runBridge(['--once', '--config', configFile, '--json'], { DISCORD_BOT_TOKEN: 'test-bot-token' });
    lock.release();
    assert.equal(run.code, 2);
    assert.equal(run.json.code, 'BRIDGE_LOCKED');
    return 'exit code 2 with BRIDGE_LOCKED';
});

// ---------------------------------------------------------------------- summary
for (const server of [integration.discord, integration.proxy, integration.model]) server.server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${results.length - failures}/${results.length} bridge tests passed`);
process.exitCode = failures === 0 ? 0 : 1;
