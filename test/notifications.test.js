import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,HOST,MANAGER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';

test('gon alert on/off는 관리자 권한 없이 본인 진행 알림만 설정하고 다른 계정은 유지한다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport),off=interaction(HOST,'off',{group:'alert'},'chat');await handle(off);
  assert.equal(f.engine.noticesEnabled(HOST.userId),false);assert.equal(f.engine.noticesEnabled(MANAGER.userId),true);assert.match(off.replies[0].content,/껐어요/);
  const on=interaction(HOST,'on',{group:'alert'},'chat');await handle(on);assert.equal(f.engine.noticesEnabled(HOST.userId),true);
});

test('생성·게시 완료·당첨자 수령의 주최자 알림을 한 번씩 예약한다',async t=>{
  const f=fixture(t),user=actor(4),eid=await f.event({participants:[user]});await f.engine.processJobs();
  assert.ok(f.notifications.has(`hostCreated:${eid}`));assert.ok(f.notifications.has(`hostStarted:${eid}`));f.advance(60001);await f.engine.tick();const [claim]=f.claims(eid);
  await f.engine.startClaim(GUILD,user,claim.id);await f.engine.processJobs();assert.ok(f.notifications.has(`hostReceived:${claim.id}`));
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE kind='hostReceived' AND ref_id=?",claim.id).n,1);
});

test('진행 알림을 끄면 대기 중인 진행 DM을 건너뛰고 상품·인증·보완 DM은 계속 처리한다',async t=>{
  const f=fixture(t),user=actor(4);f.engine.setNotices(HOST,false);const eid=await f.event({participants:[user],proof:true});await f.engine.processJobs();
  assert.equal(f.notifications.has(`hostCreated:${eid}`),false);assert.equal(f.notifications.has(`hostStarted:${eid}`),false);
  f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);await f.engine.startClaim(GUILD,user,c.id);f.engine.submitProof(GUILD,user,c.id,content('proof'));await f.engine.processJobs();assert.ok(f.notifications.has(`proof:${c.id}:host:1`));
  await f.engine.review(GUILD,HOST,c.id,1,'rework','보완');await f.engine.processJobs();assert.ok(f.notifications.has(`rework:${c.id}:dm:1`));
  f.engine.submitProof(GUILD,user,c.id,content('revised'));await f.engine.review(GUILD,HOST,c.id,2,'approve');await f.engine.processJobs();assert.equal(f.transport.sends,1);assert.equal(f.notifications.has(`hostReceived:${c.id}`),false);
});

test('주최자 알림은 상품 원문 없이 주최자 DM으로만 보내고 전송 직전 수신 설정도 확인한다',async t=>{
  const f=fixture(t),eid=await f.event({start:false}),recipients=[],sent=[];
  const channel={async send(body){sent.push(body);return {id:'notice',channelId:'host-dm'};}};
  const client={users:{async fetch(uid){recipients.push(uid);return {async createDM(){return {id:'host-dm'};}};}},channels:{async fetch(){return channel;}}};
  const transport=new DiscordTransport(client,f.store,f.encryption),event=f.store.event(eid);
  await transport.sendNotification({id:`hostCreated:${eid}`,kind:'hostCreated'},event);assert.deepEqual(recipients,[HOST.userId]);assert.doesNotMatch(JSON.stringify(sent),/상품-.*-1|prize:/);assert.match(JSON.stringify(sent),/gon alert off/);
  client.channels.fetch=async()=>{f.engine.setNotices(HOST,false);return channel;};
  await assert.rejects(transport.sendNotification({id:`hostCreated:${eid}`,kind:'hostCreated'},event),error=>error.code==='NOTICE_DISABLED');assert.equal(sent.length,1);
});

test('gon reqblock은 초기설정 완료 후 지정 관리자만 사용자와 사유를 등록한다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport),options={user:{id:HOST.userId},reason:'허위 상품 확인'};
  const notReady=interaction(MANAGER,'reqblock',options,'chat');await handle(notReady);assert.match(notReady.replies[0].content,/gon init/);
  f.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,?,'READY',?)",GUILD,'100000000000022','100000000000023',f.now());
  const denied=interaction(HOST,'reqblock',options,'chat');await handle(denied);assert.match(denied.replies[0].content,/관리자만/);
  const allowed=interaction(MANAGER,'reqblock',options,'chat');await handle(allowed);assert.equal(f.store.get('SELECT reason FROM host_blocks WHERE user_id=?',HOST.userId).reason,options.reason);
  const query=interaction(MANAGER,'log',{id:'giveaway-delivery:0000000000000000'},'chat');await handle(query);assert.match(query.replies[0].content,/이벤트를 찾을/);
});
