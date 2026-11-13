import fs from 'node:fs';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Minimal PNG text-chunk reader.
 * Character cards keep their payload as base64 in a tEXt chunk named "ccv3" (V3)
 * or "chara" (V2). iTXt is handled as a fallback for tools that emit it.
 */
export function readPngTextChunks(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Not a PNG file');
    }

    const chunks = [];
    let offset = 8;

    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;

        if (dataEnd + 4 > buffer.length) break;
        const data = buffer.subarray(dataStart, dataEnd);

        if (type === 'tEXt') {
            const separator = data.indexOf(0);
            if (separator > 0) {
                chunks.push({
                    keyword: data.toString('latin1', 0, separator),
                    text: data.toString('latin1', separator + 1),
                });
            }
        } else if (type === 'iTXt') {
            const separator = data.indexOf(0);
            if (separator > 0) {
                const keyword = data.toString('latin1', 0, separator);
                const rest = data.subarray(separator + 1);
                const compressionFlag = rest[0];
                if (compressionFlag === 0) {
                    // keyword \0 flag \0 method \0 language \0 translated \0 text
                    const parts = rest.subarray(2).toString('utf8').split('\0');
                    chunks.push({ keyword, text: parts.slice(2).join('\0') });
                }
            }
        }

        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }

    return chunks;
}

function decodeCardPayload(text) {
    const raw = String(text ?? '').trim();
    if (!raw) throw new Error('Empty card payload');

    if (raw.startsWith('{')) return JSON.parse(raw);

    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
}

export function readCardFromPng(buffer) {
    const chunks = readPngTextChunks(buffer);
    const find = (keyword) => chunks.find((chunk) => chunk.keyword.toLowerCase() === keyword);

    const v3 = find('ccv3');
    if (v3) {
        return { card: decodeCardPayload(v3.text), specHint: 'chara_card_v3', chunk: 'ccv3' };
    }
    const v2 = find('chara');
    if (v2) {
        return { card: decodeCardPayload(v2.text), specHint: 'chara_card_v2', chunk: 'chara' };
    }
    throw new Error('PNG has no ccv3 or chara metadata chunk');
}

export function normalizeCard(input, metadata = {}) {
    if (!input || typeof input !== 'object') throw new Error('Card payload must be an object');

    const wrapped = input.spec && input.data && typeof input.data === 'object';
    const data = wrapped ? input.data : input;

    const name = String(data.name ?? data.char_name ?? '').trim();
    if (!name) throw new Error('Card has no character name');

    const description = String(data.description ?? data.char_persona ?? '');
    if (!description.trim()) throw new Error(`Card "${name}" has an empty description`);

    const firstMessage = String(data.first_mes ?? data.firstMessage ?? data.greeting ?? '');
    const examples = String(data.mes_example ?? data.mesExamples ?? data.example_dialogue ?? '');
    const personality = String(data.personality ?? '');
    const scenario = String(data.scenario ?? '');

    const book = data.character_book ?? metadata.book ?? null;

    return {
        name,
        description,
        personality,
        scenario,
        firstMessage,
        examples,
        systemPrompt: String(data.system_prompt ?? data.systemPrompt ?? ''),
        postHistoryInstructions: String(data.post_history_instructions ?? ''),
        creatorNotes: String(data.creator_notes ?? ''),
        alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map(String) : [],
        book,
        spec: wrapped ? String(input.spec) : (metadata.specHint ?? 'chara_card_v2'),
        specVersion: wrapped ? String(input.spec_version ?? '') : '',
        extensions: data.extensions ?? {},
        source: metadata.source ?? null,
    };
}

export function loadCard(filePath) {
    const resolved = path.resolve(filePath);
    const extension = path.extname(resolved).toLowerCase();

    if (extension === '.png') {
        const buffer = fs.readFileSync(resolved);
        const { card, specHint, chunk } = readCardFromPng(buffer);
        return normalizeCard(card, { source: resolved, specHint, chunk });
    }

    if (extension === '.json') {
        const card = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
        return normalizeCard(card, { source: resolved });
    }

    throw new Error(`Unsupported card format: ${extension} (expected .json or .png)`);
}
