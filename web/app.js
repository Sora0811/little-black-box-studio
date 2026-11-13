const setup = document.querySelector('#setup');
const settings = document.querySelector('#settings');
const chat = document.querySelector('#chat');
const messages = document.querySelector('#messages');
const message = document.querySelector('#message');
const status = document.querySelector('#status');
const send = document.querySelector('#send');
const reset = document.querySelector('#reset');
const cardFile = document.querySelector('#card-file');
const worldFile = document.querySelector('#world-file');
const worldName = document.querySelector('#world-name');
const fields = ['name', 'description', 'personality', 'scenario', 'first_mes'];
let imported = null;
let world = null;
let active = null;

async function api(route, data, type = 'application/json') {
    const response = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: type === 'application/json' && !(data instanceof File) ? JSON.stringify(data) : data,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
}

function loadForm(card) {
    imported = card;
    const data = (card?.spec && card?.data ? card.data : card) ?? {};
    const aliases = {
        name: data.char_name,
        description: data.char_persona,
        first_mes: data.firstMessage ?? data.greeting,
    };
    for (const field of fields) setup.elements[field].value = data[field] ?? aliases[field] ?? '';
}

function render(history) {
    messages.replaceChildren();
    for (const entry of history) {
        const item = document.createElement('li');
        item.dataset.role = entry.role;
        const label = document.createElement('strong');
        label.textContent = entry.role === 'user' ? '你' : (active.card.data ?? active.card).name;
        const body = document.createElement('p');
        body.textContent = entry.content;
        item.append(label, body);
        messages.append(item);
    }
    messages.scrollTop = messages.scrollHeight;
}

function controls(working) {
    settings.disabled = working;
    send.disabled = message.disabled = reset.disabled = working || !active;
}

async function perform(task) {
    controls(true);
    try {
        await task();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        controls(false);
    }
}

function changed() {
    active = null;
    render([]);
    controls(false);
    markDone('card', false);
    markDone('chat', false);
    status.textContent = '設定已變更，請套用後試聊。';
}

setup.addEventListener('input', (event) => {
    if (event.target.type !== 'file') changed();
});

setup.elements.provider.addEventListener('change', () => {
    setup.elements.endpoint.value = setup.elements.provider.value === 'ollama' ? 'http://127.0.0.1:11434' : '';
});

document.querySelector('#sample').addEventListener('click', () => perform(async () => {
    const response = await fetch('/sample.json');
    if (!response.ok) throw new Error('無法載入範例。');
    loadForm(await response.json());
    changed();
}));

cardFile.addEventListener('change', () => {
    const file = cardFile.files[0];
    if (!file) return;
    cardFile.value = '';
    perform(async () => {
        const type = /\.png$/i.test(file.name) ? 'image/png' : 'application/json';
        loadForm((await api('/api/import', file, type)).card);
        changed();
    });
});

worldFile.addEventListener('change', () => {
    world = null;
    worldName.textContent = '';
    changed();
    const file = worldFile.files[0];
    if (!file) return;
    perform(async () => {
        if (file.size > 8 * 1024 * 1024) throw new Error('世界書超過 8 MiB。');
        try {
            world = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
            if (!world || typeof world !== 'object') throw new Error();
        } catch {
            world = null;
            worldFile.value = '';
            throw new Error('世界書須為 JSON 物件或陣列。');
        }
        worldName.textContent = file.name;
    });
});

function formCard(form) {
    const edits = Object.fromEntries(fields.map((field) => [field, form.get(field)]));
    return imported?.spec && imported?.data
        ? { ...imported, data: { ...imported.data, ...edits } }
        : { spec: 'chara_card_v3', spec_version: '3.0', data: { ...imported, ...edits } };
}

document.querySelector('#clear-world').addEventListener('click', () => {
    world = null;
    worldFile.value = '';
    worldName.textContent = '';
    changed();
});

document.querySelector('#new-card').addEventListener('click', () => {
    loadForm(null);
    document.querySelector('#clear-world').click();
    setup.elements.name.focus();
});

document.querySelector('#export-card').addEventListener('click', () => {
    const card = formCard(new FormData(setup));
    if (!card.data.name.trim() || !card.data.description.trim()) {
        status.textContent = '請先填寫名稱與描述再下載角色卡。';
        return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' }));
    link.download = 'character.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

setup.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(setup);
    const card = formCard(form);
    const model = Object.fromEntries(['provider', 'endpoint', 'model'].map((field) => [field, form.get(field)]));
    perform(async () => {
        const next = { card, model, world };
        const result = await api('/api/history', next);
        active = next;
        render(result.messages);
        markDone('card', true);
        markDone('chat', false);
        status.textContent = '設定已套用。送出第一則訊息以連線模型。';
    });
});

chat.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!active) return;
    perform(async () => {
        status.textContent = '正在等模型回覆…';
        const result = await api('/api/chat', { ...active, message: message.value });
        render(result.messages);
        message.value = '';
        markDone('card', true);
        markDone('chat', true);
        status.textContent = '已收到回覆。';
    });
});

reset.addEventListener('click', () => {
    if (!active || !confirm('清除此角色與世界書組合的網頁對話？')) return;
    perform(async () => {
        render((await api('/api/reset', active)).messages);
        markDone('chat', false);
        status.textContent = '對話已清除。';
    });
});

// ------------------------------------------------------------- Discord 引導
const webhookUrl = document.querySelector('#webhook-url');
const botToken = document.querySelector('#bot-token');
const channelId = document.querySelector('#channel-id');
const webhookState = document.querySelector('#webhook-state');
const botState = document.querySelector('#bot-state');
const channelState = document.querySelector('#channel-state');
const authorBox = document.querySelector('#authors');
const authorList = document.querySelector('#author-list');
const bridgeMode = document.querySelector('#bridge-mode');
const prefixRow = document.querySelector('#prefix-row');
const prefixInput = document.querySelector('#bridge-prefix');
const setupState = document.querySelector('#setup-state');
const configBox = document.querySelector('#config-box');
const configPreview = document.querySelector('#config-preview');
const bridgeState = document.querySelector('#bridge-state');
const bridgeLog = document.querySelector('#bridge-log');
const writeSetupButton = document.querySelector('#write-setup');
const startBridgeButton = document.querySelector('#start-bridge');
const stopBridgeButton = document.querySelector('#stop-bridge');

const passed = { webhook: false, bot: false, channel: false };
let bridgeRunning = false;
let webhookChannelId = null;
const checkSeq = { webhook: 0, bot: 0, channel: 0 };

function setState(el, text, tone = '') {
    el.textContent = text;
    el.dataset.tone = tone;
}

function markDone(step, ok) {
    const item = document.querySelector(`#done-list [data-step="${step}"]`);
    if (item) item.dataset.done = ok ? '1' : '0';
    if (step in passed) passed[step] = ok;
    refreshButtons();
}

function selectedAuthors() {
    return [...authorList.querySelectorAll('input:checked')].map((input) => input.value);
}

function channelMismatch() {
    return Boolean(webhookChannelId && channelId.value.trim() !== webhookChannelId);
}

function refreshButtons() {
    // The webhook check already returns the channel id, so manual CLI use does
    // not need a bot token. Autostart still needs the verified channel.
    const canWrite = passed.webhook && Boolean(channelId.value.trim()) && !channelMismatch();
    writeSetupButton.disabled = !canWrite || bridgeRunning;
    startBridgeButton.disabled = !(canWrite && passed.bot && passed.channel && selectedAuthors().length > 0) || bridgeRunning;
    stopBridgeButton.disabled = !bridgeRunning;
}

async function discordTask(task) {
    try {
        await task();
    } catch (error) {
        setupState.dataset.tone = 'bad';
        setupState.textContent = error.message;
    }
    refreshButtons();
}

function renderAuthors(list) {
    const picked = new Set(selectedAuthors());
    authorList.replaceChildren();
    for (const author of list) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = author.id;
        input.checked = picked.has(author.id);
        input.addEventListener('change', refreshButtons);
        label.append(input, document.createTextNode(author.username));
        authorList.append(label);
    }
    authorBox.hidden = list.length === 0;
    refreshButtons();
}

document.querySelector('#check-webhook').addEventListener('click', () => discordTask(async () => {
    const seq = ++checkSeq.webhook;
    const value = webhookUrl.value.trim();
    setState(webhookState, '檢查中…');
    const result = await api('/api/discord/webhook', { url: value });
    if (seq !== checkSeq.webhook || value !== webhookUrl.value.trim()) return;
    if (!result.ok) {
        setState(webhookState, result.error, 'bad');
        return markDone('webhook', false);
    }
    webhookChannelId = result.channelId ?? null;
    if (webhookChannelId) {
        channelId.value = webhookChannelId;
        markDone('channel', false);
        setState(channelState, '頻道 ID 已由 webhook 填入，請重新檢查。');
    }
    setState(webhookState, `通過：${result.name ?? 'webhook'}，頻道 ${result.channelId ?? '未知'}`, 'ok');
    markDone('webhook', true);
}));

document.querySelector('#check-bot').addEventListener('click', () => discordTask(async () => {
    const seq = ++checkSeq.bot;
    const token = botToken.value.trim();
    setState(botState, '檢查中…');
    const result = await api('/api/discord/bot', { token });
    if (seq !== checkSeq.bot || token !== botToken.value.trim()) return;
    if (!result.ok) {
        setState(botState, result.error, 'bad');
        return markDone('bot', false);
    }
    setState(botState, `通過：${result.username}（${result.id}）`, 'ok');
    markDone('bot', true);
}));

document.querySelector('#check-channel').addEventListener('click', () => discordTask(async () => {
    const token = botToken.value.trim();
    const id = channelId.value.trim();
    if (!token) throw new Error('請先完成 bot token 檢查。');
    if (webhookChannelId && id !== webhookChannelId) {
        throw new Error('頻道 ID 與 webhook 所屬頻道不同；請改回 webhook 填入的頻道。');
    }
    const seq = ++checkSeq.channel;
    setState(channelState, '檢查中…');
    const result = await api('/api/discord/channel', { token, channelId: id });
    if (seq !== checkSeq.channel || token !== botToken.value.trim() || id !== channelId.value.trim()) return;
    if (Array.isArray(result.authors)) renderAuthors(result.authors);
    if (result.intent !== 'visible') {
        setState(channelState, result.message ?? result.error ?? '無法確認 intent。', 'bad');
        return markDone('channel', false);
    }
    setState(channelState, `${result.name ?? '頻道'} 可讀，文字內容可見`, 'ok');
    markDone('channel', true);
}));

bridgeMode.addEventListener('change', () => {
    prefixRow.hidden = bridgeMode.value !== 'prefix';
});

// Editing a credential invalidates the checks that used the old value, and
// makes any check response still in flight stale.
webhookUrl.addEventListener('input', () => {
    checkSeq.webhook += 1;
    webhookChannelId = null;
    markDone('webhook', false);
    markDone('channel', false);
    setState(webhookState, '已變更，請重新檢查。');
});
botToken.addEventListener('input', () => {
    checkSeq.bot += 1;
    markDone('bot', false);
    markDone('channel', false);
    setState(botState, '已變更，請重新檢查。');
});
channelId.addEventListener('input', () => {
    checkSeq.channel += 1;
    markDone('channel', false);
    if (channelMismatch()) {
        setState(channelState, '頻道 ID 必須與 webhook 所屬頻道相同。', 'bad');
    } else {
        setState(channelState, '已變更，請重新檢查。');
    }
});

function setupPayload(autostart) {
    const form = new FormData(setup);
    const card = formCard(form);
    if (!card.data.name?.trim() || !card.data.description?.trim()) {
        throw new Error('請先填寫角色名稱與描述。');
    }
    if (channelMismatch()) {
        throw new Error('頻道 ID 與 webhook 所屬頻道不同；請重新檢查 webhook 或改回它填入的頻道。');
    }
    return {
        card,
        world,
        autostart,
        model: {
            provider: form.get('provider'),
            endpoint: form.get('endpoint'),
            model: form.get('model'),
        },
        discord: {
            webhookUrl: webhookUrl.value.trim(),
            webhookChannelId,
            channelId: channelId.value.trim(),
            botToken: botToken.value.trim(),
        },
        bridge: {
            mode: bridgeMode.value,
            prefix: prefixInput.value,
            allowUserIds: selectedAuthors(),
        },
    };
}

function showSetup(result) {
    configPreview.textContent = JSON.stringify(result.preview, null, 2);
    configBox.hidden = false;
    document.querySelector('#cli-row').hidden = false;
    const warningList = document.querySelector('#setup-warnings');
    warningList.replaceChildren(...(result.warnings ?? []).map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
    }));
    warningList.hidden = !(result.warnings ?? []).length;
}

document.querySelector('#copy-cli').addEventListener('click', async () => {
    const command = 'npm run cli -- --config config.local.json --message "我想看潮汐表"';
    try {
        await navigator.clipboard.writeText(command);
        setState(document.querySelector('#copy-state'), '已複製；加上 --send 才會真的送出。', 'ok');
    } catch {
        setState(document.querySelector('#copy-state'), '無法複製，請手動輸入：' + command, 'bad');
    }
});

writeSetupButton.addEventListener('click', () => discordTask(async () => {
    setupState.textContent = '寫入中…';
    const result = await api('/api/setup', setupPayload(false));
    showSetup(result);
    setupState.dataset.tone = 'ok';
    setupState.textContent = `已寫入設定：${result.configPath}（CLI 可直接使用）`;
}));

startBridgeButton.addEventListener('click', () => discordTask(async () => {
    setupState.textContent = '啟動中…';
    const result = await api('/api/setup', setupPayload(true));
    showSetup(result);
    setupState.dataset.tone = 'ok';
    setupState.textContent = '已啟動自動回覆。保持此視窗開啟，關閉即停止。';
    await refreshBridge();
}));

stopBridgeButton.addEventListener('click', () => discordTask(async () => {
    await api('/api/bridge/stop', {});
    setupState.dataset.tone = '';
    setupState.textContent = '已停止自動回覆。';
    await refreshBridge();
}));

async function refreshBridge() {
    let snapshot;
    try {
        snapshot = await (await fetch('/api/bridge')).json();
    } catch {
        return;
    }
    bridgeRunning = snapshot.status === 'running';
    if (bridgeRunning) {
        const minutes = Math.floor((snapshot.sinceMs ?? 0) / 60000);
        setState(bridgeState, `執行中（PID ${snapshot.pid}${minutes ? `，約 ${minutes} 分` : ''}）`, 'ok');
    } else if (snapshot.lastError) {
        setState(bridgeState, `已停止：${snapshot.lastError}`, 'bad');
    } else {
        setState(bridgeState, '未啟動', '');
    }
    const lines = (snapshot.logs ?? []).map((entry) => (entry.stream === 'err' ? '! ' : '') + entry.line);
    bridgeLog.hidden = lines.length === 0;
    bridgeLog.textContent = lines.join('\n');
    bridgeLog.scrollTop = bridgeLog.scrollHeight;
    document.querySelector('#done-list [data-step="bridge"]').dataset.done = bridgeRunning ? '1' : '0';
    refreshButtons();
}

setInterval(refreshBridge, 2500);
refreshBridge();
