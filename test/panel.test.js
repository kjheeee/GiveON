import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { fixture, actor, GUILD, HOST, MANAGER, OWNER, ALLOW_ROLE, DENY_ROLE } from './helpers.js';
import { handler } from '../src/interactions.js';
import { PanelPublisher, entryPanel } from '../src/panel.js';
import { createModal, contentModal, proofSettingsModal } from '../src/ui.js';

function request(user,id,fields={},type='button',ephemeral=false) {
  return {
    customId:id,commandName:type==='chat'?id:undefined,guildId:GUILD,channelId:'100000000000022',user:{id:user.userId,bot:false},
    message:ephemeral?{flags:{has:flag=>flag===MessageFlags.Ephemeral}}:undefined,
    inGuild:()=>true,isChatInputCommand:()=>type==='chat',isButton:()=>type==='button',isModalSubmit:()=>type==='modal',isAnySelectMenu:()=>type==='select',
    fields:{getTextInputValue:key=>fields[key]||'',getUploadedFiles:()=>null},values:fields.values||[],replies:[],
    async deferReply(options){this.deferred=true;this.deferOptions=options;},async deferUpdate(){this.deferred=true;this.updated=true;},
    async editReply(options){this.replies.push(options);},async reply(options){this.replied=true;this.replies.push(options);},
    async deleteReply(){this.deleted=true;},
    async showModal(modal){this.replied=true;this.modal=modal;},
  };
}
function setup(t) {
  const f=fixture(t);
  f.transport.eventEmbed=e=>new EmbedBuilder().setTitle(e.title).setDescription(e.description);
  return {...f,handle:handler(f.engine,f.transport)};
}
function panelClient() {
  const client={user:{id:'bot'}},channels=new Collection(),sent=[];
  function channel(id) {
    const history=new Collection();
    const value={id,guildId:GUILD,type:ChannelType.GuildText,rawPosition:channels.size,permissionsFor:()=>({has:()=>true}),history,
      messages:{async fetch(arg){if(typeof arg==='string'){if(!history.has(arg))throw Object.assign(new Error('unknown message'),{code:10008});return history.get(arg);}return history;}},
      async send(options){
        sent.push(options);const message={id:`m-${sent.length}`,author:client.user,content:options.content||'',components:options.components.map(c=>c.toJSON()),embeds:options.embeds.map(e=>e.toJSON()),edits:0,
          async edit(next){this.edits++;this.content=next.content||'';this.components=next.components.map(c=>c.toJSON());this.embeds=next.embeds.map(e=>e.toJSON());},async delete(){history.delete(this.id);}};
        history.set(message.id,message);return message;
      },
    };channels.set(id,value);return value;
  }
  const first=channel('100000000000022'),second=channel('100000000000023');
  const guild={id:GUILD,systemChannelId:first.id,members:{async fetchMe(){return{id:'bot'};}},channels:{async fetch(id){return id?channels.get(id):channels;}}};
  return{client,guild,first,second,sent};
}

test('공개 안내는 일반 이용 버튼 네 개만 제공하고 관리자 버튼·자동 게시가 없다',t=>{
  const f=setup(t),c=panelClient();new PanelPublisher(c.client,f.store);
  assert.equal(c.sent.length,0);
  assert.deepEqual(entryPanel(GUILD).components[0].toJSON().components.map(b=>b.label),['이벤트 신청','내 신청','내 당첨','이용 안내']);
  assert.equal(JSON.stringify(entryPanel(GUILD)).includes('ui:admin'),false);
});

test('setting은 초기설정 게시 완료 후 지정 관리자에게만 비공개 관리 화면을 연다',async t=>{
  const f=setup(t),notReady=request(MANAGER,'setting',{},'chat');
  await f.handle(notReady);assert.match(notReady.replies[0].content,/먼저 \/init/);assert.equal(notReady.deferOptions.flags,MessageFlags.Ephemeral);
  f.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,'panel','PENDING',?)",GUILD,'100000000000022',Date.now());
  const pending=request(MANAGER,'setting',{},'chat');await f.handle(pending);assert.match(pending.replies[0].content,/먼저 \/init/);
  f.store.run("UPDATE panels SET state='READY' WHERE guild_id=?",GUILD);
  const allowed=request(MANAGER,'setting',{},'chat');await f.handle(allowed);assert.match(allowed.replies[0].content,/GiveON 관리자/);assert.equal(allowed.deferOptions.flags,MessageFlags.Ephemeral);
  const denied=request(HOST,'setting',{},'chat');await f.handle(denied);assert.match(denied.replies[0].content,/관리자만/);
});

test('닫기와 예전 돌아가기 버튼은 개인 응답만 지우며 신청 안내를 복제하지 않는다',async t=>{
  const f=setup(t),calls=[];f.transport.panel={async ensure(){calls.push('post');}};
  for(const ephemeral of [true,false]){
    const close=request(HOST,'ui:home',{},'button',ephemeral);await f.handle(close);
    assert.equal(close.deleted,true);assert.deepEqual(close.replies,[]);
    if(ephemeral)assert.equal(close.updated,true);else assert.equal(close.deferOptions.flags,MessageFlags.Ephemeral);
  }
  const failed=request(HOST,'ui:home',{},'button',true);failed.deleteReply=async()=>{throw new Error('network');};
  await f.handle(failed);assert.deepEqual(failed.replies[0].components,[]);assert.deepEqual(failed.replies[0].embeds,[]);assert.equal(JSON.stringify(failed.replies).includes('ui:create'),false);assert.deepEqual(calls,[]);
});

test('입력창은 Discord Label과 File Upload를 사용해 텍스트·사진 제출을 함께 받는다',()=>{
  const create=createModal().toJSON(),prize=contentModal('form:prize:id','상품',1).toJSON(),proof=contentModal('form:proof:id','인증').toJSON();
  assert.equal(create.components.length,5);
  for(const form of [create,prize,proof,proofSettingsModal({id:'id',proof_instructions:''}).toJSON()]) {
    assert.ok(form.components.length<=5);assert.ok(form.components.every(c=>c.type===18));
  }
  const upload=proof.components.find(c=>c.component.type===19).component;
  assert.equal(upload.required,false);assert.equal(upload.max_values,2);
  assert.equal(proof.components.find(c=>c.component.type===4).component.required,false);
  const withGuide=contentModal('form:proof:id','인증',null,'연도만 보이도록 가리고 제출해주세요.').toJSON();
  assert.equal(withGuide.components[0].type,10);assert.match(withGuide.components[0].content,/연도/);
});

test('init은 지정 관리자에게만 비공개 초기설정을 열며 바로 게시하지 않는다',async t=>{
  const f=setup(t),calls=[];
  f.transport.panel={async ensure(guild,channel){calls.push(channel);return{id:'message',channelId:channel};}};
  const denied=request(HOST,'init',{},'chat');denied.client={guilds:{async fetch(){return{id:GUILD};}}};
  await f.handle(denied);assert.equal(calls.length,0);assert.match(denied.replies[0].content,/관리자만/);
  const allowed=request(MANAGER,'init',{},'chat');allowed.client=denied.client;
  await f.handle(allowed);assert.deepEqual(calls,[]);assert.equal(allowed.deferred,undefined);
  assert.match(allowed.modal.toJSON().title,/1\/3.*채널 설정/);assert.equal(f.store.all('SELECT * FROM setup_sessions').length,1);
});

test('init 재실행·게시자 재생성은 기존 메시지를 갱신하고 다른 채널에서는 이전 안내만 정리한다',async t=>{
  const f=setup(t),c=panelClient();
  let publisher=new PanelPublisher(c.client,f.store);
  const first=await publisher.ensure(c.guild,c.first.id);assert.equal(c.sent.length,1);
  publisher=new PanelPublisher(c.client,f.store);
  await publisher.ensure(c.guild,c.first.id);assert.equal(c.sent.length,1);assert.equal(c.first.history.get(first.id).edits,1);
  await publisher.ensure(c.guild,c.second.id);assert.equal(c.sent.length,2);assert.equal(c.first.history.has(first.id),false);
  assert.equal(f.store.get('SELECT channel_id FROM panels WHERE guild_id=?',GUILD).channel_id,c.second.id);
});

test('전송 결과가 불명인 안내는 기존 메시지 검색 전 무조건 재게시하지 않는다',async t=>{
  const f=setup(t),c=panelClient(),publisher=new PanelPublisher(c.client,f.store);
  f.store.run("INSERT INTO panels(guild_id,channel_id,state,updated_at) VALUES (?,?,'UNKNOWN',?)",GUILD,c.first.id,Date.now());
  await assert.rejects(publisher.ensure(c.guild,c.first.id),/PANEL_SEND_RESULT_UNKNOWN/);assert.equal(c.sent.length,0);
});

test('이벤트 생성·자리별 상품 등록·인증 설정·승인 요청까지 명령어 없이 진행한다',async t=>{
  const f=setup(t),open=request(HOST,'flow:custom:new');await f.handle(open);assert.equal(open.modal.toJSON().custom_id,'form:create');
  const create=request(HOST,'form:create',{title:'버튼 이벤트',description:'이벤트 설명',duration:'60',claim:'30',winners:'2'},'modal');
  await f.handle(create);
  const event=f.store.get('SELECT * FROM events WHERE owner_id=?',HOST.userId);assert.equal(event.status,'DRAFT');assert.ok(create.replies[0].components.length);
  const early=request(HOST,`ui:submit:${event.id}`);await f.handle(early);assert.match(early.replies[0].content,/모두 등록/);
  for(const slot of [1,2]){
    const add=request(HOST,`form:prize:${event.id}`,{slot:String(slot),text:`SECRET-PRIZE-${slot}`},'modal',true);await f.handle(add);
    assert.equal(add.updated,true);assert.equal(JSON.stringify(add.replies).includes('SECRET-PRIZE'),false);
  }
  const proof=request(HOST,`form:proofsettings:${event.id}`,{instructions:'텍스트 또는 사진 인증'},'modal');await f.handle(proof);
  assert.equal(f.store.event(event.id).proof_required,1);
  const submit=request(HOST,`ui:submit:${event.id}`);await f.handle(submit);
  assert.equal(f.store.event(event.id).status,'PENDING');assert.equal(JSON.stringify(submit.replies).includes('SECRET-PRIZE'),false);
});

test('상품 등록 입력창은 다음 빈 자리를 기본값으로 제시하고 타인의 원문 편집을 차단한다',async t=>{
  const f=setup(t),eid=await f.event({winners:2,start:false});
  f.store.run('UPDATE prizes SET secret=NULL WHERE event_id=? AND slot=2',eid);
  const allowed=request(HOST,`ui:prizeform:${eid}`);await f.handle(allowed);
  assert.equal(allowed.modal.toJSON().components[0].component.value,'2');
  const denied=request(MANAGER,`ui:prizeform:${eid}`);await f.handle(denied);assert.equal(denied.modal,undefined);assert.match(denied.replies[0].content,/본인의/);
});

test('인증 수령 버튼은 입력창을 열고 타이머를 한 번만 시작하며 제출 후 비공개 검수로 전환한다',async t=>{
  const f=setup(t),user=actor(4),eid=await f.event({proof:true,participants:[user]});f.advance(60001);await f.engine.tick();
  const [claim]=f.claims(eid),open=request(user,`claim:${claim.id}`);await f.handle(open);
  assert.equal(open.modal.toJSON().custom_id,`form:proof:${claim.id}:0`);
  const deadline=f.store.claim(claim.id).submit_deadline;f.advance(10000);
  const again=request(user,`claim:${claim.id}`);await f.handle(again);assert.equal(f.store.claim(claim.id).submit_deadline,deadline);
  const submit=request(user,`form:proof:${claim.id}`,{text:'PRIVATE-PROOF'},'modal');await f.handle(submit);
  assert.equal(f.store.claim(claim.id).status,'REVIEW');assert.equal(JSON.stringify(submit.replies).includes('PRIVATE-PROOF'),false);
  const approve=request(HOST,`papprove:${claim.id}:1`,{},'button',true);await f.handle(approve);
  assert.equal(approve.updated,true);assert.deepEqual(approve.replies[0].attachments,[]);assert.equal(f.store.claim(claim.id).status,'DELIVERED');assert.equal(f.store.claim(claim.id).proof,null);
});

test('내 신청과 내 당첨 선택 메뉴에서 타인의 비공개 정보를 조회할 수 없다',async t=>{
  const f=setup(t),user=actor(4);f.add(user);const eid=await f.event({start:false});
  const denied=request(user,'pick:event',{values:[eid]},'select');await f.handle(denied);assert.match(denied.replies[0].content,/조회할 수 없/);
  const list=request(user,'ui:mine:0');await f.handle(list);assert.match(list.replies[0].content,/없어요/);
});

test('조건 후보 목록 관리와 소유자의 관리 역할 부여 권한을 구분한다',async t=>{
  const f=setup(t),eid=await f.event({start:false});
  const noPermission=request(HOST,`ui:condition:${eid}:allow_roles`,{values:[ALLOW_ROLE]},'select');await f.handle(noPermission);assert.match(noPermission.replies[0].content,/등록하지 않은/);
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE,DENY_ROLE]);
  const allowed=request(MANAGER,`ui:condition:${eid}:deny_roles`,{values:[DENY_ROLE]},'select');await f.handle(allowed);assert.deepEqual(JSON.parse(f.store.event(eid).deny_roles),[DENY_ROLE]);
  const grant=request(MANAGER,'ui:roleset:manager_roles',{values:[ALLOW_ROLE]},'select');await f.handle(grant);assert.match(grant.replies[0].content,/소유자만/);
  const owner=request(OWNER,'ui:roleset:manager_roles',{values:[ALLOW_ROLE]},'select');await f.handle(owner);assert.deepEqual(JSON.parse(f.store.guild(GUILD).manager_roles),[ALLOW_ROLE]);
});

test('참여 가능·차단 선택 메뉴 모두 등록된 두 역할만 표시하며 일반 신청자가 선택할 수 있다',async t=>{
  const f=setup(t),eid=await f.event({start:false});
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE,DENY_ROLE]);
  f.transport.roles=async(gid,ids)=>ids.map((id,index)=>({id,name:index?'지하 2층 입장권':'지하 1층 입장권'}));
  const view=request(HOST,`ui:conditions:${eid}`);await f.handle(view);
  const menus=view.replies[0].components.slice(0,2).map(component=>component.toJSON().components[0]);
  for(const menu of menus){assert.equal(menu.type,3);assert.deepEqual(menu.options.map(option=>option.value),[ALLOW_ROLE,DENY_ROLE]);assert.deepEqual(menu.options.map(option=>option.label),['지하 1층 입장권','지하 2층 입장권']);}
  const select=request(HOST,`ui:condition:${eid}:allow_roles`,{values:[ALLOW_ROLE]},'select');await f.handle(select);
  assert.deepEqual(JSON.parse(f.store.event(eid).allow_roles),[ALLOW_ROLE]);
  const block=request(HOST,`ui:condition:${eid}:deny_roles`,{values:[DENY_ROLE]},'select');await f.handle(block);
  assert.deepEqual(JSON.parse(f.store.event(eid).deny_roles),[DENY_ROLE]);
});

test('오래된 전체 역할 메뉴나 위조한 선택 값으로 미등록 역할을 저장할 수 없다',async t=>{
  const f=setup(t),eid=await f.event({start:false});
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE]);
  for(const type of ['allow_roles','deny_roles']){
    const stale=request(HOST,`ui:condition:${eid}:${type}`,{values:[DENY_ROLE]},'select');await f.handle(stale);
    assert.match(stale.replies[0].content,/등록하지 않은/);assert.deepEqual(JSON.parse(f.store.event(eid)[type]),[]);
  }
  assert.throws(()=>f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[ALLOW_ROLE,DENY_ROLE]),/등록하지 않은/);
});

test('후보가 없거나 등록한 역할이 서버에서 삭제되어도 전체 역할로 대체하지 않는다',async t=>{
  const f=setup(t),eid=await f.event({start:false});
  const empty=request(HOST,`ui:conditions:${eid}`);await f.handle(empty);assert.match(empty.replies[0].content,/등록된 역할 후보가 없/);
  assert.ok(empty.replies[0].components.every(component=>component.toJSON().components.every(c=>c.type!==3&&c.type!==6)));
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE]);f.transport.roles=async()=>[];
  const deleted=request(HOST,`ui:conditions:${eid}`);await f.handle(deleted);assert.match(deleted.replies[0].content,/등록된 역할 후보가 없/);
});

test('후보 목록에서 뺀 역할을 가진 초안·승인 대기는 재선택이 필요하고 조건 해제로 복구한다',async t=>{
  const f=setup(t),eid=await f.event({start:false});
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE]);f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[ALLOW_ROLE]);
  f.engine.configure(GUILD,MANAGER,'condition_roles',[]);assert.throws(()=>f.engine.submit(GUILD,HOST,eid),/등록하지 않은/);
  const clear=request(HOST,`ui:conditionclear:${eid}`);await f.handle(clear);assert.deepEqual(JSON.parse(f.store.event(eid).allow_roles),[]);
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE]);f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[ALLOW_ROLE]);f.engine.submit(GUILD,HOST,eid);
  f.engine.configure(GUILD,MANAGER,'condition_roles',[]);assert.throws(()=>f.engine.approveEvent(GUILD,MANAGER,eid),/등록하지 않은/);
  assert.equal(f.store.event(eid).status,'PENDING');
});

test('조건 후보 역할 보유자는 후보 목록 관리 권한을 얻지 않으며 타인 초안도 수정할 수 없다',async t=>{
  const f=setup(t),eid=await f.event({start:false}),user=actor(8,[ALLOW_ROLE]);f.add(user);
  f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE]);
  assert.throws(()=>f.engine.configure(GUILD,user,'condition_roles',[DENY_ROLE]),/관리자만/);
  assert.throws(()=>f.engine.replaceConditions(GUILD,user,eid,'allow_roles',[ALLOW_ROLE]),/다른 사람/);
});
