/**
 * Character-card macro substitution.
 * Supports the common SillyTavern macros that appear inside cards and world books.
 */

const MACRO = /\{\{(char|user|original)\}\}|<BOT>|<USER>/gi;

export function substituteMacros(text, context = {}) {
    const char = context.char ?? 'Character';
    const user = context.user ?? 'User';

    return String(text ?? '').replace(MACRO, (match, macro) => {
        if (match === '<BOT>') return char;
        if (match === '<USER>') return user;
        switch (String(macro).toLowerCase()) {
            case 'char':
                return char;
            case 'user':
                return user;
            case 'original':
                return '';
            default:
                return match;
        }
    });
}

export function stripCharacterPrefix(text, charName) {
    if (!charName) return text;
    const pattern = new RegExp(`^\\s*${escapeRegExp(charName)}\\s*(?:[:：]|\\bsays\\b)\\s*`, 'i');
    return String(text ?? '').replace(pattern, '');
}

export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
