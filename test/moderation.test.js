import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { fixture,actor,content,GUILD,OTHER_GUILD,HOST,MANAGER,interaction } from './helpers.js';
import { ModerationFlow } from '../src/moderation.js';
import { handler } from '../src/interactions.js';

test('실물 상품은 개별 코드 없이 신청하고 주최자 연락 안내만 전달하며 인원 변경도 반영한다',async t=>{
  const f=fixture(t),user=actor(4),eid=f.engine.create(GUILD,HOST,{title:'실물 상품',description:'배송 안내',durationMinutes:1,claimMinutes:1,winners:2});
  f.engine.setDeliveryMode(GUILD,HOST,eid,true);f.engine.updateDraftDetails(GUILD,HOST,eid,{title:'수정 상품',description:'설명',durationMinutes:1,claimMinutes:1,winners:1});
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

test('신고 증거는 관리자에게만 보내고 DB에는 원문을 저장하지 않으며 주최 제한을 적용한다',async t=>{
  const f=fixture(t),user=actor(4),eid=await f.event({participants:[user]});f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);
  const sends=[];f.transport.sendReport=async(channel,report,body)=>{sends.push({channel,report,body});return {id:'100000000000098'};};
  const handle=handler(f.engine,f.transport),submit=interaction(user,`form:report:claim:${c.id}`,{text:'PRIVATE-REPORT'},'modal');await handle(submit);
  assert.equal(sends.length,1);assert.equal(sends[0].channel,f.store.guild(GUILD).manager_channel);assert.equal(sends[0].body.text,'PRIVATE-REPORT');
  const report=f.store.get('SELECT * FROM reports WHERE event_id=?',eid);assert.equal(report.status,'OPEN');assert.doesNotMatch(JSON.stringify(report),/PRIVATE-REPORT/);
  const duplicate=interaction(user,`form:report:claim:${c.id}`,{text:'dupe'},'modal');await handle(duplicate);assert.equal(sends.length,1);
  const forged=interaction(HOST,`form:report:claim:${c.id}`,{text:'forged'},'modal');await handle(forged);assert.equal(sends.length,1);
  const restrict=interaction(MANAGER,`mod:restrictok:${report.id}:on`);await handle(restrict);
  assert.throws(()=>f.engine.create(GUILD,HOST,{title:'x'}),/주최가 제한/);
  assert.throws(()=>new ModerationFlow(f.engine,f.transport).view(GUILD,user,report.id),/관리자만/);
  assert.throws(()=>new ModerationFlow(f.engine,f.transport).view(OTHER_GUILD,MANAGER,report.id),/관리자만|신고를/);
  f.engine.restrictHost(GUILD,MANAGER,HOST.userId,false);assert.doesNotThrow(()=>f.engine.requireHostAllowed(GUILD,HOST.userId));
});

test('수령 DM의 신고 버튼도 당첨자만 신고 입력창을 열 수 있다',async t=>{
  const f=fixture(t),user=actor(4),eid=await f.event({participants:[user]});f.advance(60001);await f.engine.tick();const [c]=f.claims(eid);
  const handle=handler(f.engine,f.transport),dm=a=>Object.assign(interaction(a,`mod:reportclaim:${c.id}`),{guildId:null,inGuild:()=>false,channel:{type:ChannelType.DM}});
  const open=dm(user);await handle(open);assert.equal(open.modal.toJSON().custom_id,`form:report:claim:${c.id}`);
  const denied=dm(HOST);await handle(denied);assert.equal(denied.modal,undefined);
});
