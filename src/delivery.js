import { createHash } from 'node:crypto';

import { sendMessage as sendTupperbox } from './tupperbox.js';
import { sendWebhookMessage, cleanUsername } from './webhook.js';

export const DELIVERY_PROVIDERS = ['tupperbox', 'webhook'];

export function deliveryProvider(config) {
    const provider = config?.discord?.provider ?? 'tupperbox';
    return DELIVERY_PROVIDERS.includes(provider) ? provider : 'tupperbox';
}

/**
 * History files are keyed by a numeric id plus the channel. Webhook delivery has
 * no Tupperbox member, so the character name supplies a stable id instead of
 * every character in a channel sharing one history file.
 */
export function historyMemberId(config, card) {
    if (deliveryProvider(config) !== 'webhook') return config.discord.memberId;
    const digest = createHash('sha256').update(String(card?.name ?? '')).digest();
    return (digest.readUInt32BE(0) % 2147483647) || 1;
}

/**
 * One send function for both providers, so CLI and bridge do not branch on it.
 * The webhook URL is resolved once by loadConfig (config.discord.webhook).
 */
export function createSender({ config, card, channelId = null, fetchImpl } = {}) {
    if (deliveryProvider(config) === 'webhook') {
        const target = config.discord.webhook;
        if (!target) throw new Error('discord.webhookUrl 未設定（或設定 DISCORD_WEBHOOK_URL）');
        const username = cleanUsername(card?.name);
        return (content) => sendWebhookMessage({
            webhookUrl: `https://discord.com/api/webhooks/${target.id}/${target.token}`,
            username,
            avatarUrl: config.discord.avatarUrl ?? null,
            content,
            timeoutMs: config.discord.timeoutMs,
            fetchImpl,
        });
    }

    return (content) => sendTupperbox({
        endpoint: config.discord.endpoint,
        token: config.discord.token,
        memberId: config.discord.memberId,
        channelId: channelId ?? config.discord.channelId,
        content,
        timeoutMs: config.discord.timeoutMs,
    });
}
