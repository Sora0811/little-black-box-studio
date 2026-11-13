import { DeliveryError } from './delivery-error.js';

/**
 * Discord webhook delivery: the character is posted through a channel webhook,
 * which is the same mechanism Tupperbox uses under the hood. No proxy, no
 * database, no extra service. The webhook URL is a credential: it is read from
 * the environment or config.local.json and never logged.
 */

const WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\/(\d{17,20})\/([A-Za-z0-9_.-]{20,})$/;
const DISCORD_HOST = /^(?:[a-z0-9-]+\.)?discord(?:app)?\.com$/i;

const STATUS_MESSAGES = {
    400: 'Discord 拒絕訊息內容（invalid_message）：請確認內容長度與字元',
    401: 'Webhook token 無效或已被刪除',
    403: 'Webhook 沒有發送權限，或頻道不允許 webhook',
    404: '找不到這個 webhook：請重新複製頻道設定裡的 webhook URL',
    413: '訊息內容超過大小上限',
    415: 'Discord 拒絕：Content-Type 必須是 application/json',
    429: 'Discord 限流中，請稍後重試',
    500: 'Discord 伺服器錯誤，訊息可能未送出',
    502: 'Discord 伺服器錯誤，訊息可能未送出',
    503: 'Discord 暫時無法使用，訊息可能未送出',
};

export function parseWebhookUrl(value) {
    let url;
    try {
        url = new URL(String(value ?? '').trim());
    } catch {
        throw new DeliveryError('Webhook 網址格式不正確', { code: 'WEBHOOK_URL_INVALID' });
    }
    if (url.protocol !== 'https:' || !DISCORD_HOST.test(url.hostname) || url.username || url.password) {
        throw new DeliveryError('Webhook 網址必須是 https://discord.com/api/webhooks/... ', { code: 'WEBHOOK_URL_INVALID' });
    }
    const match = WEBHOOK_PATH.exec(url.pathname);
    if (!match) {
        throw new DeliveryError('Webhook 網址缺少 id 或 token', { code: 'WEBHOOK_URL_INVALID' });
    }
    return { origin: 'https://discord.com', id: match[1], token: match[2] };
}

/**
 * Discord rejects webhook names containing "clyde" or "discord", and names are
 * limited to 80 characters (docs: Create Webhook).
 */
export function cleanUsername(name) {
    // Slice by code point so a surrogate pair is never cut in half.
    const cleaned = Array.from(String(name ?? '')
        .replace(/clyde|discord/gi, '')
        .replace(/\s+/g, ' ')
        .trim())
        .slice(0, 80)
        .join('')
        .trim();
    return cleaned || 'Character';
}

async function readJson(response) {
    const text = await response.text();
    try {
        return { json: JSON.parse(text), text };
    } catch {
        return { json: null, text };
    }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * POST one message. `origin` is kept separate so tests can point at a local
 * mock without weakening the URL check in parseWebhookUrl.
 */
export async function postWebhook({
    origin,
    id,
    token,
    username,
    avatarUrl = null,
    content,
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch,
    retries = 1,
}) {
    if (!content || !String(content).trim()) {
        throw new DeliveryError('訊息內容為空，未發送', { code: 'EMPTY_CONTENT' });
    }
    // Discord counts UTF-16 code units, not code points.
    if (String(content).length > 2000) {
        throw new DeliveryError('訊息超過 Discord 2000 字元上限，未發送', { code: 'CONTENT_TOO_LONG' });
    }

    const url = `${origin}/api/v10/webhooks/${id}/${token}?wait=1`;
    const body = {
        content,
        username,
        allowed_mentions: { parse: [] },
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    };

    let response;
    let text;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new DeliveryError(`Discord webhook 逾時（${timeoutMs} ms）`, { code: 'DELIVERY_TIMEOUT' });
        }
        throw new DeliveryError(`無法連線 Discord webhook：${error?.message ?? error}`, { code: 'DELIVERY_UNREACHABLE' });
    }

    if (response.status === 429 && retries > 0) {
        let waitMs = 1000;
        try {
            waitMs = Math.min(Math.ceil(Number(JSON.parse(text)?.retry_after ?? 1) * 1000), 5000);
        } catch { /* default wait */ }
        await sleep(waitMs);
        return postWebhook({ origin, id, token, username, avatarUrl, content, timeoutMs, fetchImpl, retries: retries - 1 });
    }

    if (response.status !== 200 && response.status !== 201) {
        const known = STATUS_MESSAGES[response.status] ?? `Discord 回應 HTTP ${response.status}`;
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        throw new DeliveryError(known, {
            code: json?.code ? `DISCORD_${json.code}` : 'DELIVERY_FAILED',
            status: response.status,
            detail: String(text ?? '').slice(0, 300),
            ambiguous: response.status >= 500,
        });
    }

    let json = null;
    try { json = JSON.parse(text); } catch { /* wait=1 should return a message */ }
    if (!json?.id) {
        throw new DeliveryError('Discord 沒有回傳訊息 ID', { code: 'DELIVERY_UNCONFIRMED', status: response.status });
    }
    return { ok: true, status: response.status, messageId: String(json.id), channelId: String(json.channel_id ?? '') };
}

export async function sendWebhookMessage({ webhookUrl, username, avatarUrl = null, content, timeoutMs, fetchImpl }) {
    const target = parseWebhookUrl(webhookUrl);
    return postWebhook({ ...target, username: cleanUsername(username), avatarUrl, content, timeoutMs, fetchImpl });
}
