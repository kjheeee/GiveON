import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,ContainerBuilder,TextDisplayBuilder,MessageFlags } from 'discord.js';
import { files } from './media.js';

export const statuses = {
  DRAFT: '초안', PENDING: '승인 대기', STARTING: '시작 게시 대기', RUNNING: '참여 중', DRAWN: '추첨 완료·수령 진행',
  COMPLETED: '마감', CANCELLED: '취소', REJECTED: '신청 거절', ANNOUNCING: '당첨 알림 대기',
  CLAIMABLE: '수령 대기', SUBMITTING: '인증 제출 중', UPLOADING: '제출 파일 처리 중', REVIEW: '인증 검수 대기', READY: '자동 전달 대기',
  PREPARING: '전달 준비 중', SENDING: '전달 중', DELIVERED: '수령 완료', EXPIRED: '기한 초과·리롤',
  DENIED: '당첨 종료', DELIVERY_FAILED: 'DM 실패·재시도 가능', DELIVERY_UNKNOWN: '전송 결과 확인 필요',
};
export const time = ms => `<t:${Math.floor(ms / 1000)}:R>`;
const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...buttons) => new ActionRowBuilder().addComponents(buttons);
const nonce = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

function markDefinite(error) {
  // 네트워크 타임아웃·5xx는 Discord가 수신했을 수도 있으므로 확정 실패로 취급하지 않습니다.
  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429) error.definite = true;
  return error;
}

export class DiscordTransport {
  constructor(client, store, vault) { Object.assign(this, { client, store, vault }); }
  async roles(guildId,ids) {
    if(!ids.length) return [];
    const guild=await this.client.guilds.fetch(guildId),roles=await guild.roles.fetch();
    return ids.map(id=>roles.get(id)).filter(role=>role&&role.id!==guildId).map(role=>({id:role.id,name:role.name}));
  }
  async member(guildId, userId) {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      return { userId: member.id, roles: [...member.roles.cache.keys()], isBot: member.user.bot };
    } catch (error) { if ([10007, 10013].includes(error.code)) return null; throw markDefinite(error); }
  }
  eventEmbed(event, marker = `job:start:${event.id}`) {
    const entries = this.store.get('SELECT count(*) n FROM entries WHERE event_id=?', event.id).n;
    const roles = value => JSON.parse(value).map(id => `<@&${id}>`).join(', ') || '없음';
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(event.title).setDescription(event.description)
      .addFields(
        { name: '주최자', value: `<@${event.owner_id}>`, inline: true },
        { name: '당첨 인원', value: `${event.winner_count}명`, inline: true },
        { name: '참여자', value: `${entries}명`, inline: true },
        { name: '상태', value: statuses[event.status] || event.status, inline: true },
        { name: '수령 제한시간', value: `${event.claim_ms / 60000}분`, inline: true },
        { name: '참여 가능 역할 (하나 이상)', value: roles(event.allow_roles) },
        { name: '참여 거절 역할', value: roles(event.deny_roles) },
      ).setFooter({ text: `GiveON · 이벤트 ${event.id}` });
    if (event.ends_at) embed.addFields({ name: '참여 마감', value: time(event.ends_at) });
    if (event.proof_required) embed.addFields({ name: '수령 전 인증 필요', value: event.proof_instructions },{name:'인증 제출 기한',value:'수령 버튼을 누른 후 5분 내 텍스트·이미지를 제출해주세요.'});
    return embed;
  }
  eventComponents(event) {
    const disabled = event.status !== 'RUNNING' && event.status !== 'STARTING';
    return [row(button(`join:${event.id}`, '참여', ButtonStyle.Success).setDisabled(disabled), button(`leave:${event.id}`, '참여 취소', ButtonStyle.Secondary).setDisabled(disabled),button(`ui:event:${event.id}`,'상세 보기',ButtonStyle.Secondary))];
  }
  publicEvent(event,notificationRoles=[]) {
    const roleText=value=>JSON.parse(value).map(id=>`<@&${id}>`).join(', ')||'없음';
    const entries=this.store.get('SELECT count(*) n FROM entries WHERE event_id=?',event.id).n;
    let body=`## ${event.title}\n${event.description}\n\n주최자 <@${event.owner_id}>\n당첨 **${event.winner_count}명** · 참여 **${entries}명**\n상태: **${statuses[event.status]}** · 수령 제한 **${event.claim_ms/60000}분**\n참여 가능: ${roleText(event.allow_roles)}\n참여 차단: ${roleText(event.deny_roles)}`;
    if(event.ends_at)body+=`\n참여 마감: ${time(event.ends_at)}`;
    if(event.proof_required){const available=Math.max(0,3800-body.length);body+=`\n\n**수령 전 인증 필요**\n${event.proof_instructions.slice(0,available)}${event.proof_instructions.length>available?'…\n전체 인증 안내는 상세 보기에서 확인하세요.':''}`;}
    body+=`\n-# 이벤트 ${event.id}`;
    const container=new ContainerBuilder().setAccentColor(0x18e979).addTextDisplayComponents(new TextDisplayBuilder().setContent(body)).addActionRowComponents(...this.eventComponents(event));
    return {flags:MessageFlags.IsComponentsV2,components:[...(notificationRoles.length?[new TextDisplayBuilder().setContent(notificationRoles.map(id=>`<@&${id}>`).join(' '))]:[]),container]};
  }
  async prepareDM(userId) {
    try { return (await (await this.client.users.fetch(userId)).createDM()).id; }
    catch (error) { throw markDefinite(error); }
  }
  async sendPrize(channelId, event, claim, content) {
    let sending = false;
    try {
      const channel = await this.client.channels.fetch(channelId);
      sending = true;
      return await channel.send({
        embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${event.title} · ${claim.slot}번 상품`)
          .setDescription(content.text || '첨부된 상품 이미지를 확인해주세요.')
          .setFooter({ text: `giveaway-delivery:${claim.id}` })],
        files: files(content, 'prize'), allowedMentions: { parse: [] },
        nonce: claim.delivery_nonce, enforceNonce: true,
      });
    } catch (error) { if (!sending) error.definite = true; throw markDefinite(error); }
  }
  async channelFor(job, event, claim) {
    if (job.channel_id) return job.channel_id;
    const settings = this.store.guild(event.guild_id);
    if (['application', 'proof', 'deliveryIssue', 'drawIssue'].includes(job.kind)) return settings.manager_channel;
    if (['rejected'].includes(job.kind)) return this.prepareDM(event.owner_id);
    if (['rework', 'denied'].includes(job.kind)) return this.prepareDM(claim.user_id);
    if(['winner','closed'].includes(job.kind)&&event.public_message_id) {
      const original=this.store.get("SELECT channel_id FROM jobs WHERE kind='start' AND ref_id=?",event.id);
      if(original?.channel_id)return original.channel_id;
    }
    return settings.event_channel;
  }
  async sendNotification(job, event, claim) {
    let sending = false;
    try {
      const channelId = await this.channelFor(job, event, claim);
      const channel = await this.client.channels.fetch(channelId);
      // 전송 전에 대상 채널을 기록해 설정 변경·재시작 후에도 동일한 메시지를 찾습니다.
      this.store.run('UPDATE jobs SET channel_id=? WHERE id=?', channelId, job.id);
      const marker = `job:${job.id}`;
      const embed = new EmbedBuilder().setColor(0x5865f2).setFooter({ text: marker });
      let components = [], content = '';
      const users = [], roles = [];
      switch (job.kind) {
        case 'application':
          embed.setTitle('이벤트 승인 요청').setDescription(`**${event.title}**\n${event.description}`)
            .addFields({ name: '이벤트 번호', value: event.id }, { name: '주최자', value: `<@${event.owner_id}>` },
              { name: '설정', value: `${event.winner_count}명 / 진행 ${event.duration_ms / 60000}분 / 수령 ${event.claim_ms / 60000}분 / 인증 ${event.proof_required ? '필요' : '없음'}` },
              { name: '인증 안내', value: event.proof_instructions || '없음' },
              { name: '역할 조건', value: `허용: ${JSON.parse(event.allow_roles).map(id => `<@&${id}>`).join(', ') || '제한 없음'}\n거절: ${JSON.parse(event.deny_roles).map(id => `<@&${id}>`).join(', ') || '없음'}` });
          components = [row(button(`eapprove:${event.id}`, '승인·시작', ButtonStyle.Success), button(`ereject:${event.id}`, '거절', ButtonStyle.Danger))];
          break;
        case 'start':
          content = JSON.parse(this.store.guild(event.guild_id).mention_roles).map(id => `<@&${id}>`).join(' ');
          roles.push(...JSON.parse(this.store.guild(event.guild_id).mention_roles));
          sending = true;
          return await channel.send({ ...this.publicEvent(event,roles),allowedMentions: { parse: [], users, roles }, nonce: nonce(job.id), enforceNonce: true });
        case 'winner':
          content = `<@${claim.user_id}>`; users.push(claim.user_id);
          embed.setTitle(`${event.title} 당첨`).setDescription(`축하합니다! 아래 버튼으로 수령해주세요.\n당첨 번호: \`${claim.id}\`\n자리: ${claim.slot}\n수령 기한: ${time(Date.now() + event.claim_ms)}${event.proof_required ? '\n수령 클릭 후 5분 내 인증 자료 제출이 필요해요.' : ''}`);
          components = [row(button(`claim:${claim.id}`, '수령', ButtonStyle.Success))];
          break;
        case 'proof':
          embed.setTitle('인증 검수 요청').setDescription(`상품: ${event.title}\n당첨 번호: \`${claim.id}\`\n신청자: <@${claim.user_id}>\n제출 버전: ${claim.proof_version}\n자료는 권한 확인 후 비공개로 표시합니다.`);
          components = [row(button(`pview:${claim.id}`, '인증 자료 조회'))];
          break;
        case 'rework': {
          const feedback = claim.feedback ? this.vault.open(claim.feedback, `feedback:${claim.id}`).text : '자료를 보완해주세요.';
          embed.setTitle('인증 보완 요청').setDescription(`${feedback}\n\n당첨 번호: \`${claim.id}\`\n재제출 기한: ${time(claim.submit_deadline)}\n이벤트 서버의 안내 패널에서 내 당첨 → 인증 자료 제출 버튼을 눌러주세요.`);
          break;
        }
        case 'denied': embed.setTitle('인증 거절').setDescription(`이벤트: ${event.title}\n당첨 번호: ${claim.id}\n해당 당첨 자리는 리롤됩니다.`); break;
        case 'expired': embed.setTitle('당첨 자리 리롤').setDescription(`이벤트: ${event.title}\n당첨 번호: ${claim.id}\n기존 당첨이 종료되어 해당 자리의 후보를 다시 추첨합니다.`); break;
        case 'received': embed.setTitle('상품 수령 완료').setDescription(`이벤트: ${event.title}\n당첨자: <@${claim.user_id}>\n자리: ${claim.slot}\n당첨 번호: ${claim.id}`); break;
        case 'deliveryIssue': embed.setTitle('상품 전달 상태 확인 필요').setDescription(`이벤트: ${event.title}\n당첨 번호: ${claim.id}\n상태: ${statuses[claim.status]}\n실패 건은 내 당첨의 다시 시도 버튼, 결과 불명 건은 관리자 메뉴의 지급 결과 확인 버튼을 사용해주세요.`); break;
        case 'drawIssue': embed.setTitle('추첨 지연').setDescription(`이벤트: ${event.title}\n이벤트 번호: ${event.id}\n참여자 역할 확인에 실패해 추첨을 보류했어요. 서버 접근 권한과 네트워크를 확인해주세요. 다음 주기에 재시도합니다.`); break;
        case 'rejected': embed.setTitle('이벤트 신청 거절').setDescription(`상품: ${event.title}\n이벤트 번호: ${event.id}\n사유: ${event.rejection_reason}\n안내 패널의 내 신청 → 미지급 상품 회수 버튼으로 보관 내용을 확인할 수 있어요.`); break;
        case 'closed': {
          const sent = this.store.get("SELECT count(*) n FROM prizes WHERE event_id=? AND status='DELIVERED'", event.id).n;
          embed.setTitle(event.status === 'CANCELLED' ? '이벤트 취소' : '이벤트 마감').setDescription(`상품: ${event.title}\n이벤트 번호: ${event.id}\n지급 완료: ${sent}/${event.winner_count}\n${sent < event.winner_count ? '남은 미지급 상품은 주최자가 회수할 수 있어요.' : '모든 상품이 지급되었습니다.'}`);
          break;
        }
        default: throw Object.assign(new Error('알림 종류 오류'), { definite: true });
      }
      sending = true;
      const reply=['winner','closed'].includes(job.kind)&&event.public_message_id?{messageReference:event.public_message_id,failIfNotExists:false}:undefined;
      return await channel.send({ content, embeds: [embed], components, allowedMentions: { parse: [], users, roles, ...(reply?{repliedUser:false}:{}) }, ...(reply?{reply}:{}), nonce: nonce(job.id), enforceNonce: true });
    } catch (error) { if (!sending) error.definite = true; throw markDefinite(error); }
  }
  async findMessage(channelId, marker, since = 0, deliveryNonce = null,componentId=null) {
    if (!channelId) return null;
    const channel = await this.client.channels.fetch(channelId);
    let before;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = messages.find(message => message.author.id === this.client.user.id &&
        ((deliveryNonce && String(message.nonce) === deliveryNonce) || (componentId&&JSON.stringify((message.components||[]).map(c=>c.toJSON?c.toJSON():c)).includes(`"custom_id":"${componentId}"`)) || message.embeds.some(embed => embed.footer?.text === marker || embed.footer?.text?.endsWith(` · ${marker}`))));
      if (found) return found;
      if (!messages.size || messages.size < 100 || messages.last().createdTimestamp < since - 60_000) return null;
      before = messages.last().id;
    }
    return null;
  }
  findPrize(claim) { return this.findMessage(claim.dm_channel_id, `giveaway-delivery:${claim.id}`, claim.send_started, claim.delivery_nonce); }
  async findNotification(job, event, claim) {
    const channel=await this.channelFor(job,event,claim);
    if(job.kind==='start') {
      const found=await this.findMessage(channel,`GiveON · 이벤트 ${event.id}`,job.created_at,null,`join:${event.id}`);
      if(found) return found;
    }
    return this.findMessage(channel,`job:${job.id}`,job.created_at);
  }
  async updateEvent(event) {
    const job = this.store.get("SELECT channel_id FROM jobs WHERE kind='start' AND ref_id=?", event.id);
    if (!job?.channel_id) return;
    const channel = await this.client.channels.fetch(job.channel_id);
    const message=await channel.messages.fetch(event.public_message_id);
    if(message.author.id!==this.client.user.id) throw new Error('EVENT_MESSAGE_IDENTITY_MISMATCH');
    const notificationText=message.content||((message.components||[]).filter(c=>c.type===10).map(c=>c.content||c.data?.content||'').join(' '));
    const roles=[...notificationText.matchAll(/<@&(\d+)>/g)].map(match=>match[1]);
    await channel.messages.edit(event.public_message_id, { ...this.publicEvent(event,roles),content:null,embeds:[],allowedMentions:{parse:[]} });
  }
}

export const buttons = { row, button };
