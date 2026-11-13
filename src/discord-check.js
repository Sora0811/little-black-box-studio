/**
 * Read-only Discord checks for the setup guide.
 *
 * Nothing here creates a webhook, a bot or a message: it only asks Discord
 * whether the value the user pasted is valid, and what the bot can see.
 * The base URL is fixed by the caller (never by the browser) so a webhook
 * token or bot token cannot be redirected to another host.
 */
import { parseWebhookUrl } from './webhook.js';

export class CheckError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'CheckError';
        this.code = details.code ?? 'CHECK_FAILED';
        this.status = details.status ?? null;
    }
}

const STATUS_MESSAGES = {
    401: '憑證無效：bot token 可能已重置，或 webhook 已被刪除。',
    403: '權限不足：請確認 bot 有「檢視頻道」與「讀取訊息歷史」。',
    404: '找不到頻道或 webhook：請確認 ID 或網址是否正確。',
    429: 'Discord 限流中，請稍後再試。',
};

function hasBody(message) {
    return Boolean(message.content?.trim()) ||
        (message.attachments?.length ?? 0) > 0 ||
        (message.embeds?.length ?? 0) > 0 ||
        (message.sticker_items?.length ?? 0) > 0;
}

export function createDiscordChecker({
    baseUrl = 'https://discord.com/api/v10',
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
} = {}) {
    async function request(pathname, { token = null } = {}) {
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${pathname}`, {
                headers: token ? { authorization: `Bot ${token}` } : {},
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new CheckError('連不到 Discord，請確認網路連線。', { code: 'DISCORD_UNREACHABLE' });
        }
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }

        if (!response.ok) {
            const known = STATUS_MESSAGES[response.status];
            throw new CheckError(known ?? `Discord 回應 HTTP ${response.status}。`, {
                code: body?.code ? `DISCORD_${body.code}` : 'DISCORD_ERROR',
                status: response.status,
            });
        }
        return body;
    }

    /** GET /webhooks/{id}/{token} needs no bot and returns the channel id. */
    async function checkWebhook(value) {
        let target;
        try {
            target = parseWebhookUrl(value);
        } catch (error) {
            throw new CheckError(error.message, { code: error.code ?? 'WEBHOOK_URL_INVALID' });
        }
        const body = await request(`/webhooks/${target.id}/${target.token}`);
        return {
            ok: true,
            id: target.id,
            name: body?.name ?? null,
            channelId: body?.channel_id ? String(body.channel_id) : null,
            guildId: body?.guild_id ? String(body.guild_id) : null,
        };
    }

    /** GET /users/@me proves the bot token before anything else is checked. */
    async function checkBot(token) {
        const value = String(token ?? '').trim();
        if (!value) throw new CheckError('請先貼上 bot token。', { code: 'TOKEN_MISSING' });
        const body = await request('/users/@me', { token: value });
        if (!body?.bot) throw new CheckError('這個 token 不是 bot：請用 Bot 分頁的 token。', { code: 'NOT_A_BOT' });
        return { ok: true, id: String(body.id), username: body.username ?? null };
    }

    /**
     * The bridge needs three things: the channel exists, the bot may read its
     * history, and the message content is not stripped (Message Content intent).
     */
    async function checkChannel({ token, channelId }) {
        const value = String(channelId ?? '').trim();
        const auth = String(token ?? '').trim();
        if (!auth) throw new CheckError('請先貼上 bot token。', { code: 'TOKEN_MISSING' });
        if (!/^[1-9]\d{16,19}$/.test(value)) throw new CheckError('頻道 ID 須為 Discord 的數字 ID。', { code: 'CHANNEL_ID_INVALID' });

        const channel = await request(`/channels/${value}`, { token: auth });
        const messages = await request(`/channels/${value}/messages?limit=20`, { token: auth });
        const list = Array.isArray(messages) ? messages : [];

        const visible = list.some((message) => message.content?.trim());
        const bodyOnly = list.length > 0 && list.every(hasBody);
        const intent = list.length === 0 ? 'unknown' : (visible ? 'visible' : (bodyOnly ? 'unknown' : 'empty'));

        const authors = new Map();
        for (const message of list) {
            const author = message.author;
            if (!author?.id || author.bot) continue;
            const id = String(author.id);
            const existing = authors.get(id);
            // Prefer a display name over a bare username, whichever message has it.
            if (!existing || author.global_name) {
                authors.set(id, { id, username: author.global_name ?? author.username ?? id });
            }
        }

        return {
            ok: intent !== 'empty',
            channelId: value,
            name: channel?.name ?? null,
            guildId: channel?.guild_id ? String(channel.guild_id) : null,
            intent,
            messagesSeen: list.length,
            authors: [...authors.values()],
            ...(intent === 'empty' ? {
                message: '讀到的訊息內容是空的：請到 Developer Portal → Bot 開啟 Message Content Intent，或先送一則文字訊息。',
            } : {}),
            ...(intent === 'unknown' ? {
                message: list.length === 0
                    ? '頻道目前沒有訊息，無法判斷 intent；請先送一則文字訊息再檢查。'
                    : '頻道只有圖片或附件訊息，無法判斷 intent；請送一則文字訊息再檢查。',
            } : {}),
        };
    }

    return { checkWebhook, checkBot, checkChannel };
}
