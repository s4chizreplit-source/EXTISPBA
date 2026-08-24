import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;

function encryptionKey() {
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required to protect application secrets');
  }
  return createHash('sha256')
    .update(`extips-app-secret:${sessionSecret}`, 'utf8')
    .digest();
}

export function encryptAppSecret(value) {
  const plaintext = String(value || '');
  if (!plaintext) throw new Error('Secret value is required');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptAppSecret(payload) {
  const [version, ivPart, tagPart, encryptedPart, extra] = String(payload || '').split('.');
  if (
    version !== FORMAT_VERSION ||
    !ivPart ||
    !tagPart ||
    !encryptedPart ||
    extra !== undefined
  ) {
    throw new Error('Invalid encrypted secret format');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}