import { UserError } from './engine.js';

const MAX_BYTES = 8 * 1024 * 1024;
const hosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
function extension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new UserError('PNG·JPG·GIF·WebP 이미지 파일만 제출할 수 있어요.');
}

export async function readContent(text, attachments, fetcher = fetch) {
  const images = [];
  let total = 0;
  for (const attachment of attachments.filter(Boolean)) {
    const url = new URL(attachment.url);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new UserError('Discord 첨부 파일만 사용할 수 있어요.');
    if (attachment.size > MAX_BYTES) throw new UserError('이미지는 합계 8MiB 이하여야 해요.');
    let response;
    try { response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new UserError('첨부 파일을 가져오지 못했어요. 다시 제출해주세요.'); }
    if (!response.ok || !response.body) throw new UserError('첨부 파일을 가져오지 못했어요.');
    const chunks = [];
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw new UserError('이미지는 합계 8MiB 이하여야 해요.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    images.push({ ext: extension(bytes), data: bytes.toString('base64') });
  }
  return { text: text || '', images };
}

export function files(content, prefix = 'image') {
  return content.images.map((image, i) => ({ attachment: Buffer.from(image.data, 'base64'), name: `${prefix}-${i + 1}.${image.ext}` }));
}
