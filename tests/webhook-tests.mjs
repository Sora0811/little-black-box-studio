#!/usr/bin/env node
/**
 * Webhook delivery tests.
 *
 * Discord itself is never contacted: postWebhook takes an `origin` and an
 * injectable fetch, so a local HTTP server stands in for the webhook endpoint.
 * The URL validator is still exercised on real Discord URLs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeliveryError } from '../src/delivery-error.js';
import { parseWebhookUrl, cleanUsername, postWebhook } from '../src/webhook.js';
import { createSender, historyMemberId, deliveryProvider } from '../src/delivery.js';
import { loadConfig } from '../src/config.js';
import { loadCard } from '../src/card.js';
import { createBridge } from '../src/bridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_JSON = path.join(ROOT, 'tests', 'fixtures', 'seraphina.json');
const CHANNEL = '1000000000000000001';
const USER = '1000000000000000002';
const WEBHOOK_ID = '123456789012345678';
const WEBHOOK_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

const results = [];
let failures = 0;

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function test(name, fn) {
    try {
        const detail = await fn();
        record(name, true, detail);
    } catch (error) {
        record(name, false, error?.message ?? String(error));
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-webhook-test-'));

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((request, response) => {
            let raw = '';
            request.on('data', (chunk) => { raw += chunk; });
            request.on('end', () => handler(request, response, raw));
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

const realWebhook = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

// ------------------------------------------------------------------ URL guard
await test('webhook URL must be https on a discord host', () => {
    for (const host of ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discordapp.com']) {
        const parsed = parseWebhookUrl(`https://${host}/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
        assert.equal(parsed.origin, 'https://discord.com');
        assert.equal(parsed.id, WEBHOOK_ID);
        assert.equal(parsed.token, WEBHOOK_TOKEN);
    }

    const bad = [
        `http://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
        `https://discord.com.evil.test/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
        `https://evil.test/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
        'https://discord.com/api/webhooks/123456789012345678',
        'https://discord.com/api/webhooks//token',
        'not a url',
        `https://user:pass@discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
    ];
    for (const value of bad) {
        assert.throws(() => parseWebhookUrl(value), (error) => error.code === 'WEBHOOK_URL_INVALID', value);
    }
    assert.throws(() => parseWebhookUrl(null), (error) => error.code === 'WEBHOOK_URL_INVALID');
    return '4 hosts accepted, 7 rejected';
});

await test('username is cleaned of Discord reserved words and capped', () => {
    assert.equal(cleanUsername('Clyde'), 'Character');
    assert.equal(cleanUsername('Discord Bot'), 'Bot');
    assert.equal(cleanUsername('  Seraphina   the  Fox  '), 'Seraphina the Fox');
    assert.equal(cleanUsername('x'.repeat(120)).length, 80);
    assert.equal(cleanUsername(''), 'Character');
    return 'reserved words stripped, 80 char cap';
});

// ------------------------------------------------------------ request shaping
let posted = [];
let rateLimited = 0;
const hook = await startServer(async (request, response, raw) => {
    posted.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    const last = posted[posted.length - 1];
    if (last.body?.content === 'please retry' && rateLimited === 0) {
        rateLimited += 1;
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ retry_after: 0.01, global: false }));
        return;
    }
    if (last.body?.content === 'no id') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: '1500000000000000999', channel_id: CHANNEL }));
});

await test('webhook post sends wait=1 JSON and returns the message id', async () => {
    posted = [];
    const result = await postWebhook({
        origin: hook.url,
        id: WEBHOOK_ID,
        token: WEBHOOK_TOKEN,
        username: 'Seraphina',
        avatarUrl: 'https://example.test/a.png',
        content: 'hello there',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, '1500000000000000999');
    assert.equal(result.channelId, CHANNEL);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, `/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}?wait=1`);
    assert.equal(posted[0].headers['content-type'], 'application/json');
    assert.equal(posted[0].body.username, 'Seraphina');
    assert.equal(posted[0].body.content, 'hello there');
    assert.deepEqual(posted[0].body.allowed_mentions, { parse: [] });
    assert.equal(posted[0].body.avatar_url, 'https://example.test/a.png');
    return 'wait=1, mentions disabled';
});

await test('avatar_url is omitted when no avatar is configured', async () => {
    posted = [];
    await postWebhook({
        origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'Seraphina', content: 'no avatar',
    });
    assert.equal('avatar_url' in posted[0].body, false);
    return 'no avatar_url key';
});

await test('429 is retried once using retry_after', async () => {
    posted = [];
    const result = await postWebhook({
        origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'Seraphina', content: 'please retry',
    });
    assert.equal(result.ok, true);
    assert.equal(posted.length, 2);
    assert.ok(posted.every((entry) => entry.url.endsWith('?wait=1')));
    return 'first 429, second 200';
});

await test('a 2xx without a message id is not treated as delivered', async () => {
    await assert.rejects(
        () => postWebhook({ origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'Seraphina', content: 'no id' }),
        (error) => error.code === 'DELIVERY_UNCONFIRMED',
    );
    return 'wait=1 without id -> DELIVERY_UNCONFIRMED';
});

// ---------------------------------------------------------------- error paths
await test('Invalid Form Body reports a 400 with a readable message', async () => {
    const bad = await startServer((request, response) => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 50035, message: 'Invalid Form Body' }));
    });
    await assert.rejects(
        () => postWebhook({ origin: bad.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: 'x' }),
        (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.code, 'DISCORD_50035');
            assert.equal(error.ambiguous, false);
            return true;
        },
    );
    bad.server.close();
    return 'status 400, code DISCORD_50035';
});

await test('a 5xx is flagged ambiguous so callers verify before resending', async () => {
    const broken = await startServer((request, response) => {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('bad gateway');
    });
    await assert.rejects(
        () => postWebhook({ origin: broken.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: 'x' }),
        (error) => {
            assert.equal(error.status, 502);
            assert.equal(error.ambiguous, true);
            return true;
        },
    );
    broken.server.close();
    return 'ambiguous=true on 5xx';
});

await test('a timeout is ambiguous and a refused connection is unreachable', async () => {
    const hanging = await startServer(() => { /* never answers */ });
    await assert.rejects(
        () => postWebhook({ origin: hanging.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: 'x', timeoutMs: 150 }),
        (error) => error.code === 'DELIVERY_TIMEOUT',
    );
    hanging.server.close();

    await assert.rejects(
        () => postWebhook({ origin: 'http://127.0.0.1:1', id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: 'x' }),
        (error) => error.code === 'DELIVERY_UNREACHABLE',
    );
    return 'timeout / unreachable';
});

// ------------------------------------------------------------- length limits
await test('length is counted in UTF-16 units, like Discord does', async () => {
    posted = [];
    const emoji = '\u{1F600}';
    const atLimit = emoji.repeat(1000); // 2000 code units, 1000 code points
    assert.equal(atLimit.length, 2000);
    const ok = await postWebhook({ origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: atLimit });
    assert.equal(ok.ok, true);

    posted = [];
    const overLimit = emoji.repeat(1001); // 2002 code units
    await assert.rejects(
        () => postWebhook({ origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: overLimit }),
        (error) => error.code === 'CONTENT_TOO_LONG',
    );
    assert.equal(posted.length, 0, 'nothing may be sent when the body is over the limit');
    return '2000 units accepted, 2002 rejected before sending';
});

await test('empty content is never sent', async () => {
    posted = [];
    await assert.rejects(
        () => postWebhook({ origin: hook.url, id: WEBHOOK_ID, token: WEBHOOK_TOKEN, username: 'x', content: '   ' }),
        (error) => error.code === 'EMPTY_CONTENT',
    );
    assert.equal(posted.length, 0);
    return 'EMPTY_CONTENT';
});

// ------------------------------------------------------------- provider switch
await test('createSender posts through the webhook for provider=webhook', async () => {
    const card = loadCard(CARD_JSON);
    const calls = [];
    const config = {
        discord: {
            provider: 'webhook',
            channelId: CHANNEL,
            timeoutMs: 5000,
            webhook: parseWebhookUrl(realWebhook),
            avatarUrl: null,
        },
    };
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id: '1500000000000000777', channel_id: CHANNEL }), { status: 200 });
    };

    const result = await createSender({ config, card, fetchImpl })('hello');
    assert.equal(result.messageId, '1500000000000000777');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}?wait=1`);
    assert.equal(calls[0].body.username, 'Seraphina');
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
    return 'character name used as the webhook username';
});

await test('provider=tupperbox still posts to the proxy', async () => {
    const proxy = await startServer((request, response) => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messageId: '1500000000000000888', channelId: CHANNEL }));
    });
    const card = loadCard(CARD_JSON);
    const config = {
        discord: {
            provider: 'tupperbox', endpoint: proxy.url, token: 'test-token',
            memberId: 3, channelId: CHANNEL, timeoutMs: 5000, webhook: null,
        },
    };
    const result = await createSender({ config, card })('hello');
    assert.equal(result.messageId, '1500000000000000888');
    proxy.server.close();
    return 'proxy path unchanged';
});

await test('history ids stay stable per character and differ between characters', () => {
    const config = { discord: { provider: 'webhook', memberId: 1 } };
    const a1 = historyMemberId(config, { name: 'Seraphina' });
    const a2 = historyMemberId(config, { name: 'Seraphina' });
    const b = historyMemberId(config, { name: 'Eldoria' });
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.ok(Number.isInteger(a1) && a1 > 0 && a1 <= 2147483647);

    const tupperbox = { discord: { provider: 'tupperbox', memberId: 42 } };
    assert.equal(historyMemberId(tupperbox, { name: 'Seraphina' }), 42);
    assert.equal(deliveryProvider({}), 'tupperbox');
    assert.equal(deliveryProvider({ discord: { provider: 'nope' } }), 'tupperbox');
    return `hash(${'Seraphina'})=${a1}, hash(${'Eldoria'})=${b}`;
});

// --------------------------------------------------------------- config wiring
function writeConfig(dir, overrides = {}) {
    const config = {
        character: { card: CARD_JSON, world: null, userName: 'User' },
        model: {
            provider: 'ollama',
            endpoint: 'http://127.0.0.1:1',
            model: 'mock-model',
            temperature: 0.7,
            maxTokens: 120,
            contextBudget: 4096,
        },
        prompt: { includeFirstMessage: true, includeExamples: false },
        worldInfo: {
            enabled: true, scanDepth: 2, budgetPercent: 25, budgetCapTokens: 0,
            recursive: false, wholeWord: false, maxRecursionSteps: 2, caseSensitive: false,
        },
        history: { dir: path.join(dir, 'history'), maxTurns: 20 },
        discord: {
            provider: 'webhook',
            channelId: CHANNEL,
            maxLength: 2000,
            sanitizeMentions: true,
            timeoutMs: 5000,
            webhookUrl: realWebhook,
        },
        outbox: { dir: path.join(dir, 'outbox') },
        ...overrides,
    };
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return file;
}

await test('config resolves the webhook URL from config, env and a secret file', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'config-'));
    const file = writeConfig(dir);
    const fromConfig = loadConfig(file).config;
    assert.equal(fromConfig.discord.provider, 'webhook');
    assert.equal(fromConfig.discord.webhook.id, WEBHOOK_ID);
    assert.equal(fromConfig.discord.webhookSource, 'config');

    const envUrl = `https://discord.com/api/webhooks/223456789012345678/${WEBHOOK_TOKEN}`;
    process.env.DISCORD_WEBHOOK_URL = envUrl;
    try {
        const fromEnv = loadConfig(file).config;
        assert.equal(fromEnv.discord.webhook.id, '223456789012345678');
        assert.equal(fromEnv.discord.webhookSource, 'env');
    } finally {
        delete process.env.DISCORD_WEBHOOK_URL;
    }

    const secretFile = path.join(dir, 'webhook.txt');
    fs.writeFileSync(secretFile, `# channel webhook\n${realWebhook}\n`, 'utf8');
    const fileConfig = writeConfig(dir, { discord: { provider: 'webhook', channelId: CHANNEL, webhookUrl: null, webhookUrlFile: 'webhook.txt' } });
    const fromFile = loadConfig(fileConfig).config;
    assert.equal(fromFile.discord.webhook.id, WEBHOOK_ID);
    assert.equal(fromFile.discord.webhookSource, 'file:webhook.txt');
    return 'config / env / file';
});

await test('config rejects webhook mode without a URL and mangled URLs', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'bad-config-'));
    const noUrl = writeConfig(dir, { discord: { provider: 'webhook', channelId: CHANNEL, webhookUrl: null } });
    assert.throws(() => loadConfig(noUrl), /webhookUrl/);
    // Preview and history runs do not need delivery to be configured.
    assert.equal(loadConfig(noUrl, { requireDelivery: false }).config.discord.provider, 'webhook');

    const badUrl = writeConfig(dir, { discord: { provider: 'webhook', channelId: CHANNEL, webhookUrl: 'http://discord.com/api/webhooks/1/x' } });
    assert.throws(() => loadConfig(badUrl), (error) => error.code === 'WEBHOOK_URL_INVALID');
    return 'missing URL refused for sending, allowed for preview';
});

// ------------------------------------------------------------------- bridge
await test('the bridge replies through a webhook and records the message id', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'bridge-'));
    const config = {
        character: { userName: 'User' },
        model: { maxTokens: 120, contextBudget: 4096, timeoutMs: 5000 },
        prompt: { includeFirstMessage: true, includeExamples: false },
        worldInfo: {
            enabled: false, scanDepth: 2, budgetPercent: 25, budgetCapTokens: 0,
            recursive: false, wholeWord: false, maxRecursionSteps: 2, caseSensitive: false,
        },
        history: { dir: path.join(dir, 'history'), maxTurns: 20 },
        discord: {
            provider: 'webhook', channelId: CHANNEL, memberId: 1, maxLength: 2000,
            sanitizeMentions: true, timeoutMs: 5000, webhook: parseWebhookUrl(realWebhook),
        },
        bridge: {
            mode: 'natural', prefix: '', allowUserIds: ['1000000000000000042'], channelId: CHANNEL,
            pollIntervalMs: 1000, maxMessagesPerPoll: 10, startFrom: 'all',
            verifyWindow: 20, stateFile: path.join(dir, 'state.json'),
            lockFile: path.join(dir, 'lock'), pendingDir: path.join(dir, 'pending'),
            apiBase: 'https://discord.com/api/v10',
        },
    };
    const card = loadCard(CARD_JSON);
    const sent = [];
    const api = {
        async getMessages() {
            return [{
                id: USER, authorId: '1000000000000000042', channelId: CHANNEL,
                content: 'hello there', authorBot: false, webhookId: null,
            }];
        },
    };
    const bridge = createBridge({
        config,
        card,
        book: null,
        api,
        generate: async () => ({ text: 'Seraphina: *she smiles* Welcome back.' }),
        send: createSender({
            config,
            card,
            fetchImpl: async (url, init) => {
                sent.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ id: '1500000000000000555', channel_id: CHANNEL }), { status: 200 });
            },
        }),
        verify: async () => false,
        statePath: config.bridge.stateFile,
        pendingDir: config.bridge.pendingDir,
        historyMemberId: historyMemberId(config, card),
    });

    const report = await bridge.pollOnce();
    assert.equal(report.replies.length, 1);
    assert.equal(report.handled, 1);
    assert.equal(report.replies[0].replyId, '1500000000000000555');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].username, 'Seraphina');
    assert.ok(!String(sent[0].content).includes('Seraphina:'));

    const files = fs.readdirSync(config.history.dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].includes(String(historyMemberId(config, card))));
    return `history=${files[0]}, messageId=1500000000000000555`;
});

await test('an ambiguous webhook failure is verified before any resend', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'bridge-ambiguous-'));
    const config = {
        character: { userName: 'User' },
        model: { maxTokens: 120, contextBudget: 4096, timeoutMs: 5000 },
        prompt: { includeFirstMessage: true, includeExamples: false },
        worldInfo: {
            enabled: false, scanDepth: 2, budgetPercent: 25, budgetCapTokens: 0,
            recursive: false, wholeWord: false, maxRecursionSteps: 2, caseSensitive: false,
        },
        history: { dir: path.join(dir, 'history'), maxTurns: 20 },
        discord: {
            provider: 'webhook', channelId: CHANNEL, memberId: 1, maxLength: 2000,
            sanitizeMentions: true, timeoutMs: 5000, webhook: parseWebhookUrl(realWebhook),
        },
        bridge: {
            mode: 'natural', prefix: '', allowUserIds: ['1000000000000000042'], channelId: CHANNEL,
            pollIntervalMs: 1000, maxMessagesPerPoll: 10, startFrom: 'all',
            verifyWindow: 20, stateFile: path.join(dir, 'state.json'),
            lockFile: path.join(dir, 'lock'), pendingDir: path.join(dir, 'pending'),
            apiBase: 'https://discord.com/api/v10',
        },
    };
    const card = loadCard(CARD_JSON);
    let sends = 0;
    const bridge = createBridge({
        config,
        card,
        book: null,
        api: {
            async getMessages() {
                return [{ id: USER, authorId: '1000000000000000042', channelId: CHANNEL, content: 'hi', authorBot: false, webhookId: null }];
            },
        },
        generate: async () => ({ text: 'Seraphina: *nods*' }),
        send: async () => {
            sends += 1;
            throw new DeliveryError('bad gateway', { code: 'DELIVERY_FAILED', status: 502, ambiguous: true });
        },
        verify: async () => true,
        statePath: config.bridge.stateFile,
        pendingDir: config.bridge.pendingDir,
        historyMemberId: historyMemberId(config, card),
    });

    const report = await bridge.pollOnce();
    assert.equal(sends, 1, 'the ambiguous failure must not be resent');
    assert.equal(report.handled, 1);
    assert.equal(report.replies[0].verified, true);
    return 'verified once, sent once';
});

// -------------------------------------------------------------------- summary
hook.server.close();

console.log('');
console.log(`${results.length - failures}/${results.length} webhook tests passed`);
if (failures > 0) {
    process.exitCode = 1;
}
