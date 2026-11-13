/**
 * Runs tools/bridge.mjs as a child of the studio, so one cmd window keeps the
 * page and the Discord replies alive together.
 *
 * The supervisor only starts the bridge after the setup step has written a
 * config file; it never passes tokens on the command line (they are in the
 * config's env file) and it keeps the last lines of output for the page.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class SupervisorError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SupervisorError';
        this.code = details.code ?? 'SUPERVISOR_ERROR';
    }
}

const MAX_LINES = 200;

export function createBridgeSupervisor({
    projectDir = process.cwd(),
    script = null,
    spawnImpl = spawn,
    logLimit = MAX_LINES,
} = {}) {
    const scriptPath = script ?? path.join(projectDir, 'tools', 'bridge.mjs');
    let child = null;
    let startedAt = null;
    let lastExit = null;
    let lastError = null;
    let stopping = false;
    const lines = [];

    function push(stream, chunk) {
        for (const line of String(chunk).split(/\r?\n/)) {
            if (!line.trim()) continue;
            lines.push({ stream, line: line.trimEnd(), at: new Date().toISOString() });
        }
        if (lines.length > logLimit) lines.splice(0, lines.length - logLimit);
    }

    function running() {
        return Boolean(child);
    }

    function start(configPath) {
        if (running()) throw new SupervisorError('自動回覆已在執行。', { code: 'BRIDGE_RUNNING' });
        const resolved = path.resolve(configPath);
        if (!fs.existsSync(resolved)) throw new SupervisorError('找不到設定檔，請先寫入設定。', { code: 'CONFIG_MISSING' });

        lastError = null;
        lastExit = null;
        stopping = false;
        lines.length = 0;

        const proc = spawnImpl(process.execPath, [scriptPath, '--config', resolved], {
            cwd: projectDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // The bridge stops itself if this studio disappears without a clean exit.
            env: { ...process.env, LBB_PARENT_PID: String(process.pid) },
        });
        child = proc;
        startedAt = new Date().toISOString();

        proc.stdout?.on('data', (chunk) => push('out', chunk));
        proc.stderr?.on('data', (chunk) => push('err', chunk));
        proc.on('error', (error) => {
            lastError = error?.message ?? '無法啟動自動回覆。';
            push('err', lastError);
        });
        proc.on('close', (code, signal) => {
            child = null;
            startedAt = null;
            lastExit = { code, signal, at: new Date().toISOString() };
            if (stopping) {
                stopping = false;
                lastError = null;
            } else if (code !== 0 && code !== null) {
                const locked = lines.some((entry) => entry.line.includes('BRIDGE_LOCKED'));
                lastError = locked
                    ? '另一個自動回覆程序正在使用同一個狀態檔，請先關閉它。'
                    : `自動回覆結束（exit ${code}），請看下方輸出。`;
            } else if (code === 0) {
                lastError = null;
            }
        });

        return status();
    }

    async function stop({ timeoutMs = 5000 } = {}) {
        if (!child) return status();
        const proc = child;
        stopping = true;
        await new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already gone */ }
                done();
            }, timeoutMs);
            proc.once('exit', done);
            try {
                proc.kill();
            } catch {
                done();
            }
        });
        child = null;
        startedAt = null;
        stopping = false;
        return status();
    }

    /** Synchronous best effort for process 'exit'. */
    function stopSync() {
        if (!child) return;
        try { child.kill(); } catch { /* already gone */ }
        child = null;
        startedAt = null;
    }

    function status() {
        return {
            status: running() ? 'running' : 'stopped',
            pid: child?.pid ?? null,
            startedAt,
            sinceMs: startedAt ? Date.now() - Date.parse(startedAt) : 0,
            lastExit,
            lastError,
            logs: lines.slice(-80),
        };
    }

    return { start, stop, stopSync, status, scriptPath };
}
