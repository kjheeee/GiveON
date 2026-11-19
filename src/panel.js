import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';

export const entryPanel = guildId => ({
  content:'## GiveON · 이벤트 센터\n**이벤트 신청**에서 템플릿을 고르고 순서대로 입력하세요.\n**내 신청·내 당첨**에서 진행 상황과 수령·인증을 확인할 수 있어요.',
  embeds:[],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ui:create').setLabel('이벤트 신청').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ui:mine:0').setLabel('내 신청').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ui:wins:0').setLabel('내 당첨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ui:help').setLabel('이용 안내').setStyle(ButtonStyle.Secondary),
  )], allowedMentions: { parse: [] },
});

export class PanelPublisher {
  constructor(client, store) { Object.assign(this, { client, store }); this.running = new Map(); }
  ensure(guild, preferredChannelId) {
    if (this.running.has(guild.id)) return this.running.get(guild.id);
    const operation = this.publish(guild, preferredChannelId).finally(() => this.running.delete(guild.id));
    this.running.set(guild.id, operation);
    return operation;
  }
  async publish(guild, preferredChannelId) {
    this.store.guild(guild.id);
    const previous = this.store.get('SELECT * FROM panels WHERE guild_id=?', guild.id);
    const me = await guild.members.fetchMe();
    const required = [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory];
    const usable = channel => channel?.type === ChannelType.GuildText && channel.permissionsFor(me)?.has(required);
    let channel;
    const wanted = preferredChannelId || previous?.channel_id || this.store.guild(guild.id).event_channel;
    if (wanted) channel = await guild.channels.fetch(wanted).catch(() => null);
    if (preferredChannelId && !usable(channel)) throw new Error('PANEL_CHANNEL_UNAVAILABLE');
    if (!usable(channel)) {
      const channels = await guild.channels.fetch();
      channel = channels.get(guild.systemChannelId);
      if (!usable(channel)) channel = [...channels.values()].filter(usable).sort((a,b) => a.rawPosition - b.rawPosition)[0];
    }
    if (!usable(channel)) throw new Error('NO_PANEL_CHANNEL');
    const marker = `giveon-panel:${guild.id}`;
    const isPanel=message=>message.author.id===this.client.user.id&&(message.embeds.some(e=>e.footer?.text===marker)||(message.content?.startsWith('## GiveON · 이벤트 센터')&&JSON.stringify((message.components||[]).map(c=>c.toJSON?c.toJSON():c)).includes('"custom_id":"ui:create"')));
    let found;
    if (previous?.channel_id === channel.id && previous.message_id) {
      try { found = await channel.messages.fetch(previous.message_id); }
      catch (error) { if (error.code !== 10008) throw error; }
      if (found && !isPanel(found)) throw new Error('PANEL_MESSAGE_IDENTITY_MISMATCH');
    }
    // 첫 전송의 응답이 유실되어도 고유 표식으로 기존 안내를 먼저 찾습니다.
    if (!found) {
      let before;
      for (let page = 0; page < 10; page++) {
        const messages = await channel.messages.fetch({ limit:100, ...(before ? {before} : {}) });
        found = messages.find(isPanel);
        if (found || messages.size < 100) break;
        before = messages.last().id;
      }
    }
    if (!found && previous?.channel_id === channel.id && ['SENDING','UNKNOWN'].includes(previous.state)) throw new Error('PANEL_SEND_RESULT_UNKNOWN');
    if (found) {
      await found.edit(entryPanel(guild.id));
    } else {
      this.store.run(`INSERT INTO panels(guild_id,channel_id,state,updated_at,previous_channel_id,previous_message_id)
        VALUES (?,?,'SENDING',?,?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,
        message_id=NULL,state='SENDING',updated_at=excluded.updated_at,
        previous_channel_id=excluded.previous_channel_id,previous_message_id=excluded.previous_message_id`,
      guild.id, channel.id, Date.now(), previous?.channel_id || null, previous?.message_id || null);
      try {
        found = await channel.send({ ...entryPanel(guild.id), nonce:createHash('sha256').update(`${marker}:${channel.id}`).digest('hex').slice(0,24), enforceNonce:true });
      } catch (error) {
        const definite = typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429;
        this.store.run('UPDATE panels SET state=? WHERE guild_id=?', definite ? 'PENDING' : 'UNKNOWN', guild.id);
        throw error;
      }
    }
    this.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,?,'READY',?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,state='READY',updated_at=excluded.updated_at", guild.id, channel.id, found.id, Date.now());
    const oldChannel = previous?.previous_channel_id || (previous?.channel_id !== channel.id ? previous?.channel_id : null);
    const oldMessage = previous?.previous_message_id || (previous?.channel_id !== channel.id ? previous?.message_id : null);
    if (oldChannel && oldMessage) {
      try {
        const old = await (await guild.channels.fetch(oldChannel)).messages.fetch(oldMessage);
        if (isPanel(old)) await old.delete();
        this.store.run('UPDATE panels SET previous_channel_id=NULL,previous_message_id=NULL WHERE guild_id=?', guild.id);
      } catch (error) { if ([10003,10008].includes(error.code)) this.store.run('UPDATE panels SET previous_channel_id=NULL,previous_message_id=NULL WHERE guild_id=?', guild.id); }
    }
    return { id:found.id, channelId:channel.id };
  }
}
