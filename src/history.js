import fs from 'node:fs';
import path from 'node:path';

function historyPath({ dir, memberId, channelId }) {
    const safeChannel = String(channelId).replace(/[^\d]/g, '') || 'nochannel';
    return path.join(dir, `${memberId}-${safeChannel}.json`);
}

function emptyStore({ memberId, channelId, character }) {
    return {
        version: 1,
        character,
        memberId,
        channelId: String(channelId ?? ''),
        messages: [],
        updatedAt: null,
    };
}

export function loadHistory({ dir, memberId, channelId, character }) {
    const file = historyPath({ dir, memberId, channelId });
    if (!fs.existsSync(file)) {
        return { store: emptyStore({ memberId, channelId, character }), file, created: true };
    }

    const store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(store.messages)) throw new Error(`History file is corrupted: ${file}`);

    return { store, file, created: false };
}

export function saveHistory({ dir, store, file }) {
    const target = file ?? historyPath({ dir, memberId: store.memberId, channelId: store.channelId });
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const payload = { ...store, updatedAt: new Date().toISOString() };
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
    return target;
}

export function appendMessages(store, messages, { maxTurns = 20 } = {}) {
    for (const message of messages) {
        store.messages.push({
            role: message.role,
            content: message.content,
            at: message.at ?? new Date().toISOString(),
        });
    }

    if (maxTurns > 0) {
        const keep = maxTurns * 2;
        if (store.messages.length > keep) {
            store.messages = store.messages.slice(-keep);
        }
    }

    return store;
}

export function resetHistory({ dir, memberId, channelId, character }) {
    const store = emptyStore({ memberId, channelId, character });
    const file = saveHistory({ dir, store });
    return { store, file };
}

export function ensureFirstMessage(store, card, { enabled = true } = {}) {
    if (!enabled) return false;
    if (store.messages.length > 0) return false;
    if (!card.firstMessage?.trim()) return false;

    store.messages.push({
        role: 'assistant',
        content: card.firstMessage,
        at: new Date().toISOString(),
        origin: 'first_message',
    });
    return true;
}

export function historyStats(store) {
    return {
        messages: store.messages.length,
        turns: Math.floor(store.messages.length / 2),
        updatedAt: store.updatedAt,
    };
}
