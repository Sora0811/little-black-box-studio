import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridgeSupervisor, SupervisorError } from '../src/bridge-supervisor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'fake-bridge.mjs');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(check, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) return true;
        await sleep(25);
    }
    return false;
}

function fixture(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'lbb-supervisor-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'config.local.json');
    writeFileSync(configPath, '{}\n', 'utf8');
    return { dir, configPath };
}

test('supervisor starts, reports logs, refuses a second start and stops', async (t) => {
    const { dir, configPath } = fixture(t);
    const supervisor = createBridgeSupervisor({ projectDir: dir, script: SCRIPT });
    t.after(() => supervisor.stopSync());

    assert.equal(supervisor.status().status, 'stopped');
    supervisor.start(configPath);
    assert.equal(supervisor.status().status, 'running');
    assert.ok(supervisor.status().pid > 0);

    assert.ok(await waitFor(() => supervisor.status().logs.some((entry) => /parent=\d+/.test(entry.line))));
    const output = supervisor.status().logs.map((entry) => entry.line).join('\n');
    assert.match(output, /fake bridge started/);
    assert.match(output, /parent=\d+/, 'the child is told which studio process owns it');
    assert.equal(supervisor.status().sinceMs >= 0, true);

    assert.throws(() => supervisor.start(configPath), (error) => error.code === 'BRIDGE_RUNNING');

    const stopped = await supervisor.stop();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.sinceMs, 0, 'the elapsed time only applies while running');
    assert.equal(stopped.lastError, null, 'an intentional stop is not an error');
});

test('supervisor refuses a missing config and explains a lock conflict', async (t) => {
    const { dir, configPath } = fixture(t);
    const supervisor = createBridgeSupervisor({ projectDir: dir, script: SCRIPT });
    t.after(() => supervisor.stopSync());

    assert.throws(() => supervisor.start(path.join(dir, 'nope.json')), (error) => {
        assert.ok(error instanceof SupervisorError);
        assert.equal(error.code, 'CONFIG_MISSING');
        return true;
    });

    const previous = process.env.FAKE_BRIDGE_LOCKED;
    process.env.FAKE_BRIDGE_LOCKED = '1';
    try {
        supervisor.start(configPath);
        assert.ok(await waitFor(() => supervisor.status().status === 'stopped'));
        const status = supervisor.status();
        assert.equal(status.lastExit.code, 2);
        assert.match(status.lastError, /另一個自動回覆程序/);
    } finally {
        if (previous === undefined) delete process.env.FAKE_BRIDGE_LOCKED;
        else process.env.FAKE_BRIDGE_LOCKED = previous;
    }
});
