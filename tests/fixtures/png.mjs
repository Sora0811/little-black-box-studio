// Minimal PNG container for metadata parser tests. No image pixels or avatar.
export function cardPng(card, keyword = 'ccv3') {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    const payload = Buffer.from(keyword + '\0' + Buffer.from(JSON.stringify(card)).toString('base64'));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length);
    header.write('tEXt', 4);
    return Buffer.concat([signature, header, payload, Buffer.alloc(4)]);
}
