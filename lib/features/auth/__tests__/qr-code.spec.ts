/**
 * The authenticator QR code. Two kinds of check:
 *
 *   - against values ISO/IEC 18004 publishes: the 32 format-information words,
 *     version information, byte capacities, and the error correction codewords
 *     of the standard's worked examples;
 *   - every code drawn is read back by a reader written here, apart from the
 *     encoder: it finds the function patterns itself, takes the masks from the
 *     standard's formulas (row i, column j), checks each block's error
 *     correction by its syndromes rather than by repeating the division, and
 *     decodes the bytes.
 *
 * The final check is a phone: an authenticator app scanning it on Settings →
 * Security.
 */
import { describe, expect, it } from "vitest";

import {
  alignmentPositions,
  byteCapacity,
  encodeQr,
  formatBits,
  numDataCodewords,
  numRawDataModules,
  rsRemainder,
  versionBits,
  type EccLevel,
  type QrCode,
} from "../qr-code";

const LEVELS: EccLevel[] = ["L", "M", "Q", "H"];

describe("against the standard's published values", () => {
  it("writes the 32 format-information words of ISO/IEC 18004 Table C.1", () => {
    const table: Record<EccLevel, string[]> = {
      L: ["111011111000100", "111001011110011", "111110110101010", "111100010011101", "110011000101111", "110001100011000", "110110001000001", "110100101110110"],
      M: ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"],
      Q: ["011010101011111", "011000001101000", "011111100110001", "011101000000110", "010010010110100", "010000110000011", "010111011011010", "010101111101101"],
      H: ["001011010001001", "001001110111110", "001110011100111", "001100111010000", "000011101100010", "000001001010101", "000110100001100", "000100000111011"],
    };
    for (const ecc of LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        expect(formatBits(ecc, mask).toString(2).padStart(15, "0"), `${ecc} mask ${mask}`).toBe(table[ecc][mask]);
      }
    }
  });

  it("writes the version information of Table D.1", () => {
    expect(versionBits(7).toString(2).padStart(18, "0")).toBe("000111110010010100");
    expect(versionBits(8).toString(2).padStart(18, "0")).toBe("001000010110111100");
    expect(versionBits(9).toString(2).padStart(18, "0")).toBe("001001101010011001");
    expect(versionBits(10).toString(2).padStart(18, "0")).toBe("001010010011010011");
    expect(versionBits(40).toString(2).padStart(18, "0")).toBe("101000110001101001");
  });

  it("holds as many bytes as Table 7 says, at every level", () => {
    const capacity: Record<EccLevel, number[]> = {
      L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858],
      M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666],
      Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482],
      H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382],
    };
    for (const ecc of LEVELS) {
      capacity[ecc].forEach((bytes, i) => expect(byteCapacity(i + 1, ecc), `${i + 1}-${ecc}`).toBe(bytes));
    }
    expect(LEVELS.map((ecc) => byteCapacity(40, ecc))).toEqual([2953, 2331, 1663, 1273]);
  });

  it("counts the codewords of each version as Table 9 does", () => {
    expect([1, 2, 7, 10, 40].map((v) => numRawDataModules(v) >> 3)).toEqual([26, 44, 196, 346, 3706]);
    expect(numDataCodewords(1, "M")).toBe(16);
    expect(numDataCodewords(5, "Q")).toBe(62);
  });

  it("places the alignment patterns of Annex E", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  it("computes the error correction codewords of the standard's worked examples", () => {
    // "01234567" at 1-M (ISO/IEC 18004 Annex I).
    expect(rsRemainder([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
    // "HELLO WORLD" at 1-M.
    expect(rsRemainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A reader, written from the standard and not from the encoder.

const EXP: number[] = [];
const LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

/** Every syndrome of a block, Σ c_k α^(i(n-1-k)) for i = 0..ec-1, is zero for a valid block. */
function syndromesZero(block: number[], ec: number): boolean {
  for (let i = 0; i < ec; i++) {
    let s = 0;
    for (const c of block) s = gfMul(s, EXP[i % 255]!) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

/** Function modules as a reader finds them: finders, separators, timing, alignment, format, version. */
function functionMap(version: number): boolean[][] {
  const size = 17 + 4 * version;
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) f[r]![c] = true;
  };
  mark(0, 0, 9, 9); // top-left finder, separator and both format strips
  mark(0, size - 8, 9, 8); // top-right finder, separator, format
  mark(size - 8, 0, 8, 9); // bottom-left finder, separator, format and the dark module
  mark(6, 0, 1, size); // timing row
  mark(0, 6, size, 1); // timing column
  const centres = alignmentPositions(version);
  for (const r of centres) {
    for (const c of centres) {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (!onFinder) mark(r - 2, c - 2, 5, 5);
    }
  }
  if (version >= 7) {
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }
  return f;
}

/** The masks as ISO/IEC 18004 Table 10 writes them: i is the row, j the column. */
const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

/** Read a drawn code back to its text, or throw saying what did not read. */
function readBack(code: QrCode, blocks: { count: number; ec: number }): string {
  const m = code.modules;
  const size = m.length;
  expect(size).toBe(17 + 4 * code.version);
  // Format information around the top-left finder, bit 14 first.
  const primary = [
    m[8]![0], m[8]![1], m[8]![2], m[8]![3], m[8]![4], m[8]![5], m[8]![7], m[8]![8],
    m[7]![8], m[5]![8], m[4]![8], m[3]![8], m[2]![8], m[1]![8], m[0]![8],
  ].map((b) => (b ? 1 : 0)).join("");
  const secondary = [
    ...Array.from({ length: 7 }, (_, k) => m[size - 1 - k]![8]),
    ...Array.from({ length: 8 }, (_, k) => m[8]![size - 8 + k]),
  ].map((b) => (b ? 1 : 0)).join("");
  expect(secondary, "the two format copies agree").toBe(primary);
  const word = parseInt(primary, 2) ^ 0x5412;
  const levelBits = word >> 13;
  const mask = (word >> 10) & 7;
  const level = (["M", "L", "H", "Q"] as const)[levelBits]!;
  expect(level).toBe(code.ecc);
  expect(m[size - 8]![8], "the dark module").toBe(true);

  // Data modules, unmasked, in the zigzag.
  const fn = functionMap(code.version);
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[row]![c]) continue;
        bits.push((m[row]![c] ? 1 : 0) ^ (MASKS[mask]!(row, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const total = numRawDataModules(code.version) >> 3;
  expect(bits.length - total * 8, "remainder bits").toBeLessThan(8);
  const words: number[] = [];
  for (let i = 0; i < total; i++) words.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));

  // De-interleave: data codewords round the blocks, then error correction.
  const dataTotal = total - blocks.count * blocks.ec;
  const short = Math.floor(dataTotal / blocks.count);
  const longCount = dataTotal % blocks.count;
  const dataBlocks: number[][] = Array.from({ length: blocks.count }, () => []);
  let p = 0;
  for (let i = 0; i < short + 1; i++) {
    for (let b = 0; b < blocks.count; b++) {
      const len = short + (b >= blocks.count - longCount ? 1 : 0);
      if (i < len) dataBlocks[b]!.push(words[p++]!);
    }
  }
  const ecBlocks: number[][] = Array.from({ length: blocks.count }, () => []);
  for (let i = 0; i < blocks.ec; i++) for (let b = 0; b < blocks.count; b++) ecBlocks[b]!.push(words[p++]!);
  dataBlocks.forEach((d, b) => expect(syndromesZero([...d, ...ecBlocks[b]!], blocks.ec), `block ${b}`).toBe(true));

  // Byte mode: 0100, a count, the bytes.
  const data = dataBlocks.flat();
  const dbits = data.flatMap((w) => Array.from({ length: 8 }, (_, k) => (w >> (7 - k)) & 1));
  const take = (n: number) => parseInt(dbits.splice(0, n).join(""), 2);
  expect(take(4), "byte mode").toBe(0b0100);
  const count = take(code.version <= 9 ? 8 : 16);
  const bytes = Array.from({ length: count }, () => take(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Block counts and error correction per block, for level M, from Table 9. */
const M_BLOCKS: Record<number, { count: number; ec: number }> = {
  1: { count: 1, ec: 10 }, 2: { count: 1, ec: 16 }, 3: { count: 1, ec: 26 }, 4: { count: 2, ec: 18 },
  5: { count: 2, ec: 24 }, 6: { count: 4, ec: 16 }, 7: { count: 4, ec: 18 }, 8: { count: 4, ec: 22 },
  9: { count: 5, ec: 22 }, 10: { count: 5, ec: 26 }, 11: { count: 5, ec: 30 }, 12: { count: 8, ec: 22 },
  13: { count: 9, ec: 22 }, 14: { count: 9, ec: 24 },
};

describe("every code drawn reads back", () => {
  const uris = [
    "otpauth://totp/Pallio%3Ahelen%40demo.pallio.io?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Pallio&algorithm=SHA1&digits=6&period=30",
    "otpauth://totp/Pallio%3Abiller.two%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Pallio&algorithm=SHA1&digits=6&period=30",
    // A long address: a larger version, with version information.
    `otpauth://totp/Pallio%3A${"a".repeat(60)}%40${"b".repeat(60)}.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Pallio&algorithm=SHA1&digits=6&period=30`,
    "01234567",
    "HELLO WORLD",
    "é and ü: bytes, not characters",
  ];
  for (const text of uris) {
    it(`reads back ${JSON.stringify(text.slice(0, 48))}…`, () => {
      const code = encodeQr(text);
      expect(code.ecc).toBe("M");
      expect(M_BLOCKS[code.version], `version ${code.version} in the test's table`).toBeDefined();
      expect(readBack(code, M_BLOCKS[code.version]!)).toBe(text);
      // The smallest version that holds it.
      const bytes = new TextEncoder().encode(text).length;
      expect(bytes).toBeLessThanOrEqual(byteCapacity(code.version, "M"));
      if (code.version > 1) expect(bytes).toBeGreaterThan(byteCapacity(code.version - 1, "M"));
    });
  }

  it("reads back under each of the eight masks, at a version with version information", () => {
    const text = uris[2]!;
    for (let mask = 0; mask < 8; mask++) {
      const code = encodeQr(text, "M", mask);
      expect(code.mask).toBe(mask);
      expect(code.version).toBeGreaterThanOrEqual(7);
      expect(readBack(code, M_BLOCKS[code.version]!), `mask ${mask}`).toBe(text);
    }
    // And at the version the authenticator links use.
    for (let mask = 0; mask < 8; mask++) {
      const code = encodeQr(uris[0]!, "M", mask);
      expect(readBack(code, M_BLOCKS[code.version]!), `mask ${mask}`).toBe(uris[0]);
    }
  });

  it("CONTROL: the reader refuses a code with a module flipped in the data", () => {
    const code = encodeQr(uris[0]!, "M", 3);
    // A data module a few columns in from the bottom-right corner.
    code.modules[code.size - 1]![code.size - 1] = !code.modules[code.size - 1]![code.size - 1];
    expect(() => readBack(code, M_BLOCKS[code.version]!)).toThrow();
  });

  it("draws the three finder patterns where a scanner looks for them", () => {
    const { modules: m, size } = encodeQr(uris[0]!);
    const finderAt = (r: number, c: number) => {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          expect(m[r + dr]![c + dc], `(${r + dr}, ${c + dc})`).toBe(ring !== 2);
        }
      }
    };
    finderAt(0, 0);
    finderAt(0, size - 7);
    finderAt(size - 7, 0);
  });

  it("refuses text no version holds", () => {
    expect(() => encodeQr("x".repeat(2332))).toThrow(/Too long/);
    expect(() => encodeQr("x".repeat(2331))).not.toThrow();
  });
});
