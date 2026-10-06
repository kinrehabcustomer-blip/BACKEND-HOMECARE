import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  return createHash('sha256').update(`employee-temp-password:${process.env.JWT_SECRET}`).digest();
}

export function encryptTempPassword(password, employeeId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(employeeId));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptTempPassword(value, employeeId) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(employeeId));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
