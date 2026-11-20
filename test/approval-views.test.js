import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,HOST,OWNER,MANAGER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';

const buttons=view=>view.components.flatMap(r=>r.toJSON().components).map(c=>c.custom_id);
function setup(t){const f=fixture(t);f.transport.eventEmbed=(event,options)=>new DiscordTransport({},f.store,f.encryption).eventEmbed(event,options);return {...f,handle:handler(f.engine,f.transport)};}
function draft(f,host=OWNER){const eid=f.engine.create(GUILD,host,{title:'승인 화면 검사',description:'이벤트 설명',durationMinutes:1,claimMinutes:1,winners:1});f.engine.setProductInfo(GUILD,host,eid,1,'PRIVATE-PRODUCT',false);f.engine.setPrize(GUILD,host,eid,1,content('SECRET-DELIVERY'));return eid;}

test('관리자 권한이 있는 신청자도 신청 완료·내 신청·일반 상세에서는 승인 거절 버튼이 없다',async t=>{
  const f=setup(t),eid=draft(f),submit=interaction(OWNER,`ui:submit:${eid}`);await f.handle(submit);
  assert.equal(f.engine.manager(GUILD,OWNER),true);assert.equal(f.store.event(eid).status,'PENDING');assert.match(submit.replies[0].content,/관리자 승인 대기/);
  for(const id of [`pick:event`,`ui:event:${eid}`]){const i=interaction(OWNER,id,{values:[eid]},id==='pick:event'?'select':'button');await f.handle(i);assert.equal(buttons(i.replies[0]).some(id=>/^(eapprove|ereject):/.test(id)),false);assert.equal(buttons(i.replies[0]).some(id=>id.startsWith('ui:eventclaims:')),false);assert.match(i.replies[0].content,/승인을 기다리고/);}
  assert.equal(buttons(submit.replies[0]).some(id=>/^(eapprove|ereject):/.test(id)),false);assert.ok(buttons(submit.replies[0]).includes(`ui:event:${eid}`));
  const mine=interaction(OWNER,'ui:mine:0');await f.handle(mine);assert.ok(buttons(mine.replies[0]).includes('pick:event'));assert.equal(buttons(mine.replies[0]).includes('pick:event:manage'),false);
});

test('관리자는 관리자 승인 목록에서만 관리 보기로 진입하고 상품 목록을 다녀와도 승인 버튼을 유지한다',async t=>{
  const f=setup(t),eid=draft(f);f.engine.submit(GUILD,OWNER,eid);
  const pending=interaction(OWNER,'ui:pending:0');await f.handle(pending);assert.ok(buttons(pending.replies[0]).includes('pick:event:manage'));
  const select=interaction(OWNER,'pick:event:manage',{values:[eid]},'select');await f.handle(select);assert.ok(buttons(select.replies[0]).includes(`eapprove:${eid}`));assert.ok(buttons(select.replies[0]).includes(`ereject:${eid}`));
  const products=interaction(OWNER,`ui:manageproducts:${eid}:0`);await f.handle(products);assert.ok(buttons(products.replies[0]).includes(`ui:manageevent:${eid}`));
  const back=interaction(OWNER,`ui:manageevent:${eid}`);await f.handle(back);assert.ok(buttons(back.replies[0]).includes(`eapprove:${eid}`));assert.equal(JSON.stringify(back.replies).includes('SECRET-DELIVERY'),false);
  const approve=interaction(OWNER,`eapprove:${eid}`);await f.handle(approve);assert.equal(f.store.event(eid).status,'STARTING');
});

test('일반 신청자의 관리 화면 위조·승인·거절 요청은 실제 권한 검사에서 막는다',async t=>{
  const f=setup(t),eid=draft(f,HOST);f.engine.submit(GUILD,HOST,eid);
  const requests=[interaction(HOST,`ui:manageevent:${eid}`),interaction(HOST,'pick:event:manage',{values:[eid]},'select'),interaction(HOST,`ui:manageproducts:${eid}:0`),interaction(HOST,`eapprove:${eid}`),interaction(HOST,`ereject:${eid}`),interaction(HOST,`form:reject:${eid}`,{reason:'위조'},'modal')];
  for(const i of requests){await f.handle(i);assert.equal(f.store.event(eid).status,'PENDING');assert.equal(i.modal,undefined);assert.match(i.replies[0].content,/관리자만/);}
});

test('관리 화면을 연 뒤 역할이 해제되면 다음 조회·승인 시 최신 권한으로 거절한다',async t=>{
  const f=setup(t),eid=draft(f,HOST);f.engine.submit(GUILD,HOST,eid);
  const first=interaction(MANAGER,`ui:manageevent:${eid}`);await f.handle(first);assert.ok(buttons(first.replies[0]).includes(`eapprove:${eid}`));
  f.add({...MANAGER,roles:[]});for(const id of [`ui:manageevent:${eid}`,`eapprove:${eid}`]){const i=interaction(MANAGER,id);await f.handle(i);assert.match(i.replies[0].content,/관리자만/);assert.doesNotMatch(JSON.stringify(i.replies),/PRIVATE-PRODUCT/);}
  assert.equal(f.store.event(eid).status,'PENDING');
});

test('승인 요청 채널의 상세 버튼은 관리 보기로 연결하고 승인 거절은 관리자에게 유지한다',async t=>{
  const f=setup(t),eid=draft(f,HOST),sent=[];
  const transport=new DiscordTransport({channels:{async fetch(){return {async send(value){sent.push(value);return {id:'message',channelId:'manager'};}};}}},f.store,f.encryption);
  await transport.sendNotification({id:`application:${eid}`,kind:'application'},f.store.event(eid));assert.deepEqual(buttons(sent[0]),[`ui:manageevent:${eid}`,`eapprove:${eid}`,`ereject:${eid}`]);assert.doesNotMatch(JSON.stringify(sent),/SECRET-DELIVERY/);
});
