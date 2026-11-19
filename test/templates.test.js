import test from 'node:test';
import assert from 'node:assert/strict';
import {EmbedBuilder,MessageFlags} from 'discord.js';
import {fixture,actor,content,GUILD,OTHER_GUILD,HOST,MANAGER,ALLOW_ROLE,DENY_ROLE} from './helpers.js';
import {handler} from '../src/interactions.js';
import {DraftFlow} from '../src/drafts.js';
import {templateCreateModal} from '../src/ui.js';
import {entryPanel} from '../src/panel.js';

function setup(t){
  const f=fixture(t);f.engine.configure(GUILD,MANAGER,'condition_roles',[ALLOW_ROLE,DENY_ROLE]);
  f.transport.eventEmbed=e=>new EmbedBuilder().setTitle(e.title).setDescription(e.description);
  return {...f,handle:handler(f.engine,f.transport),flow:new DraftFlow(f.engine,f.transport)};
}
function request(user,id,fields={},type='button'){
  return{customId:id,guildId:GUILD,user:{id:user.userId,bot:false},replies:[],
    inGuild:()=>true,isChatInputCommand:()=>false,isButton:()=>type==='button',isModalSubmit:()=>type==='modal',isAnySelectMenu:()=>type==='select',values:fields.values||[],
    fields:{getTextInputValue:key=>fields[key]||'',getUploadedFiles:()=>null},
    async deferReply(options){this.deferred=true;this.deferOptions=options;},async editReply(value){this.replies.push(value);},async reply(value){this.replied=true;this.replies.push(value);},async showModal(value){this.modal=value;this.replied=true;}};
}
function template(f){
  const tid=f.engine.createTemplate(GUILD,MANAGER,'30렙','30레벨 이상 참여 가능합니다. 역할 갱신은 지정 채널에서 진행해주세요.');
  f.engine.updateTemplate(GUILD,MANAGER,tid,{allow_roles:[ALLOW_ROLE],deny_roles:[DENY_ROLE],proof_instructions:'인증 메시지 또는 사진을 제출해주세요.',enabled:true});return tid;
}
const options={title:'상품',durationMinutes:45,claimMinutes:12,winners:2};

test('같은 역할의 참여·차단 중복과 공통 차단 역할의 참여 허용을 저장 단계에서 막는다',async t=>{
  const f=setup(t),eid=await f.event({start:false});f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[ALLOW_ROLE]);
  assert.throws(()=>f.engine.replaceConditions(GUILD,HOST,eid,'deny_roles',[ALLOW_ROLE]),/동시에/);
  assert.throws(()=>f.engine.setCondition(GUILD,HOST,eid,'deny_roles',ALLOW_ROLE),/동시에/);
  f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[]);f.engine.replaceConditions(GUILD,HOST,eid,'deny_roles',[DENY_ROLE]);
  assert.throws(()=>f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[DENY_ROLE]),/동시에/);
  f.engine.configure(GUILD,MANAGER,'blocked_roles',[ALLOW_ROLE]);
  assert.throws(()=>f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[ALLOW_ROLE]),/공통 참여 금지/);
});

test('템플릿은 문구·역할·인증만 보관하며 시간·인원·상품 원문은 받지 않는다',t=>{
  const f=setup(t),tid=template(f),value=f.engine.template(tid,GUILD);
  assert.deepEqual(JSON.parse(value.allow_roles),[ALLOW_ROLE]);assert.equal(value.proof_required,1);
  const columns=f.store.columns('event_templates');
  for(const forbidden of ['duration_ms','claim_ms','winner_count','secret','proof'])assert.equal(columns.includes(forbidden),false);
  assert.throws(()=>f.engine.updateTemplate(GUILD,MANAGER,tid,{duration_ms:5000}),/지원하지 않는/);
  assert.throws(()=>f.engine.createTemplate(GUILD,HOST,'다른','문구'),/관리자만/);
});

test('템플릿 신청은 문구·역할·인증을 함께 적용하고 시간·인원은 신청자의 입력을 사용한다',t=>{
  const f=setup(t),tid=template(f),eid=f.engine.create(GUILD,HOST,{...options,templateId:tid,description:'바꿔치기',proofRequired:false});
  const e=f.store.event(eid);assert.equal(e.duration_ms,45*60000);assert.equal(e.claim_ms,12*60000);assert.equal(e.winner_count,2);
  assert.equal(e.description,f.engine.template(tid,GUILD).description);assert.equal(e.proof_required,1);assert.deepEqual(JSON.parse(e.allow_roles),[ALLOW_ROLE]);
  assert.throws(()=>f.engine.replaceConditions(GUILD,HOST,eid,'allow_roles',[]),/템플릿/);
  assert.throws(()=>f.engine.setProofRequirement(GUILD,HOST,eid,''),/템플릿/);
  f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,title:'이름 수정',description:'변경 시도',durationMinutes:90});
  assert.equal(f.store.event(eid).duration_ms,90*60000);assert.equal(f.store.event(eid).description,e.description);
});

test('미등록·겹치는 역할의 템플릿을 막고 중지·타 서버 템플릿은 신청할 수 없다',t=>{
  const f=setup(t),tid=template(f);
  assert.throws(()=>f.engine.updateTemplate(GUILD,MANAGER,tid,{deny_roles:[ALLOW_ROLE]}),/동시에/);
  assert.throws(()=>f.engine.create(OTHER_GUILD,HOST,{...options,templateId:tid}),/이 서버의 템플릿/);
  f.engine.updateTemplate(GUILD,MANAGER,tid,{enabled:false});assert.throws(()=>f.engine.create(GUILD,HOST,{...options,templateId:tid}),/사용 중/);
});

test('템플릿 변경은 재확인하게 하며 다시 선택해도 입력 시간과 등록 상품은 보존한다',t=>{
  const f=setup(t),tid=template(f),eid=f.engine.create(GUILD,HOST,{...options,templateId:tid});
  for(const slot of [1,2])f.engine.setPrize(GUILD,HOST,eid,slot,content('PRIVATE-'+slot));
  const secret=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret);
  f.engine.updateTemplate(GUILD,MANAGER,tid,{description:'변경된 공개 문구'});assert.throws(()=>f.engine.submit(GUILD,HOST,eid),/변경/);
  f.engine.applyTemplate(GUILD,HOST,eid,tid);const e=f.store.event(eid);
  assert.equal(e.duration_ms,45*60000);assert.equal(e.claim_ms,12*60000);assert.equal(e.winner_count,2);assert.equal(e.description,'변경된 공개 문구');
  assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret),secret);
  f.engine.submit(GUILD,HOST,eid);assert.equal(f.store.event(eid).status,'PENDING');
});

test('직접 신청은 조건→인증→상품1→상품2→최종확인으로 이어지고 중간 상태를 복구한다',async t=>{
  const f=setup(t),create=request(HOST,'form:create',{title:'순차 신청',description:'설명',duration:'60',claim:'30',winners:'2'},'modal');await f.handle(create);
  const e=f.store.get('SELECT * FROM events WHERE owner_id=?',HOST.userId);assert.match(create.replies[0].content,/2\/5/);
  const next=request(HOST,`flow:step:${e.id}:verification`);await f.handle(next);assert.match(next.replies[0].content,/3\/5/);
  const noProof=request(HOST,`flow:noproof:${e.id}`);await f.handle(noProof);assert.match(noProof.replies[0].content,/4\/5/);
  const open=request(HOST,`flow:prize:${e.id}:1`);await f.handle(open);const form=open.modal.toJSON();assert.equal(form.custom_id,`form:prize:${e.id}:1`);assert.equal(form.components.some(c=>c.component?.custom_id==='slot'),false);
  const one=request(HOST,`form:prize:${e.id}:1`,{text:'SECRET-ONE'},'modal');await f.handle(one);assert.match(one.replies[0].content,/2번/);
  const resumed=await new DraftFlow(f.engine,f.transport).view(GUILD,HOST,e.id);assert.match(resumed.content,/2번/);
  const two=request(HOST,`form:prize:${e.id}:2`,{text:'SECRET-TWO'},'modal');await f.handle(two);assert.match(two.replies[0].content,/5\/5/);assert.equal(JSON.stringify(two.replies).includes('SECRET-'),false);
  const submit=request(HOST,`ui:submit:${e.id}`);await f.handle(submit);assert.equal(f.store.event(e.id).status,'PENDING');
});

test('템플릿 선택 화면은 사용 중인 목록만 노출하며 선택 후 시간 입력창을 연다',async t=>{
  const f=setup(t),tid=template(f);f.engine.createTemplate(GUILD,MANAGER,'비공개 준비','문구');
  const picker=request(HOST,'ui:create');await f.handle(picker);const serialized=JSON.stringify(picker.replies);
  assert.ok(serialized.includes('30렙'));assert.equal(serialized.includes('비공개 준비'),false);assert.equal(picker.modal,undefined);
  const choose=request(HOST,'flow:template:new',{values:[tid]},'select');await f.handle(choose);
  const modal=choose.modal.toJSON();assert.equal(modal.custom_id,`form:templatecreate:${tid}`);assert.equal(modal.components.length,5);
  const fields=modal.components.filter(c=>c.type===18).map(c=>c.component.custom_id);assert.deepEqual(fields,['title','duration','claim','winners']);
  const create=request(HOST,`form:templatecreate:${tid}`,{title:'템플릿 상품',duration:'123',claim:'15',winners:'1'},'modal');await f.handle(create);
  assert.match(create.replies[0].content,/4\/5/);assert.equal(f.store.get('SELECT duration_ms FROM events WHERE title=?','템플릿 상품').duration_ms,123*60000);
});

test('설정은 채널 두 개와 역할 종류·목록을 한 화면에서 고른다',async t=>{
  const f=setup(t),i=request(MANAGER,'ui:channels');await f.handle(i);
  const rows=i.replies[0].components.map(c=>c.toJSON());assert.equal(rows.length,5);
  assert.deepEqual(rows.slice(0,4).map(r=>r.components[0].type),[8,8,3,6]);
});

test('상품이 등록된 자리를 인원 축소로 지우지 않고 빈 자리만 안전하게 조정한다',async t=>{
  const f=setup(t),eid=await f.event({winners:2,start:false});
  assert.throws(()=>f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,winners:1,description:'설명'}),/등록된 상품/);
  f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,winners:3,description:'설명'});assert.equal(f.store.get('SELECT count(*) n FROM prizes WHERE event_id=?',eid).n,3);
  assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret);
});

test('임베드가 없는 안내를 제공하고 템플릿 관리에서도 반대쪽 역할은 후보에서 제외한다',async t=>{
  const f=setup(t),tid=template(f),panel=entryPanel(GUILD);assert.deepEqual(panel.embeds,[]);assert.ok(panel.content.startsWith('## GiveON'));
  const view=await f.flow.templateView(GUILD,MANAGER,tid),menus=view.components.slice(0,2).map(r=>r.toJSON().components[0]);
  assert.deepEqual(menus[0].options.map(o=>o.value),[ALLOW_ROLE]);assert.deepEqual(menus[1].options.map(o=>o.value),[DENY_ROLE]);
});
