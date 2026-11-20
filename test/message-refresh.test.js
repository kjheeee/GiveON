import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { fixture,actor,interaction,GUILD,OTHER_GUILD,HOST,MANAGER,OWNER } from './helpers.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { handler } from '../src/interactions.js';
import { commands } from '../src/commands.js';

const json=body=>JSON.parse(JSON.stringify(body));
function discord(f) {
  const history=new Collection(),sent=[],edits=[],fetched=[];
  let seq=0,unknown=false,editError=null;
  const channel={async send(body){const data=json(body),message={...data,id:`msg-${++seq}`,channelId:'original-channel',author:{id:'bot'},createdTimestamp:f.now()};history.set(message.id,message);sent.push(message);if(unknown){unknown=false;throw new Error('timeout after send');}return message;},
    messages:{async fetch(id){if(typeof id!=='string')return history;const value=history.get(id);if(!value)throw Object.assign(new Error('deleted'),{code:10008});return value;},async edit(id,body){if(editError)throw editError;edits.push({id,...json(body)});Object.assign(history.get(id),json(body));}}};
  const client={user:{id:'bot'},channels:{async fetch(id){fetched.push(id);return channel;}},users:{async fetch(){return {async createDM(){return {id:'dm'};}};}}};
  const transport=new DiscordTransport(client,f.store,f.encryption);
  f.engine.transport=transport;
  return {transport,history,sent,edits,fetched,unknown(){unknown=true;},editError(value){editError=value;}};
}
const ids=body=>body.components.flatMap(r=>r.components||[]).map(c=>c.custom_id).filter(Boolean);
async function pending(f,c) {const eid=await f.event({start:false});f.engine.submit(GUILD,HOST,eid);await f.engine.processJobs();return {eid,request:f.store.get("SELECT * FROM jobs WHERE kind='application' AND ref_id=?",eid)};}

test('승인 채널 원본에 대기·승인 상태, 처리자·시각과 공개 링크를 표시하고 처리 버튼을 제거한다',async t=>{
  const f=fixture(t),c=discord(f),{eid,request}=await pending(f,c),initial=c.history.get(request.message_id);
  assert.match(JSON.stringify(initial),/승인 대기/);assert.ok(ids(initial).includes(`eapprove:${eid}`));
  f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();await f.engine.tick();
  const updated=c.history.get(request.message_id),text=JSON.stringify(updated);
  assert.match(text,/승인 완료/);assert.match(text,new RegExp(MANAGER.userId));assert.match(text,/처리 시각/);assert.match(text,/참여 중/);assert.ok(updated.components[0].components.some(b=>b.url?.endsWith(f.store.event(eid).public_message_id)));
  assert.deepEqual(ids(updated),[`ui:manageevent:${eid}`]);assert.equal(c.sent.filter(m=>m.embeds?.[0]?.footer?.text===`job:application:${eid}`).length,1);assert.deepEqual(updated.allowedMentions,{parse:[],users:[],roles:[]});
  assert.doesNotMatch(text,/상품-.*-1|prize:/);
});

test('거절·취소도 승인 원본에 사유·처리자를 반영하고 다시 승인할 수 없다',async t=>{
  const f=fixture(t),c=discord(f),{eid,request}=await pending(f,c);
  f.engine.rejectEvent(GUILD,MANAGER,eid,'상품 설명 보완 필요');await f.engine.processJobs();
  let view=c.history.get(request.message_id);assert.match(JSON.stringify(view),/거절 완료/);assert.match(JSON.stringify(view),/상품 설명 보완 필요/);assert.deepEqual(ids(view),[`ui:manageevent:${eid}`]);assert.throws(()=>f.engine.approveEvent(GUILD,MANAGER,eid),/승인 대기/);
  const second=await pending(f,c);f.engine.cancel(GUILD,HOST,second.eid);await f.engine.processJobs();view=c.history.get(second.request.message_id);assert.match(JSON.stringify(view),/취소됨/);assert.match(JSON.stringify(view),new RegExp(HOST.userId));assert.equal(ids(view).some(id=>id.startsWith('eapprove:')),false);
});

test('편집 실패는 재시도하고 재시작 시 기존 처리 메시지를 갱신하며 삭제된 메시지를 재생성하지 않는다',async t=>{
  const f=fixture(t),c=discord(f),{eid,request}=await pending(f,c);
  c.editError(new Error('network'));f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.processJobs();assert.ok(f.store.get("SELECT id FROM jobs WHERE kind='applicationUpdate' AND status='PENDING' AND error_code='EDIT_RETRY'"));
  c.editError(null);f.advance(60001);f.engine.recover();await f.engine.processJobs();assert.match(JSON.stringify(c.history.get(request.message_id)),/승인 완료/);
  c.history.delete(request.message_id);const count=c.sent.length;f.engine.cancel(GUILD,HOST,eid);await f.engine.processJobs();assert.equal(c.sent.filter(m=>m.embeds?.[0]?.footer?.text===`job:application:${eid}`).length,1);assert.ok(f.store.get("SELECT id FROM jobs WHERE kind='applicationUpdate' AND error_code='MESSAGE_DELETED'"));assert.ok(c.sent.length>=count);
});

test('승인 요청 전송 결과 불명 직후 승인해도 원본을 찾아 처리 상태로 갱신한다',async t=>{
  const f=fixture(t),c=discord(f),eid=await f.event({start:false});f.engine.setNotices(HOST,false);f.engine.submit(GUILD,HOST,eid);c.unknown();await f.engine.processJobs();
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',`application:${eid}`).status,'UNKNOWN');f.engine.approveEvent(GUILD,MANAGER,eid);f.advance(60001);await f.engine.processJobs();await f.engine.processJobs();
  const job=f.store.get('SELECT * FROM jobs WHERE id=?',`application:${eid}`);assert.equal(job.status,'DONE');assert.match(JSON.stringify(c.history.get(job.message_id)),/승인 완료/);assert.equal(c.sent.filter(m=>m.embeds?.[0]?.footer?.text===`job:application:${eid}`).length,1);
});

test('gon bump는 초기설정·최신 관리자 권한을 확인하고 진행 중인 같은 서버만 중복 없이 예약한다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport);
  assert.ok(commands[0].toJSON().options.some(c=>c.name==='bump'));
  const notReady=interaction(MANAGER,'bump',{},'chat');await handle(notReady);assert.match(notReady.replies[0].content,/gon init/);
  f.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,?,'READY',?)",GUILD,'panel-channel','panel',f.now());
  const user=actor(4),eid=await f.event({participants:[user]}),before=f.store.event(eid),other=await f.event();f.store.guild(OTHER_GUILD);f.store.run('UPDATE events SET guild_id=? WHERE id=?',OTHER_GUILD,other);await f.event({start:false});
  const denied=interaction(HOST,'bump',{},'chat');await handle(denied);assert.match(denied.replies[0].content,/관리자만/);
  const allowed=interaction(MANAGER,'bump',{},'chat');await handle(allowed);assert.match(allowed.replies[0].content,/1개/);assert.deepEqual(f.engine.bumpEvents(GUILD,OWNER),{queued:0,pending:1});
  assert.deepEqual(f.store.event(eid),before);assert.equal(f.store.get('SELECT count(*) n FROM entries WHERE event_id=?',eid).n,1);assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE kind='bump'").n,1);
  f.add({...MANAGER,roles:[]});const removed=interaction(MANAGER,'bump',{},'chat');await handle(removed);assert.match(removed.replies[0].content,/관리자만/);
});

test('최신 재게시 후 참가·마감·상품을 유지하고 이전 글은 링크로 바꾸며 멘션을 재전송하지 않는다',async t=>{
  const f=fixture(t),c=discord(f),{eid}=await pending(f,c);f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();await f.engine.tick();
  const user=actor(4);f.add(user);f.engine.join(GUILD,user,eid);const before=f.store.event(eid),secrets=f.store.all('SELECT * FROM prizes WHERE event_id=?',eid);
  f.engine.configure(GUILD,OWNER,'event_channel','new-setting-channel');f.engine.bumpEvents(GUILD,MANAGER);await f.engine.tick();await f.engine.tick();
  const after=f.store.event(eid),posted=c.history.get(after.public_message_id),old=c.history.get(before.public_message_id);
  assert.notEqual(after.public_message_id,before.public_message_id);for(const key of ['ends_at','started_at','status','winner_count'])assert.equal(after[key],before[key]);assert.deepEqual(f.store.all('SELECT * FROM prizes WHERE event_id=?',eid),secrets);assert.equal(f.store.get('SELECT count(*) n FROM entries WHERE event_id=?',eid).n,1);
  assert.deepEqual(posted.allowedMentions.parse,[]);assert.equal((posted.allowedMentions.users||[]).length,0);assert.equal((posted.allowedMentions.roles||[]).length,0);assert.equal(posted.channelId,'original-channel');assert.match(JSON.stringify(old),/최신 이벤트 보기/);assert.match(JSON.stringify(old),new RegExp(after.public_message_id));assert.equal(ids(old).length,0);assert.ok(!c.fetched.includes('new-setting-channel'));
  const winner={id:'winner:fake',kind:'winner'};f.store.run("INSERT INTO claims(id,event_id,slot,user_id,claim_deadline,created_at,delivery_nonce) VALUES (?,?,1,?,?,?,?)",'fake',eid,user.userId,f.now()+60000,f.now(),'nonce');await c.transport.sendNotification(winner,after,f.store.claim('fake'));assert.equal(c.sent.at(-1).reply.messageReference,after.public_message_id);
});

test('재게시 전송 결과 불명·재시작은 동일 nonce 글만 찾아 연결하고 다시 보내지 않는다',async t=>{
  const f=fixture(t),c=discord(f),{eid}=await pending(f,c);f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();await f.engine.tick();const old=f.store.event(eid).public_message_id;
  f.engine.bumpEvents(GUILD,MANAGER);c.unknown();await f.engine.processJobs();assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='bump'").status,'UNKNOWN');const sent=c.sent.length;
  f.engine.recover();f.advance(60001);await f.engine.processJobs();await f.engine.processJobs();assert.equal(c.sent.length,sent);assert.notEqual(f.store.event(eid).public_message_id,old);assert.match(JSON.stringify(c.history.get(old)),/최신 이벤트 보기/);assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='bump'").status,'DONE');
});

test('마감된 대기 재게시는 게시하지 않고 원본 편집은 봇 작성자만 허용한다',async t=>{
  const f=fixture(t),c=discord(f),{eid,request}=await pending(f,c);f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();await f.engine.tick();
  f.engine.bumpEvents(GUILD,MANAGER);const sent=c.sent.length;f.advance(60001);await f.engine.processJobs();assert.equal(c.sent.length,sent);assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='bump'").status,'DONE');
  c.history.get(request.message_id).author.id='someone-else';await assert.rejects(c.transport.updateApplication(f.store.event(eid)),/IDENTITY/);
});
