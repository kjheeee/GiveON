import { EmbedBuilder,ButtonStyle,StringSelectMenuBuilder } from 'discord.js';
import { UserError } from './engine.js';
import { btn,row,back,payload,listView,conditionMenu } from './ui.js';
import { timeLimitsText,eventTimesText } from './time-limits.js';

const roles=value=>JSON.parse(value||'[]');
const mention=value=>roles(value).map(id=>`<@&${id}>`).join(', ')||'없음';
const fail=message=>{throw new UserError(message);};

export class DraftFlow {
  constructor(engine,transport){Object.assign(this,{engine,transport,store:engine.store});}
  draft(gid,a,eid){const e=this.engine.event(eid,gid);if(e.owner_id!==a.userId||e.status!=='DRAFT')fail('본인의 신청 전 초안만 진행할 수 있어요.');return e;}
  save(eid,step,slot=1){this.store.run('INSERT INTO draft_steps(event_id,step,slot) VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET step=excluded.step,slot=excluded.slot',eid,step,slot);}
  choose(gid,a,eid='new',page=0){
    if(eid!=='new')this.draft(gid,a,eid);
    const templates=this.store.all('SELECT * FROM event_templates WHERE guild_id=? AND enabled=1 ORDER BY name,id LIMIT 21 OFFSET ?',gid,page*20);
    const components=[];
    if(templates.length)components.push(row(new StringSelectMenuBuilder().setCustomId(`flow:template:${eid}`).setPlaceholder('안내 템플릿 선택').addOptions(templates.slice(0,20).map(t=>({label:t.name,value:t.id,description:`참여 ${roles(t.allow_roles).length}개 · 차단 ${roles(t.deny_roles).length}개 · 인증 ${t.proof_required?'필요':'없음'}`})))));
    const buttons=[btn(`flow:custom:${eid}`,'직접 설정',ButtonStyle.Secondary)];
    if(page>0)buttons.push(btn(`flow:choose:${eid}:${page-1}`,'이전',ButtonStyle.Secondary));
    if(templates.length>20)buttons.push(btn(`flow:choose:${eid}:${page+1}`,'다음',ButtonStyle.Secondary));
    buttons.push(btn('ui:home','닫기',ButtonStyle.Secondary));components.push(row(...buttons));
    return payload(`**어떤 안내로 신청할까요?**\n${templates.length?'템플릿을 고르면 안내 문구·참여 역할·차단 역할·인증이 한 번에 적용됩니다. 이벤트명·시간·인원은 직접 입력합니다.':'등록된 사전 템플릿이 없어요. 직접 설정으로 신청할 수 있습니다. 관리자는 템플릿 메뉴에서 미리 등록할 수 있어요.'}\n서버 시간 범위: ${timeLimitsText(this.engine.timeLimits(gid))}`,components);
  }
  async conditions(gid,a,eid){
    const e=this.engine.event(eid,gid);if(e.status!=='DRAFT'||(e.owner_id!==a.userId&&!this.engine.manager(gid,a)))fail('참여 조건을 설정할 권한이 없어요.');
    if(this.store.get('SELECT template_id FROM draft_steps WHERE event_id=?',eid)?.template_id)return this.view(gid,a,eid,'review');
    const options=await this.transport.roles(gid,roles(this.store.guild(gid).condition_roles));
    const allowed=roles(e.allow_roles),denied=roles(e.deny_roles),blocked=roles(this.store.guild(gid).blocked_roles);
    const allowOptions=options.filter(r=>!denied.includes(r.id)&&!blocked.includes(r.id)),denyOptions=options.filter(r=>!allowed.includes(r.id));
    const components=[];
    if(allowOptions.length)components.push(conditionMenu(`ui:condition:${eid}:allow_roles`,'참여 가능 역할',allowOptions,allowed));
    if(denyOptions.length)components.push(conditionMenu(`ui:condition:${eid}:deny_roles`,'참여 차단 역할',denyOptions,denied));
    if(e.owner_id===a.userId){this.save(eid,'conditions');components.push(row(btn(`flow:step:${eid}:verification`,'다음 · 인증 설정',ButtonStyle.Success),btn(`flow:details:${eid}`,'기본 정보 수정',ButtonStyle.Secondary),btn(`ui:conditionclear:${eid}`,'조건 해제',ButtonStyle.Secondary)));}
    else components.push(row(btn(`ui:conditionclear:${eid}`,'조건 해제',ButtonStyle.Secondary),btn(`ui:event:${eid}`,'돌아가기',ButtonStyle.Secondary)));
    const stale=[...allowed,...denied].some(id=>!options.some(r=>r.id===id));
    return payload(`**2/5 · 참여 조건**\n${options.length?'필요한 역할을 선택하거나 제한 없이 다음으로 진행하세요. 한쪽에서 선택한 역할은 반대쪽 후보에서 제외됩니다.':'등록된 역할 후보가 없어 역할 제한 없이 진행합니다. 관리자는 설정에서 후보를 등록할 수 있어요.'}${stale?'\n등록 목록에서 빠진 기존 조건이 있어요. 다시 선택하거나 조건을 해제해주세요.':''}`,components);
  }
  async view(gid,a,eid,requestedStep=null,requestedSlot=null){
    const e=this.draft(gid,a,eid),saved=this.store.get('SELECT * FROM draft_steps WHERE event_id=?',eid);
    const remaining=this.store.get('SELECT slot FROM prizes WHERE event_id=? AND (secret IS NULL OR name IS NULL) ORDER BY slot LIMIT 1',eid)?.slot;
    const step=requestedStep||saved?.step||(remaining?'conditions':'review');
    if(!['conditions','verification','items','review'].includes(step))fail('진행 단계를 확인해주세요.');
    if(step==='conditions')return this.conditions(gid,a,eid);
    if(step==='verification'&&saved?.template_id)return this.view(gid,a,eid,'items');
    const slot=requestedSlot||remaining||saved?.slot||1;
    if(!Number.isInteger(slot)||slot<1||slot>e.winner_count)fail('상품 번호가 잘못되었어요.');
    this.save(eid,step,slot);
    if(step==='verification')return payload(`**3/5 · 인증이 필요한가요?**\n${e.proof_required?e.proof_instructions:'수령 전 확인할 자료가 있으면 인증 필요를 선택하세요.'}`, [row(btn(`flow:noproof:${eid}`,'인증 없이 진행',ButtonStyle.Success),btn(`ui:proofsettings:${eid}`,'인증 필요')),row(btn(`flow:step:${eid}:conditions`,'이전',ButtonStyle.Secondary))]);
    if(step==='items'){
      const product=this.engine.product(e,slot,true),direct=product.direct,count=this.store.get('SELECT count(*) n FROM prizes WHERE event_id=? AND secret IS NOT NULL AND name IS NOT NULL',eid).n;
      const registered=Boolean(this.store.get('SELECT secret IS NOT NULL filled FROM prizes WHERE event_id=? AND slot=?',eid,slot)?.filled);
      const delivery=row(btn(`flow:mode:${eid}:${slot}:digital`,'이 상품 · 디지털',direct?ButtonStyle.Secondary:ButtonStyle.Success),btn(`flow:mode:${eid}:${slot}:direct`,'이 상품 · 실물·직접 전달',direct?ButtonStyle.Success:ButtonStyle.Secondary));
      const nav=[];if(slot>1)nav.push(btn(`flow:step:${eid}:items:${slot-1}`,'이전 상품',ButtonStyle.Secondary));
      if(registered&&slot<e.winner_count)nav.push(btn(`flow:step:${eid}:items:${slot+1}`,'다음 상품'));
      if(count===e.winner_count)nav.push(btn(`flow:step:${eid}:review`,'최종 확인',ButtonStyle.Success));
      const text=`**4/5 · 상품 등록 (${count}/${e.winner_count})**\n**${slot}번 상품: ${product.name}**\n상품명: ${product.publicName?'공개':'비공개 (당첨자에게는 표시)'} · ${direct?'실물·직접 전달':'디지털 자동 전달'}\n${!product.named?'먼저 상품명을 입력하고 공개 여부를 선택해주세요.':direct?'주최자 연락 안내를 준비했습니다. 이름·주소·연락처는 주최자와 개인 DM으로 주고받아주세요.':registered?'이미 전달 내용을 등록한 상품입니다. 수정하면 이 상품의 내용만 교체합니다.':'실물로 선택하거나 디지털 상품 메시지·이미지를 입력하세요.'}\n상품 전달 원문은 관리자에게 표시되지 않습니다.`;
      return payload(text,[row(btn(`flow:product:${eid}:${slot}`,product.named?'상품명·공개 설정 수정':'상품명·공개 설정 입력',ButtonStyle.Primary)),delivery,...(!direct?[row(btn(`flow:prize:${eid}:${slot}`,`${slot}번 디지털 상품 ${registered?'수정':'입력'}`,ButtonStyle.Success))]:[]),...(nav.length?[row(...nav)]:[]),row(btn(saved?.template_id?`flow:choose:${eid}:0`:`flow:step:${eid}:verification`,'이전 단계',ButtonStyle.Secondary),btn('ui:home','나중에 이어하기',ButtonStyle.Secondary))]);
    }
    const template=saved?.template_id?this.engine.template(saved.template_id,gid):null;
    const embed=new EmbedBuilder().setTitle(e.title).setDescription(e.description).setColor(0x18e979).addFields(
      {name:'진행 시간 / 수령 시간',value:eventTimesText(e),inline:true},{name:'당첨 인원',value:`${e.winner_count}명`,inline:true},
      {name:'참여 가능 역할',value:mention(e.allow_roles)},{name:'참여 차단 역할',value:mention(e.deny_roles)},
      {name:'인증',value:e.proof_required?e.proof_instructions:'없음'},
      {name:'전달 방식',value:this.engine.deliverySummary(eid).label},{name:'상품 번호 · 실물 / 디지털',value:`${this.engine.deliverySummary(eid).directSlots.join(', ')||'없음'} / ${this.engine.deliverySummary(eid).digitalSlots.join(', ')||'없음'}`},
    );
    if(template)embed.addFields({name:'적용 템플릿',value:template.name});
    return payload(`**5/5 · 최종 확인**\n내용을 확인하고 승인 요청을 누르세요. 상품 전달 원문은 이 화면에 표시하지 않습니다.\n서버 시간 범위: ${timeLimitsText(this.engine.timeLimits(gid))}\n범위가 변경된 경우 기본 정보 수정에서 시간을 다시 입력해주세요.`,[
      row(btn(`ui:submit:${eid}`,'승인 요청',ButtonStyle.Success),btn(`flow:details:${eid}`,'기본 정보 수정',ButtonStyle.Secondary),btn(`flow:step:${eid}:items:1`,'상품 수정',ButtonStyle.Secondary)),
      row(btn(`flow:choose:${eid}:0`,'템플릿 변경',ButtonStyle.Secondary),...(!template?[btn(`flow:step:${eid}:conditions`,'조건·인증 수정',ButtonStyle.Secondary)]:[]),btn(`ui:products:${eid}:0`,'상품명 목록 확인',ButtonStyle.Secondary),btn(`ui:cancel:${eid}`,'신청 취소',ButtonStyle.Danger)),
    ],[embed]);
  }
  templateList(gid,a,page=0){
    this.engine.requireManager(gid,a);
    const records=this.store.all('SELECT id,name title,enabled FROM event_templates WHERE guild_id=? ORDER BY name,id LIMIT 21 OFFSET ?',gid,page*20);
    const view=listView('안내 템플릿',records,page,'tpl:list','tpl:edit',t=>t.enabled?'사용 중':'준비·중지');
    view.components.unshift(row(btn('tpl:new','새 템플릿',ButtonStyle.Success),btn('ui:admin','관리자로',ButtonStyle.Secondary)));return view;
  }
  async templateView(gid,a,tid){
    this.engine.requireManager(gid,a);const t=this.engine.template(tid,gid);
    const options=await this.transport.roles(gid,roles(this.store.guild(gid).condition_roles));
    const allowed=roles(t.allow_roles),denied=roles(t.deny_roles),blocked=roles(this.store.guild(gid).blocked_roles);
    const permitted=options.filter(r=>!denied.includes(r.id)&&!blocked.includes(r.id)),forbidden=options.filter(r=>!allowed.includes(r.id));
    const components=[];
    if(permitted.length)components.push(conditionMenu(`tpl:roles:${tid}:allow_roles`,'참여 가능 역할',permitted,allowed));
    if(forbidden.length)components.push(conditionMenu(`tpl:roles:${tid}:deny_roles`,'참여 차단 역할',forbidden,denied));
    components.push(row(btn(`tpl:meta:${tid}`,'문구·이름 수정'),btn(`tpl:proof:${tid}`,'인증 설정'),btn(`tpl:toggle:${tid}`,t.enabled?'사용 중지':'사용 시작',t.enabled?ButtonStyle.Secondary:ButtonStyle.Success)));
    components.push(row(btn(`tpl:clear:${tid}`,'역할 조건 해제',ButtonStyle.Secondary),btn('tpl:list:0','목록으로',ButtonStyle.Secondary)));
    const embed=new EmbedBuilder().setTitle(t.name).setDescription(t.description).setColor(0x5865f2).addFields({name:'참여 가능',value:mention(t.allow_roles)},{name:'참여 차단',value:mention(t.deny_roles)},{name:'인증',value:t.proof_required?t.proof_instructions:'없음'});
    return payload(`**템플릿 ${t.enabled?'사용 중':'준비·중지'}**\n문구·역할·인증만 저장합니다. 시간·인원·상품 전달 내용은 저장하지 않습니다.`,components,[embed]);
  }
}
