/**
 * Discord mention neutralisation.
 * Both delivery paths can disable mentions server-side (the webhook via
 * `allowed_mentions`, the proxy on its own), but generated text must not depend
 * on that: the engine never emits a live @everyone/@here or a raw
 * user/role/channel mention tag.
 */

export function sanitizeMentions(text) {
    let output = String(text ?? '');

    output = output.replace(/@(everyone|here)\b/gi, (match, name) => `@\u200b${name}`);
    output = output.replace(/<@!?\d+>/g, '@user');
    output = output.replace(/<@&\d+>/g, '@role');
    output = output.replace(/<#\d+>/g, '#channel');

    return output;
}

/**
 * Discord counts message length in UTF-16 code units and caps at 2000, so a
 * reply made of emoji must be measured with `String.length`, not code points.
 * Trim on a code-point boundary and prefer a sentence break.
 */
export function truncateForDiscord(text, maxLength = 2000) {
    const value = String(text ?? '');
    if (value.length <= maxLength) return { text: value, truncated: false };

    let slice = '';
    let units = 0;
    for (const char of value) {
        if (units + char.length > maxLength - 1) break;
        slice += char;
        units += char.length;
    }

    const lastBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'));

    if (lastBreak > maxLength * 0.6) {
        return { text: `${slice.slice(0, lastBreak + 1).trimEnd()}…`, truncated: true };
    }
    return { text: `${slice.trimEnd()}…`, truncated: true };
}
