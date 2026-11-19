import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { draw } from '../src/draw.js';
import { vault } from '../src/vault.js';
import { readContent } from '../src/media.js';
import { Store } from '../src/store.js';
import { commands } from '../src/commands.js';
import { fixture, actor, GUILD, HOST } from './helpers.js';

test('추첨은 세 번 섞고 균등 인덱스로 중복 없이 선택하며 입력 순서를 보존한다', () => {
  const input = ['a', 'b', 'c', 'd'], bounds = [];
  const winners = draw(input, 4, max => { bounds.push(max); return max - 1; });
  assert.deepEqual(bounds, [4,3,2,4,3,2,4,3,2,4,3,2,1]);
  assert.equal(new Set(winners).size, 4);
  assert.deepEqual(input, ['a', 'b', 'c', 'd']);
  assert.deepEqual(draw([], 4), []);
  assert.equal(draw(['a', 'a', 'b'], 10).length, 2);
});

test('암호문은 인증 태그와 문맥에 묶이며 다른 자리로 바꾸거나 변조할 수 없다', () => {
  const v = vault(Buffer.alloc(32, 1)), value = { text: 'SECRET', images: [] };
  const blob = v.seal(value, 'prize:a:1');
  assert.ok(!blob.includes(Buffer.from('SECRET')));
  assert.deepEqual(v.open(blob, 'prize:a:1'), value);
  assert.throws(() => v.open(blob, 'prize:a:2'));
  const corrupt = Buffer.from(blob); corrupt[30] ^= 1;
  assert.throws(() => v.open(corrupt, 'prize:a:1'));
});

test('이미지는 Discord HTTPS 첨부만 허용하고 MIME·확장자가 아닌 파일 서명을 검사한다', async () => {
  await assert.rejects(readContent('', [{ url: 'http://127.0.0.1/private', size: 1 }]), /Discord 첨부/);
  await assert.rejects(readContent('', [{ url: 'https://cdn.discordapp.com.evil.example/a', size: 1 }]), /Discord 첨부/);
  const attachment = { url: 'https://cdn.discordapp.com/attachments/a/b/image.png', size: 20 };
  await assert.rejects(readContent('', [attachment], async () => new Response('<svg>unsafe</svg>')), /이미지 파일/);
  const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
  const result = await readContent('인증', [attachment], async () => new Response(png));
  assert.equal(result.images[0].ext, 'png');
  await assert.rejects(readContent('', [{ ...attachment, size: 9 * 1024 * 1024 }]), /8MiB/);
});

test('관리자용 init·setting만 등록하고 일반 이용 명령은 제공하지 않는다', () => {
  const definitions = commands.map(c => c.toJSON());
  assert.deepEqual(definitions.map(c=>c.name),['init','setting']);
  assert.equal(new Set(definitions.map(c => c.name)).size, definitions.length);
  for (const definition of definitions) assert.deepEqual(definition.contexts, [0]);
});

test('SQLite 재개방·암호화·실제 삭제·실행 잠금 검증', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'giveaway-test-'));
  const path = join(dir, 'test.sqlite');
  let store;
  t.after(() => {
    try { store?.close(); } catch { /* 이미 닫힘 */ }
    // Windows에서는 테스트 파일도 휴지통으로 이동합니다. 실패 시 영구 삭제로 전환하지 않습니다.
    const target = realpathSync(dir), expected = resolve(tmpdir());
    assert.ok(target.toLowerCase().startsWith(`${expected.toLowerCase()}\\`) || process.platform !== 'win32');
    for (const file of readdirSync(target)) assert.equal(lstatSync(join(target, file)).isSymbolicLink(), false);
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:GIVEAWAY_TEST_CLEANUP, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)'],
      { env: { ...process.env, GIVEAWAY_TEST_CLEANUP: target }, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`테스트 자료 휴지통 이동 실패, 보관 경로: ${target}`);
    } else rmSync(target, { recursive: true });
    assert.equal(existsSync(dir), false);
  });
  store = new Store(path);
  const f = fixture(t, store), user = actor(4);
  const eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, c.id);
  f.engine.submitProof(GUILD, user, c.id, { text: 'PRIVATE-PROOF-STRING', images: [] });
  const prizeBlob = Buffer.from(store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret);
  const proofBlob = Buffer.from(store.claim(c.id).proof);
  assert.equal(readFileSync(path).includes(Buffer.from('PRIVATE-PROOF-STRING')), false);
  store.run('DROP TABLE panels'); // 이전 배포본에는 패널 테이블이 없었습니다.
  store.close(); store = new Store(path);
  assert.ok(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='panels'"));
  assert.equal(store.claim(c.id).status, 'REVIEW');
  assert.equal(store.claim(c.id).proof_version, 1);
  assert.equal(store.get('PRAGMA secure_delete').secure_delete, 1);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'delete');
  store.acquireLease('one', 100_000);
  assert.throws(() => store.acquireLease('two', 100_001), /이미 봇/);
  store.heartbeat('one', 110_000);
  assert.throws(() => store.checkLease('two', 110_001), /실행 잠금/);
  store.releaseLease('one');
  store.acquireLease('two', 110_001); store.releaseLease('two');
  store.run('UPDATE claims SET proof=NULL WHERE id=?', c.id);
  store.run('UPDATE prizes SET secret=NULL WHERE event_id=? AND slot=1', eid);
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(prizeBlob), false);
  assert.equal(bytes.includes(proofBlob), false);
  assert.deepEqual(readdirSync(dir), ['test.sqlite']);
});
