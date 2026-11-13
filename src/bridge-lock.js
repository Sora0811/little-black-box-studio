/**
 * Single-instance guard for the bridge.
 *
 * A second process must not answer the same Discord message, so the lock is
 * exclusive. A lock left behind by a dead process is taken over after the
 * stale window, which is what makes a crash-restart work.
 */
import fs from 'node:fs';
import path from 'node:path';

export class LockBusyError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'LockBusyError';
        this.code = 'BRIDGE_LOCKED';
        this.holder = details.holder ?? null;
    }
}

export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

export function readLock(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

export function acquireLock(file, { pid = process.pid, staleMs = 60000, isAlive = isProcessAlive, now = Date.now } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const write = () => {
        const payload = { pid, startedAt: new Date(now()).toISOString(), heartbeatAt: new Date(now()).toISOString() };
        const temporary = `${file}.${pid}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        fs.renameSync(temporary, file);
        return payload;
    };

    let created = false;
    try {
        fs.writeFileSync(file, '', { flag: 'wx' });
        created = true;
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
    }

    if (created) {
        write();
    } else {
        const current = readLock(file);
        const heartbeat = current?.heartbeatAt ? Date.parse(current.heartbeatAt) : 0;
        const stale = !current || (now() - heartbeat > staleMs) || !isAlive(Number(current.pid));
        if (!stale) {
            throw new LockBusyError('Another bridge instance is already running', { holder: current });
        }
        write();
    }

    return {
        file,
        pid,
        heartbeat() {
            write();
        },
        release() {
            const current = readLock(file);
            if (current && Number(current.pid) === pid) {
                try {
                    fs.unlinkSync(file);
                } catch {
                    /* already gone */
                }
            }
        },
    };
}
