import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,MessageFlags } from 'discord.js';
import { fixture,actor,content,GUILD,OTHER_GUILD,HOST,MANAGER,OWNER,interaction } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { PROOF_MS } from '../src/engine.js';

const dm=(user,id,options={},type='button')=>Object.assign(interaction(user,id,options,type),{guildId:null,inGuild:()=>false,channel:{type:ChannelType.DM,recipientId:user.userId},message:{flags:{has:()=>false}}});
async function reviewFixture(t){const f=fixture(t),user=actor(4),eid=await f.event({proof:true,participants:[user]});f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);await f.engine.startClaim(GUILD,user,c.id);f.engine.submitProof(GUILD,user,c.id,content('PRIVATE-PROOF'));return {...f,user,eid,c,handle:handler(f.engine,f.transport)};}

test('주최자 DM에서만 인증 조회·보완·승인을 처리하며 관리자는 원문을 볼 수 없다',async t=>{
  const f=await reviewFixture(t),view=dm(HOST,`pview:${f.c.id}`);await f.handle(view);
  assert.equal(view.updated,true);assert.match(JSON.stringify(view.replies[0]),/PRIVATE-PROOF/);
  for(const user of [MANAGER,OWNER,f.user]){const denied=dm(user,`pview:${f.c.id}`);await f.handle(denied);assert.doesNotMatch(JSON.stringify(denied.replies),/PRIVATE-PROOF/);assert.match(denied.replies[0].content,/주최자만/);}
  const wrong=interaction(HOST,`pview:${f.c.id}`);wrong.guildId=OTHER_GUILD;await f.handle(wrong);assert.doesNotMatch(JSON.stringify(wrong.replies),/PRIVATE-PROOF/);
  const group=dm(HOST,`pview:${f.c.id}`);group.channel.type=ChannelType.GroupDM;await f.handle(group);assert.match(group.replies[0].content,/개인 DM/);
  const open=dm(HOST,`prework:${f.c.id}:1`);await f.handle(open);assert.equal(open.modal.toJSON().custom_id,`form:rework:${f.c.id}:1`);
  const rework=dm(HOST,`form:rework:${f.c.id}:1`,{reason:'연도 확인 필요'},'modal');await f.handle(rework);assert.equal(f.store.claim(f.c.id).submit_deadline,f.now()+PROOF_MS);assert.deepEqual(rework.replies[0].attachments,[]);
  const deadline=f.store.claim(f.c.id).submit_deadline,upload=dm(f.user,`ui:proofupload:${f.c.id}:1`);f.advance(5000);await f.handle(upload);
  assert.equal(upload.modal.toJSON().custom_id,`form:proof:${f.c.id}:1`);assert.equal(f.store.claim(f.c.id).submit_deadline,deadline);
  const submit=dm(f.user,`form:proof:${f.c.id}:1`,{text:'REVISED-PROOF'},'modal');await f.handle(submit);assert.equal(f.store.claim(f.c.id).proof_version,2);assert.equal(f.store.claim(f.c.id).status,'REVIEW');
  const stale=dm(HOST,`papprove:${f.c.id}:1`);await f.handle(stale);assert.equal(f.store.claim(f.c.id).status,'REVIEW');
  const approve=dm(HOST,`papprove:${f.c.id}:2`);await f.handle(approve);assert.equal(f.store.claim(f.c.id).status,'DELIVERED');assert.equal(f.store.claim(f.c.id).proof,null);assert.deepEqual(approve.replies[0].attachments,[]);
});

test('DM 보완 제출은 본인만 가능하며 정확히 5분 이후 기한을 연장하지 않는다',async t=>{
  const f=await reviewFixture(t);await f.engine.review(GUILD,HOST,f.c.id,1,'rework','보완');
  const intruder=dm(MANAGER,`form:proof:${f.c.id}:1`,{text:'forged'},'modal');await f.handle(intruder);assert.equal(f.store.claim(f.c.id).proof,null);
  const deadline=f.store.claim(f.c.id).submit_deadline;f.advance(PROOF_MS);
  const late=dm(f.user,`form:proof:${f.c.id}:1`,{text:'late'},'modal');await f.handle(late);assert.match(late.replies[0].content,/가능 시간/);assert.equal(f.store.claim(f.c.id).submit_deadline,deadline);
});

test('인증 승인 시 상품 DM 실패와 무관하게 인증 원문을 즉시 삭제한다',async t=>{
  const f=await reviewFixture(t);f.transport.behavior='definite';await f.engine.review(GUILD,HOST,f.c.id,1,'approve');
  assert.equal(f.store.claim(f.c.id).status,'DELIVERY_FAILED');assert.equal(f.store.claim(f.c.id).proof,null);assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=?',f.eid).secret);
});

test('재시작은 구 검수 알림을 관리자에게 재전송하지 않고 주최자 DM용으로 한 번만 예약한다',async t=>{
  const f=await reviewFixture(t);f.store.run('DELETE FROM jobs WHERE kind=?','proof');f.store.queue('proof',f.c.id,f.now(),':1');
  f.engine.recover();f.engine.recover();await f.engine.processJobs();
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',`proof:${f.c.id}:1`).status,'DONE');assert.equal(f.notifications.has(`proof:${f.c.id}:1`),false);
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE kind='proof' AND id LIKE ?",`%:host:%`).n,1);
  const recipients=[],tr=new DiscordTransport({users:{async fetch(uid){recipients.push(uid);return {async createDM(){return {id:'host-dm'};}};}}},f.store,f.encryption);
  assert.equal(await tr.channelFor({id:`proof:${f.c.id}:1`,kind:'proof',channel_id:'old-manager'},f.store.event(f.eid),f.store.claim(f.c.id)),'host-dm');assert.deepEqual(recipients,[HOST.userId]);
});

test('주최자 인증함은 본인 이벤트만 표시하며 관리자 인증 메뉴를 없앤다',async t=>{
  const f=await reviewFixture(t);
  const mine=interaction(HOST,'ui:reviews:0');await f.handle(mine);assert.match(JSON.stringify(mine.replies),new RegExp(f.c.id));
  const manager=interaction(MANAGER,'ui:reviews:0');await f.handle(manager);assert.doesNotMatch(JSON.stringify(manager.replies),new RegExp(f.c.id));
  assert.equal(mine.deferOptions.flags,MessageFlags.Ephemeral);
});
