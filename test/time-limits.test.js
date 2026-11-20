import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,content,interaction,GUILD,OTHER_GUILD,HOST,MANAGER,OWNER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DEFAULT_TIME_LIMITS } from '../src/time-limits.js';

const custom={duration_min:10,duration_max:120,claim_min:5,claim_max:30};
const options={title:'시간 검사',description:'이벤트 설명',durationMinutes:60,claimMinutes:15,winners:1};
const fields=values=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,String(v)]));
function ready(f){f.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,?,'READY',?)",GUILD,'panel-channel','panel',f.now());}
function prepared(f,overrides={}){const eid=f.engine.create(GUILD,HOST,{...options,...overrides});f.engine.setProductInfo(GUILD,HOST,eid,1,'상품명',true);f.engine.setPrize(GUILD,HOST,eid,1,content('SECRET-TIME-PRODUCT'));return eid;}
const textFields=modal=>Object.fromEntries(modal.toJSON().components.filter(c=>c.type===18).map(c=>[c.component.custom_id,{label:c.label,value:c.component.value}]));

test('기본 시간 범위는 기존과 같고 관리자의 서버별 설정은 다른 서버·역할 설정과 분리된다',t=>{
  const f=fixture(t),guild=f.store.guild(GUILD);assert.deepEqual(f.engine.timeLimits(GUILD),DEFAULT_TIME_LIMITS);
  f.engine.setTimeLimits(GUILD,MANAGER,custom);assert.deepEqual(f.engine.timeLimits(GUILD),custom);assert.deepEqual(f.engine.timeLimits(OTHER_GUILD),DEFAULT_TIME_LIMITS);assert.deepEqual(f.store.guild(GUILD),guild);
  const saved=f.store.get('SELECT * FROM guild_time_limits WHERE guild_id=?',GUILD);assert.equal(saved.updated_by,MANAGER.userId);assert.equal(saved.updated_at,f.now());
  f.engine.setTimeLimits(GUILD,OWNER,{duration_min:20,duration_max:20,claim_min:7,claim_max:7});f.engine.validateTimes(GUILD,20,7);
});

test('정수가 아닌 값·시스템 상한·최소 최대 역전은 네 범위를 전부 보존하며 거부한다',t=>{
  const f=fixture(t);f.engine.setTimeLimits(GUILD,MANAGER,custom);
  const before=f.store.get('SELECT * FROM guild_time_limits WHERE guild_id=?',GUILD);
  for(const changes of [{duration_min:0},{duration_max:43201},{claim_min:0},{claim_max:10081},{duration_min:121},{claim_min:31},{duration_min:NaN},{claim_max:1.5},{claim_min:'5'},{claim_max:Infinity},{unexpected:1}]) {
    assert.throws(()=>f.engine.setTimeLimits(GUILD,MANAGER,{...custom,...changes}));assert.deepEqual(f.store.get('SELECT * FROM guild_time_limits WHERE guild_id=?',GUILD),before);
  }
  assert.throws(()=>f.engine.setTimeLimits(GUILD,HOST,custom),/관리자만/);assert.deepEqual(f.store.get('SELECT * FROM guild_time_limits WHERE guild_id=?',GUILD),before);
});

test('직접·템플릿 생성과 초안 수정은 경계값을 허용하고 범위 밖 시간은 상품과 초안을 보존하며 거부한다',t=>{
  const f=fixture(t);f.engine.setTimeLimits(GUILD,MANAGER,custom);
  const tid=f.engine.createTemplate(GUILD,MANAGER,'사전 안내','안내 문구');f.engine.updateTemplate(GUILD,MANAGER,tid,{enabled:true});
  for(const templateId of [undefined,tid]) {
    for(const times of [{durationMinutes:10,claimMinutes:5},{durationMinutes:120,claimMinutes:30}])prepared(f,{...times,templateId});
    for(const times of [{durationMinutes:9},{durationMinutes:121},{claimMinutes:4},{claimMinutes:31},{durationMinutes:10.5}])assert.throws(()=>f.engine.create(GUILD,HOST,{...options,...times,templateId}),/시간/);
    const eid=prepared(f,{templateId}),before=f.store.event(eid),secret=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret);
    assert.throws(()=>f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,durationMinutes:5}),/10~120/);assert.deepEqual(f.store.event(eid),before);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret),secret);
    f.engine.updateDraftDetails(GUILD,HOST,eid,{...options,durationMinutes:10,claimMinutes:5});assert.equal(f.store.event(eid).claim_ms,300000);
  }
});

test('입력창을 연 뒤 설정이 바뀌면 제출·승인에서 최신 범위를 확인하고 진행 중인 이벤트는 유지한다',async t=>{
  const f=fixture(t),running=await f.event(),draft=prepared(f),pending=prepared(f);f.engine.submit(GUILD,HOST,pending);const active=f.store.event(running);
  f.engine.setTimeLimits(GUILD,MANAGER,{duration_min:100,duration_max:200,claim_min:20,claim_max:40});
  assert.throws(()=>f.engine.submit(GUILD,HOST,draft),/100~200/);assert.equal(f.store.event(draft).status,'DRAFT');
  assert.throws(()=>f.engine.approveEvent(GUILD,MANAGER,pending),/취소한 뒤 다시 신청/);assert.equal(f.store.event(pending).status,'PENDING');assert.equal(f.store.get("SELECT id FROM jobs WHERE kind='start' AND ref_id=?",pending),undefined);
  assert.deepEqual(f.store.event(running),active);assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=?',pending).secret);
  f.engine.setTimeLimits(GUILD,MANAGER,DEFAULT_TIME_LIMITS);f.engine.submit(GUILD,HOST,draft);f.engine.approveEvent(GUILD,MANAGER,pending);assert.equal(f.store.event(pending).status,'STARTING');
});

test('설정의 시간 범위 팝업은 READY 관리자만 열고 역할 해제·위조 제출을 막는다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport),notReady=interaction(MANAGER,'ui:timelimits');await handle(notReady);assert.match(notReady.replies[0].content,/gon init/);
  ready(f);const settings=interaction(MANAGER,'ui:channels');await handle(settings);assert.match(settings.replies[0].content,/1~43200/);assert.ok(settings.replies[0].components.some(r=>r.toJSON().components.some(c=>c.custom_id==='ui:timelimits')));
  const open=interaction(MANAGER,'ui:timelimits');await handle(open);assert.equal(open.deferred,false);assert.equal(open.modal.toJSON().custom_id,'form:timelimits');assert.equal(Object.keys(textFields(open.modal)).length,4);assert.ok(open.modal.toJSON().components.length<=5);
  const denied=interaction(HOST,'form:timelimits',fields(custom),'modal');await handle(denied);assert.match(denied.replies[0].content,/관리자만/);
  f.add({...MANAGER,roles:[]});const revoked=interaction(MANAGER,'form:timelimits',fields(custom),'modal');await handle(revoked);assert.match(revoked.replies[0].content,/관리자만/);assert.deepEqual(f.engine.timeLimits(GUILD),DEFAULT_TIME_LIMITS);
  f.add(MANAGER);const save=interaction(MANAGER,'form:timelimits',fields(custom),'modal');await handle(save);assert.match(save.replies[0].content,/시간 범위를 저장/);assert.match(save.replies[0].content,/10~120/);assert.deepEqual(f.engine.timeLimits(GUILD),custom);
  const bad=interaction(MANAGER,'form:timelimits',{...fields(custom),claim_min:'31'},'modal');await handle(bad);assert.match(bad.replies[0].content,/최소/);assert.deepEqual(f.engine.timeLimits(GUILD),custom);
});

test('직접·템플릿 신청 팝업은 최신 범위를 안내하고 새 기본값은 허용 범위 안으로 맞춘다',async t=>{
  const f=fixture(t),handle=handler(f.engine,f.transport);f.engine.setTimeLimits(GUILD,MANAGER,{duration_min:120,duration_max:200,claim_min:2,claim_max:10});
  const choose=interaction(HOST,'ui:create');await handle(choose);assert.match(choose.replies[0].content,/진행 120~200분/);
  const tid=f.engine.createTemplate(GUILD,MANAGER,'사전 안내','문구');f.engine.updateTemplate(GUILD,MANAGER,tid,{enabled:true});
  for(const open of [interaction(HOST,'flow:custom:new'),interaction(HOST,'flow:template:new',{values:[tid]},'select')]) {
    await handle(open);const form=textFields(open.modal);assert.equal(form.duration.value,'120');assert.equal(form.claim.value,'10');assert.match(form.duration.label,/120~200/);assert.match(form.claim.label,/2~10/);
  }
  const forged=interaction(HOST,'form:templatecreate:'+tid,{title:'위조',duration:'60',claim:'10',winners:'1'},'modal');await handle(forged);assert.match(forged.replies[0].content,/120~200/);assert.equal(f.store.get('SELECT count(*) n FROM events').n,0);
});
