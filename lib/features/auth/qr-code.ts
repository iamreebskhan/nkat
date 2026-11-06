/**
 * A QR code for setting up an authenticator app (0121).
 *
 * Setting up a second factor meant typing a 32-character key into a phone, or
 * opening a link on the phone itself; every admin and biller meets this at their
 * first sign-in. A QR code is what authenticator apps scan. It is drawn here, in
 * the browser, from the otpauth link: the link carries the account's TOTP
 * secret, so it never goes to a QR service or any other server, and no package
 * is added for it.
 *
 * ISO/IEC 18004 model 2, byte mode, error correction level M, the smallest
 * version that holds the text, and the mask with the lowest penalty, as the
 * standard sets out. The tables and the Reed-Solomon arithmetic follow the
 * standard; qr-code.spec.ts checks them against its published values (format
 * and version bits, error correction codewords, capacities) and reads every
 * code it draws back to the text.
 */

/** The four error correction levels, in the standard's order of strength. */
export type EccLevel = "L" | "M" | "Q" | "H";

const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two bits each level writes into the format information. */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed [level ordinal][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Modules available for data (codewords and remainder bits) in a version. */
export function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords a version holds at a level, after error correction. */
export function numDataCodewords(version: number, ecc: EccLevel): number {
  const e = ECC_ORDINAL[ecc];
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e]![version]! * NUM_ERROR_CORRECTION_BLOCKS[e]![version]!
  );
}

/** The most bytes a version holds in byte mode at a level. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((numDataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

// ---- Reed-Solomon over GF(2^8), the field the standard names (x^8+x^4+x^3+x^2+1).

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial's coefficients for `degree` codewords, highest power dropped. */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords for one block of data codewords. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---- Format and version information.

/** The 15 format bits for a level and mask: BCH(15,5), then the standard's XOR mask. */
export function formatBits(ecc: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up): BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** Centres of the alignment patterns along each axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** A drawn QR code: `modules[y][x]` is dark. */
export interface QrCode {
  version: number;
  ecc: EccLevel;
  mask: number;
  size: number;
  modules: boolean[][];
}

/**
 * Encode text (as UTF-8 bytes) into a QR code at level `ecc` (M by default),
 * the smallest version that holds it. Throws when no version does. `mask`
 * forces one of the eight masks instead of the best (the tests read each back).
 */
export function encodeQr(text: string, ecc: EccLevel = "M", mask?: number): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  while (version <= 40 && bytes.length > byteCapacity(version, ecc)) version++;
  if (version > 40) throw new RangeError("Too long for a QR code.");

  // Mode indicator (byte), character count, the bytes, then a terminator and
  // padding to the version's capacity.
  const bits: number[] = [];
  const append = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  const capacityBits = numDataCodewords(version, ecc) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  const codewords = interleave(data, version, ecc);
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  drawFunctionPatterns(version, size, set);
  drawFormat(ecc, 0, size, set); // reserved now, written for real below
  drawCodewords(codewords, size, modules, isFunction);

  // The mask with the lowest penalty, as the standard chooses.
  let best = mask ?? 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8 && mask === undefined; m++) {
    applyMask(m, size, modules, isFunction);
    drawFormat(ecc, m, size, set);
    const penalty = penaltyScore(size, modules);
    if (penalty < bestPenalty) {
      best = m;
      bestPenalty = penalty;
    }
    applyMask(m, size, modules, isFunction); // undo: XOR again
  }
  applyMask(best, size, modules, isFunction);
  drawFormat(ecc, best, size, set);
  return { version, ecc, mask: best, size, modules };
}

/** Split the data into blocks, add each block's error correction, and interleave. */
function interleave(data: number[], version: number, ecc: EccLevel): number[] {
  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccWords = rsRemainder(dat, blockEccLen);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccWords));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // The padding byte of a short block is not a codeword.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function drawFunctionPatterns(version: number, size: number, set: (x: number, y: number, dark: boolean) => void): void {
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators, in three corners.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns, except where they would sit on a finder.
  const pos = alignmentPositions(version);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Version information, from version 7.
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }
}

function drawFormat(ecc: EccLevel, mask: number, size: number, set: (x: number, y: number, dark: boolean) => void): void {
  const f = formatBits(ecc, mask);
  // Beside the top-left finder.
  for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
  set(8, 7, bit(f, 6));
  set(8, 8, bit(f, 7));
  set(7, 8, bit(f, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
  // The copy split between the other two finders, and the dark module.
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
  set(8, size - 8, true);
}

/** The codewords' bits in the standard's zigzag, two columns at a time from the bottom right. */
function drawCodewords(codewords: number[], size: number, modules: boolean[][], isFunction: boolean[][]): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

/** Whether mask `mask` inverts the module at (x, y): the standard's eight conditions. */
export function maskInverts(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError(`No mask ${mask}.`);
  }
}

function applyMask(mask: number, size: number, modules: boolean[][], isFunction: boolean[][]): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y]![x] && maskInverts(mask, x, y)) modules[y]![x] = !modules[y]![x];
    }
  }
}

/** The standard's penalty: runs, 2×2 blocks, finder-like patterns, and the balance of dark. */
function penaltyScore(size: number, modules: boolean[][]): number {
  let result = 0;
  const line = (get: (i: number) => boolean) => {
    let runColor = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (len: number) => {
      if (history[0] === 0) len += size; // the light border before the line
      history.pop();
      history.unshift(len);
    };
    const finderLike = () => {
      const n = history[1]!;
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      if (get(i) === runColor) {
        run++;
        if (run === 5) result += PENALTY_N1;
        else if (run > 5) result++;
      } else {
        addHistory(run);
        if (!runColor) result += finderLike() * PENALTY_N3;
        runColor = get(i);
        run = 1;
      }
    }
    if (runColor) {
      addHistory(run);
      run = 0;
    }
    addHistory(run + size); // the light border after the line
    result += finderLike() * PENALTY_N3;
  };
  for (let y = 0; y < size; y++) line((x) => modules[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => modules[y]![x]!);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += PENALTY_N2;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/**
 * The code as one SVG path of unit squares, with the four-module quiet zone the
 * standard asks for around it: `viewBox` "0 0 size+8 size+8".
 */
export function qrSvgPath(code: QrCode): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) if (code.modules[y]![x]) parts.push(`M${x + 4},${y + 4}h1v1h-1z`);
  }
  return parts.join("");
}
