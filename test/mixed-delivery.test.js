import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,OTHER_GUILD,HOST,MANAGER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DraftFlow } from '../src/drafts.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { claimView } from '../src/ui.js';

const options={title:'혼합 상품',description:'자리별 상품 안내',durationMinutes:1,claimMinutes:1,winners:3};
function createNamed(f){const eid=f.engine.create(GUILD,HOST,options);for(let slot=1;slot<=options.winners;slot++)f.engine.setProductInfo(GUILD,HOST,eid,slot,'상품 '+slot,true);return eid;}
async function start(f,eid,users){f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();f.add(...users);for(const user of users)f.engine.join(GUILD,user,eid);f.advance(60001);await f.engine.tick();return f.claims(eid);}

test('1번 실물·2/3번 디지털을 함께 추첨하고 각 자리의 암호문을 복호화해 서로 다른 내용으로 전달한다',async t=>{
  const f=fixture(t),eid=createNamed(f),users=[actor(4),actor(5),actor(6)];
  f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);f.engine.setPrize(GUILD,HOST,eid,2,{text:'DIGITAL-2',images:[{ext:'png',data:'aW1hZ2U='}]});f.engine.setPrize(GUILD,HOST,eid,3,content('DIGITAL-3'));
  const rows=f.store.all('SELECT secret FROM prizes WHERE event_id=? ORDER BY slot',eid);assert.equal(rows.some(row=>Buffer.from(row.secret).includes(Buffer.from('DIGITAL-'))),false);
  const claims=await start(f,eid,users),delivered=new Map();f.transport.sendPrize=async(channel,event,claim,value)=>{delivered.set(claim.slot,value);return {id:`mixed-${claim.slot}`,channelId:channel};};
  for(const c of claims)await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);
  assert.match(delivered.get(1).text,/1번 실물/);assert.match(delivered.get(1).text,new RegExp(HOST.userId));assert.equal(delivered.get(2).text,'DIGITAL-2');assert.equal(delivered.get(2).images.length,1);assert.equal(delivered.get(3).text,'DIGITAL-3');
  assert.equal(new Set(claims.map(c=>c.user_id)).size,3);assert.equal(f.store.all('SELECT secret FROM prizes WHERE event_id=?',eid).every(p=>p.secret===null),true);
  assert.deepEqual(f.engine.deliverySummary(eid).directSlots,[1]);assert.deepEqual(f.engine.deliverySummary(eid).digitalSlots,[2,3]);
  for(const c of claims){const view=claimView(f.engine,GUILD,f.members.get(c.user_id),c.id);assert.match(view.content,c.slot===1?/연락 안내 완료/:/수령 완료/);}
  const notices=[],transport=new DiscordTransport({channels:{async fetch(){return {async send(body){notices.push(body);return {id:'notice',channelId:'dm'};}};}},users:{async fetch(){return {async createDM(){return {id:'dm'};}};}}},f.store,f.encryption);
  for(const c of claims)await transport.sendNotification({id:`hostReceived:${c.id}`,kind:'hostReceived'},f.store.event(eid),f.store.claim(c.id));
  assert.equal(notices.filter(n=>n.embeds[0].toJSON().title.includes('연락 안내')).length,1);assert.equal(notices.filter(n=>n.embeds[0].toJSON().title.includes('상품 수령')).length,2);
  await transport.sendNotification({id:`closed:${eid}`,kind:'closed'},f.store.event(eid));assert.match(notices.at(-1).embeds[0].toJSON().description,/디지털 지급 완료: 2건/);assert.match(notices.at(-1).embeds[0].toJSON().description,/실물 연락 안내 완료: 1건/);
});

test('한 자리 방식 변경은 다른 자리 암호문을 보존하고 같은 방식 재선택도 내용을 지우지 않는다',async t=>{
  const f=fixture(t),eid=await f.event({winners:3,start:false}),before=f.store.all('SELECT secret FROM prizes WHERE event_id=? ORDER BY slot',eid).map(p=>Buffer.from(p.secret)),handle=handler(f.engine,f.transport);
  const choose=interaction(HOST,`flow:mode:${eid}:1:direct`);await handle(choose);assert.equal(f.engine.direct(eid,1),false);assert.match(choose.replies[0].content,/1번.*삭제/);
  const confirm=interaction(HOST,`flow:modeok:${eid}:1:direct`);await handle(confirm);assert.equal(f.engine.direct(eid,1),true);
  for(const slot of [2,3])assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=?',eid,slot).secret),before[slot-1]);
  f.engine.setDeliveryMode(GUILD,HOST,eid,1,false);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret,null);
  f.engine.setPrize(GUILD,HOST,eid,1,content('NEW-1'));const saved=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret);f.engine.setDeliveryMode(GUILD,HOST,eid,1,false);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret),saved);
});

test('전부 실물도 자리별 선택만으로 순차 완료하고 디지털 입력창은 열지 않는다',async t=>{
  const f=fixture(t),eid=createNamed(f),handle=handler(f.engine,f.transport);
  for(let slot=1;slot<=3;slot++){const choice=interaction(HOST,`flow:mode:${eid}:${slot}:direct`);await handle(choice);assert.equal(f.engine.direct(eid,slot),true);assert.match(choice.replies[0].content,slot<3?new RegExp(`${slot+1}번`):/최종 확인/);}
  assert.doesNotThrow(()=>f.engine.submit(GUILD,HOST,eid));
  const draft=createNamed(f);f.engine.setDeliveryMode(GUILD,HOST,draft,1,true);const denied=interaction(HOST,`flow:prize:${draft}:1`);await handle(denied);assert.equal(denied.modal,undefined);assert.match(denied.replies[0].content,/실물 자리/);
});

test('혼합 초안 인원 변경은 등록 디지털을 보호하고 새 자리는 빈 디지털로 만든다',async t=>{
  const f=fixture(t),eid=createNamed(f);f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);f.engine.setPrize(GUILD,HOST,eid,2,content('KEEP-2'));f.engine.setPrize(GUILD,HOST,eid,3,content('KEEP-3'));
  assert.throws(()=>f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,winners:2}),/등록된 상품/);
  f.engine.setDeliveryMode(GUILD,HOST,eid,3,true);f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,winners:2});assert.deepEqual(f.engine.deliverySummary(eid).directSlots,[1]);
  f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,winners:4});assert.deepEqual(f.engine.deliverySummary(eid).digitalSlots,[2,3,4]);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=3',eid).secret,null);
});

test('자리별 방식은 주최자 초안에서만 바꾸고 다른 서버·잘못된 자리·구 전체 버튼을 차단한다',async t=>{
  const f=fixture(t),eid=createNamed(f);
  assert.throws(()=>f.engine.setDeliveryMode(GUILD,MANAGER,eid,1,true),/본인의 초안/);assert.throws(()=>f.engine.setDeliveryMode(OTHER_GUILD,HOST,eid,1,true),/이 서버/);
  for(const slot of [0,4,NaN])assert.throws(()=>f.engine.setDeliveryMode(GUILD,HOST,eid,slot,true),/상품 자리/);
  const legacy=interaction(HOST,`flow:mode:${eid}:direct`);await handler(f.engine,f.transport)(legacy);assert.match(legacy.replies[0].content,/상품 자리/);assert.deepEqual(f.engine.deliverySummary(eid).directSlots,[]);
  const view=await new DraftFlow(f.engine,f.transport).view(GUILD,HOST,eid,'review');assert.match(JSON.stringify(view),/상품 번호 · 실물 \/ 디지털/);assert.equal(view.components.length<=5,true);
});

test('혼합 이벤트 리롤은 해당 자리의 실물 방식을 유지하고 디지털 자리의 내용도 보존한다',async t=>{
  const f=fixture(t),eid=createNamed(f),users=[actor(4),actor(5),actor(6),actor(7)];
  f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);f.engine.setPrize(GUILD,HOST,eid,2,content('KEEP-2'));f.engine.setPrize(GUILD,HOST,eid,3,content('KEEP-3'));
  const old=await start(f,eid,users),oldDirect=old.find(c=>c.slot===1),saved=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=2',eid).secret);
  await f.engine.reroll(GUILD,MANAGER,oldDirect.id);await f.engine.processJobs();const replacement=f.claims(eid).find(c=>c.slot===1&&c.id!==oldDirect.id);
  assert.ok(replacement);assert.equal(f.engine.direct(eid,replacement.slot),true);assert.equal(old.some(c=>c.user_id===replacement.user_id),false);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=2',eid).secret),saved);
});
