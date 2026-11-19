import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function vault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('암호화 키 길이가 잘못되었습니다.');
  return {
    seal(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(blob, context) {
      const bytes = Buffer.from(blob);
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    },
  };
}
