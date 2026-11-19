import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ChannelType, Collection, ModalSubmitFields } from 'discord.js';
import { fixture, GUILD, OTHER_GUILD, OWNER, HOST, MANAGER, ALLOW_ROLE, MANAGER_ROLE } from './helpers.js';
import { SetupFlow } from '../src/setup.js';
import { handler } from '../src/interactions.js';

const PANEL='100000000000022',EVENT='100000000000023',REVIEW='100000000000024';
const channelData={panel_channel:PANEL,event_channel:EVENT,manager_channel:REVIEW};
const fieldData=(channels=channelData,roles={})=>({
  getSelectedChannels:key=>new Collection([[channels[key],{id:channels[key]}]]),
  getSelectedRoles:key=>new Collection((roles[key]||[]).map(id=>[id,{id}])),
});
function setup(t) {
  const f=fixture(t),calls=[],everyone={id:GUILD};
  const channels=new Map([PANEL,EVENT,REVIEW].map(id=>[id,{id,guildId:GUILD,type:ChannelType.GuildText,permissionsFor:member=>({has:()=>member!==everyone||id!==REVIEW})}]));
  const guild={id:GUILD,roles:{everyone},members:{async fetchMe(){return{id:'bot'};}},channels:{async fetch(id){return channels.get(id);}}};
  f.transport.panel={async ensure(gid,id){calls.push(id);return{id:'posted',channelId:id};}};
  const flow=new SetupFlow(f.engine,f.transport);
  return {...f,flow,calls,guild,channels,token(user=OWNER){return f.store.get('SELECT token FROM setup_sessions WHERE guild_id=? AND user_id=?',GUILD,user.userId).token;}};
}
async function ready(f,user=OWNER) {
  f.flow.start(GUILD,user,PANEL);const token=f.token(user);
  await f.flow.submitChannels(GUILD,user,token,fieldData(),f.guild);
  f.flow.submitRoles(GUILD,user,token,fieldData(channelData,{manager_roles:[MANAGER_ROLE],condition_roles:[ALLOW_ROLE]}));
  return token;
}
test('초기설정은 Label 안의 채널·역할 선택 팝업이며 모두 완료 전에는 게시·설정 저장을 하지 않는다',async t=>{
  const f=setup(t),before=f.store.guild(GUILD),modal=f.flow.start(GUILD,OWNER,PANEL).toJSON(),token=f.token();
  assert.equal(modal.components.length,4);assert.deepEqual(modal.components.slice(1).map(c=>c.component.type),[8,8,8]);
  assert.equal(modal.components[1].component.default_values[0].id,PANEL);assert.equal(f.calls.length,0);
  await f.flow.submitChannels(GUILD,OWNER,token,fieldData(),f.guild);
  const roles=f.flow.modal(GUILD,OWNER,token,'roles').toJSON();assert.equal(roles.components.length,5);
  assert.ok(roles.components.slice(1).every(c=>c.component.type===6&&c.component.required===false));
  f.flow.submitRoles(GUILD,OWNER,token,fieldData(channelData,{condition_roles:[ALLOW_ROLE]}));
  assert.deepEqual(f.store.guild(GUILD),before);assert.equal(f.calls.length,0);
  f.flow.cancel(GUILD,OWNER,token);assert.deepEqual(f.store.guild(GUILD),before);assert.equal(f.calls.length,0);
});
test('완료 버튼만 설정을 저장하고 실행 채널과 별도로 선택한 안내 채널에 게시한다',async t=>{
  const f=setup(t),token=await ready(f);
  const message=await f.flow.finish(GUILD,OWNER,token,f.guild);
  assert.deepEqual(f.calls,[PANEL]);assert.match(message.content,/초기설정을 완료/);assert.deepEqual(message.embeds,[]);
  assert.equal(f.store.guild(GUILD).event_channel,EVENT);assert.equal(f.store.guild(GUILD).manager_channel,REVIEW);
  assert.deepEqual(JSON.parse(f.store.guild(GUILD).condition_roles),[ALLOW_ROLE]);
  assert.equal(f.store.get('SELECT * FROM setup_sessions WHERE token=?',token),undefined);
});
test('검수채널 공개·채널 중복·권한 부족을 다음 단계와 최종 게시에서 재검사한다',async t=>{
  const f=setup(t);f.flow.start(GUILD,OWNER,PANEL);const token=f.token();
  await assert.rejects(f.flow.submitChannels(GUILD,OWNER,token,fieldData({...channelData,manager_channel:PANEL}),f.guild),/달라야/);
  await assert.rejects(f.flow.submitChannels(GUILD,OWNER,token,fieldData({...channelData,manager_channel:'100000000000025'}),f.guild),/텍스트 채널/);
  f.channels.get(REVIEW).permissionsFor=()=>({has:()=>true});
  await assert.rejects(f.flow.submitChannels(GUILD,OWNER,token,fieldData(),f.guild),/@everyone/);
  f.channels.get(REVIEW).permissionsFor=()=>({has:()=>false});
  await assert.rejects(f.flow.submitChannels(GUILD,OWNER,token,fieldData(),f.guild),/권한/);assert.equal(f.calls.length,0);
});
test('초기설정 토큰은 서버·실행자·현재 관리 권한에 귀속되며 단계를 건너뛰지 못한다',async t=>{
  const f=setup(t);f.flow.start(GUILD,OWNER,PANEL);const token=f.token();
  assert.throws(()=>f.flow.modal(GUILD,OWNER,token,'roles'),/먼저 채널/);
  await assert.rejects(f.flow.finish(GUILD,OWNER,token,f.guild),/최종 확인/);
  assert.throws(()=>f.flow.view(GUILD,MANAGER,token),/만료/);assert.throws(()=>f.flow.view(OTHER_GUILD,OWNER,token),/만료/);
  assert.throws(()=>f.flow.start(GUILD,HOST,PANEL),/관리자만/);
  await ready(f,MANAGER);const managerToken=f.token(MANAGER);f.members.set(MANAGER.userId,{...MANAGER,roles:[]});
  await assert.rejects(f.flow.finish(GUILD,MANAGER,managerToken,f.guild),/관리자만/);assert.equal(f.calls.length,0);
});
test('지정 관리자의 팝업에는 관리 역할 편집이 없고 위조 필드도 소유자 권한을 만들지 못한다',async t=>{
  const f=setup(t);f.flow.start(GUILD,MANAGER,PANEL);const token=f.token(MANAGER);
  await f.flow.submitChannels(GUILD,MANAGER,token,fieldData(),f.guild);
  const modal=f.flow.modal(GUILD,MANAGER,token,'roles').toJSON();assert.equal(modal.components.length,4);
  assert.ok(modal.components.every(c=>c.component?.custom_id!=='manager_roles'));
  f.flow.submitRoles(GUILD,MANAGER,token,fieldData(channelData,{manager_roles:[ALLOW_ROLE]}));
  await f.flow.finish(GUILD,MANAGER,token,f.guild);assert.deepEqual(JSON.parse(f.store.guild(GUILD).manager_roles),[MANAGER_ROLE]);
});
test('다른 관리자의 변경·삭제된 채널은 오래된 최종 확인으로 덮거나 게시하지 않는다',async t=>{
  const f=setup(t),token=await ready(f);
  f.engine.configure(GUILD,OWNER,'condition_roles',[ALLOW_ROLE]);
  await assert.rejects(f.flow.finish(GUILD,OWNER,token,f.guild),/다른 관리자/);assert.equal(f.calls.length,0);
  const next=await ready(f);f.channels.delete(EVENT);
  await assert.rejects(f.flow.finish(GUILD,OWNER,next,f.guild),/텍스트 채널/);assert.equal(f.calls.length,0);
});
test('게시 실패는 비공개 재시도 화면을 유지하고 중복 완료 요청은 실행하지 않는다',async t=>{
  const f=setup(t),token=await ready(f);let resolve;
  f.transport.panel.ensure=()=>new Promise(r=>{resolve=r;});
  const first=f.flow.finish(GUILD,OWNER,token,f.guild);
  await new Promise(r=>setImmediate(r));
  await assert.rejects(f.flow.finish(GUILD,OWNER,token,f.guild),/처리 중/);
  resolve({id:'posted',channelId:PANEL});await first;
  const retryToken=await ready(f);f.transport.panel.ensure=async()=>{throw new Error('network');};
  const failed=await f.flow.finish(GUILD,OWNER,retryToken,f.guild);assert.match(failed.content,/설정은 저장했지만/);
  f.transport.panel.ensure=async()=>({id:'posted',channelId:PANEL});
  assert.match((await f.flow.finish(GUILD,OWNER,retryToken,f.guild)).content,/완료하고/);
});
test('실제 모달 필드 구조로 init→채널팝업→역할팝업→비공개확인→완료만 게시한다',async t=>{
  const f=setup(t),handle=handler(f.engine,f.transport),client={guilds:{async fetch(){return f.guild;}}};
  const request=(id,type,fields)=>({customId:id,commandName:type==='chat'?id:undefined,guildId:GUILD,channelId:EVENT,user:{id:OWNER.userId},client,fields,
    inGuild:()=>true,isChatInputCommand:()=>type==='chat',isButton:()=>type==='button',isModalSubmit:()=>type==='modal',isAnySelectMenu:()=>false,
    async showModal(modal){assert.equal(this.deferred,undefined);this.modal=modal.toJSON();this.replied=true;},async deferReply(options){this.deferred=true;this.flags=options.flags;},async editReply(data){this.response=data;},async reply(data){this.response=data;},
  });
  const open=request('init','chat');await handle(open);assert.ok(open.modal);assert.equal(f.calls.length,0);const token=f.token();
  const modalFields=(data,type)=>new ModalSubmitFields(Object.entries(data).map(([key,values])=>({type:18,component:{type,customId:key,values,[type===8?'channels':'roles']:new Collection(values.map(id=>[id,{id}]))}})));
  const channels=request(`form:setupchannels:${token}`,'modal',modalFields(Object.fromEntries(Object.entries(channelData).map(([k,v])=>[k,[v]])),8));
  await handle(channels);assert.equal(channels.flags,MessageFlags.Ephemeral);assert.deepEqual(channels.response.embeds,[]);assert.equal(f.calls.length,0);
  const rolesOpen=request(`setup:open:${token}:roles`,'button');await handle(rolesOpen);assert.ok(rolesOpen.modal);
  const roles=request(`form:setuproles:${token}`,'modal',modalFields({manager_roles:[MANAGER_ROLE],condition_roles:[],blocked_roles:[],mention_roles:[]},6));
  await handle(roles);assert.equal(roles.flags,MessageFlags.Ephemeral);assert.match(roles.response.content,/최종 확인/);assert.equal(f.calls.length,0);
  const finish=request(`setup:finish:${token}`,'button');await handle(finish);assert.equal(finish.flags,MessageFlags.Ephemeral);assert.deepEqual(f.calls,[PANEL]);
});
