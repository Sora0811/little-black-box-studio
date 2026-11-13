import { log } from './logger.js';

export class ModelError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ModelError';
        this.code = details.code ?? 'MODEL_ERROR';
        this.status = details.status ?? null;
        this.detail = details.detail ?? null;
    }
}

function trimTrailingSlash(url) {
    return String(url).replace(/\/+$/, '');
}

export function resolveModelUrl(provider, endpoint) {
    const base = trimTrailingSlash(endpoint);
    if (provider === 'ollama') {
        if (/\/api\/chat$/.test(base)) return base;
        return `${base}/api/chat`;
    }
    if (/\/v1\/chat\/completions$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

function snippet(text, limit = 400) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function postJson(url, body, { timeoutMs, apiKey, redirect }) {
    let response;
    let text;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
            redirect,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new ModelError(`Model request timed out after ${timeoutMs} ms`, { code: 'MODEL_TIMEOUT' });
        }
        throw new ModelError(`Could not reach model endpoint: ${error?.message ?? error}`, { code: 'MODEL_UNREACHABLE' });
    }

    if (!response.ok) {
        throw new ModelError(`Model endpoint returned HTTP ${response.status}`, {
            code: 'MODEL_HTTP_ERROR',
            status: response.status,
            detail: snippet(text),
        });
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new ModelError('Model endpoint returned non-JSON output', { code: 'MODEL_BAD_RESPONSE', detail: snippet(text) });
    }
}

/**
 * @param {object} params
 * @param {object} params.config full engine config
 * @param {{role: string, content: string}[]} params.messages
 */
export async function generateReply({ config, messages }) {
    const provider = config.model.provider;
    const url = resolveModelUrl(provider, config.model.endpoint);

    const body = provider === 'ollama'
        ? {
            model: config.model.model,
            messages,
            stream: false,
            think: false,
            options: {
                temperature: config.model.temperature,
                num_predict: config.model.maxTokens,
            },
        }
        : {
            model: config.model.model,
            messages,
            stream: false,
            temperature: config.model.temperature,
            max_tokens: config.model.maxTokens,
        };

    log.debug('Calling model', { provider, url, model: config.model.model, messages: messages.length });

    const started = Date.now();
    const data = await postJson(url, body, config.model);
    const elapsedMs = Date.now() - started;

    if (provider === 'ollama') {
        const content = String(data?.message?.content ?? '').trim();
        if (!content) {
            const thinking = String(data?.message?.thinking ?? '').trim();
            throw new ModelError(
                thinking
                    ? 'Model produced reasoning but no visible content. Lower reasoning or raise model.maxTokens.'
                    : 'Model returned an empty reply.',
                { code: 'MODEL_EMPTY_REPLY', detail: data?.done_reason ?? null },
            );
        }
        return {
            text: content,
            provider,
            model: data?.model ?? config.model.model,
            elapsedMs,
            usage: {
                promptTokens: data?.prompt_eval_count ?? null,
                completionTokens: data?.eval_count ?? null,
            },
            finishReason: data?.done_reason ?? null,
        };
    }

    const choice = data?.choices?.[0];
    const content = String(choice?.message?.content ?? '').trim();
    if (!content) {
        const reasoning = String(choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? '').trim();
        throw new ModelError(
            reasoning
                ? 'Model produced reasoning but no visible content. Lower reasoning or raise model.maxTokens.'
                : 'Model returned an empty reply.',
            { code: 'MODEL_EMPTY_REPLY', detail: choice?.finish_reason ?? null },
        );
    }

    return {
        text: content,
        provider,
        model: data?.model ?? config.model.model,
        elapsedMs,
        usage: {
            promptTokens: data?.usage?.prompt_tokens ?? null,
            completionTokens: data?.usage?.completion_tokens ?? null,
        },
        finishReason: choice?.finish_reason ?? null,
    };
}
