/**
 * Discord bridge core.
 *
 * Polls one channel over REST, decides whether a message is addressed to the
 * character, generates a reply through the existing prompt/model pipeline and
 * posts it with the configured delivery provider (channel webhook by default,
 * Tupperbox proxy as a legacy option). Two modes:
 *
 *   prefix  — only messages starting with the configured prefix
 *   natural — any message from an allowed user in the allowed channel
 *
 * Everything external (Discord, model, proxy, clock) is injected so the whole
 * flow can be exercised offline.
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildPrompt } from './prompt.js';
import { loadHistory, saveHistory, appendMessages } from './history.js';
import { sanitizeMentions, truncateForDiscord } from './mentions.js';
import { stripCharacterPrefix } from './macros.js';
import { compareIds } from './discord-api.js';

export const BRIDGE_DEFAULTS = {
    mode: 'prefix',
    prefix: '!devil',
    channelId: null,
    allowUserIds: [],
    pollIntervalMs: 4000,
    maxMessagesPerPoll: 20,
    startFrom: 'latest',
    verifyWindow: 20,
    stateFile: 'data/bridge-state.json',
    lockFile: 'data/bridge.lock',
    pendingDir: 'data/bridge-pending',
    botTokenFile: null,
    apiBase: 'https://discord.com/api/v10',
};

export const BRIDGE_MODES = ['prefix', 'natural'];

export function resolveBridgeConfig(config) {
    const raw = config.bridge ?? {};
    const cfg = { ...BRIDGE_DEFAULTS, channelId: config.discord?.channelId ?? null, ...raw };

    if (!BRIDGE_MODES.includes(cfg.mode)) {
        throw new Error(`bridge.mode must be one of ${BRIDGE_MODES.join(' | ')} (got ${cfg.mode})`);
    }
    if (cfg.mode === 'prefix' && !String(cfg.prefix ?? '').trim()) {
        throw new Error('bridge.prefix must not be empty in prefix mode');
    }
    if (!/^[1-9]\d{16,19}$/.test(String(cfg.channelId ?? ''))) {
        throw new Error('bridge.channelId must be a Discord snowflake string (or set discord.channelId)');
    }
    if (!Array.isArray(cfg.allowUserIds) || cfg.allowUserIds.length === 0) {
        throw new Error('bridge.allowUserIds must list at least one Discord user id');
    }
    for (const id of cfg.allowUserIds) {
        if (!/^[1-9]\d{16,19}$/.test(String(id))) {
            throw new Error(`bridge.allowUserIds contains a non-snowflake id: ${id}`);
        }
    }
    if (!Number.isFinite(cfg.pollIntervalMs) || cfg.pollIntervalMs < 1000) {
        throw new Error('bridge.pollIntervalMs must be >= 1000');
    }
    if (!Number.isInteger(cfg.maxMessagesPerPoll) || cfg.maxMessagesPerPoll < 1 || cfg.maxMessagesPerPoll > 100) {
        throw new Error('bridge.maxMessagesPerPoll must be between 1 and 100');
    }
    if (!['latest', 'all'].includes(cfg.startFrom)) {
        throw new Error('bridge.startFrom must be "latest" or "all"');
    }
    return cfg;
}

/** Returns the text addressed to the character, or null when it is not for her. */
export function parseTrigger(content, cfg) {
    const text = String(content ?? '').trim();
    if (!text) return null;

    if (cfg.mode === 'natural') return text;

    const prefix = String(cfg.prefix).trim();
    if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const rest = text.slice(prefix.length).trim();
    return rest || null;
}

/**
 * Decide whether a Discord message should be answered.
 * Returns { text } when accepted, or { skip: reason } otherwise.
 */
export function classifyMessage(message, cfg, { selfUserId = null } = {}) {
    if (!message?.id) return { skip: 'no_id' };
    if (message.authorBot) return { skip: 'bot' };
    if (message.webhookId) return { skip: 'webhook' };
    if (selfUserId && message.authorId === selfUserId) return { skip: 'self' };
    if (!cfg.allowUserIds.map(String).includes(String(message.authorId))) return { skip: 'not_allowed' };
    if (String(message.channelId) !== String(cfg.channelId)) return { skip: 'other_channel' };
    if (message.attachmentCount && !String(message.content ?? '').trim()) return { skip: 'attachment_only' };

    const text = parseTrigger(message.content, cfg);
    if (!text) return { skip: 'no_trigger' };
    return { text };
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
}

export function emptyState({ channelId, mode }) {
    return {
        version: 1,
        channelId: String(channelId),
        mode,
        lastMessageId: null,
        processed: [],
        updatedAt: null,
    };
}

export function loadState(file, { channelId, mode }) {
    const raw = readJson(file, null);
    const sameChannel = raw && typeof raw === 'object' && String(raw.channelId ?? '') === String(channelId);
    // A cursor belongs to one channel. Reusing it after a setup change would
    // answer a backlog in the new channel or drop new messages in the old one.
    const state = sameChannel ? raw : emptyState({ channelId, mode });
    if (!Array.isArray(state.processed)) state.processed = [];
    if (!('lastMessageId' in state)) state.lastMessageId = null;
    return state;
}

export function saveState(file, state) {
    writeJsonAtomic(file, { ...state, updatedAt: new Date().toISOString() });
}

/**
 * @param {object} deps
 * @param {object} deps.config full engine config (bridge section resolved separately)
 * @param {object} deps.card  loaded character card
 * @param {object} deps.book  normalized world book
 * @param {object} deps.api   { getMessages(channelId, opts) }
 * @param {Function} deps.generate ({config, messages}) => {text, ...}
 * @param {Function} deps.send (content) => {messageId, channelId}
 * @param {Function} deps.verify (content, afterId) => boolean
 * @param {string} deps.statePath
 * @param {string} deps.pendingDir
 */
export function createBridge({ config, card, book, api, generate, send, verify, statePath, pendingDir, selfUserId = null, historyMemberId = null, logger = null }) {
    const cfg = resolveBridgeConfig(config);
    const historyId = historyMemberId ?? config.discord.memberId;
    const state = loadState(statePath, { channelId: cfg.channelId, mode: cfg.mode });
    state.mode = cfg.mode;

    const log = (level, message, data) => {
        if (logger?.[level]) logger[level](message, data);
    };

    function persist() {
        saveState(statePath, state);
    }

    function loadStore() {
        return loadHistory({
            dir: config.history.dir,
            memberId: historyId,
            channelId: cfg.channelId,
            character: card.name,
        });
    }

    function markProcessed(messageId) {
        if (!state.processed.includes(messageId)) state.processed.push(messageId);
        if (state.processed.length > 50) state.processed = state.processed.slice(-50);
        if (!state.lastMessageId || compareIds(messageId, state.lastMessageId) > 0) state.lastMessageId = messageId;
        persist();
    }

    function pendingPath(messageId) {
        return path.join(pendingDir, `${messageId}.json`);
    }

    function writePending(payload) {
        ensureDir(pendingDir);
        const file = pendingPath(payload.messageId);
        writeJsonAtomic(file, payload);
        return file;
    }

    function readPending() {
        if (!fs.existsSync(pendingDir)) return [];
        return fs.readdirSync(pendingDir)
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => ({ file: path.join(pendingDir, name), payload: readJson(path.join(pendingDir, name), null) }))
            .filter((entry) => entry.payload && entry.payload.messageId && entry.payload.content);
    }

    function commitTurn(message, text, content) {
        const { store } = loadStore();
        appendMessages(store, [
            { role: 'user', content: text },
            { role: 'assistant', content: content },
        ], { maxTurns: config.history.maxTurns });
        saveHistory({ dir: config.history.dir, store });
        markProcessed(message.messageId ?? message.id);
    }

    function cleanReply(raw) {
        const text = config.discord.sanitizeMentions ? stripCharacterPrefix(raw, card.name) : raw;
        return truncateForDiscord(sanitizeMentions(text), config.discord.maxLength);
    }

    async function deliverWithGuards({ messageId, userMessage, content }) {
        const pendingFile = writePending({
            messageId,
            userMessage,
            content,
            channelId: cfg.channelId,
            memberId: historyId,
            createdAt: new Date().toISOString(),
        });

        try {
            const delivery = await send(content);
            commitTurn({ messageId }, userMessage, content);
            fs.renameSync(pendingFile, `${pendingFile}.done`);
            return { ok: true, messageId: delivery.messageId ?? null, retried: false };
        } catch (error) {
            const ambiguous = error?.ambiguous === true ||
                error?.code === 'DELIVERY_TIMEOUT' || error?.code === 'DELIVERY_UNREACHABLE';
            if (ambiguous) {
                const arrived = await verify(content, messageId).catch(() => false);
                if (arrived) {
                    commitTurn({ messageId }, userMessage, content);
                    fs.renameSync(pendingFile, `${pendingFile}.done`);
                    log('warn', 'Delivery timed out but the message was found in the channel; not resending.');
                    return { ok: true, messageId: null, verified: true };
                }
            }

            try {
                const retry = await send(content);
                commitTurn({ messageId }, userMessage, content);
                fs.renameSync(pendingFile, `${pendingFile}.done`);
                log('warn', 'First delivery failed; the same content was sent once more.');
                return { ok: true, messageId: retry.messageId ?? null, retried: true };
            } catch (second) {
                log('error', 'Delivery failed twice; keeping the pending record.', {
                    code: second?.code ?? error?.code ?? 'UNKNOWN',
                    status: second?.status ?? error?.status ?? null,
                });
                return {
                    ok: false,
                    reason: 'delivery_failed',
                    error: { code: second?.code ?? error?.code ?? 'UNKNOWN', status: second?.status ?? error?.status ?? null },
                    pendingFile,
                };
            }
        }
    }

    /** Finish or resend work left over from a previous run or a failed cycle. */
    async function resolvePending() {
        const pending = readPending();
        const report = { resolved: 0, failed: 0, skipped: 0 };
        for (const { file, payload } of pending) {
            // A pending reply belongs to the channel and character that produced
            // it; sending it after a setup change would post to the wrong place.
            if (String(payload.channelId ?? '') !== String(cfg.channelId) ||
                String(payload.memberId ?? '') !== String(historyId)) {
                const stale = `${file}.stale`;
                fs.renameSync(file, fs.existsSync(stale) ? `${file}.${Date.now()}.stale` : stale);
                report.skipped += 1;
                continue;
            }
            const arrived = await verify(payload.content, payload.messageId).catch(() => null);
            if (arrived === true) {
                commitTurn({ messageId: payload.messageId }, payload.userMessage, payload.content);
                fs.renameSync(file, `${file}.done`);
                report.resolved += 1;
                continue;
            }

            const outcome = await deliverWithGuards(payload);
            if (outcome.ok) report.resolved += 1;
            else {
                report.failed += 1;
                break;
            }
        }
        return report;
    }

    async function replyTo(message, text) {
        const { store } = loadStore();
        const prompt = buildPrompt({
            card,
            book,
            history: store.messages,
            userMessage: text,
            config,
        });

        let generation;
        try {
            generation = await generate({ config, messages: prompt.messages });
        } catch (error) {
            return { ok: false, reason: 'model_failed', error: { code: error?.code ?? 'MODEL_ERROR', status: error?.status ?? null } };
        }

        const raw = generation?.text ?? '';
        if (!raw.trim()) return { ok: false, reason: 'empty_generation' };

        const clean = cleanReply(raw);
        const outcome = await deliverWithGuards({ messageId: message.id, userMessage: text, content: clean.text });
        return { ...outcome, chars: clean.text.length, truncated: clean.truncated };
    }

    async function pollOnce() {
        const pending = await resolvePending();
        const older = state.lastMessageId ?? undefined;

        let messages = await api.getMessages(cfg.channelId, { after: older, limit: cfg.maxMessagesPerPoll });

        if (!older) {
            const newest = messages.reduce((acc, message) => (acc === null || compareIds(message.id, acc) > 0 ? message.id : acc), null);
            if (cfg.startFrom === 'all') {
                state.lastMessageId = '0';
            } else if (newest) {
                state.lastMessageId = newest;
                persist();
                return { baseline: true, skipped: messages.length, handled: 0, pending, lastMessageId: newest };
            }
        }

        messages = [...messages].sort((a, b) => compareIds(a.id, b.id));
        const report = { handled: 0, skipped: 0, replies: [], pending, stopped: false };

        for (const message of messages) {
            if (state.lastMessageId && compareIds(message.id, state.lastMessageId) <= 0) continue;

            if (state.processed.includes(message.id)) {
                markProcessed(message.id);
                report.skipped += 1;
                continue;
            }

            const verdict = classifyMessage(message, cfg, { selfUserId });
            if (verdict.skip) {
                markProcessed(message.id);
                report.skipped += 1;
                continue;
            }

            const outcome = await replyTo(message, verdict.text);
            if (outcome.ok) {
                report.handled += 1;
                report.replies.push({
                    messageId: message.id,
                    replyId: outcome.messageId ?? null,
                    chars: outcome.chars ?? 0,
                    verified: Boolean(outcome.verified),
                    retried: Boolean(outcome.retried),
                });
            } else {
                report.stopped = true;
                report.replies.push({ messageId: message.id, error: outcome.reason, detail: outcome.error ?? null });
                break;
            }
        }

        report.lastMessageId = state.lastMessageId;
        return report;
    }

    return {
        config: cfg,
        state,
        pollOnce,
        resolvePending,
        pending: () => readPending(),
        status: () => ({
            mode: cfg.mode,
            prefix: cfg.prefix,
            channelId: cfg.channelId,
            allowUserIds: cfg.allowUserIds,
            pollIntervalMs: cfg.pollIntervalMs,
            lastMessageId: state.lastMessageId,
            processed: state.processed.length,
            pending: readPending().length,
            stateFile: statePath,
        }),
    };
}
