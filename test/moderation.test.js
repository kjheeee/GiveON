import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { fixture,actor,content,GUILD,OTHER_GUILD,HOST,MANAGER,OWNER,interaction } from './helpers.js';
import { ModerationFlow } from '../src/moderation.js';
import { handler } from '../src/interactions.js';

test('실물 상품은 개별 코드 없이 신청하고 주최자 연락 안내만 전달하며 인원 변경도 반영한다',async t=>{
  const f=fixture(t),user=actor(4),eid=f.engine.create(GUILD,HOST,{title:'실물 상품',description:'배송 안내',durationMinutes:1,claimMinutes:1,winners:2});
  f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);f.engine.setDeliveryMode(GUILD,HOST,eid,2,true);f.engine.updateDraftDetails(GUILD,HOST,eid,{title:'수정 상품',description:'설명',durationMinutes:1,claimMinutes:1,winners:1});
  assert.equal(f.store.all('SELECT slot FROM prizes WHERE event_id=?',eid).length,1);assert.throws(()=>f.engine.setPrize(GUILD,HOST,eid,1,content()),/직접 전달/);
  f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();f.add(user);f.engine.join(GUILD,user,eid);f.advance(60001);await f.engine.tick();
  let sent;f.transport.sendPrize=async(channel,event,claim,value)=>{sent=value;return {id:'direct-contact',channelId:channel};};
  const [c]=f.claims(eid);await f.engine.startClaim(GUILD,user,c.id);assert.match(sent.text,new RegExp(HOST.userId));assert.match(sent.text,/주소.*봇에 제출하지/);assert.equal(f.store.claim(c.id).status,'DELIVERED');
  assert.match(new ModerationFlow(f.engine,f.transport).lookup(GUILD,user,`giveaway-delivery:${c.id}`).content,/연락 안내 완료/);
});

test('거절·취소·기존 종료 이벤트의 미지급 원문은 삭제하고 회수 버튼은 동작하지 않는다',async t=>{
  const f=fixture(t),a=await f.event({start:false});f.engine.submit(GUILD,HOST,a);f.engine.rejectEvent(GUILD,MANAGER,a,'거절');assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',a).secret,null);
  const b=await f.event({start:false});f.engine.cancel(GUILD,HOST,b);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',b).secret,null);
  const old=await f.event({start:false});f.store.run("UPDATE events SET status='COMPLETED' WHERE id=?",old);f.engine.recover();assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',old).secret,null);
  const i=interaction(HOST,`ui:recover:${old}`);await handler(f.engine,f.transport)(i);assert.equal(i.modal,undefined);assert.doesNotMatch(JSON.stringify(i.replies),/상품 비밀 코드/);
});

test('식별자 검색은 관련 당사자·관리자만 가능하고 서버 경계 및 원문 삭제를 보존한다',async t=>{
  const f=fixture(t),user=actor(4),eid=await f.event({participants:[user]});f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);await f.engine.startClaim(GUILD,user,c.id);
  for(const a of [user,HOST,MANAGER])assert.equal(f.engine.lookup(GUILD,a,`giveaway-delivery:${c.id}`).claim.id,c.id);
  assert.throws(()=>f.engine.lookup(GUILD,actor(99),c.id),/관련된/);assert.throws(()=>f.engine.lookup(OTHER_GUILD,user,c.id),/이 서버/);assert.throws(()=>f.engine.lookup(GUILD,user,`x${c.id}`),/입력/);
  const view=new ModerationFlow(f.engine,f.transport).lookup(GUILD,MANAGER,c.id);assert.doesNotMatch(JSON.stringify(view),/상품-.*-1|prize:/);
});

test('신고 접수와 신고 버튼을 제공하지 않으며 이전 버튼·모달은 내용을 저장하지 않는다',async t=>{
  const f=fixture(t),user=actor(4),eid=await f.event({participants:[user]});f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);
  const handle=handler(f.engine,f.transport),flow=new ModerationFlow(f.engine,f.transport);
  assert.doesNotMatch(JSON.stringify(flow.lookup(GUILD,user,c.id)),/mod:report|신고/);
  const retired=interaction(user,`form:report:claim:${c.id}`,{text:'DO-NOT-STORE'},'modal');await handle(retired);
  assert.match(retired.replies[0].content,/더 이상 사용하지/);assert.doesNotMatch(JSON.stringify(retired.replies),/DO-NOT-STORE/);
  const dm=Object.assign(interaction(user,`mod:reportclaim:${c.id}`),{guildId:null,inGuild:()=>false,channel:{type:ChannelType.DM}});await handle(dm);assert.equal(dm.modal,undefined);assert.match(dm.replies[0].content,/gon log/);
  assert.equal(f.transport.sendReport,undefined);assert.equal(f.store.columns('reports').length,0);
});

test('관리자는 사용자·필수 사유로 주최 제한을 설정하고 생성·초안 제출·승인을 막는다',async t=>{
  const f=fixture(t),draft=await f.event({start:false}),pending=await f.event({start:false});f.engine.submit(GUILD,HOST,pending);
  const handle=handler(f.engine,f.transport),open=interaction(MANAGER,'host:new');await handle(open);
  assert.equal(open.modal.toJSON().custom_id,'form:hostblock:new');assert.equal(open.modal.toJSON().components.length,2);
  const submit=interaction(MANAGER,'form:hostblock:new',{user:`<@${HOST.userId}>`,reason:'허위 상품 안내 · 관리자 확인'},'modal');await handle(submit);
  const block=f.store.get('SELECT * FROM host_blocks WHERE guild_id=? AND user_id=?',GUILD,HOST.userId);
  assert.equal(block.reason,'허위 상품 안내 · 관리자 확인');assert.equal(block.actor_id,MANAGER.userId);assert.equal(block.active,1);
  assert.match(submit.replies[0].content,/허위 상품 안내/);assert.match(submit.replies[0].content,new RegExp(MANAGER.userId));
  assert.throws(()=>f.engine.create(GUILD,HOST,{title:'x'}),/주최가 제한/);assert.throws(()=>f.engine.submit(GUILD,HOST,draft),/주최가 제한/);assert.throws(()=>f.engine.approveEvent(GUILD,MANAGER,pending),/주최가 제한/);
  const list=interaction(MANAGER,'host:list:0');await handle(list);assert.match(JSON.stringify(list.replies),/허위 상품 안내/);
});

test('주최 제한 사유 수정·해제 시 최근 사유·설정 관리자와 해제 기록을 보존한다',async t=>{
  const f=fixture(t);f.engine.restrictHost(GUILD,MANAGER,HOST.userId,true,'최초 사유');f.advance(1000);
  f.engine.restrictHost(GUILD,OWNER,HOST.userId,true,'수정 사유');f.advance(1000);f.engine.restrictHost(GUILD,MANAGER,HOST.userId,false);
  const block=f.store.get('SELECT * FROM host_blocks WHERE guild_id=? AND user_id=?',GUILD,HOST.userId);
  assert.equal(block.active,0);assert.equal(block.reason,'수정 사유');assert.equal(block.actor_id,OWNER.userId);assert.equal(block.released_by,MANAGER.userId);assert.equal(block.released_at,f.now());
  assert.doesNotThrow(()=>f.engine.requireHostAllowed(GUILD,HOST.userId));
  const flow=new ModerationFlow(f.engine,f.transport),view=flow.view(GUILD,MANAGER,HOST.userId);assert.match(view.content,/최근 제한 사유: 수정 사유/);assert.match(view.content,/해제 관리자/);
  f.engine.restrictHost(GUILD,MANAGER,HOST.userId,true,'재제한');assert.equal(f.store.get('SELECT released_by FROM host_blocks WHERE user_id=?',HOST.userId).released_by,null);
});

test('제한·사유 열람은 관리자만 가능하고 빈 사유·긴 사유·변조된 대상은 저장하지 않는다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport),flow=new ModerationFlow(f.engine,f.transport);
  assert.throws(()=>f.engine.restrictHost(GUILD,HOST,actor(9).userId,true,'사유'),/관리자만/);
  assert.throws(()=>flow.view(GUILD,HOST,actor(9).userId),/관리자만/);
  for(const reason of ['', '  ', 'a'.repeat(501)])assert.throws(()=>f.engine.restrictHost(GUILD,MANAGER,HOST.userId,true,reason),/사유/);
  assert.throws(()=>f.engine.restrictHost(GUILD,MANAGER,'invalid',true,'사유'),/사용자/);
  const forged=interaction(MANAGER,`form:hostblock:${HOST.userId}`,{user:actor(9).userId,reason:'대상 바꾸기'},'modal');await handle(forged);assert.match(forged.replies[0].content,/선택한 사용자는/);
  assert.equal(f.store.get('SELECT count(*) n FROM host_blocks').n,0);
  f.engine.restrictHost(GUILD,MANAGER,HOST.userId,true,'이 서버 사유');f.engine.configure(OTHER_GUILD,OWNER,'manager_roles',[]);
  assert.doesNotThrow(()=>f.engine.requireHostAllowed(OTHER_GUILD,HOST.userId));assert.throws(()=>flow.view(OTHER_GUILD,MANAGER,HOST.userId),/관리자만/);
});
