import { UserError } from './engine.js';

// Message Content 특권 없이도 봇을 멘션한 답장의 본문은 Discord에서 제공합니다.
export function replyHandler(engine,transport,client) {
  const busy=new Set();
  return async message=>{
    if(message.author?.bot||!message.inGuild()||!message.reference?.messageId)return;
    const text=(message.content||'').trim().replace(new RegExp(`^<@!?${client.user.id}>\\s*`),'');
    if(!/^(reroll|리롤)$/i.test(text))return;
    let changed=false;
    const respond=content=>message.reply({content,allowedMentions:{parse:[],repliedUser:false}});
    try {
      engine.guard();
      const actor=await transport.member(message.guildId,message.author.id);
      if(!actor)return;
      engine.requireManager(message.guildId,actor);
      const job=engine.store.get(`SELECT j.ref_id FROM jobs j JOIN claims c ON c.id=j.ref_id JOIN events e ON e.id=c.event_id
        WHERE j.kind='winner' AND j.message_id=? AND j.channel_id=? AND e.guild_id=?`,message.reference.messageId,message.channelId,message.guildId);
      if(!job)return await respond('GiveON이 게시한 당첨 안내 메시지에 답장으로 reroll 또는 리롤을 입력해주세요.');
      if(busy.has(job.ref_id))return;
      const original=await message.fetchReference();
      if(original.author?.id!==client.user.id)return;
      // 최신 역할 확인과 원본 대조를 마친 뒤 해당 당첨 자리만 변경합니다.
      const current=await transport.member(message.guildId,message.author.id);
      if(!current)return;
      engine.requireManager(message.guildId,current);
      const {claim}=engine.claim(job.ref_id,message.guildId);
      if(claim.status==='DELIVERED')throw new UserError('이미 지급 완료된 당첨은 리롤할 수 없어요.');
      busy.add(job.ref_id);
      try {
        await engine.reroll(message.guildId,current,job.ref_id);changed=true;
        const next=engine.store.get("SELECT id FROM claims WHERE event_id=? AND slot=? AND status NOT IN ('EXPIRED','DENIED')",claim.event_id,claim.slot);
        await respond(next?`${claim.slot}번 당첨 자리를 강제 리롤했어요. 새 당첨 안내를 확인해주세요.`:`${claim.slot}번 당첨을 종료했어요. 다시 추첨할 참여자가 없어 해당 자리를 마감했습니다.`);
      } finally {busy.delete(job.ref_id);}
    } catch(error) {
      if(!(error instanceof UserError))console.error(`[답장 리롤] ${typeof error.code==='number'?error.code:'INTERNAL_OR_NETWORK'}`);
      if(changed)return; // 처리 결과 알림 실패로 같은 당첨을 다시 리롤하지 않습니다.
      try{await respond(error instanceof UserError?error.message:'리롤을 확인하지 못했어요. 당첨 상태를 확인한 뒤 다시 시도해주세요.');}catch{ /* 본문·비밀자료는 기록하지 않습니다. */ }
    }
  };
}
