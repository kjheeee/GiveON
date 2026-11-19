import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, actor, OWNER, MANAGER, HOST, GUILD, OTHER_GUILD } from './helpers.js';
import { replyHandler } from '../src/replies.js';

async function setup(t,{winners=1,participants=3}={}) {
  const f=fixture(t),users=Array.from({length:participants},(_,n)=>actor(n+10)),eid=await f.event({winners,participants:users});
  f.advance(60_001);await f.engine.tick();const claims=f.claims(eid),claim=claims[0];
  const job=f.store.get("SELECT * FROM jobs WHERE kind='winner' AND ref_id=?",claim.id);
  const handle=replyHandler(f.engine,f.transport,{user:{id:'bot'}});
  const message=(user=MANAGER,text='reroll',options={})=>({author:{id:user.userId,bot:false},guildId:GUILD,channelId:job.channel_id,content:text,reference:{messageId:job.message_id},responses:[],
    inGuild:()=>true,async fetchReference(){return{author:{id:'bot'}};},async reply(data){this.responses.push(data);},...options});
  return {...f,eid,initialClaims:claims,claim,handle,message};
}
test('등록 관리 역할의 reroll 답장은 해당 자리만 리롤하고 이전 당첨자는 제외한다',async t=>{
  const f=await setup(t,{winners:2}),m=f.message(MANAGER,' REROLL ');
  await f.handle(m);assert.equal(f.store.claim(f.claim.id).status,'EXPIRED');assert.equal(f.store.claim(f.initialClaims[1].id).status,'CLAIMABLE');
  const next=f.claims(f.eid).find(c=>!f.initialClaims.some(previous=>previous.id===c.id));assert.ok(next);assert.notEqual(next.user_id,f.claim.user_id);
  assert.match(m.responses[0].content,/강제 리롤/);assert.deepEqual(m.responses[0].allowedMentions,{parse:[],repliedUser:false});
  const duplicate=f.message();await f.handle(duplicate);assert.equal(f.claims(f.eid).length,3);assert.match(duplicate.responses[0].content,/리롤할 수 없는/);
});
test('리롤 답장은 소유자도 가능하고 일반 사용자·다른 서버·다른 채널·다른 봇 메시지는 거절한다',async t=>{
  const f=await setup(t);
  for(const m of [f.message(HOST),f.message(MANAGER,'reroll',{guildId:OTHER_GUILD}),f.message(MANAGER,'reroll',{channelId:'other'}),f.message(MANAGER,'reroll',{async fetchReference(){return{author:{id:'other-bot'}};}})])await f.handle(m);
  assert.equal(f.store.claim(f.claim.id).status,'CLAIMABLE');
  const owner=f.message(OWNER,'<@bot> 리롤');await f.handle(owner);assert.equal(f.store.claim(f.claim.id).status,'EXPIRED');
});
test('답장 아닌 메시지·봇·빈 본문·다른 명령은 무시한다',async t=>{
  const f=await setup(t);
  for(const m of [f.message(MANAGER,'reroll',{reference:null}),f.message(MANAGER,'reroll',{author:{id:MANAGER.userId,bot:true}}),f.message(MANAGER,''),f.message(MANAGER,'reroll all')]){await f.handle(m);assert.equal(m.responses.length,0);}
  assert.equal(f.store.claim(f.claim.id).status,'CLAIMABLE');
});
test('지급 완료·전송 결과 불명은 답장 리롤로 바꾸지 못한다',async t=>{
  const f=await setup(t);await f.engine.startClaim(GUILD,f.members.get(f.claim.user_id),f.claim.id);await f.engine.tick();
  const paid=f.message();await f.handle(paid);assert.equal(f.store.claim(f.claim.id).status,'DELIVERED');assert.match(paid.responses[0].content,/지급 완료/);
  f.store.run("UPDATE claims SET status='DELIVERY_UNKNOWN' WHERE id=?",f.claim.id);
  const unknown=f.message();await f.handle(unknown);assert.equal(f.store.claim(f.claim.id).status,'DELIVERY_UNKNOWN');assert.match(unknown.responses[0].content,/리롤할 수 없는/);
});
test('답장 처리 중 관리 역할이 제거되면 원본 확인 후에도 리롤하지 않는다',async t=>{
  const f=await setup(t),m=f.message();m.fetchReference=async()=>{f.members.set(MANAGER.userId,{...MANAGER,roles:[]});return{author:{id:'bot'}};};
  await f.handle(m);assert.equal(f.store.claim(f.claim.id).status,'CLAIMABLE');assert.match(m.responses[0].content,/관리자만/);
});
test('후보가 없으면 해당 자리만 마감한다',async t=>{
  const f=await setup(t,{participants:1}),m=f.message(MANAGER,'리롤');await f.handle(m);
  assert.equal(f.store.event(f.eid).status,'COMPLETED');assert.match(m.responses[0].content,/참여자가 없어/);
});
