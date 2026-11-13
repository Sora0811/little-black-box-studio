#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { loadCard } from './card.js';
import { mergeBooks } from './worldbook.js';
import { buildPrompt } from './prompt.js';
import { generateReply } from './model.js';
import { sendMessage, DeliveryError } from './tupperbox.js';
import { loadHistory, saveHistory, appendMessages, resetHistory, ensureFirstMessage, historyStats } from './history.js';
import { sanitizeMentions, truncateForDiscord } from './mentions.js';
import { stripCharacterPrefix } from './macros.js';
import { log, setLogLevel } from './logger.js';

const HELP = `rp-engine — SillyTavern 角色卡 → 模型 → Tupperbox 代理

用法：
  node src/cli.js --message "..."                 預覽（只生成，不發送）
  node src/cli.js --message "..." --send          生成並發送到 Discord
  node src/cli.js --history                       查看已保存的對話歷史
  node src/cli.js --history --reset               清空歷史（保留角色開場）
  node src/cli.js --show-prompt --message "..."   只組 prompt，不呼叫模型
  node src/cli.js --retry data/outbox/xxx.json    重送先前生成但發送失敗的訊息

預覽預設不寫入歷史；要保留該輪請加 --save-preview。

選項：
  --config <path>        設定檔（預設 config.json）
  --character <path>     覆寫角色卡（.json 或 .png）
  --world <path>         覆寫／附加獨立世界書（ST world JSON 或 V3 character_book）
  --member-id <n>        覆寫 Tupperbox memberId
  --channel-id <id>      覆寫 Discord channelId
  --json                 以 JSON 輸出結果（適合腳本與測試）
  --log-level <level>    error | warn | info | debug（預設 info）

環境變數：
  TUPPERBOX_API_TOKEN      Tupperbox 代理 Bearer token（建議）
  TUPPERBOX_TOKEN_FILE     含 token 的檔案路徑（第一行）
  RP_CARD / RP_WORLD / RP_MEMBER_ID / RP_CHANNEL_ID / RP_MODEL_ENDPOINT / RP_MODEL_NAME
`;

function parseArgs(argv) {
    const options = { preview: true };
    const need = new Set(['config', 'character', 'world', 'message', 'message-file', 'member-id', 'channel-id', 'log-level', 'retry']);

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') { options.help = true; continue; }
        if (arg === '--send') { options.preview = false; continue; }
        if (arg === '--preview' || arg === '--dry-run') { options.preview = true; continue; }
        if (arg === '--json') { options.json = true; continue; }
        if (arg === '--reset') { options.reset = true; continue; }
        if (arg === '--history') { options.history = true; continue; }
        if (arg === '--show-prompt') { options.showPrompt = true; continue; }
        if (arg === '--save-preview') { options.savePreview = true; continue; }

        if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        const key = arg.slice(2);
        if (!need.has(key)) throw new Error(`Unknown option: ${arg}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`Option ${arg} needs a value`);
        options[key] = value;
        index += 1;
    }

    return options;
}

function output(payload, options, humanText) {
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (humanText) {
        process.stdout.write(`${humanText}\n`);
    }
}

function writeOutbox(config, payload) {
    fs.mkdirSync(config.outbox.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.outbox.dir, `${stamp}-${payload.memberId}-${payload.channelId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return file;
}

async function handleRetry(file, config, options) {
    const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
    const result = await sendMessage({
        endpoint: config.discord.endpoint,
        token: config.discord.token,
        memberId: payload.memberId ?? config.discord.memberId,
        channelId: payload.channelId ?? config.discord.channelId,
        content: payload.content,
        timeoutMs: config.discord.timeoutMs,
    });

    fs.renameSync(path.resolve(file), `${path.resolve(file)}.sent`);
    output({ ok: true, retried: path.basename(file), messageId: result.messageId, channelId: result.channelId }, options,
        `已重送，messageId=${result.messageId} channel=${result.channelId}；原 outbox 檔已改名為 .sent`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(HELP);
        return 0;
    }

    if (options.json) setLogLevel('error');
    else if (options['log-level']) setLogLevel(options['log-level']);

    const { config } = loadConfig(options.config ?? 'config.json', {
        card: options.character,
        world: options.world,
        memberId: options['member-id'] ? Number(options['member-id']) : undefined,
        channelId: options['channel-id'],
    });

    if (options['log-level']) setLogLevel(options['log-level']);

    if (options.retry) {
        await handleRetry(options.retry, config, options);
        return 0;
    }

    if (!config.discord.channelId) throw new Error('discord.channelId 未設定（config 或 --channel-id / RP_CHANNEL_ID）');

    const card = loadCard(config.character.card);
    const extraBook = config.character.world
        ? JSON.parse(fs.readFileSync(config.character.world, 'utf8').replace(/^\uFEFF/, ''))
        : null;
    const book = mergeBooks(card.book, extraBook);

    const { store, file } = loadHistory({
        dir: config.history.dir,
        memberId: config.discord.memberId,
        channelId: config.discord.channelId,
        character: card.name,
    });

    if (options.reset) {
        resetHistory({ dir: config.history.dir, memberId: config.discord.memberId, channelId: config.discord.channelId, character: card.name });
        const fresh = loadHistory({ dir: config.history.dir, memberId: config.discord.memberId, channelId: config.discord.channelId, character: card.name });
        ensureFirstMessage(fresh.store, card, { enabled: config.prompt.includeFirstMessage });
        saveHistory({ dir: config.history.dir, store: fresh.store });
        output({ ok: true, reset: true, character: card.name, historyFile: fresh.file }, options,
            `已清空 ${card.name} 的對話歷史：${fresh.file}`);
        return 0;
    }

    if (options.history) {
        const preview = store.messages.slice(-6).map((message) => ({ role: message.role, content: message.content.slice(0, 200) }));
        output({ ok: true, character: card.name, historyFile: file, stats: historyStats(store), recent: preview }, options,
            [
                `角色：${card.name}`,
                `歷史檔：${file}`,
                `訊息數：${store.messages.length}（${historyStats(store).turns} 輪）`,
                ...preview.map((message) => `  [${message.role}] ${message.content.replace(/\s+/g, ' ').slice(0, 120)}`),
            ].join('\n'));
        return 0;
    }

    const userMessage = options.message ?? (options['message-file'] ? fs.readFileSync(options['message-file'], 'utf8').trim() : null);
    if (!userMessage) throw new Error('缺少 --message（或 --message-file）');

    const seeded = ensureFirstMessage(store, card, { enabled: config.prompt.includeFirstMessage });
    if (seeded && options.savePreview) saveHistory({ dir: config.history.dir, store });

    const prompt = buildPrompt({ card, book, history: store.messages, userMessage, config });

    if (options.showPrompt) {
        output({ ok: true, character: card.name, stats: prompt.stats, messages: prompt.messages }, options,
            [
                `角色：${card.name}`,
                `訊息數：${prompt.messages.length}，估算 tokens：${prompt.stats.totalTokens} / ${prompt.stats.contextBudget}`,
                `世界書：${prompt.stats.worldInfoEntries.map((entry) => entry.comment).join(', ') || '（無觸發）'}，${prompt.stats.worldInfoTokens} tokens`,
                '',
                ...prompt.detail.map((message, index) => `--- #${index} ${message.role} (${message.meta?.segment}) ---\n${message.content}`),
            ].join('\n'));
        return 0;
    }

    const generation = await generateReply({ config, messages: prompt.messages });

    const clean = truncateForDiscord(
        sanitizeMentions(
            config.discord.sanitizeMentions
                ? stripCharacterPrefix(generation.text, card.name)
                : generation.text,
        ),
        config.discord.maxLength,
    );

    appendMessages(store, [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: clean.text },
    ], { maxTurns: config.history.maxTurns });

    const persistTurn = !options.preview || Boolean(options.savePreview);
    if (persistTurn) saveHistory({ dir: config.history.dir, store });

    const summary = {
        ok: true,
        character: card.name,
        generated: generation.text,
        content: clean.text,
        truncated: clean.truncated,
        preview: options.preview,
        historySaved: persistTurn,
        historyFile: file,
        prompt: {
            messages: prompt.messages.length,
            estimatedTokens: prompt.stats.totalTokens,
            worldInfoEntries: prompt.stats.worldInfoEntries.map((entry) => entry.comment),
            worldInfoTokens: prompt.stats.worldInfoTokens,
            historyKept: prompt.stats.historyKept,
            historyTrimmed: prompt.stats.historyTrimmed,
        },
        model: {
            provider: generation.provider,
            name: generation.model,
            elapsedMs: generation.elapsedMs,
            usage: generation.usage,
            finishReason: generation.finishReason,
        },
        mentions: { sanitized: config.discord.sanitizeMentions, containsLiveMention: /@(everyone|here)\b|<@!?\d+>|<@&\d+>|<#\d+>/.test(clean.text) },
    };

    if (options.preview) {
        output({ ...summary, sent: false }, options,
            [
                `[預覽] ${card.name}（${generation.provider}/${generation.model}，${generation.elapsedMs} ms）`,
                `世界書觸發：${summary.prompt.worldInfoEntries.join(', ') || '（無）'}（${summary.prompt.worldInfoTokens} tokens）`,
                `prompt：${summary.prompt.messages} 則，估算 ${summary.prompt.estimatedTokens} tokens`,
                '',
                clean.text,
                '',
                persistTurn
                    ? '（未發送；此輪已寫入歷史）'
                    : '（未發送；預覽不寫入歷史，加 --save-preview 可保留）',
            ].join('\n'));
        return 0;
    }

    try {
        const delivery = await sendMessage({
            endpoint: config.discord.endpoint,
            token: config.discord.token,
            memberId: config.discord.memberId,
            channelId: config.discord.channelId,
            content: clean.text,
            timeoutMs: config.discord.timeoutMs,
        });

        output({ ...summary, sent: true, messageId: delivery.messageId, channelId: delivery.channelId }, options,
            [
                `已發送：${card.name} → 頻道 ${delivery.channelId}（messageId=${delivery.messageId}）`,
                `世界書觸發：${summary.prompt.worldInfoEntries.join(', ') || '（無）'}`,
                '',
                clean.text,
            ].join('\n'));
        return 0;
    } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;

        const outboxFile = writeOutbox(config, {
            createdAt: new Date().toISOString(),
            character: card.name,
            memberId: config.discord.memberId,
            channelId: config.discord.channelId,
            content: clean.text,
            error: { code: error.code, status: error.status, message: error.message, detail: error.detail },
            prompt: summary.prompt,
            model: summary.model,
        });

        output({
            ...summary,
            sent: false,
            deliveryError: { code: error.code, status: error.status, message: error.message },
            outboxFile,
        }, options,
        [
            `生成成功但發送失敗：${error.message}`,
            `訊息已保留在 outbox：${outboxFile}`,
            '修正後可重送：node src/cli.js --retry ' + outboxFile,
            '',
            clean.text,
        ].join('\n'));

        return 2;
    }
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        if (process.argv.includes('--json')) {
            process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message, detail: error.detail ?? null }, null, 2)}\n`);
        } else {
            log.error(error.message);
            if (error.detail) log.error(String(error.detail));
        }
        process.exitCode = 1;
    });
