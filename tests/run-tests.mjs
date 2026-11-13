#!/usr/bin/env node
/**
 * Offline acceptance suite.
 * Starts a mock model endpoint and a mock Tupperbox proxy, then drives the real
 * CLI as a child process. No Discord traffic, no real model calls, no secrets.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cardPng } from './fixtures/png.mjs';
import { estimateTokens } from '../src/token-estimate.js';
import { sanitizeMentions, truncateForDiscord } from '../src/mentions.js';
import { readCardFromPng, loadCard } from '../src/card.js';
import { normalizeBook, activateWorldInfo } from '../src/worldbook.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const CARD_JSON = path.join(ROOT, 'tests', 'fixtures', 'seraphina.json');
const CARD_PNG = path.join(ROOT, 'examples', 'characters', 'seraphina.png');
const EXTRA_WORLD = path.join(ROOT, 'tests', 'fixtures', 'eldoria-extra.json');
const CHANNEL = '1000000000000000001';

const results = [];
let failures = 0;

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    if (!ok) failures += 1;
    const label = ok ? 'PASS' : 'FAIL';
    console.log(`${label}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function test(name, fn) {
    try {
        const detail = await fn();
        record(name, true, detail);
    } catch (error) {
        record(name, false, error?.message ?? String(error));
    }
}

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, url: `http://127.0.0.1:${port}` });
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

function runCli(args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], {
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
            try { json = JSON.parse(stdout); } catch { /* not JSON mode */ }
            resolve({ code, stdout, stderr, json });
        });
    });
}

function writeConfig(dir, overrides = {}) {
    const config = {
        character: { card: CARD_JSON, world: null, userName: 'User' },
        model: {
            provider: 'ollama',
            endpoint: 'http://127.0.0.1:1',
            model: 'mock-model',
            temperature: 0.7,
            maxTokens: 200,
            contextBudget: 4096,
            timeoutMs: 15000,
        },
        prompt: { includeFirstMessage: true, includeExamples: false },
        worldInfo: { enabled: true, scanDepth: 2, budgetPercent: 25, budgetCapTokens: 0, recursive: false, wholeWord: false },
        history: { dir: path.join(dir, 'history'), maxTurns: 20 },
        discord: {
            provider: 'tupperbox',
            endpoint: 'http://127.0.0.1:1',
            memberId: 1,
            channelId: CHANNEL,
            maxLength: 2000,
            sanitizeMentions: true,
            timeoutMs: 5000,
            token: 'test-token',
            tokenFile: null,
        },
        outbox: { dir: path.join(dir, 'outbox') },
    };
    const merged = { ...config, ...overrides };
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return file;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-engine-test-'));

// ---------------------------------------------------------------- mock model
let modelReply = 'Seraphina: *she smiles* The forest remembers you. @everyone <@123456789012345678>';
let modelCalls = [];

const model = await startServer(async (request, response) => {
    const raw = await readBody(request);
    modelCalls.push({ url: request.url, body: JSON.parse(raw) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
        model: 'mock-model',
        message: { role: 'assistant', content: modelReply },
        done_reason: 'stop',
        prompt_eval_count: 100,
        eval_count: 20,
    }));
});

// ------------------------------------------------------------ mock tupperbox
let proxyStatus = 201;
let proxyCalls = [];

const proxy = await startServer(async (request, response) => {
    const raw = await readBody(request);
    proxyCalls.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    const payload = proxyStatus === 201
        ? { messageId: '1500000000000000123', channelId: CHANNEL }
        : { error: proxyStatus === 401 ? 'unauthorized' : 'forbidden' };
    response.writeHead(proxyStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
});

const baseConfig = () => writeConfig(TMP, {
    model: {
        provider: 'ollama',
        endpoint: model.url,
        model: 'mock-model',
        temperature: 0.7,
        maxTokens: 200,
        contextBudget: 4096,
        timeoutMs: 15000,
    },
    discord: {
        provider: 'tupperbox',
        endpoint: proxy.url,
        memberId: 1,
        channelId: CHANNEL,
        maxLength: 2000,
        sanitizeMentions: true,
        timeoutMs: 5000,
        token: 'test-token',
        tokenFile: null,
    },
});

// ------------------------------------------------------------------- tests
await test('JSON V3 card loads with embedded world book', () => {
    const card = loadCard(CARD_JSON);
    assert.equal(card.name, 'Seraphina');
    assert.equal(card.spec, 'chara_card_v3');
    const book = normalizeBook(card.book);
    assert.equal(book.entries.length, 4);
    return `${card.name}, ${book.entries.length} entries`;
});

await test('PNG card path still parses', () => {
    const CARD_PNG = path.join(TMP, 'card.png');
    fs.writeFileSync(CARD_PNG, cardPng(JSON.parse(fs.readFileSync(CARD_JSON, 'utf8'))));
    const chunks = readCardFromPng(fs.readFileSync(CARD_PNG));
    const card = loadCard(CARD_PNG);
    assert.equal(card.name, 'Seraphina');
    assert.ok(card.description.length > 1000);
    return `chunk=${chunks.chunk}`;
});

await test('world book activates on keyword and respects budget', () => {
    const card = loadCard(CARD_JSON);
    const book = normalizeBook(card.book);
    const budgetTokens = 2048;
    const hit = activateWorldInfo({
        book,
        scanTexts: ['Tell me about Eldoria and the Shadowfangs.'],
        options: { recursive: false, wholeWord: false, caseSensitive: false, maxRecursionSteps: 2 },
        budgetTokens,
        macros: { char: 'Seraphina', user: 'User' },
    });
    assert.ok(hit.active.some((entry) => entry.comment === 'eldoria'));
    assert.ok(hit.active.some((entry) => entry.comment === 'shadowfang'));

    const miss = activateWorldInfo({
        book,
        scanTexts: ['Hello there, how are you today?'],
        options: { recursive: false, wholeWord: false, caseSensitive: false, maxRecursionSteps: 2 },
        budgetTokens,
        macros: { char: 'Seraphina', user: 'User' },
    });
    assert.equal(miss.active.length, 0);

    const tight = activateWorldInfo({
        book,
        scanTexts: ['Eldoria shadowfang glade power magic'],
        options: { recursive: false, wholeWord: false, caseSensitive: false, maxRecursionSteps: 2 },
        budgetTokens: 100,
        macros: { char: 'Seraphina', user: 'User' },
    });
    assert.ok(tight.skipped.length > 0, 'expected entries skipped by budget');
    assert.ok(tight.usedTokens <= 100);
    return `hit=${hit.active.length}, miss=0, budget-skipped=${tight.skipped.length}`;
});

await test('mentions are neutralised and long text is truncated', () => {
    const cleaned = sanitizeMentions('hi @everyone <@!123> <@&456> <#789> @here');
    assert.ok(!/@everyone\b/.test(cleaned));
    assert.ok(!/<@/.test(cleaned));
    const long = 'x'.repeat(2500);
    const cut = truncateForDiscord(long, 2000);
    assert.equal(cut.truncated, true);
    assert.ok(Array.from(cut.text).length <= 2000);
    return cleaned;
});

await test('prompt assembly includes card, world info and token accounting', async () => {
    const config = baseConfig();
    const run = await runCli(['--config', config, '--message', 'Tell me about Eldoria and the Shadowfangs.', '--show-prompt', '--json']);
    assert.equal(run.code, 0, run.stderr);
    const stats = run.json.stats;
    assert.ok(stats.worldInfoEntries.some((entry) => entry.comment === 'eldoria'));
    assert.ok(stats.totalTokens < stats.contextBudget);
    const contents = run.json.messages.map((message) => message.content).join('\n');
    assert.ok(contents.includes('Seraphina'));
    return `messages=${run.json.messages.length}, tokens=${stats.totalTokens}/${stats.contextBudget}, wi=${stats.worldInfoTokens}`;
});

await test('preview generates, never calls the proxy, and does not grow history', async () => {
    const config = baseConfig();
    await runCli(['--config', config, '--reset', '--json']);
    const before = await runCli(['--config', config, '--history', '--json']);
    assert.equal(before.json.stats.messages, 1);

    proxyCalls = [];
    const run = await runCli(['--config', config, '--message', 'Tell me about Eldoria.', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.sent, false);
    assert.equal(run.json.historySaved, false);
    assert.ok(run.json.content.length > 0);
    assert.equal(proxyCalls.length, 0, 'proxy must not be called in preview');

    const after = await runCli(['--config', config, '--history', '--json']);
    assert.equal(after.json.stats.messages, 1, 'preview must not persist a turn');
    return `preview chars=${run.json.content.length}, proxy calls=0, history unchanged`;
});

await test('--save-preview keeps a preview turn in history', async () => {
    const config = baseConfig();
    const run = await runCli(['--config', config, '--message', 'A private rehearsal.', '--save-preview', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.sent, false);
    assert.equal(run.json.historySaved, true);
    const after = await runCli(['--config', config, '--history', '--json']);
    assert.equal(after.json.stats.messages, 3);
    return 'history=3 (greeting + 1 turn)';
});

await test('send path posts memberId/channelId/content and returns messageId', async () => {
    const config = baseConfig();
    await runCli(['--config', config, '--reset', '--json']);
    proxyStatus = 201;
    proxyCalls = [];
    const run = await runCli(['--config', config, '--message', 'Tell me about Eldoria and the Shadowfangs.', '--send', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.sent, true);
    assert.equal(run.json.messageId, '1500000000000000123');
    assert.equal(proxyCalls.length, 1);
    const body = proxyCalls[0].body;
    assert.equal(body.memberId, 1);
    assert.equal(body.channelId, CHANNEL);
    assert.ok(body.content.length > 0);
    assert.ok(!/@everyone\b|<@!?\d+>/.test(body.content), 'mentions must be neutralised before sending');
    assert.match(String(proxyCalls[0].headers.authorization), /^Bearer /);
    return `messageId=${run.json.messageId}, content=${body.content.length} chars`;
});

await test('second turn reads the first turn from history', async () => {
    const config = baseConfig();
    const run = await runCli(['--config', config, '--message', 'What about the glade?', '--show-prompt', '--json']);
    assert.equal(run.code, 0, run.stderr);
    const joined = run.json.messages.map((message) => message.content).join('\n');
    assert.ok(joined.includes('Tell me about Eldoria and the Shadowfangs.'), 'first user turn missing from prompt');
    assert.ok(run.json.stats.historyKept >= 3, `historyKept=${run.json.stats.historyKept}`);
    return `historyKept=${run.json.stats.historyKept}`;
});

await test('history survives a restart (new process reads the same file)', async () => {
    const config = baseConfig();
    const first = await runCli(['--config', config, '--history', '--json']);
    assert.equal(first.code, 0, first.stderr);
    const countBefore = first.json.stats.messages;

    const second = await runCli(['--config', config, '--history', '--json']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.stats.messages, countBefore);
    assert.ok(countBefore >= 3);
    return `messages=${countBefore}, file=${path.basename(first.json.historyFile)}`;
});

await test('invalid token (401) is reported as failure and kept in outbox', async () => {
    const config = baseConfig();
    proxyStatus = 401;
    proxyCalls = [];
    const run = await runCli(['--config', config, '--message', 'Hello again.', '--send', '--json']);
    assert.equal(run.code, 2, `expected exit 2, got ${run.code}`);
    assert.equal(run.json.sent, false);
    assert.equal(run.json.deliveryError.code, 'unauthorized');
    assert.equal(run.json.deliveryError.status, 401);
    assert.ok(run.json.content.length > 0, 'generation must be preserved');
    assert.ok(fs.existsSync(run.json.outboxFile), 'outbox file missing');
    const saved = JSON.parse(fs.readFileSync(run.json.outboxFile, 'utf8'));
    assert.equal(saved.content, run.json.content);
    return `code=401, outbox=${path.basename(run.json.outboxFile)}`;
});

await test('unauthorized channel (403) is reported, not counted as success', async () => {
    const config = baseConfig();
    proxyStatus = 403;
    const run = await runCli(['--config', config, '--message', 'Hello once more.', '--send', '--json']);
    assert.equal(run.code, 2);
    assert.equal(run.json.sent, false);
    assert.equal(run.json.deliveryError.status, 403);
    assert.match(run.json.deliveryError.message, /沒有授權/);
    return 'status=403';
});

await test('separate world file loads and triggers its own keywords', async () => {
    const config = writeConfig(TMP, {
        character: { card: CARD_JSON, world: EXTRA_WORLD, userName: 'User' },
        model: { provider: 'ollama', endpoint: model.url, model: 'mock-model', temperature: 0.7, maxTokens: 200, contextBudget: 4096, timeoutMs: 15000 },
        discord: { provider: 'tupperbox', endpoint: proxy.url, memberId: 1, channelId: CHANNEL, maxLength: 2000, sanitizeMentions: true, timeoutMs: 5000, token: 'test-token', tokenFile: null },
    });
    const run = await runCli(['--config', config, '--message', '月影議會知道銀葉草嗎？', '--show-prompt', '--json']);
    assert.equal(run.code, 0, run.stderr);
    const comments = run.json.stats.worldInfoEntries.map((entry) => entry.comment);
    assert.ok(comments.includes('月影議會'), `missing 月影議會: ${comments.join(',')}`);
    assert.ok(comments.includes('銀葉草'));
    return comments.join(', ');
});

await test('model empty reply is an explicit error, not an empty send', async () => {
    modelReply = '';
    const config = baseConfig();
    const run = await runCli(['--config', config, '--message', 'Say something.', '--json']);
    assert.equal(run.code, 1);
    assert.equal(run.json.ok, false);
    assert.equal(run.json.code, 'MODEL_EMPTY_REPLY');
    modelReply = 'Seraphina: *she smiles* The forest remembers you.';
    return 'MODEL_EMPTY_REPLY';
});

await test('outbox retry resends without calling the model again', async () => {
    const config = baseConfig();
    proxyStatus = 401;
    const failed = await runCli(['--config', config, '--message', 'Retry probe.', '--send', '--json']);
    assert.equal(failed.code, 2);
    const outboxFile = failed.json.outboxFile;
    assert.ok(fs.existsSync(outboxFile));

    const modelCallsBefore = modelCalls.length;
    proxyStatus = 201;
    proxyCalls = [];
    const retried = await runCli(['--config', config, '--retry', outboxFile, '--json']);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(retried.json.messageId, '1500000000000000123');
    assert.equal(modelCalls.length, modelCallsBefore, 'retry must not call the model again');
    assert.equal(proxyCalls.length, 1);
    assert.ok(fs.existsSync(`${outboxFile}.sent`), 'outbox should be renamed after a successful retry');
    return 'no model call, 1 proxy call';
});

await test('token file prefers the proxy token over DISCORD_TOKEN', async () => {
    const { loadConfig } = await import('../src/config.js');
    const dir = path.join(TMP, 'tokenfile');
    fs.mkdirSync(dir, { recursive: true });
    const envFile = path.join(dir, 'bot.env');
    fs.writeFileSync(envFile, [
        '# dotenv',
        'DISCORD_TOKEN=discord-bot-secret',
        'PROXY_API_PORT=8787',
        'PROXY_API_TOKEN=proxy-api-secret',
    ].join('\n'), 'utf8');

    const configFile = writeConfig(dir, {
        discord: {
            provider: 'tupperbox',
            endpoint: proxy.url,
            memberId: 1,
            channelId: CHANNEL,
            maxLength: 2000,
            sanitizeMentions: true,
            timeoutMs: 5000,
            token: null,
            tokenFile: envFile,
        },
    });

    const { config } = loadConfig(configFile);
    assert.equal(config.discord.token, 'proxy-api-secret');
    return `source=${config.discord.tokenSource}`;
});

await test('model API key is bound to its endpoint for CLI and bridge', async () => {
    const { loadConfig } = await import('../src/config.js');
    const dir = path.join(TMP, 'model-key');
    fs.mkdirSync(dir, { recursive: true });
    const configFile = writeConfig(dir, {
        model: {
            provider: 'openai',
            endpoint: 'https://api.example.test/v1',
            model: 'mock-model',
            temperature: 0.7,
            maxTokens: 200,
            contextBudget: 4096,
            timeoutMs: 5000,
            apiKey: 'sk-from-file',
        },
    });
    const names = ['RP_MODEL_API_KEY', 'RP_MODEL_KEY_ENDPOINT', 'RP_WEB_MODEL_API_KEY', 'RP_WEB_KEY_ENDPOINT'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const restore = () => {
        for (const name of names) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    };
    try {
        for (const name of names) delete process.env[name];
        assert.equal(loadConfig(configFile).config.model.apiKey, undefined, 'a key in the config file is ignored');

        process.env.RP_WEB_MODEL_API_KEY = 'sk-web';
        process.env.RP_WEB_KEY_ENDPOINT = 'https://api.example.test/v1';
        assert.equal(loadConfig(configFile).config.model.apiKey, 'sk-web', 'the web variable also serves the bridge');

        process.env.RP_MODEL_API_KEY = 'sk-cli';
        process.env.RP_MODEL_KEY_ENDPOINT = 'https://api.example.test/v1';
        assert.equal(loadConfig(configFile).config.model.apiKey, 'sk-cli', 'the shared variable wins');

        process.env.RP_MODEL_KEY_ENDPOINT = 'https://other.example.test/v1';
        assert.equal(loadConfig(configFile).config.model.apiKey, undefined, 'a key is never sent to another endpoint');
        return 'file key ignored, endpoint binding enforced';
    } finally {
        restore();
    }
});

await test('--reset clears history but keeps the greeting', async () => {
    const config = baseConfig();
    const run = await runCli(['--config', config, '--reset', '--json']);
    assert.equal(run.code, 0, run.stderr);
    const after = await runCli(['--config', config, '--history', '--json']);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(after.json.stats.messages, 1);
    return 'messages=1 (first_message only)';
});

// ---------------------------------------------------------------- teardown
model.server.close();
proxy.server.close();
fs.rmSync(TMP, { recursive: true, force: true });

const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} tests passed`);
if (failures > 0) process.exitCode = 1;
