import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,OTHER_GUILD,HOST,MANAGER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { productsView,claimView } from '../src/ui.js';
import { ModerationFlow } from '../src/moderation.js';

const options={title:'수험자 용 이벤트',description:'상품별 안내',durationMinutes:1,claimMinutes:1,winners:4};
async function published(f,eid,users=[]){f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();f.add(...users);for(const user of users)f.engine.join(GUILD,user,eid);return f.store.event(eid);}

test('상품명은 필수이며 암호화 저장하고 공개 여부 수정은 전달 내용을 지우지 않는다',t=>{
  const f=fixture(t),eid=f.engine.create(GUILD,HOST,{...options,winners:1});f.engine.setPrize(GUILD,HOST,eid,1,content('PRIVATE-CODE'));
  assert.throws(()=>f.engine.submit(GUILD,HOST,eid),/상품명/);for(const name of ['', ' ', 'a'.repeat(101)])assert.throws(()=>f.engine.setProductInfo(GUILD,HOST,eid,1,name,true),/상품명/);
  assert.throws(()=>f.engine.setProductInfo(GUILD,MANAGER,eid,1,'이름',true),/본인의/);assert.throws(()=>f.engine.setProductInfo(OTHER_GUILD,HOST,eid,1,'이름',true),/이 서버/);
  const original=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret);f.engine.setProductInfo(GUILD,HOST,eid,1,'PRIVATE-PRODUCT',false);
  const prize=f.store.get('SELECT name,name_public FROM prizes WHERE event_id=?',eid);assert.equal(Buffer.from(prize.name).includes(Buffer.from('PRIVATE-PRODUCT')),false);assert.equal(prize.name_public,0);
  assert.throws(()=>f.encryption.open(prize.name,`product-name:${eid}:2`));assert.equal(f.engine.product(f.store.event(eid),1,true).name,'PRIVATE-PRODUCT');
  f.engine.setProductInfo(GUILD,HOST,eid,1,'수정 상품',true);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret),original);assert.doesNotThrow(()=>f.engine.submit(GUILD,HOST,eid));
});

test('공개 카드·상품 목록·당첨 안내는 비공개 이름을 숨기고 당첨자 DM·조회에는 실제 이름을 표시한다',async t=>{
  const f=fixture(t),eid=f.engine.create(GUILD,HOST,options),names=['치킨 쿠폰','PRIVATE-키보드','배달 상품권','마우스'],users=[actor(4),actor(5),actor(6),actor(7)];
  for(let slot=1;slot<=4;slot++){f.engine.setProductInfo(GUILD,HOST,eid,slot,names[slot-1],slot!==2);if([2,4].includes(slot))f.engine.setDeliveryMode(GUILD,HOST,eid,slot,true);else f.engine.setPrize(GUILD,HOST,eid,slot,content(`CODE-${slot}`));}
  const event=await published(f,eid,users),sent=[],channel={async send(body){sent.push(body);return {id:'message',channelId:'dm'};}};
  const transport=new DiscordTransport({channels:{async fetch(){return channel;}},users:{async fetch(){return {async createDM(){return {id:'dm'};}};}}},f.store,f.encryption);
  const publicCard=JSON.stringify(transport.publicEvent(event));assert.match(publicCard,/치킨 쿠폰/);assert.match(publicCard,/마우스/);assert.doesNotMatch(publicCard,/PRIVATE-키보드/);assert.match(publicCard,/비공개 상품/);
  const list=productsView(f.engine,GUILD,actor(99),eid);assert.doesNotMatch(list.content,/PRIVATE-키보드/);assert.match(productsView(f.engine,GUILD,MANAGER,eid).content,/PRIVATE-키보드/);
  f.advance(60001);await f.engine.tick();const claim=f.claims(eid).find(c=>c.slot===2),winner=f.members.get(claim.user_id);
  await transport.sendNotification({id:`winner:${claim.id}`,kind:'winner'},f.store.event(eid),claim);assert.doesNotMatch(JSON.stringify(sent.at(-1)),/PRIVATE-키보드/);
  await transport.sendPrize('dm',f.store.event(eid),claim,content('CONTACT'));assert.match(sent.at(-1).embeds[0].toJSON().title,/2번 PRIVATE-키보드/);
  assert.match(claimView(f.engine,GUILD,winner,claim.id).content,/2번 상품: \*\*PRIVATE-키보드/);assert.match(new ModerationFlow(f.engine,f.transport).lookup(GUILD,winner,claim.id).content,/PRIVATE-키보드/);
  await f.engine.startClaim(GUILD,winner,claim.id);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=2',eid).secret,null);assert.ok(f.store.get('SELECT name FROM prizes WHERE event_id=? AND slot=2',eid).name);
});

test('상품명 팝업은 입력·공개 선택을 저장하며 다른 사람은 이름을 변경할 수 없다',async t=>{
  const f=fixture(t),eid=f.engine.create(GUILD,HOST,{...options,winners:1}),handle=handler(f.engine,f.transport);
  const open=interaction(HOST,`flow:product:${eid}:1`);await handle(open);assert.equal(open.modal.toJSON().components[0].component.custom_id,'name');assert.equal(open.modal.toJSON().components[1].component.custom_id,'visibility');
  const submit=interaction(HOST,`form:product:${eid}:1`,{name:'치킨 쿠폰',visibility:'private'},'modal');await handle(submit);assert.match(submit.replies[0].content,/치킨 쿠폰/);assert.equal(f.engine.product(f.store.event(eid),1,true).publicName,false);
  const denied=interaction(MANAGER,`form:product:${eid}:1`,{name:'바꾼 이름',visibility:'public'},'modal');await handle(denied);assert.match(denied.replies[0].content,/본인의/);assert.equal(f.engine.product(f.store.event(eid),1,true).name,'치킨 쿠폰');
});

test('상품 100개도 10개씩 페이지로 보여주며 예전 게시 이벤트의 상품명은 이벤트명으로 호환한다',async t=>{
  const f=fixture(t),eid=f.engine.create(GUILD,HOST,{...options,winners:100});for(let slot=1;slot<=100;slot++){f.engine.setProductInfo(GUILD,HOST,eid,slot,'A'.repeat(95)+String(slot).padStart(3,'0'),true);f.engine.setDeliveryMode(GUILD,HOST,eid,slot,true);}
  await published(f,eid);const page=productsView(f.engine,GUILD,actor(99),eid,1);assert.match(page.content,/11번 상품/);assert.match(page.content,/20번 상품/);assert.ok(page.content.length<=2000);assert.equal(f.engine.products(GUILD,actor(99),eid,99).page,9);
  f.store.run('UPDATE prizes SET name=NULL WHERE event_id=? AND slot=1',eid);assert.equal(f.engine.product(f.store.event(eid),1).name,options.title);assert.throws(()=>f.engine.products(OTHER_GUILD,HOST,eid),/이 서버/);
});
