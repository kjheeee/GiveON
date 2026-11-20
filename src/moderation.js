import { ButtonStyle,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle } from 'discord.js';
import { UserError } from './engine.js';
import { btn,row,back,payload,listView } from './ui.js';
import { statuses,time } from './discord-transport.js';
import { commandAction } from './commands.js';

const check=(ok,message)=>{if(!ok)throw new UserError(message);};
const userId=value=>{const match=/^(?:<@!?(\d{15,22})>|(\d{15,22}))$/.exec(value.trim());check(match,'사용자 ID 또는 @멘션을 입력해주세요.');return match[1]||match[2];};
export class ModerationFlow {
  constructor(engine,transport){Object.assign(this,{engine,transport,store:engine.store});}
  matches(i){return ['log','reqblock'].includes(commandAction(i))||(i.customId||'').startsWith('host:')||(i.customId||'').startsWith('form:hostblock:');}
  eventLink(event){const job=this.store.get("SELECT channel_id FROM jobs WHERE kind='start' AND ref_id=?",event.id);return event.public_message_id&&/^\d{15,22}$/.test(job?.channel_id||'')?`https://discord.com/channels/${event.guild_id}/${job.channel_id}/${event.public_message_id}`:null;}
  lookup(gid,a,query){
    const {event,claim,audit}=this.engine.lookup(gid,a,query),url=this.eventLink(event),components=[row(btn(`ui:event:${event.id}`,'이벤트 보기'))];
    let text=`**${event.title} · 기록 검색**\n이벤트: ${event.id}\n주최자: <@${event.owner_id}>\n이벤트 상태: ${statuses[event.status]}`;
    if(url)text+=`\n[원 이벤트](${url})`;
    if(claim){
      text+=`\n당첨 번호: ${claim.id}\n당첨자: <@${claim.user_id}>\n${claim.slot}번 상품: ${this.engine.product(event,claim.slot,true).name}\n처리 상태: ${claim.status==='DELIVERED'&&this.engine.direct(event.id,claim.slot)?'주최자 연락 안내 완료':statuses[claim.status]}`;
      if(claim.completed_at)text+=`\n전달 완료: ${time(claim.completed_at)}`;
      if(claim.user_id===a.userId&&claim.dm_channel_id&&claim.dm_message_id)text+=`\n[본인 수령 DM](https://discord.com/channels/@me/${claim.dm_channel_id}/${claim.dm_message_id})`;
      if(audit.length)text+='\n\n최근 처리 기록\n'+audit.map(x=>`${time(x.created_at)} · ${x.action}`).join('\n');
      if(event.owner_id===a.userId&&claim.status==='REVIEW')components.push(row(btn(`pview:${claim.id}`,'인증 검수')));
      if(this.engine.manager(gid,a))components.push(row(btn(`ui:eventclaims:${event.id}:0`,'당첨 관리')));
    }
    if(this.engine.manager(gid,a))components.push(row(btn(`host:view:${event.owner_id}`,'주최자 제한 관리',ButtonStyle.Secondary)));
    text+='\n\n상품·인증 원문은 검색 결과에 표시하지 않으며, 삭제한 내용은 복구할 수 없습니다.';
    components.push(back());return payload(text,components);
  }
  block(gid,a,id){this.engine.requireManager(gid,a);check(/^\d{15,22}$/.test(id||''),'대상 사용자를 확인해주세요.');return this.store.get('SELECT * FROM host_blocks WHERE guild_id=? AND user_id=?',gid,id);}
  view(gid,a,id){
    const block=this.block(gid,a,id),active=Boolean(block?.active);
    let text=`**주최 제한 관리**\n사용자: <@${id}> (${id})\n상태: **${active?'주최 제한 중':'제한 없음'}**`;
    if(block){text+=`\n${active?'사유':'최근 제한 사유'}: ${block.reason||'(기존 제한 · 사유 미등록)'}\n설정 관리자: <@${block.actor_id}>\n설정·수정 시각: ${time(block.created_at)}`;if(block.released_by)text+=`\n해제 관리자: <@${block.released_by}>\n해제 시각: ${time(block.released_at)}`;}
    text+='\n\n이 서버의 신규 생성·초안 제출·승인을 제한합니다. 진행 중인 이벤트는 별도로 취소해주세요.';
    const actions=[btn(`host:edit:${id}`,active?'사유 수정':'주최 제한',active?ButtonStyle.Primary:ButtonStyle.Danger)];
    if(active)actions.push(btn(`host:lift:${id}`,'제한 해제',ButtonStyle.Secondary));
    return payload(text,[row(...actions),row(btn('host:list:0','제한 목록',ButtonStyle.Secondary)),back()]);
  }
  modal(gid,a,id=null){
    this.engine.requireManager(gid,a);const block=id?this.block(gid,a,id):null;
    const input=(name,label,max,value,paragraph=false)=>{const text=new TextInputBuilder().setCustomId(name).setStyle(paragraph?TextInputStyle.Paragraph:TextInputStyle.Short).setMaxLength(max).setRequired(true);if(value)text.setValue(value);return new LabelBuilder().setLabel(label).setTextInputComponent(text);};
    return new ModalBuilder().setCustomId(`form:hostblock:${id||'new'}`).setTitle('사용자 주최 제한·사유 설정')
      .addLabelComponents(input('user','사용자 ID 또는 @멘션',30,id),input('reason','주최 제한 사유 (관리자에게만 표시)',500,block?.reason,true));
  }
  async handle(i,a){
    const gid=i.guildId,[kind,action,arg]=(i.customId||'').split(':');
    const command=commandAction(i);
    if(command==='log')return this.lookup(gid,a,i.options.getString('id',true));
    this.engine.requireManager(gid,a);
    if(command==='reqblock'){const id=i.options.getUser('user',true).id;this.engine.restrictHost(gid,a,id,true,i.options.getString('reason',true));return this.view(gid,a,id);}
    if(kind==='host'&&['new','edit'].includes(action))return i.showModal(this.modal(gid,a,action==='edit'?arg:null));
    if(kind==='form'&&action==='hostblock'){
      const id=userId(i.fields.getTextInputValue('user'));check(arg==='new'||arg===id,'선택한 사용자는 변경할 수 없어요. 새 제한 등록을 이용해주세요.');
      this.engine.restrictHost(gid,a,id,true,i.fields.getTextInputValue('reason'));return this.view(gid,a,id);
    }
    if(action==='list'){
      const page=Number(arg);check(Number.isSafeInteger(page)&&page>=0&&page<50000,'페이지를 확인해주세요.');
      const records=this.store.all('SELECT user_id id,user_id title,reason,active FROM host_blocks WHERE guild_id=? ORDER BY active DESC,created_at DESC,user_id LIMIT 21 OFFSET ?',gid,page*20);
      const view=listView('주최 제한 · 해제 기록',records,page,'host:list','host:pick',record=>`${record.active?'제한 중':'해제됨'} · ${record.reason||'기존 제한 · 사유 미등록'}`);
      view.components.unshift(row(btn('host:new','사용자 지정·제한',ButtonStyle.Danger),btn('ui:admin','관리자로',ButtonStyle.Secondary)));return view;
    }
    if(action==='pick')return this.view(gid,a,i.values[0]);
    if(action==='lift'){
      check(this.block(gid,a,arg)?.active,'현재 주최 제한 중인 사용자가 아니에요.');
      return payload(`<@${arg}>의 주최 제한을 해제할까요? 최근 제한 사유와 설정 기록은 남습니다.`,[row(btn(`host:liftok:${arg}`,'제한 해제 확인',ButtonStyle.Danger),btn(`host:view:${arg}`,'돌아가기',ButtonStyle.Secondary))]);
    }
    if(action==='liftok')this.engine.restrictHost(gid,a,arg,false);
    else check(action==='view','유효하지 않은 주최 제한 요청이에요.');
    return this.view(gid,a,arg);
  }
}
