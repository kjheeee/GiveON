import { randomBytes } from 'node:crypto';
import { ButtonStyle,ChannelType } from 'discord.js';
import { UserError } from './engine.js';
import { btn,row,back,payload,contentModal,listView } from './ui.js';
import { readContent } from './media.js';
import { statuses,time } from './discord-transport.js';

const check=(ok,message)=>{if(!ok)throw new UserError(message);};
export class ModerationFlow {
  constructor(engine,transport){Object.assign(this,{engine,transport,store:engine.store});}
  matches(i){return i.commandName==='lookup'||(i.customId||'').startsWith('mod:')||(i.customId||'').startsWith('form:report:');}
  target(gid,a,type,id){
    if(type==='claim'){
      const {claim,event}=this.engine.claim(id,gid);check(claim.user_id===a.userId,'당첨자 본인의 전달 내용만 신고할 수 있어요.');return {event,claim};
    }
    check(type==='event','신고 대상을 확인해주세요.');
    return {event:this.engine.visibleEvent(gid,a,id),claim:null};
  }
  eventLink(event){const job=this.store.get("SELECT channel_id FROM jobs WHERE kind='start' AND ref_id=?",event.id);return event.public_message_id&&/^\d{15,22}$/.test(job?.channel_id||'')?`https://discord.com/channels/${event.guild_id}/${job.channel_id}/${event.public_message_id}`:null;}
  lookup(gid,a,query){
    const {event,claim,audit}=this.engine.lookup(gid,a,query),url=this.eventLink(event),components=[row(btn(`ui:event:${event.id}`,'이벤트 보기'))];
    let text=`**${event.title} · 기록 검색**\n이벤트: ${event.id}\n주최자: <@${event.owner_id}>\n이벤트 상태: ${statuses[event.status]}`;
    if(url)text+=`\n[원 이벤트](${url})`;
    if(claim){
      text+=`\n당첨 번호: ${claim.id}\n당첨자: <@${claim.user_id}>\n자리: ${claim.slot}\n처리 상태: ${claim.status==='DELIVERED'&&this.engine.direct(event.id)?'주최자 연락 안내 완료':statuses[claim.status]}`;
      if(claim.completed_at)text+=`\n전달 완료: ${time(claim.completed_at)}`;
      if(claim.user_id===a.userId&&claim.dm_channel_id&&claim.dm_message_id)text+=`\n[본인 수령 DM](https://discord.com/channels/@me/${claim.dm_channel_id}/${claim.dm_message_id})`;
      if(audit.length)text+='\n\n최근 처리 기록\n'+audit.map(x=>`${time(x.created_at)} · ${x.action}`).join('\n');
      if(claim.user_id===a.userId)components.push(row(btn(`mod:reportclaim:${claim.id}`,'전달 내용 신고',ButtonStyle.Danger)));
      else if(event.owner_id===a.userId&&claim.status==='REVIEW')components.push(row(btn(`pview:${claim.id}`,'인증 검수')));
      if(this.engine.manager(gid,a))components.push(row(btn(`ui:eventclaims:${event.id}:0`,'당첨 관리')));
    }
    text+='\n\n상품·인증 원문은 검색 결과에 표시하지 않으며, 삭제한 내용은 복구할 수 없습니다.';
    components.push(back());return payload(text,components);
  }
  report(gid,a,rid){
    this.engine.requireManager(gid,a);
    const report=this.store.get('SELECT r.* FROM reports r JOIN events e ON e.id=r.event_id WHERE r.id=? AND e.guild_id=?',rid,gid);
    check(report,'이 서버의 신고를 찾을 수 없어요.');return report;
  }
  view(gid,a,rid){
    const r=this.report(gid,a,rid),e=this.engine.event(r.event_id,gid),blocked=Boolean(this.store.get('SELECT user_id FROM host_blocks WHERE guild_id=? AND user_id=?',gid,e.owner_id));
    let text=`**신고 ${r.id}**\n상품: ${e.title}\n주최자: <@${e.owner_id}>\n신고자: <@${r.reporter_id}>\n접수 상태: ${r.status}\n주최 제한: ${blocked?'설정됨':'없음'}\n이벤트: ${e.id}${r.claim_id?`\n당첨 번호: ${r.claim_id}`:''}`;
    if(r.message_id)text+=`\n[신고 내용·증거 보기](https://discord.com/channels/${gid}/${r.channel_id}/${r.message_id})`;
    const actions=[btn(`mod:restrict:${rid}:${blocked?'off':'on'}`,blocked?'주최 제한 해제':'주최 제한',ButtonStyle.Danger),btn(`mod:close:${rid}`,'처리 완료',ButtonStyle.Secondary)];
    if(!['COMPLETED','CANCELLED'].includes(e.status))actions.push(btn(`ui:cancel:${e.id}`,'이벤트 취소',ButtonStyle.Danger));
    return payload(text,[row(...actions),row(btn('mod:list:0','신고 목록',ButtonStyle.Secondary)),back()]);
  }
  async handleDM(i){
    try {
      this.engine.guard();check(i.channel?.type===ChannelType.DM,'봇과의 개인 DM에서 사용해주세요.');
      const [kind,action,arg,extra]=(i.customId||'').split(':'),modal=i.isModalSubmit();
      check((i.isButton()&&kind==='mod'&&action==='reportclaim')||(modal&&kind==='form'&&action==='report'&&arg==='claim'),'신고 관리는 서버에서 진행해주세요.');
      const record=this.store.get('SELECT c.user_id,e.guild_id FROM claims c JOIN events e ON e.id=c.event_id WHERE c.id=?',modal?extra:arg);
      check(record?.user_id===i.user.id&&!i.user.bot,'당첨자 본인의 전달 내용만 신고할 수 있어요.');
      if(modal)await i.deferReply();
      const value=await this.handle(i,{userId:i.user.id,roles:[],isBot:false},record.guild_id);
      if(modal)await i.editReply({...value,components:[]});
    }catch(error){const value=payload(error instanceof UserError?error.message:'신고 접수 중 오류가 발생했어요. 서버 관리자에게 문의해주세요.');try{if(i.deferred||i.replied)await i.editReply(value);else await i.reply(value);}catch{ /* 원문은 로그에 남기지 않습니다. */ }}
  }
  async handle(i,a,gid=i.guildId){
    const [kind,action,arg,extra]=(i.customId||'').split(':');
    if(i.commandName==='lookup')return this.lookup(gid,a,i.options.getString('id',true));
    if(kind==='mod'&&['reportevent','reportclaim'].includes(action)){
      const type=action==='reportclaim'?'claim':'event';this.target(gid,a,type,arg);
      return i.showModal(contentModal(`form:report:${type}:${arg}`,'이벤트·상품 신고',null,'신고 내용과 직접 첨부한 증거만 서버 관리자에게 전송합니다. 개인정보·상품 코드를 가리고 제출해주세요.'));
    }
    if(kind==='form'&&action==='report'){
      const {event,claim}=this.target(gid,a,arg,extra);
      check(!this.store.get("SELECT id FROM reports WHERE event_id=? AND reporter_id=? AND status IN ('SENDING','UNKNOWN','OPEN')",event.id,a.userId),'이미 접수한 신고가 있어요. 추가 내용은 서버 관리자에게 전달해주세요.');
      check(this.store.get('SELECT count(*) n FROM reports WHERE reporter_id=? AND created_at>?',a.userId,this.engine.now()-86400000).n<5,'신고는 하루 5건까지 접수할 수 있어요.');
      const content=await readContent(i.fields.getTextInputValue('text'),[...(i.fields.getUploadedFiles('images')?.values()||[])]);
      this.engine.validateContent(content);const rid=randomBytes(8).toString('hex'),channel=this.store.guild(gid).manager_channel;check(channel,'신고 접수 채널이 설정되지 않았어요. 서버 관리자에게 문의해주세요.');
      this.store.run("INSERT INTO reports(id,event_id,claim_id,reporter_id,status,channel_id,created_at) VALUES (?,?,?,?,'SENDING',?,?)",rid,event.id,claim?.id||null,a.userId,channel,this.engine.now());
      try{
        const message=await this.transport.sendReport(channel,{id:rid,event,claim,reporterId:a.userId},content);
        this.engine.guard();this.store.run("UPDATE reports SET status='OPEN',message_id=? WHERE id=?",message.id,rid);
      }catch(error){this.engine.guard();this.store.run('UPDATE reports SET status=? WHERE id=?',error.definite?'FAILED':'UNKNOWN',rid);throw new UserError(`신고 전송 ${error.definite?'실패':'결과 확인 필요'} · 번호 ${rid}. 서버 관리자에게 문의해주세요.`);}
      return payload(`신고를 접수했어요.\n신고 번호: ${rid}\n신고 내용·증거는 관리자 채널로 전송했으며 봇 DB에는 원문을 저장하지 않았어요.`,[back()]);
    }
    if(action==='list'){
      this.engine.requireManager(gid,a);const page=Number(arg);check(Number.isSafeInteger(page)&&page>=0&&page<50000,'페이지를 확인해주세요.');
      return listView('이벤트 신고',this.store.all('SELECT r.id,e.title,r.status FROM reports r JOIN events e ON e.id=r.event_id WHERE e.guild_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 21 OFFSET ?',gid,page*20),page,'mod:list','mod:pick',r=>r.status);
    }
    if(action==='pick')return this.view(gid,a,i.values[0]);
    const r=this.report(gid,a,arg),event=this.engine.event(r.event_id,gid);
    if(action==='restrict'){
      check(['on','off'].includes(extra),'제한 여부를 확인해주세요.');
      return payload(`주최자 <@${event.owner_id}>의 이 서버 이벤트 주최를 ${extra==='on'?'제한':'허용'}할까요?\n신규 신청·기존 초안 제출·승인을 제어합니다. 진행 중인 이벤트는 별도 취소가 필요합니다.`,[row(btn(`mod:restrictok:${r.id}:${extra}`,'확인',ButtonStyle.Danger),btn(`mod:view:${r.id}`,'돌아가기',ButtonStyle.Secondary))]);
    }
    if(action==='restrictok'){check(['on','off'].includes(extra),'제한 여부를 확인해주세요.');this.engine.restrictHost(gid,a,event.owner_id,extra==='on');this.store.audit(event.id,r.claim_id,extra==='on'?'HOST_BLOCKED':'HOST_UNBLOCKED',a.userId,this.engine.now());}
    else if(action==='close')this.store.run("UPDATE reports SET status='CLOSED',reviewer_id=? WHERE id=?",a.userId,r.id);
    else check(action==='view','유효하지 않은 신고 관리 요청이에요.');
    return this.view(gid,a,r.id);
  }
}
