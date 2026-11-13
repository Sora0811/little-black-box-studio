import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/web.js';
import { createBridgeSupervisor } from '../src/bridge-supervisor.js';
import { cardPng } from './fixtures/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function start(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
}

test('Web workspace serves UI, accepts cards and guards local endpoints', async (t) => {
    const origin = await start(t, createStudio());
    const page = await fetch(origin);
    assert.match(await page.text(), /網頁試聊/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (const asset of ['/app.js', '/style.css', '/sample.json']) {
        assert.equal((await fetch(origin + asset)).status, 200);
    }
    assert.equal((await fetch(origin + '/config.json')).status, 404);
    assert.equal((await fetch(origin + '/api/health')).status, 200);
    const headers = { origin, 'Content-Type': 'application/json' };
    const sample = { spec: 'chara_card_v2', data: { name: 'Example', description: 'Fictional.' } };
    const body = JSON.stringify(sample);
    assert.equal((await fetch(origin + '/api/import', { method: 'POST', headers: { ...headers, origin: 'https://example.test' }, body })).status, 403);
    assert.equal((await fetch(origin + '/api/import', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(origin + '/api/import', { method: 'POST', headers, body: ' '.repeat(8 * 1024 * 1024 + 1) })).status, 413);
    const json = await fetch(origin + '/api/import', { method: 'POST', headers, body });
    assert.deepEqual((await json.json()).card, sample);
    for (const keyword of ['chara', 'ccv3']) {
        const png = await fetch(origin + '/api/import', {
            method: 'POST', headers: { origin, 'Content-Type': 'image/png' }, body: cardPng(sample, keyword),
        });
        assert.deepEqual((await png.json()).card, sample);
    }
});

test('Web chat uses both providers, activates lore, persists and resets turns', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lbb-web-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const requests = [];
    const modelEndpoint = await start(t, createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, body: JSON.parse(body) });
        if (requests.at(-1).body.model === 'broken') {
            res.writeHead(401).end('mock private detail');
            return;
        }
        res.end(JSON.stringify(req.url === '/api/chat'
            ? { message: { content: '栗燈: 晚安。' } }
            : { choices: [{ message: { content: '早安。' } }] }));
    }));
    const origin = await start(t, createStudio({ historyDir: dir }));
    const post = (route, body, url = origin) => fetch(url + '/api/' + route, {
        method: 'POST',
        headers: { origin: url, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const card = (await (await fetch(origin + '/sample.json')).json());
    const input = {
        card,
        world: { entries: [{ keys: ['潮汐表'], content: '額外世界書條目。' }] },
        model: { provider: 'ollama', endpoint: modelEndpoint, model: 'mock' },
        message: '我想看潮汐表。',
    };
    const first = await post('chat', input);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).messages.at(-1).content, '晚安。');
    assert.match(JSON.stringify(requests[0].body.messages), /額外世界書條目/);
    assert.match(JSON.stringify(requests[0].body.messages), /東側礁道/);
    assert.equal(requests[0].url, '/api/chat');

    const restart = await start(t, createStudio({ historyDir: dir }));
    assert.equal((await (await post('history', input, restart)).json()).messages.length, 3);
    const openai = { ...input, model: { ...input.model, provider: 'openai' } };
    assert.equal((await post('chat', openai)).status, 200);
    assert.equal(requests[1].url, '/v1/chat/completions');
    assert.match(JSON.stringify(requests[1].body.messages), /晚安/);

    const failed = await post('chat', { ...input, model: { ...input.model, model: 'broken' } });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /mock private detail/);
    assert.equal((await (await post('history', input)).json()).messages.length, 5);

    const reset = await post('reset', input);
    assert.equal((await reset.json()).messages.length, 1);
    assert.equal((await (await post('history', input)).json()).messages.length, 1);
});

test('Setup guide checks Discord read-only and writes a usable config', async (t) => {
    const projectDir = mkdtempSync(path.join(tmpdir(), 'lbb-setup-'));
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));

    const CHANNEL = '1000000000000000001';
    const WEBHOOK_ID = '123456789012345678';
    const WEBHOOK_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    const discord = await start(t, createServer((req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.url.startsWith('/webhooks/')) return send(200, { id: WEBHOOK_ID, name: 'Studio', channel_id: CHANNEL });
        if (req.url === '/users/@me') return send(200, { id: '1000000000000000042', username: 'studio-bot', bot: true });
        if (/^\/channels\/\d+$/.test(req.url)) return send(200, { id: CHANNEL, name: 'test-channel' });
        if (/^\/channels\/\d+\/messages/.test(req.url)) {
            return send(200, [{ id: '2', content: 'hello', author: { id: '1000000000000000077', username: 'sora', global_name: 'Sora' } }]);
        }
        return send(404, { code: 10015, message: 'Unknown' });
    }));

    const supervisor = createBridgeSupervisor({
        projectDir,
        script: path.join(ROOT, 'tests', 'fixtures', 'fake-bridge.mjs'),
    });
    t.after(() => supervisor.stopSync());
    const origin = await start(t, createStudio({
        projectDir,
        historyDir: path.join(projectDir, 'web-history'),
        discordBaseUrl: discord,
        supervisor,
    }));

    const post = (route, body) => fetch(`${origin}/api/${route}`, {
        method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const crossOrigin = await fetch(`${origin}/api/discord/webhook`, {
        method: 'POST',
        headers: { origin: 'https://example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}` }),
    });
    assert.equal(crossOrigin.status, 403, 'the new routes keep the origin guard');

    const webhook = await (await post('discord/webhook', { url: `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}` })).json();
    assert.equal(webhook.ok, true);
    assert.equal(webhook.channelId, CHANNEL);

    assert.equal((await (await post('discord/bot', { token: 'test-token' })).json()).username, 'studio-bot');

    const channel = await (await post('discord/channel', { token: 'test-token', channelId: CHANNEL })).json();
    assert.equal(channel.intent, 'visible');
    assert.deepEqual(channel.authors, [{ id: '1000000000000000077', username: 'Sora' }]);

    const card = await (await fetch(origin + '/sample.json')).json();
    const payload = {
        card,
        world: { entries: [{ keys: ['tide'], content: 'extra lore' }] },
        model: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'mock' },
        discord: {
            webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
            channelId: CHANNEL,
            botToken: 'test-token',
        },
        bridge: { mode: 'natural', prefix: '!devil', allowUserIds: ['1000000000000000077'] },
    };

    const written = await (await post('setup', payload)).json();
    assert.equal(written.ok, true);
    const configPath = path.join(projectDir, 'config.local.json');
    assert.ok(existsSync(configPath));
    assert.ok(existsSync(written.cardPath));
    assert.ok(existsSync(written.worldPath));
    const saved = readFileSync(configPath, 'utf8');
    assert.match(saved, /"provider": "webhook"/);
    assert.match(saved, /bridge\.env/);
    assert.ok(!JSON.stringify(written.preview).includes(WEBHOOK_TOKEN), 'the preview masks the webhook token');
    assert.ok(!/DISCORD_TOKEN/.test(JSON.stringify(written.preview)), 'the preview never carries the bot token');

    const started = await (await post('bridge/start', {})).json();
    assert.equal(started.bridge.status, 'running');
    const status = await (await fetch(origin + '/api/bridge')).json();
    assert.equal(status.status, 'running');
    const stopped = await (await post('bridge/stop', {})).json();
    assert.equal(stopped.bridge.status, 'stopped');

    const noToken = await post('setup', { ...payload, autostart: true, discord: { ...payload.discord, botToken: '' } });
    assert.equal(noToken.status, 400, 'autostart without a bot token is refused before anything is written');
});
