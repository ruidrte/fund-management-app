/**
 * Encrypting a book at rest.
 *
 * The folder is usually inside a synced drive, so the files exist on at least
 * one machine that is not the user's and in whatever version history the sync
 * client keeps. Encrypting them means the confidentiality of the book rests on
 * a passphrase the user holds rather than on the account the drive belongs to.
 *
 * AES-GCM with a key derived from the passphrase by PBKDF2-SHA256. GCM
 * authenticates as well as encrypts, so a tampered file fails to decrypt rather
 * than decrypting to something plausible. PBKDF2 rather than Argon2 because it
 * is in the browser already, and a dependency that handles the key to a book of
 * record has to earn its place; the iteration count carries the cost instead.
 *
 * What is encrypted: every fact, every reference file, every stored document,
 * and the list of which clients the book holds. What is not, because opening
 * the book depends on reading it: the schema version and the parameters below —
 * algorithm, iteration count, salt, and a verifier used to tell a wrong
 * passphrase from a corrupted file. None of that says anything about the data.
 *
 * There is no recovery. A lost passphrase is a lost book, which is why the
 * export exists and why the interface says so before anyone chooses one.
 */

/** OWASP's floor for PBKDF2-HMAC-SHA256, and roughly a third of a second here. */
export const ITERATIONS = 600_000;

const KNOWN = 'fund-book';

export interface EncryptionHeader {
  algorithm: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** Base64. Per book, so two books with the same passphrase have different keys. */
  salt: string;
  /** A known string, encrypted. Distinguishes a wrong passphrase from damage. */
  verifier: string;
}

export interface Cipher {
  /** Encrypts to base64 of `iv || ciphertext`, safe on one line. */
  encryptText(plain: string): Promise<string>;
  decryptText(blob: string): Promise<string>;
  encryptBytes(bytes: Uint8Array): Promise<Uint8Array>;
  decryptBytes(bytes: Uint8Array): Promise<Uint8Array>;
}

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase does not open this folder.');
    this.name = 'WrongPassphrase';
  }
}

export class Damaged extends Error {
  constructor(what: string) {
    super(`${what} did not decrypt. The passphrase is right, so the file has been altered or truncated.`);
    this.name = 'Damaged';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function cipherFor(key: CryptoKey): Cipher {
  const encryptBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
    // A fresh 96-bit nonce per message. Reusing one under the same key is the
    // one mistake GCM does not survive, so it is never derived from anything.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, bytes as unknown as BufferSource,
    ));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv, 0);
    out.set(sealed, iv.length);
    return out;
  };

  const decryptBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
    if (bytes.length <= 12) throw new Error('Too short to be an encrypted value.');
    const iv = bytes.slice(0, 12);
    const body = bytes.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, body as unknown as BufferSource,
    ));
  };

  return {
    encryptBytes,
    decryptBytes,
    async encryptText(plain: string) {
      return toBase64(await encryptBytes(encoder.encode(plain)));
    },
    async decryptText(blob: string) {
      return decoder.decode(await decryptBytes(fromBase64(blob)));
    },
  };
}

/** A new header and the cipher that goes with it, for a book being protected. */
export async function protectWith(passphrase: string): Promise<{
  header: EncryptionHeader;
  cipher: Cipher;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cipher = cipherFor(await deriveKey(passphrase, salt, ITERATIONS));
  return {
    header: {
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: toBase64(salt),
      verifier: await cipher.encryptText(KNOWN),
    },
    cipher,
  };
}

/**
 * Opens a protected book. Throws `WrongPassphrase` for a passphrase that does
 * not match, which is a different problem from a file that will not decrypt
 * afterwards — one is a typo and the other is damage.
 */
export async function unlock(passphrase: string, header: EncryptionHeader): Promise<Cipher> {
  if (header.algorithm !== 'AES-GCM' || header.kdf !== 'PBKDF2-SHA256') {
    throw new Error(`This folder is encrypted with ${header.kdf}/${header.algorithm}, which this build cannot read.`);
  }
  const cipher = cipherFor(await deriveKey(passphrase, fromBase64(header.salt), header.iterations));
  try {
    if (await cipher.decryptText(header.verifier) !== KNOWN) throw new WrongPassphrase();
  } catch {
    throw new WrongPassphrase();
  }
  return cipher;
}

/* Base64 without Buffer, so the same code runs in the browser and in tests. */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
