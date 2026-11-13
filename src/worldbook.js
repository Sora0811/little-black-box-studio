import { estimateTokens } from './token-estimate.js';
import { substituteMacros } from './macros.js';

function toArray(value) {
    if (Array.isArray(value)) return value.map(String).filter((item) => item.trim());
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
}

function normalizeEntry(entry, index) {
    const id = entry.uid ?? entry.id ?? index;
    const rawKeys = entry.keys ?? entry.key ?? entry.keywords ?? [];
    const rawSecondary = entry.secondary_keys ?? entry.keysecondary ?? entry.secondaryKeys ?? [];

    return {
        id,
        comment: String(entry.comment ?? entry.name ?? entry.title ?? `entry-${id}`),
        keys: toArray(rawKeys),
        secondaryKeys: toArray(rawSecondary),
        content: String(entry.content ?? ''),
        enabled: entry.enabled !== undefined ? Boolean(entry.enabled) : entry.disable !== true,
        constant: Boolean(entry.constant ?? entry.always ?? false),
        order: Number(entry.insertion_order ?? entry.order ?? 100),
        caseSensitive: entry.case_sensitive ?? null,
        wholeWord: entry.match_whole_words ?? null,
        source: entry.world ?? null,
    };
}

/**
 * Accepts a V3 character_book ({entries: [...]}, an ST world file
 * ({entries: {"0": {...}}}), or a bare entry array.
 */
export function normalizeBook(input) {
    if (!input) return { name: null, entries: [] };

    const container = input.character_book ?? input.book ?? input;
    const name = container.name ?? input.name ?? null;

    const rawEntries = container.entries ?? container;
    let list = [];

    if (Array.isArray(rawEntries)) {
        list = rawEntries;
    } else if (rawEntries && typeof rawEntries === 'object') {
        list = Object.values(rawEntries);
    }

    const entries = list
        .filter((entry) => entry && typeof entry === 'object')
        .map(normalizeEntry)
        .filter((entry) => entry.content.trim().length > 0);

    return { name, entries };
}

function keyMatches(text, key, { caseSensitive, wholeWord }) {
    if (!key) return false;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? key : key.toLowerCase();

    if (!wholeWord) return haystack.includes(needle);

    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[\p{L}\p{N}_]/u.test(needle) ? '(?<![\\p{L}\\p{N}_])' : '';
    const right = /[\p{L}\p{N}_]$/u.test(needle) ? '(?![\\p{L}\\p{N}_])' : '';
    const flags = caseSensitive ? 'u' : 'iu';

    try {
        return new RegExp(`${left}${escaped}${right}`, flags).test(text);
    } catch {
        return haystack.includes(needle);
    }
}

function findHits(entry, text, options) {
    const caseSensitive = entry.caseSensitive ?? options.caseSensitive;
    const wholeWord = entry.wholeWord ?? options.wholeWord;

    return entry.keys.filter((key) => keyMatches(text, key, { caseSensitive, wholeWord }));
}

/**
 * Keyword activation with optional recursion and a token budget.
 *
 * @param {object} params
 * @param {{entries: object[]}} params.book normalized book
 * @param {string[]} params.scanTexts oldest to newest; the last item is the current input
 * @param {object} params.options worldInfo config
 * @param {number} params.budgetTokens absolute budget for activated entries
 * @param {{char: string, user: string}} params.macros
 */
export function activateWorldInfo({ book, scanTexts, options, budgetTokens, macros }) {
    const entries = [...book.entries].sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));

    const active = [];
    const skipped = [];
    const activatedIds = new Set();

    const baseText = scanTexts.join('\n');
    const liveText = { value: baseText };

    const tryActivate = (entry, reason, matchedKeys) => {
        if (activatedIds.has(entry.id)) return false;
        const content = substituteMacros(entry.content, macros);
        const tokens = estimateTokens(content);

        const used = active.reduce((sum, item) => sum + item.tokens, 0);
        if (used + tokens > budgetTokens) {
            skipped.push({ id: entry.id, comment: entry.comment, tokens, reason: 'budget' });
            activatedIds.add(entry.id);
            return false;
        }

        active.push({ id: entry.id, comment: entry.comment, keys: entry.keys, matchedKeys, reason, tokens, content });
        activatedIds.add(entry.id);
        return true;
    };

    for (const entry of entries) {
        if (!entry.enabled) continue;
        if (entry.constant) {
            tryActivate(entry, 'constant', []);
            continue;
        }
        const hits = findHits(entry, liveText.value, options);
        if (!hits.length) continue;

        if (entry.secondaryKeys.length) {
            const secondary = entry.secondaryKeys.filter((key) =>
                keyMatches(liveText.value, key, {
                    caseSensitive: entry.caseSensitive ?? options.caseSensitive,
                    wholeWord: entry.wholeWord ?? options.wholeWord,
                }));
            if (!secondary.length) continue;
            tryActivate(entry, 'keyword+secondary', [...hits, ...secondary]);
        } else {
            tryActivate(entry, 'keyword', hits);
        }
    }

    if (options.recursive) {
        let steps = 0;
        let changed = true;
        while (changed && steps < Math.max(1, options.maxRecursionSteps)) {
            steps += 1;
            changed = false;
            const recursionText = active.map((item) => item.content).join('\n');
            if (!recursionText.trim()) break;

            for (const entry of entries) {
                if (!entry.enabled || activatedIds.has(entry.id)) continue;
                if (findHits(entry, recursionText, options).length === 0) continue;
                if (tryActivate(entry, 'recursive', findHits(entry, recursionText, options))) changed = true;
            }
        }
    }

    const before = active.map((item) => item.content).join('\n');
    const usedTokens = active.reduce((sum, item) => sum + item.tokens, 0);

    return {
        before,
        active: active.map(({ content, ...rest }) => rest),
        skipped,
        usedTokens,
        budgetTokens,
        totalEntries: entries.length,
    };
}

export function mergeBooks(cardBook, extraBook) {
    const books = [cardBook, extraBook].filter(Boolean).map(normalizeBook);
    const entries = [];
    books.forEach((book, bookIndex) => {
        book.entries.forEach((entry, entryIndex) => {
            entries.push({ ...entry, id: `${bookIndex}-${entryIndex}-${entry.id}` });
        });
    });
    return { name: books.map((book) => book.name).filter(Boolean).join('+') || null, entries };
}
