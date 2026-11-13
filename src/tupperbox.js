export class DeliveryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DeliveryError';
        this.code = details.code ?? 'DELIVERY_ERROR';
        this.status = details.status ?? null;
        this.detail = details.detail ?? null;
    }
}

export function resolveProxyUrl(endpoint) {
    const base = String(endpoint).replace(/\/+$/, '');
    if (/\/v1\/proxy\/messages$/.test(base)) return base;
    return `${base}/v1/proxy/messages`;
}

const STATUS_MESSAGES = {
    400: 'Tupperbox 拒絕訊息內容（invalid_message）：memberId、channelId 或 content 格式不符',
    401: 'Tupperbox 認證失敗：API token 不正確或未設定',
    403: 'Tupperbox 拒絕發送：此 memberId / channelId 沒有授權，或角色不屬於授權擁有者',
    404: 'Tupperbox 代理路徑不存在：請確認 endpoint 與 /v1/proxy/messages',
    413: 'Tupperbox 拒絕：訊息內容超過大小上限',
    415: 'Tupperbox 拒絕：Content-Type 必須是 application/json',
    429: 'Tupperbox 忙碌中（busy），請稍後重試',
    502: 'Tupperbox 代理發送失敗（proxy_failed），Discord 端可能出錯',
    503: 'Tupperbox 尚未連上 Discord（discord_unavailable）',
};

async function readJson(response) {
    const text = await response.text();
    try {
        return { json: JSON.parse(text), text };
    } catch {
        return { json: null, text };
    }
}

/**
 * Send one message through the Tupperbox external proxy.
 * Never logs or returns the token.
 */
export async function sendMessage({ endpoint, token, memberId, channelId, content, timeoutMs = 20000 }) {
    if (!token) {
        throw new DeliveryError('找不到 Tupperbox API token（請設 TUPPERBOX_API_TOKEN 或 TUPPERBOX_TOKEN_FILE）', { code: 'NO_TOKEN' });
    }
    if (!content || !String(content).trim()) {
        throw new DeliveryError('訊息內容為空，未發送', { code: 'EMPTY_CONTENT' });
    }
    if (Array.from(content).length > 2000) {
        throw new DeliveryError('訊息超過 Discord 2000 字元上限，未發送', { code: 'CONTENT_TOO_LONG' });
    }

    const url = resolveProxyUrl(endpoint);
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ memberId, channelId, content }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new DeliveryError(`Tupperbox 請求逾時（${timeoutMs} ms）`, { code: 'DELIVERY_TIMEOUT' });
        }
        throw new DeliveryError(`無法連線 Tupperbox 代理：${error?.message ?? error}`, { code: 'DELIVERY_UNREACHABLE' });
    }

    const { json, text } = await readJson(response);

    if (response.status === 201 && json?.messageId) {
        return { ok: true, status: 201, messageId: String(json.messageId), channelId: String(json.channelId ?? channelId) };
    }

    const known = STATUS_MESSAGES[response.status] ?? `Tupperbox 回應 HTTP ${response.status}`;
    throw new DeliveryError(known, {
        code: json?.error ?? 'DELIVERY_FAILED',
        status: response.status,
        detail: (json?.error ?? text ?? '').slice(0, 300),
    });
}
