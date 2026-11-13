const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let current = LEVELS.info;
const SECRET_KEYS = /token|authorization|secret|password|api[_-]?key/i;

export function setLogLevel(name) {
    if (name in LEVELS) current = LEVELS[name];
}

function redact(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redact);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        out[key] = SECRET_KEYS.test(key) ? '<redacted>' : redact(val);
    }
    return out;
}

function emit(level, message, meta) {
    if (LEVELS[level] > current) return;
    const line = meta === undefined ? message : `${message} ${JSON.stringify(redact(meta))}`;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`[${level}] ${line}\n`);
}

export const log = {
    error: (message, meta) => emit('error', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    info: (message, meta) => emit('info', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
};

export { redact };
