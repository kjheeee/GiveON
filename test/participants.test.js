import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { fixture, actor, GUILD, OTHER_GUILD, HOST, MANAGER, content } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';

function request(user,eid,page='') {
  return {customId:`ui:event:${eid}${page!==''?':'+page:''}`,guildId:GUILD,user:{id:user.userId},replies:[],
    inGuild:()=>true,isChatInputCommand:()=>false,isButton:()=>true,isModalSubmit:()=>false,isAnySelectMenu:()=>false,
    async deferReply(options){this.flags=options.flags;this.deferred=true;},async editReply(value){this.replies.push(value);},async reply(value){this.replies.push(value);},
  };
}
test('상세보기에 참여자 25명과 총인원을 표시하고 다음 페이지에서 나머지를 보여준다',async t=>{
  const f=fixture(t),users=Array.from({length:32},(_,index)=>actor(index+10)),viewer=actor(999);f.add(viewer);
  const eid=await f.event({participants:users});
  f.transport.eventEmbed=event=>new DiscordTransport({},f.store,f.encryption).eventEmbed(event);
  const handle=handler(f.engine,f.transport),first=request(viewer,eid);await handle(first);
  assert.equal(first.flags,MessageFlags.Ephemeral);
  const field=first.replies[0].embeds[0].toJSON().fields.at(-1);assert.match(field.name,/총 32명 · 1\/2페이지/);assert.equal(field.value.split('\n').length,25);
  assert.deepEqual(first.replies[0].allowedMentions,{parse:[]});
  const buttons=first.replies[0].components.flatMap(row=>row.toJSON().components);assert.ok(buttons.some(button=>button.custom_id===`ui:event:${eid}:1`));
  const second=request(viewer,eid,'1');await handle(second);const tail=second.replies[0].embeds[0].toJSON().fields.at(-1);
  assert.equal(tail.value.split('\n').length,7);assert.ok(tail.value.startsWith('26. '));assert.ok(!tail.value.includes(`<@${users[0].userId}>`));
  const publicButtons=new DiscordTransport({},f.store,f.encryption).eventComponents(f.store.event(eid))[0].toJSON().components;
  assert.deepEqual(publicButtons.map(button=>button.label),['참여','참여 취소','상세 보기']);
});
test('참여 취소·빈 목록·오래된 페이지는 현재 참여 신청 기준으로 새로 표시한다',async t=>{
  const f=fixture(t),users=Array.from({length:26},(_,index)=>actor(index+10)),eid=await f.event({participants:users});
  assert.equal(f.engine.participants(GUILD,HOST,eid,1).users.length,1);
  f.engine.leave(GUILD,users.at(-1),eid);const refreshed=f.engine.participants(GUILD,HOST,eid,1);assert.equal(refreshed.page,0);assert.equal(refreshed.total,25);
  for(const user of users.slice(0,-1))f.engine.leave(GUILD,user,eid);
  assert.deepEqual(f.engine.participants(GUILD,HOST,eid,99),{total:0,page:0,pages:1,users:[]});
});
test('참여자 조회는 다른 서버·비공개 초안 접근을 차단하며 상품 원문을 반환하지 않는다',async t=>{
  const f=fixture(t),viewer=actor(999),eid=await f.event({start:false});f.add(viewer);
  f.engine.setPrize(GUILD,HOST,eid,1,content('ROSTER-PRIVATE-PRIZE'));
  assert.throws(()=>f.engine.participants(GUILD,viewer,eid),/조회할 수 없/);
  assert.throws(()=>f.engine.participants(OTHER_GUILD,HOST,eid),/이 서버/);
  assert.throws(()=>f.engine.participants(GUILD,HOST,eid,-1),/페이지/);
  assert.equal(JSON.stringify(f.engine.participants(GUILD,HOST,eid)).includes('ROSTER-PRIVATE'),false);
});
test('공개된 종료·취소 이벤트는 상세 참여자를 유지하고 미게시 취소는 공개하지 않는다',async t=>{
  const f=fixture(t),user=actor(10),viewer=actor(999),eid=await f.event({participants:[user]});f.add(viewer);
  f.engine.cancel(GUILD,HOST,eid);assert.deepEqual(f.engine.participants(GUILD,viewer,eid).users,[user.userId]);
  const draft=await f.event({start:false});f.engine.cancel(GUILD,HOST,draft);assert.throws(()=>f.engine.participants(GUILD,viewer,draft),/조회할 수 없/);
});

test('최대 길이 인증 안내가 있는 이벤트도 상세 참여자 목록을 함께 표시한다',async t=>{
  const f=fixture(t),eid=await f.event({start:false}),instructions='인'.repeat(1000);
  f.engine.setProofRequirement(GUILD,HOST,eid,instructions);f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();
  f.transport.eventEmbed=event=>new DiscordTransport({},f.store,f.encryption).eventEmbed(event);
  const view=request(HOST,eid);await handler(f.engine,f.transport)(view);
  const fields=view.replies[0].embeds[0].toJSON().fields;
  assert.equal(fields.find(field=>field.name==='수령 전 인증 필요').value,instructions);assert.match(fields.at(-1).value,/아직 참여자가 없/);assert.ok(fields.every(field=>field.value.length<=1024));
});
