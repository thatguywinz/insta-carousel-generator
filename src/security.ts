import crypto from 'node:crypto';

/**
 * Security utilities: secret redaction and authenticated (AES-256-GCM) token
 * encryption. Nothing here ever logs or returns plaintext secrets.
 */

/** Env var names whose values must never appear in logs or output. */
export const SENSITIVE_ENV_KEYS = [
  'GOOGLE_SERVICE_ACCOUNT_B64',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'INSTAGRAM_ACCESS_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'GH_PUSH_TOKEN',
] as const;

/** Collect the raw sensitive values currently present in the environment. */
function currentSecretValues(): string[] {
  const out: string[] = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    const v = process.env[key];
    if (v && v.length >= 6) out.push(v);
  }
  return out;
}

/**
 * Redact known secret values plus token/key-like substrings from an arbitrary
 * string. Always run this before logging anything derived from external input,
 * errors, or credentials.
 */
export function redact(input: string): string {
  let out = input;

  for (const secret of currentSecretValues()) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }

  // Bearer / access-token query params.
  out = out.replace(/(access_token=)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
  // Long opaque token-like blobs (Meta long-lived tokens, IGAAxxxx...).
  out = out.replace(/\bIG[A-Za-z0-9._-]{20,}\b/g, '[REDACTED]');
  out = out.replace(/\bEA[A-Za-z0-9]{40,}\b/g, '[REDACTED]');
  // Base64-ish very long blobs (service account).
  out = out.replace(/\b[A-Za-z0-9+/]{200,}={0,2}\b/g, '[REDACTED]');
  // PEM private keys.
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );

  return out;
}

/** Redact an unknown thrown value into a safe single-line string. */
export function sanitizeError(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  } else {
    try {
      message = JSON.stringify(err);
    } catch {
      message = String(err);
    }
  }
  return redact(message).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/** Derive a stable 32-byte key from the configured encryption key material. */
function deriveKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  // Accept hex (64 chars) or base64; otherwise hash to 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const b = Buffer.from(trimmed, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return crypto.createHash('sha256').update(trimmed).digest();
}

export interface EncryptedBlob {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Encrypt plaintext with AES-256-GCM. Returns a self-describing JSON-able blob. */
export function encryptSecret(plaintext: string, keyMaterial: string): EncryptedBlob {
  const key = deriveKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt a blob produced by encryptSecret. Throws on tamper / wrong key. */
export function decryptSecret(blob: EncryptedBlob, keyMaterial: string): string {
  if (blob.v !== 1 || blob.alg !== 'aes-256-gcm') {
    throw new Error('unsupported encrypted blob format');
  }
  const key = deriveKey(keyMaterial);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Show only a short prefix/suffix fingerprint of a secret, never the middle. */
export function fingerprint(secret: string | undefined): string {
  if (!secret) return '(unset)';
  if (secret.length <= 8) return `len:${secret.length}`;
  return `${secret.slice(0, 3)}…${secret.slice(-2)} len:${secret.length}`;
}
