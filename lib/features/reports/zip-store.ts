/**
 * A ZIP whose entries are stored, not compressed: the package an .xlsx or a
 * .pptx is. The files Pallio writes are small and Office opens either kind, so
 * nothing here needs a dependency.
 *
 * The CRC is our own: zlib.crc32 only exists from Node 22.2. Every entry carries
 * the same date (1 Jan 1980, the format's first day), so the same report writes
 * the same bytes.
 */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

const DOS_DATE_1980 = 0x21;
const UTF8_NAMES = 0x0800;

export function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const files = entries.map((e) => {
    const data = typeof e.data === "string" ? encoder.encode(e.data) : e.data;
    return { name: encoder.encode(e.name), data, crc: crc32(data) };
  });
  const size =
    files.reduce((n, f) => n + 30 + f.name.length + f.data.length + 46 + f.name.length, 0) + 22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  // What the local and the central headers both carry, in the same order.
  const common = (f: (typeof files)[number]) => {
    u16(20); // version needed
    u16(UTF8_NAMES);
    u16(0); // stored
    u16(0); // time
    u16(DOS_DATE_1980);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0); // extra
  };

  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(at);
    u32(0x04034b50);
    common(f);
    bytes(f.name);
    bytes(f.data);
  }
  const directory = at;
  files.forEach((f, i) => {
    u32(0x02014b50);
    u16(20); // version made by
    common(f);
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]!);
    bytes(f.name);
  });
  const directorySize = at - directory;
  u32(0x06054b50);
  u16(0); // this disk
  u16(0); // the directory's disk
  u16(files.length);
  u16(files.length);
  u32(directorySize);
  u32(directory);
  u16(0); // comment
  return out;
}
