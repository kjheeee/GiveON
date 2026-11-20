import { ButtonStyle, ChannelType, MessageFlags,EmbedBuilder } from 'discord.js';
import { UserError } from './engine.js';
import { readContent, files } from './media.js';
import { btn, row, back, payload, contentModal, reasonModal } from './ui.js';
import { statuses, time } from './discord-transport.js';

const check=(ok,message)=>{if(!ok)throw new UserError(message);};
const number=value=>/^\d+$/.test(value||'')?Number(value):NaN;
const hostActions=new Set(['pview','pstatus','papprove','pdeny','prework']);

export class ProofFlow {
  constructor(engine) {this.engine=engine;this.store=engine.store;}
  matches(i) {
    const [kind,action]=(i.customId||'').split(':');
    return (i.isButton()&&(hostActions.has(kind)||kind==='proofstatus'||(kind==='ui'&&action==='proofupload')))
      ||(i.isModalSubmit()&&kind==='form'&&['proof','rework'].includes(action))
      ||(i.isAnySelectMenu?.()&&i.customId==='pick:claim:reviewer');
  }
  context(i) {
    const parts=(i.customId||'').split(':'),[kind,action,arg]=parts;
    const isSelect=i.isAnySelectMenu?.()&&i.customId==='pick:claim:reviewer';
    const cid=isSelect?i.values[0]:kind==='form'||kind==='ui'?arg:action;
    check(/^[a-f0-9]{16}$/.test(cid||''),'당첨 정보를 확인해주세요.');
    const record=this.store.get('SELECT e.guild_id,e.owner_id,c.user_id FROM claims c JOIN events e ON e.id=c.event_id WHERE c.id=?',cid);
    check(record,'당첨 정보를 찾을 수 없어요.');
    if(i.inGuild())check(i.guildId===record.guild_id,'이 서버의 당첨 정보가 아니에요.');
    else {
      check(i.channel?.type===ChannelType.DM,'봇과의 개인 DM에서 진행해주세요.');
      if(i.channel.recipientId)check(i.channel.recipientId===i.user.id,'본인의 개인 DM에서 진행해주세요.');
    }
    const host=isSelect||hostActions.has(kind)||(kind==='form'&&action==='rework');
    check(!i.user.bot&&(host?record.owner_id:record.user_id)===i.user.id,host?'이 이벤트의 주최자만 인증을 검수할 수 있어요.':'당첨자 본인만 인증을 제출할 수 있어요.');
    return {parts,kind,action,arg,cid,guildId:record.guild_id,actor:{userId:i.user.id,roles:[],isBot:false},host};
  }
  async defer(i) {
    if(i.message&&(!i.inGuild()||i.message.flags?.has(MessageFlags.Ephemeral)))await i.deferUpdate();
    else await i.deferReply(i.inGuild()?{flags:MessageFlags.Ephemeral}:{});
  }
  respond(i,value) {return i.editReply({content:'',embeds:[],components:[],attachments:[],allowedMentions:{parse:[]},...value});}
  hostView(context,withProof=false,inGuild=false) {
    const {guildId,actor,cid}=context,{claim,event}=this.engine.proofReviewer(guildId,actor,cid);
    let text=`**${event.title} · 인증 검수**\n당첨자: <@${claim.user_id}>\n자리: ${claim.slot}\n상태: **${statuses[claim.status]}**\n당첨 번호: ${cid}`;
    const actions=[],value=payload(text);
    if(claim.status==='REVIEW') {
      actions.push(btn(`pview:${cid}`,'인증 자료 보기',ButtonStyle.Primary),btn(`papprove:${cid}:${claim.proof_version}`,'승인·자동 지급',ButtonStyle.Success),
        btn(`prework:${cid}:${claim.proof_version}`,'보완 요청',ButtonStyle.Secondary),btn(`pdeny:${cid}:${claim.proof_version}`,'최종 거절·리롤',ButtonStyle.Danger));
      if(withProof) {
        const {content}=this.engine.viewProof(guildId,actor,cid);
        value.content+=`\n제출 버전: ${claim.proof_version}`;
        value.embeds=[new EmbedBuilder().setColor(0x5865f2).setTitle('제출한 인증 자료').setDescription(content.text||'(이미지만 제출됨)')];value.files=files(content,'proof');
      }
    } else if(claim.status==='SUBMITTING')value.content+=`\n보완 제출 대기 · 기한 ${time(claim.submit_deadline)}`;
    else if(claim.status==='DELIVERED')value.content+='\n상품 지급을 완료했습니다. 봇 DB의 상품·인증 원문을 삭제했습니다.';
    actions.push(btn(`pstatus:${cid}`,'상태 확인',ButtonStyle.Secondary));value.components=[row(...actions)];
    if(inGuild)value.components.push(back());
    return value;
  }
  winnerView(context,inGuild=false) {
    const {claim,event}=this.engine.claim(context.cid,context.guildId),actions=[];
    let text=`**${event.title} · 인증 제출**\n당첨 번호: ${claim.id}\n상태: **${statuses[claim.status]}**`;
    if(claim.status==='SUBMITTING') {
      text+=`\n제출 기한: ${time(claim.submit_deadline)}`;
      if(claim.feedback)text+=`\n보완 요청: ${this.engine.vault.open(claim.feedback,`feedback:${claim.id}`).text}`;
      if(claim.submit_deadline>this.engine.now())actions.push(btn(`ui:proofupload:${claim.id}:${claim.proof_version}`,'보완·인증 제출',ButtonStyle.Success));
    } else if(claim.status==='REVIEW')text+='\n주최자 검수를 기다리고 있어요.';
    else if(claim.status==='DELIVERY_FAILED')text+='\n서버 안내의 내 당첨에서 상품 전달을 다시 시도해주세요.';
    actions.push(btn(`proofstatus:${claim.id}`,'상태 확인',ButtonStyle.Secondary));
    return payload(text,[row(...actions),...(inGuild?[back()]:[])]);
  }
  async handle(i) {
    let context;
    try {
      this.engine.guard();context=this.context(i);
      const {parts,kind,action,cid,guildId,actor}=context;
      if(i.isButton()&&kind==='prework') {
        const {claim}=this.engine.proofReviewer(guildId,actor,cid);
        check(claim.status==='REVIEW'&&claim.proof_version===number(parts[2]),'현재 인증 자료를 다시 확인해주세요.');
        return await i.showModal(reasonModal(`form:rework:${cid}:${claim.proof_version}`,'인증 보완 요청','보완할 내용'));
      }
      if(i.isButton()&&kind==='ui'&&action==='proofupload') {
        const {claim,event}=this.engine.claim(cid,guildId);
        check(claim.status==='SUBMITTING'&&claim.submit_deadline>this.engine.now(),'인증 제출 가능 시간이 아니에요.');
        if(parts[3]!==undefined)check(claim.proof_version===number(parts[3]),'보완 요청이 갱신됐어요. 상태 확인 후 다시 제출해주세요.');
        return await i.showModal(contentModal(`form:proof:${cid}:${claim.proof_version}`,'인증 자료 제출',null,event.proof_instructions));
      }
      await this.defer(i);
      if(i.isModalSubmit()&&action==='proof') {
        const {claim}=this.engine.claim(cid,guildId);
        if(parts[3]!==undefined)check(claim.proof_version===number(parts[3]),'보완 요청이 갱신됐어요. 상태 확인 후 다시 제출해주세요.');
        const ticket=this.engine.reserveProof(guildId,actor,cid);
        try {this.engine.submitProof(guildId,actor,cid,await readContent(i.fields.getTextInputValue('text'),[...(i.fields.getUploadedFiles('images')?.values()||[])]),ticket);}
        catch(error){this.engine.abortProof(cid,ticket);throw error;}
        return await this.respond(i,this.winnerView(context,i.inGuild()));
      }
      if(i.isModalSubmit()&&action==='rework')await this.engine.review(guildId,actor,cid,number(parts[3]),'rework',i.fields.getTextInputValue('reason'));
      else if(kind==='papprove'||kind==='pdeny')await this.engine.review(guildId,actor,cid,number(parts[2]),kind==='papprove'?'approve':'deny');
      if(context.host)return await this.respond(i,this.hostView(context,kind==='pview'||i.customId==='pick:claim:reviewer',i.inGuild()));
      return await this.respond(i,this.winnerView(context,i.inGuild()));
    } catch(error) {
      const text=error instanceof UserError?error.message:'인증 처리 중 오류가 발생했어요. 현재 상태를 확인한 뒤 다시 시도해주세요.';
      if(!(error instanceof UserError))console.error(`[인증 요청] ${typeof error.code==='number'?error.code:'INTERNAL_OR_NETWORK'}`);
      try {
        if(!i.deferred&&!i.replied)return await i.reply({...payload(text),...(i.inGuild()?{flags:MessageFlags.Ephemeral}:{})});
        let value=payload(text);
        if(context)try{value=context.host?this.hostView(context,false,i.inGuild()):this.winnerView(context,i.inGuild());value.content=text+'\n\n'+value.content;}catch{ /* 이미 삭제된 자료는 복사하지 않습니다. */ }
        await this.respond(i,value);
      }catch{ /* 만료된 요청·DM 수신 실패의 원문은 기록하지 않습니다. */ }
    }
  }
}
