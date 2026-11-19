import { randomBytes } from 'node:crypto';
console.log(`DATA_KEY=${randomBytes(32).toString('hex')}`);
