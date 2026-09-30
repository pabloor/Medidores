// Codificador/decodificador OSC mínimo (lo justo para mesas Behringer/Midas).
const align4 = (n) => Math.ceil(n / 4) * 4;

function encStr(s) {
  const raw = Buffer.from(s + '\0', 'utf8');
  return Buffer.concat([raw, Buffer.alloc(align4(raw.length) - raw.length)]);
}

function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; parts.push(encStr(a)); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); }
  }
  return Buffer.concat([encStr(address), encStr(tags), ...parts]);
}

function readStr(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0) throw new Error('Cadena OSC sin terminar');
  return [buf.toString('utf8', off, end), align4(end + 1)];
}

function decode(buf) {
  let off, address, tags;
  [address, off] = readStr(buf, 0);
  if (off >= buf.length) return { address, args: [] };
  [tags, off] = readStr(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 's') { let s; [s, off] = readStr(buf, off); args.push(s); }
    else if (t === 'b') {
      const len = buf.readInt32BE(off); off += 4;
      args.push(buf.subarray(off, off + len)); off += align4(len);
    } else break;
  }
  return { address, args };
}

module.exports = { encode, decode };
