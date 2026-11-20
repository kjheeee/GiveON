import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, actor, content, GUILD, OTHER_GUILD, OWNER, HOST, MANAGER, ALLOW_ROLE, DENY_ROLE, BLOCK_ROLE } from './helpers.js';
import { PROOF_MS, Engine } from '../src/engine.js';

test('당첨 인원만큼 사전 등록해야 신청할 수 있고 관리자는 원문을 변경·회수할 수 없다', async t => {
  const f = fixture(t);
  const eid = f.engine.create(GUILD, HOST, { title: '상품', description: '설명', durationMinutes: 1, claimMinutes: 1, winners: 2 });
  f.engine.setPrize(GUILD, HOST, eid, 1, content());
  assert.throws(() => f.engine.submit(GUILD, HOST, eid), /모두 등록/);
  assert.throws(() => f.engine.setPrize(GUILD, MANAGER, eid, 2, content()), /주최자만/);
  f.engine.setPrize(GUILD, HOST, eid, 2, content());
  f.engine.submit(GUILD, HOST, eid);
  assert.equal(f.store.event(eid).status, 'PENDING');
  assert.equal(f.engine.unusedPrize,undefined);
});

test('관리 역할 부여는 소유자만 가능하며 다른 서버의 정보는 접근할 수 없다', async t => {
  const f = fixture(t), eid = await f.event({ start: false });
  assert.throws(() => f.engine.configure(GUILD, MANAGER, 'manager_roles', []), /소유자만/);
  assert.throws(() => f.engine.event(eid, OTHER_GUILD), /이 서버/);
  assert.throws(() => f.engine.configure(GUILD, OWNER, 'blocked_roles', [GUILD]), /everyone/);
  assert.throws(() => f.engine.approveEvent(GUILD, HOST, eid), /관리자만/);
});

test('신청자는 등록된 역할만 조건으로 선택하며 허용 OR·거절 우선·공통 금지가 적용된다', async t => {
  const f = fixture(t), eid = await f.event({ start: false });
  assert.throws(() => f.engine.setCondition(GUILD, HOST, eid, 'allow_roles', ALLOW_ROLE), /등록하지 않은/);
  f.engine.configure(GUILD, MANAGER, 'condition_roles', [ALLOW_ROLE,DENY_ROLE]);
  f.engine.setCondition(GUILD, HOST, eid, 'allow_roles', ALLOW_ROLE);
  f.engine.setCondition(GUILD, MANAGER, eid, 'deny_roles', DENY_ROLE);
  f.engine.configure(GUILD, MANAGER, 'blocked_roles', [BLOCK_ROLE]);
  const event = f.store.event(eid);
  assert.equal(f.engine.eligibility(event, actor(4, [ALLOW_ROLE])), true);
  assert.equal(f.engine.eligibility(event, actor(4)), false);
  assert.equal(f.engine.eligibility(event, actor(4, [ALLOW_ROLE, DENY_ROLE])), false);
  assert.equal(f.engine.eligibility(event, actor(4, [ALLOW_ROLE, BLOCK_ROLE])), false);
  assert.equal(f.engine.eligibility(event, { ...actor(4, [ALLOW_ROLE]), isBot: true }), false);
});

test('참여는 중복되지 않고 마감 후에는 참여·취소가 차단된다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  assert.equal(f.engine.join(GUILD, user, eid), false);
  assert.equal(f.store.get('SELECT count(*) n FROM entries WHERE event_id=?', eid).n, 1);
  f.advance(60_000);
  assert.throws(() => f.engine.join(GUILD, user, eid), /마감/);
  assert.throws(() => f.engine.leave(GUILD, user, eid), /마감/);
});

test('추첨 직전 최신 역할로 자격을 다시 확인한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  f.engine.configure(GUILD, OWNER, 'blocked_roles', [BLOCK_ROLE]);
  f.add({ ...user, roles: [BLOCK_ROLE] });
  f.advance(60_001); await f.engine.tick();
  assert.equal(f.claims(eid).length, 0);
  assert.equal(f.store.event(eid).status, 'COMPLETED');
});

test('다수 당첨 중 미수령 자리만 리롤하고 이 이벤트의 과거 당첨자는 재당첨되지 않는다', async t => {
  const f = fixture(t), users = [actor(4), actor(5), actor(6)];
  const eid = await f.event({ winners: 2, participants: users });
  f.advance(60_001); await f.engine.tick();
  const initial = f.claims(eid);
  assert.equal(initial.length, 2);
  assert.equal(new Set(initial.map(c => c.user_id)).size, 2);
  const [first, second] = initial;
  await f.engine.startClaim(GUILD, f.members.get(first.user_id), first.id);
  assert.equal(f.store.claim(first.id).status, 'DELIVERED');
  f.advance(60_001); await f.engine.tick();
  const next = f.claims(eid);
  assert.equal(next.length, 3);
  const replacement = next.find(c => !initial.some(old => old.id === c.id));
  assert.equal(replacement.slot, second.slot);
  assert.ok(!initial.some(c => c.user_id === replacement.user_id));
  assert.equal(f.store.claim(first.id).status, 'DELIVERED');
  assert.equal(f.store.claim(second.id).status, 'EXPIRED');
  await assert.rejects(f.engine.startClaim(GUILD, f.members.get(second.user_id), second.id), /시간이 지났/);
});

test('이벤트 1과 2의 당첨 이력은 독립적이며 각각 리롤되면 해당 이벤트에서만 재당첨 제외', async t => {
  const f = fixture(t), user = actor(4);
  const e1 = await f.event({ participants: [user] });
  const e2 = await f.event({ participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c1] = f.claims(e1), [c2] = f.claims(e2);
  assert.equal(c1.user_id, user.userId); assert.equal(c2.user_id, user.userId);
  await f.engine.reroll(GUILD, MANAGER, c1.id);
  assert.equal(f.claims(e1).length, 1);
  assert.equal(f.store.claim(c2.id).status, 'CLAIMABLE');
  await f.engine.reroll(GUILD, MANAGER, c2.id);
  assert.equal(f.claims(e2).length, 1);
  assert.equal(f.store.claim(c1.id).status, 'EXPIRED');
  assert.equal(f.store.claim(c2.id).status, 'EXPIRED');
});

test('인증 수령 클릭 후 5분, 제출 후 무기한 검수 대기, 보완 요청 시 새 5분', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [claim] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, claim.id);
  assert.equal(f.store.claim(claim.id).submit_deadline, f.now() + PROOF_MS);
  f.advance(PROOF_MS - 1);
  f.engine.submitProof(GUILD, user, claim.id, content('텍스트 인증'));
  f.advance(86400_000); await f.engine.tick();
  assert.equal(f.store.claim(claim.id).status, 'REVIEW');
  assert.equal(f.engine.viewProof(GUILD, HOST, claim.id).content.text, '텍스트 인증');
  await f.engine.review(GUILD, HOST, claim.id, 1, 'rework', '올해 시험인지 확인할 수 있게 제출해주세요.');
  const rework = f.store.claim(claim.id);
  assert.equal(rework.submit_deadline, f.now() + PROOF_MS);
  assert.equal(rework.proof, null);
  f.advance(PROOF_MS - 1);
  f.engine.submitProof(GUILD, user, claim.id, content('보완 인증'));
  await assert.rejects(f.engine.review(GUILD, HOST, claim.id, 1, 'approve'), /새 인증 자료/);
  await f.engine.review(GUILD, HOST, claim.id, 2, 'approve');
  assert.equal(f.store.claim(claim.id).status, 'DELIVERED');
  assert.equal(f.store.claim(claim.id).proof, null);
  assert.equal(f.store.claim(claim.id).feedback, null);
  assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret, null);
  assert.equal(f.store.get("SELECT count(*) n FROM audit WHERE claim_id=? AND action='DELIVERED'", claim.id).n, 1);
});

test('사진만으로도 인증 가능하며 다른 유저·서버는 제출과 검수를 할 수 없다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  await assert.rejects(f.engine.startClaim(GUILD, HOST, c.id), /당첨자 본인/);
  await f.engine.startClaim(GUILD, user, c.id);
  assert.throws(() => f.engine.submitProof(GUILD, HOST, c.id, content('다른 사람')), /본인의 당첨/);
  f.engine.submitProof(GUILD, user, c.id, { text: '', images: [{ ext: 'png', data: Buffer.from('test-image').toString('base64') }] });
  assert.throws(() => f.engine.viewProof(GUILD, MANAGER, c.id), /주최자만/);
  assert.throws(() => f.engine.viewProof(GUILD, OWNER, c.id), /주최자만/);
  await assert.rejects(f.engine.review(GUILD,MANAGER,c.id,1,'approve'),/주최자만/);
  assert.throws(() => f.engine.viewProof(OTHER_GUILD, OWNER, c.id), /이 서버/);
  assert.equal(f.engine.viewProof(GUILD, HOST, c.id).content.images.length, 1);
});

test('정확히 5분이 되면 늦은 제출을 거부하고 해당 자리만 리롤한다', async t => {
  const f = fixture(t), users = [actor(4), actor(5)], eid = await f.event({ proof: true, participants: users });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid), user = f.members.get(c.user_id);
  await f.engine.startClaim(GUILD, user, c.id);
  f.advance(PROOF_MS);
  assert.throws(() => f.engine.submitProof(GUILD, user, c.id, content('지각')), /가능 시간/);
  await f.engine.tick();
  assert.equal(f.store.claim(c.id).status, 'EXPIRED');
  assert.equal(f.claims(eid).length, 2);
});

test('인증 최종 거절 시 원문 삭제 및 동일 이벤트 재당첨 제외', async t => {
  const f = fixture(t), users = [actor(4), actor(5)], eid = await f.event({ proof: true, participants: users });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  await f.engine.startClaim(GUILD, f.members.get(c.user_id), c.id);
  f.engine.submitProof(GUILD, f.members.get(c.user_id), c.id, content('불합격 자료'));
  await f.engine.review(GUILD, HOST, c.id, 1, 'deny');
  assert.equal(f.store.claim(c.id).proof, null);
  assert.equal(f.store.claim(c.id).status, 'DENIED');
  assert.notEqual(f.claims(eid).find(item => item.id !== c.id).user_id, c.user_id);
});

test('DM 확정 실패 시 원문 유지, 재시도 성공 시 삭제, 중복 수령 금지', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  f.transport.behavior = 'definite';
  await f.engine.startClaim(GUILD, user, c.id);
  assert.equal(f.store.claim(c.id).status, 'DELIVERY_FAILED');
  assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret);
  f.transport.behavior = 'success';
  await Promise.all([f.engine.retry(GUILD, user, c.id), f.engine.deliver(c.id)]);
  assert.equal(f.transport.sends, 2);
  assert.equal(f.store.claim(c.id).status, 'DELIVERED');
  assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret, null);
  await assert.rejects(f.engine.startClaim(GUILD, user, c.id));
});

test('전송 직후 응답 유실은 무조건 재전송하지 않고 기존 DM을 대조해 복구한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  f.transport.behavior = 'unknown';
  await f.engine.startClaim(GUILD, user, c.id);
  assert.equal(f.store.claim(c.id).status, 'DELIVERY_UNKNOWN');
  await assert.rejects(f.engine.retry(GUILD, user, c.id), /확실히/);
  await assert.rejects(f.engine.reroll(GUILD, MANAGER, c.id), /리롤할 수 없는/);
  await f.engine.reconcile(GUILD, MANAGER, c.id);
  assert.equal(f.transport.sends, 1);
  assert.equal(f.store.claim(c.id).status, 'DELIVERED');
});

test('전송 결과 불명인데 DM에서 못 찾으면 원문과 상태를 유지한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  f.transport.behavior = 'unknown'; await f.engine.startClaim(GUILD, user, c.id);
  f.prizeMessages.clear();
  await assert.rejects(f.engine.reconcile(GUILD, MANAGER, c.id), /확인하지 못했/);
  assert.equal(f.store.claim(c.id).status, 'DELIVERY_UNKNOWN');
  assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret);
});

test('후보가 없으면 종료하고 미지급 상품 원문은 회수 없이 삭제한다', async t => {
  const f = fixture(t), eid = await f.event();
  f.advance(60_001); await f.engine.tick();
  assert.equal(f.store.event(eid).status, 'COMPLETED');
  assert.equal(f.engine.unusedPrize,undefined);
  assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1', eid).secret, null);
});

test('서비스 재생성 후 검수 상태·기한을 유지하며 전송 중 상태는 결과 확인으로 복구한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, c.id);
  const deadline = f.store.claim(c.id).submit_deadline;
  const restored = new Engine(f.store, f.encryption, f.transport, { owners: [OWNER.userId], now: f.now });
  restored.recover();
  assert.equal(f.store.claim(c.id).submit_deadline, deadline);
  restored.submitProof(GUILD, user, c.id, content('재시작 후 인증'));
  f.store.run("UPDATE claims SET status='SENDING' WHERE id=?", c.id);
  restored.recover();
  assert.equal(f.store.claim(c.id).status, 'DELIVERY_UNKNOWN');
  assert.ok(f.store.claim(c.id).proof);
});

test('공개 당첨 알림이 실패하면 수령 타이머가 시작되지 않는다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ participants: [user] });
  f.transport.notifyBehavior = 'definite';
  f.advance(60_001); await f.engine.tick();
  const [c] = f.claims(eid);
  assert.equal(f.store.claim(c.id).status, 'ANNOUNCING');
  f.advance(600_000); await f.engine.tick();
  assert.equal(f.store.claim(c.id).status, 'ANNOUNCING');
  f.transport.notifyBehavior = 'success';
  f.advance(60_001); await f.engine.tick();
  assert.equal(f.store.claim(c.id).status, 'CLAIMABLE');
  assert.equal(f.store.claim(c.id).claim_deadline, f.now() + 60_000);
});

test('알림 전송 응답 유실도 기존 알림을 찾아 중복 없이 복구한다', async t => {
  const f = fixture(t), eid = await f.event({ start: false });
  f.engine.submit(GUILD, HOST, eid);
  f.transport.notifyBehavior = 'unknown'; await f.engine.tick();
  assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='application'").status, 'UNKNOWN');
  const count = f.notifications.size;
  f.advance(60_001); await f.engine.tick();
  assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='application'").status, 'DONE');
  assert.equal(f.notifications.size, count);
});

test('기한 직전 접수한 첨부를 내려받는 동안은 리롤하지 않고 늦게 접수하는 새 제출은 차단한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [claim] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, claim.id);
  f.advance(PROOF_MS - 1);
  const ticket = f.engine.reserveProof(GUILD, user, claim.id);
  f.advance(10_000); await f.engine.tick();
  assert.equal(f.store.claim(claim.id).status, 'UPLOADING');
  assert.throws(() => f.engine.reserveProof(GUILD, user, claim.id), /제출 가능/);
  f.engine.submitProof(GUILD, user, claim.id, content('기한 내 접수된 자료'), ticket);
  assert.equal(f.store.claim(claim.id).status, 'REVIEW');
});

test('게시 요청 도중 취소하더라도 생성된 공개 메시지를 추적하여 버튼을 비활성화한다', async t => {
  const f = fixture(t), eid = await f.event({ start: false });
  f.engine.submit(GUILD, HOST, eid); await f.engine.tick();
  f.engine.approveEvent(GUILD, MANAGER, eid);
  const normalSend = f.transport.sendNotification.bind(f.transport);
  f.transport.sendNotification = async job => {
    if (job.kind === 'start') f.engine.cancel(GUILD, HOST, eid);
    return normalSend(job);
  };
  await f.engine.tick();
  assert.equal(f.store.event(eid).status, 'CANCELLED');
  assert.ok(f.store.event(eid).public_message_id);
});
