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
        status.textContent = '已收到回覆。';
    });
});

reset.addEventListener('click', () => {
    if (!active || !confirm('清除此角色與世界書組合的網頁對話？')) return;
    perform(async () => {
        render((await api('/api/reset', active)).messages);
        status.textContent = '對話已清除。';
    });
});
