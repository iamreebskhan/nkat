import {
  decrypt,
  displaySuffix,
  encrypt,
  parseMasterKey,
} from '../credential-crypto';
import { randomBytes } from 'node:crypto';

const MASTER_B64 = randomBytes(32).toString('base64');
const master = parseMasterKey(MASTER_B64);

describe('parseMasterKey', () => {
  it('returns a 32-byte buffer for a valid base64 key', () => {
    expect(master.length).toBe(32);
  });

  it('throws when key length is wrong', () => {
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseMasterKey(randomBytes(64).toString('base64'))).toThrow(/32 bytes/);
  });

  it('throws on empty input', () => {
    expect(() => parseMasterKey('')).toThrow(/empty/);
  });
});

describe('encrypt + decrypt', () => {
  it('round-trips arbitrary UTF-8 plaintext', () => {
    const text = JSON.stringify({ clientId: 'abc-123', clientSecret: 'super-secret-x9y8z7' });
    const out = encrypt({ master, plaintext: text });
    expect(out.ciphertext).not.toContain('abc-123');
    expect(out.ciphertext).not.toContain('super-secret');
    const back = decrypt({ master, payload: out });
    expect(back).toBe(text);
  });

  it('produces a fresh IV per call (no reuse)', () => {
    const a = encrypt({ master, plaintext: 'x' });
    const b = encrypt({ master, plaintext: 'x' });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses to decrypt tampered ciphertext (auth tag fails)', () => {
    const enc = encrypt({ master, plaintext: 'sensitive' });
    const tampered = {
      ...enc,
      ciphertext: Buffer.from(
        Buffer.from(enc.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 0x01 : b)),
      ).toString('base64'),
    };
    expect(() => decrypt({ master, payload: tampered })).toThrow();
  });

  it('refuses to decrypt with the wrong master key', () => {
    const enc = encrypt({ master, plaintext: 'sensitive' });
    const otherMaster = parseMasterKey(randomBytes(32).toString('base64'));
    expect(() => decrypt({ master: otherMaster, payload: enc })).toThrow();
  });

  it('refuses to decrypt when auth tag is wrong length', () => {
    const enc = encrypt({ master, plaintext: 'x' });
    expect(() =>
      decrypt({
        master,
        payload: { ...enc, auth_tag: Buffer.from('shorttag').toString('base64') },
      }),
    ).toThrow(/auth tag length/);
  });

  it('refuses to decrypt when IV is wrong length', () => {
    const enc = encrypt({ master, plaintext: 'x' });
    expect(() =>
      decrypt({
        master,
        payload: { ...enc, iv: Buffer.alloc(8).toString('base64') },
      }),
    ).toThrow(/IV length/);
  });
});

describe('displaySuffix', () => {
  it('returns last 4 chars of clientId', () => {
    expect(displaySuffix({ clientId: 'abc123XYZ9' })).toBe('YZ9' === 'YZ9' ? 'XYZ9' : '');
  });

  it('falls back through ordered candidate keys', () => {
    expect(displaySuffix({ username: 'alice@example.com' })).toBe('.com');
    expect(displaySuffix({ trader_id: 'TRADER12345' })).toBe('2345');
  });

  it('pads short values', () => {
    expect(displaySuffix({ clientId: 'ab' })).toBe('**ab');
  });

  it('returns **** when no identifier field present', () => {
    expect(displaySuffix({ secret: 'x' })).toBe('****');
  });
});
