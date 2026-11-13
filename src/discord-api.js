/**
 * Minimal Discord REST client for the bridge.
 *
 * Only what a poller needs: read channel history. It never opens a gateway
 * connection, so it cannot fight with the Tupperbox bot's own session.
 */
export class DiscordApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DiscordApiError';
        this.code = details.code ?? 'DISCORD_ERROR';
        this.status = details.status ?? null;
        this.retryAfterMs = details.retryAfterMs ?? null;
    }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function normalize(message) {
    return {
        id: String(message.id),
        channelId: String(message.channel_id),
        authorId: String(message.author?.id ?? ''),
        authorBot: Boolean(message.author?.bot),
        username: message.author?.username ?? null,
        content: String(message.content ?? ''),
        webhookId: message.webhook_id ?? null,
        timestamp: message.timestamp ?? null,
        attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
    };
}

export function createDiscordApi({
    token,
    baseUrl = 'https://discord.com/api/v10',
    timeoutMs = 15000,
    fetchImpl = globalThis.fetch,
    userAgent = 'DiscordBot (rp-engine, 0.1.0)',
}) {
    if (!token) throw new Error('Discord bot token is required for the bridge');

    async function request(pathname, { retryOnRateLimit = true } = {}) {
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${pathname}`, {
                method: 'GET',
                headers: { authorization: `Bot ${token}`, 'user-agent': userAgent },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new DiscordApiError(`Cannot reach Discord: ${error?.message ?? error}`, { code: 'DISCORD_UNREACHABLE' });
        }

        if (response.status === 429 && retryOnRateLimit) {
            const body = await response.json().catch(() => ({}));
            const waitMs = Math.min(Number(body.retry_after ?? 1) * 1000, 5000);
            await sleep(waitMs);
            return request(pathname, { retryOnRateLimit: false });
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new DiscordApiError(`Discord returned HTTP ${response.status}`, {
                code: response.status === 401 ? 'DISCORD_UNAUTHORIZED' : response.status === 403 ? 'DISCORD_FORBIDDEN' : 'DISCORD_HTTP_ERROR',
                status: response.status,
                retryAfterMs: null,
                detail: detail.slice(0, 200),
            });
        }

        return response.json();
    }

    return {
        baseUrl,
        async getMessages(channelId, { after, before, limit = 50 } = {}) {
            const params = new URLSearchParams({ limit: String(limit) });
            if (after) params.set('after', after);
            if (before) params.set('before', before);
            const list = await request(`/channels/${channelId}/messages?${params.toString()}`);
            return (Array.isArray(list) ? list : []).map(normalize);
        },
        async getMe() {
            const me = await request('/users/@me');
            return { id: String(me.id), username: me.username, bot: Boolean(me.bot) };
        },
    };
}

/** Snowflake ids are numeric; compare as BigInt so ordering is exact. */
export function compareIds(a, b) {
    if (a === b) return 0;
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
}
