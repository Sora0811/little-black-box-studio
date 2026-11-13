import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createDiscordChecker } from '../src/discord-check.js';

const WEBHOOK_ID = '123456789012345678';
const WEBHOOK_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const CHANNEL = '1000000000000000001';
const BOT = '1000000000000000042';

async function mockDiscord(t, routes) {
    const server = createServer(async (req, res) => {
        const entry = routes.find(([pattern]) => pattern.test(req.url));
        if (!entry) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 10015, message: 'Unknown' }));
            return;
        }
        req.seen = { url: req.url, authorization: req.headers.authorization ?? null };
        await entry[1](req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

test('webhook check resolves the channel without a bot token', async (t) => {
    let seen = null;
    const baseUrl = await mockDiscord(t, [[/^\/webhooks\//, (req, res) => {
        seen = req.seen;
        json(res, 200, { id: WEBHOOK_ID, name: 'Studio', channel_id: CHANNEL, guild_id: '900000000000000001' });
    }]]);
    const checker = createDiscordChecker({ baseUrl });

    const result = await checker.checkWebhook(`https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
    assert.equal(result.ok, true);
    assert.equal(result.channelId, CHANNEL);
    assert.equal(result.name, 'Studio');
    assert.equal(seen.url, `/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
    assert.equal(seen.authorization, null, 'a webhook check must not send a bot token');

    await assert.rejects(
        () => checker.checkWebhook('https://discord.com/api/webhooks/123/too-short'),
        (error) => error.code === 'WEBHOOK_URL_INVALID',
    );
    await assert.rejects(
        () => checker.checkWebhook('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345'),
        (error) => error.code === 'WEBHOOK_URL_INVALID',
    );
    await assert.rejects(
        () => checker.checkWebhook(`https://evil.test/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`),
        (error) => error.code === 'WEBHOOK_URL_INVALID',
    );
});

test('a deleted webhook becomes a readable 404 message', async (t) => {
    const baseUrl = await mockDiscord(t, [[/^\/webhooks\//, (req, res) => {
        json(res, 404, { code: 10015, message: 'Unknown Webhook' });
    }]]);
    const checker = createDiscordChecker({ baseUrl });
    await assert.rejects(
        () => checker.checkWebhook(`https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`),
        (error) => {
            assert.equal(error.status, 404);
            assert.match(error.message, /找不到/);
            return true;
        },
    );
});

test('bot check proves the token and rejects a user token', async (t) => {
    let authorization = null;
    const baseUrl = await mockDiscord(t, [[/^\/users\/@me$/, (req, res) => {
        authorization = req.seen.authorization;
        json(res, 200, { id: BOT, username: 'studio-bot', bot: true });
    }]]);
    const checker = createDiscordChecker({ baseUrl });

    const bot = await checker.checkBot('test-token');
    assert.equal(bot.ok, true);
    assert.equal(bot.id, BOT);
    assert.equal(authorization, 'Bot test-token');

    const human = createDiscordChecker({
        baseUrl: await mockDiscord(t, [[/^\/users\/@me$/, (req, res) => {
            json(res, 200, { id: BOT, username: 'someone', bot: false });
        }]]),
    });
    await assert.rejects(() => human.checkBot('user-token'), (error) => error.code === 'NOT_A_BOT');

    await assert.rejects(() => checker.checkBot('   '), (error) => error.code === 'TOKEN_MISSING');
});

test('channel check reports visible content, stripped content and authors', async (t) => {
    const messages = [
        { id: '1', content: '', author: { id: BOT, username: 'bot', bot: true } },
        { id: '2', content: '我想看潮汐表', author: { id: '1000000000000000077', username: 'sora', global_name: 'Sora' } },
        { id: '3', content: '', author: { id: '1000000000000000077', username: 'sora' } },
    ];
    const baseUrl = await mockDiscord(t, [
        [/^\/channels\/\d+$/, (req, res) => json(res, 200, { id: CHANNEL, name: 'test-channel', guild_id: '900000000000000001' })],
        [/^\/channels\/\d+\/messages/, (req, res) => json(res, 200, messages)],
    ]);
    const checker = createDiscordChecker({ baseUrl });

    const result = await checker.checkChannel({ token: 'test-token', channelId: CHANNEL });
    assert.equal(result.ok, true);
    assert.equal(result.intent, 'visible');
    assert.equal(result.name, 'test-channel');
    assert.deepEqual(result.authors, [{ id: '1000000000000000077', username: 'Sora' }], 'bots are not offered as allowed users');
    assert.equal(result.messagesSeen, 3);
});

test('stripped content points at the Message Content intent', async (t) => {
    const baseUrl = await mockDiscord(t, [
        [/^\/channels\/\d+$/, (req, res) => json(res, 200, { id: CHANNEL, name: 'test-channel' })],
        [/^\/channels\/\d+\/messages/, (req, res) => json(res, 200, [
            { id: '1', content: '', author: { id: '1000000000000000077', username: 'sora' } },
        ])],
    ]);
    const checker = createDiscordChecker({ baseUrl });

    const result = await checker.checkChannel({ token: 'test-token', channelId: CHANNEL });
    assert.equal(result.ok, false);
    assert.equal(result.intent, 'empty');
    assert.match(result.message, /Message Content Intent/);
});

test('an empty channel is unknown rather than broken', async (t) => {
    const baseUrl = await mockDiscord(t, [
        [/^\/channels\/\d+$/, (req, res) => json(res, 200, { id: CHANNEL, name: 'quiet' })],
        [/^\/channels\/\d+\/messages/, (req, res) => json(res, 200, [])],
    ]);
    const checker = createDiscordChecker({ baseUrl });
    const result = await checker.checkChannel({ token: 'test-token', channelId: CHANNEL });
    assert.equal(result.intent, 'unknown');
    assert.equal(result.ok, true);
    assert.match(result.message, /先送一則文字訊息/);
});

test('missing history permission explains the 403', async (t) => {
    const baseUrl = await mockDiscord(t, [
        [/^\/channels\/\d+$/, (req, res) => json(res, 200, { id: CHANNEL, name: 'locked' })],
        [/^\/channels\/\d+\/messages/, (req, res) => json(res, 403, { code: 50001, message: 'Missing Access' })],
    ]);
    const checker = createDiscordChecker({ baseUrl });
    await assert.rejects(
        () => checker.checkChannel({ token: 'test-token', channelId: CHANNEL }),
        (error) => {
            assert.equal(error.status, 403);
            assert.match(error.message, /讀取訊息歷史/);
            return true;
        },
    );
});
