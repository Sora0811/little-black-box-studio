/**
 * Lightweight token estimate, no external tokenizer.
 *
 * CJK and other non-ASCII characters are counted as one token each; ASCII runs
 * are counted at roughly four characters per token. This tracks cl100k/Qwen
 * style tokenizers within a wide margin and is only used for budget control.
 */

const ASCII_RUN = /[\x20-\x7E]+/g;

export function estimateTokens(text) {
    if (!text) return 0;
    const value = String(text);

    let asciiChars = 0;
    for (const run of value.match(ASCII_RUN) ?? []) asciiChars += run.length;

    const nonAscii = value.length - asciiChars;
    const asciiTokens = Math.ceil(asciiChars / 4);
    return asciiTokens + nonAscii;
}

export function estimateMessages(messages) {
    return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}
