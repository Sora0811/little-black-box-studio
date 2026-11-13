import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeSetup, slugify } from '../src/setup-writer.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const CHANNEL = '1000000000000000001';

function project(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'lbb-writer-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function card(name, description = 'Fictional character.') {
    return { spec: 'chara_card_v2', data: { name, description } };
}

function input(overrides = {}) {
    return {
        card: card('栗燈'),
        model: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'mock' },
        discord: { webhookUrl: WEBHOOK, channelId: CHANNEL },
        bridge: { mode: 'natural', allowUserIds: ['1000000000000000077'] },
        ...overrides,
    };
}

test('slugs stay usable on Windows', async (t) => {
    assert.equal(slugify('Con'), 'con-card');
    assert.equal(slugify('nul'), 'nul-card');
    assert.equal(slugify('COM1'), 'com1-card');
    assert.equal(slugify('栗燈'), '栗燈');
    assert.equal(slugify('  ...  '), 'character');

    const projectDir = project(t);
    const first = writeSetup({ projectDir, ...input() });
    assert.equal(path.basename(first.cardPath), '栗燈.json');

    const second = writeSetup({ projectDir, ...input({ card: card('栗燈', 'A different character.') }) });
    assert.equal(path.basename(second.cardPath), '栗燈-2.json', 'a different card with the same name gets a new file');

    const again = writeSetup({ projectDir, ...input() });
    assert.equal(again.cardPath, first.cardPath, 'an unchanged card reuses its file');
});

test('validation happens before any file is written', async (t) => {
    const projectDir = project(t);
    const rejects = (overrides, pattern) => assert.throws(
        () => writeSetup({ projectDir, ...input(overrides) }),
        pattern,
    );

    rejects({
        model: { provider: 'openai', endpoint: 'https://user:secret@api.example.test/v1', model: 'm' },
    }, /帳密/);
    rejects({
        model: { provider: 'openai', endpoint: 'https://api.example.test/v1?key=1', model: 'm' },
    }, /查詢字串/);
    rejects({
        model: { provider: 'openai', endpoint: 'not a url', model: 'm' },
    }, /格式不正確/);
    rejects({ discord: { webhookUrl: WEBHOOK, channelId: CHANNEL, botToken: 'a\nb' } }, /換行/);
    rejects({ bridge: { mode: 'natural', allowUserIds: '1000000000000000077' } }, /格式錯誤/);
    rejects({ bridge: { mode: 'prefix', prefix: '   ', allowUserIds: [] } }, /非空白的前綴/);
    rejects({
        discord: { webhookUrl: WEBHOOK, channelId: CHANNEL, webhookChannelId: '1000000000000000002' },
    }, /webhook 所屬頻道/);

    assert.equal(existsSync(path.join(projectDir, 'config.local.json')), false, 'a rejected setup leaves no config');
    assert.equal(existsSync(path.join(projectDir, 'data', 'cards')), false, 'a rejected setup creates no card');
});

test('the token file is private and the preview masks secrets', async (t) => {
    const projectDir = project(t);
    const result = writeSetup({
        projectDir,
        ...input({ discord: { webhookUrl: WEBHOOK, channelId: CHANNEL, botToken: 'bot-token-value' } }),
    });

    const tokenFile = path.join(projectDir, 'data', 'bridge.env');
    assert.equal(readFileSync(tokenFile, 'utf8'), 'DISCORD_TOKEN=bot-token-value\n');
    if (process.platform !== 'win32') {
        assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
        assert.equal(statSync(path.join(projectDir, 'config.local.json')).mode & 0o777, 0o600);
    }

    const config = readFileSync(path.join(projectDir, 'config.local.json'), 'utf8');
    assert.ok(!config.includes('bot-token-value'), 'the bot token never lands in the config file');
    assert.ok(!JSON.stringify(result.preview).includes('abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'));
    assert.ok(!JSON.stringify(result.preview).includes('bot-token-value'));

    const files = readdirSync(path.join(projectDir, 'data', 'cards'));
    assert.deepEqual(files.sort(), ['栗燈.json'], 'no world file is written when there is no world book');
});
