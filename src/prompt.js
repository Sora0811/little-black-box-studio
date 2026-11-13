import { substituteMacros } from './macros.js';
import { activateWorldInfo, normalizeBook } from './worldbook.js';
import { estimateTokens } from './token-estimate.js';

export function buildInstruction(card, config) {
    const macros = { char: card.name, user: config.character.userName };
    if (config.prompt.systemPrompt) return substituteMacros(config.prompt.systemPrompt, macros);
    return `Write ${card.name}'s next reply in a fictional chat between ${card.name} and ${config.character.userName}.`;
}

export function buildCharacterBlock(card, config) {
    const macros = { char: card.name, user: config.character.userName };
    const parts = [substituteMacros(card.description, macros).trim()];

    if (card.personality.trim()) {
        parts.push(`Personality: ${substituteMacros(card.personality, macros).trim()}`);
    }
    if (card.scenario.trim()) {
        parts.push(`Scenario: ${substituteMacros(card.scenario, macros).trim()}`);
    }

    return parts.filter(Boolean).join('\n\n');
}

function selectScanTexts(history, userMessage, depth) {
    const limit = Math.max(0, depth - 1);
    const recent = limit === 0 ? [] : history.slice(-limit).map((message) => message.content);
    return [...recent, userMessage];
}

/**
 * @param {object} params
 * @param {object} params.card normalized card
 * @param {object|null} params.book normalized or raw world book
 * @param {{role: string, content: string}[]} params.history stored turns, oldest first
 * @param {string} params.userMessage
 * @param {object} params.config
 */
export function buildPrompt({ card, book, history, userMessage, config }) {
    const worldBook = book ? (book.entries ? book : normalizeBook(book)) : { entries: [] };
    const contextBudget = config.model.contextBudget;
    const reserved = config.model.maxTokens + 32;

    const instruction = buildInstruction(card, config);
    const characterBlock = buildCharacterBlock(card, config);

    let world = { before: '', active: [], skipped: [], usedTokens: 0, budgetTokens: 0, totalEntries: 0 };
    if (config.worldInfo.enabled && worldBook.entries.length) {
        const budgetTokens = config.worldInfo.budgetCapTokens > 0
            ? config.worldInfo.budgetCapTokens
            : Math.floor(contextBudget * (config.worldInfo.budgetPercent / 100));

        world = activateWorldInfo({
            book: worldBook,
            scanTexts: selectScanTexts(history, userMessage, config.worldInfo.scanDepth),
            options: config.worldInfo,
            budgetTokens,
            macros: { char: card.name, user: config.character.userName },
        });
    }

    const fixed = [];
    fixed.push({ role: 'system', content: instruction, meta: { segment: 'instruction' } });
    if (world.before) fixed.push({ role: 'system', content: world.before, meta: { segment: 'world_info' } });
    fixed.push({ role: 'system', content: characterBlock, meta: { segment: 'character' } });

    if (config.prompt.includeExamples && card.examples.trim()) {
        fixed.push({ role: 'system', content: `Example dialogue:\n${substituteMacros(card.examples, { char: card.name, user: config.character.userName })}`, meta: { segment: 'examples' } });
    }

    if (config.prompt.postHistoryInstructions) {
        fixed.push({ role: 'system', content: substituteMacros(config.prompt.postHistoryInstructions, { char: card.name, user: config.character.userName }), meta: { segment: 'post_history' } });
    }

    const userTurn = { role: 'user', content: userMessage, meta: { segment: 'user' } };
    const fixedTokens = fixed.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0) + estimateTokens(userMessage) + 4;
    let remaining = contextBudget - reserved - fixedTokens;

    const kept = [];
    let trimmed = 0;

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        const cost = estimateTokens(message.content) + 4;
        if (cost > remaining) {
            trimmed = index + 1;
            break;
        }
        remaining -= cost;
        kept.unshift({ role: message.role, content: message.content, meta: { segment: 'history' } });
    }

    const messages = [...fixed, ...kept, userTurn];

    return {
        messages: messages.map(({ meta, ...message }) => message),
        detail: messages,
        stats: {
            totalTokens: messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0),
            contextBudget,
            reservedForCompletion: config.model.maxTokens,
            fixedTokens,
            historyTokens: kept.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0),
            worldInfoTokens: world.usedTokens,
            worldInfoBudget: world.budgetTokens,
            worldInfoEntries: world.active,
            worldInfoSkipped: world.skipped,
            worldInfoTotal: world.totalEntries,
            historyKept: kept.length,
            historyTrimmed: trimmed,
            historyTotal: history.length,
        },
    };
}
