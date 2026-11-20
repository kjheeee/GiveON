import { randomBytes } from 'node:crypto';
import { ButtonStyle, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits, ModalBuilder, LabelBuilder, RoleSelectMenuBuilder, TextDisplayBuilder } from 'discord.js';
import { UserError } from './engine.js';
import { btn, row, payload } from './ui.js';

const ROLES = { manager_roles:'관리 역할 (선택)',condition_roles:'참여·차단 조건의 후보 역할 (선택)',blocked_roles:'공통 참여 금지 역할 (선택)',mention_roles:'이벤트 시작 알림 역할 (선택)' };
const CHANNELS = { panel_channel:'신청 안내를 게시할 채널',event_channel:'승인된 이벤트를 공개할 채널',manager_channel:'이벤트 승인용 비공개 채널' };
const check = (ok,message) => { if (!ok) throw new UserError(message); };
const summary = ids => ids.length ? ids.slice(0,5).map(id=>`<@&${id}>`).join(' ')+(ids.length>5?` 외 ${ids.length-5}개`:'') : '없음';

export class SetupFlow {
  constructor(engine,transport) { Object.assign(this,{engine,transport,store:engine.store});this.publishing=new Set(); }
  configuration(gid) { return JSON.stringify(this.store.guild(gid)); }
  requireReady(gid,actor) {
    this.engine.requireManager(gid,actor);
    const settings=this.store.guild(gid),panel=this.store.get('SELECT * FROM panels WHERE guild_id=?',gid);
    check(panel?.state==='READY'&&panel.message_id&&settings.event_channel&&settings.manager_channel,'먼저 /gon init으로 초기설정을 완료하고 신청 안내를 게시해주세요.');
  }
  start(gid,actor,channelId) {
    this.engine.requireManager(gid,actor);
    check(!this.publishing.has(gid),'다른 초기설정을 게시 중이에요. 잠시 후 다시 시도해주세요.');
    const settings=this.store.guild(gid),data={panel_channel:this.store.get('SELECT channel_id FROM panels WHERE guild_id=?',gid)?.channel_id||channelId};
    for(const key of Object.keys(ROLES))data[key]=JSON.parse(settings[key]);
    data.event_channel=settings.event_channel;data.manager_channel=settings.manager_channel;
    const token=randomBytes(8).toString('hex');
    this.store.run(`INSERT INTO setup_sessions(guild_id,user_id,token,step,data,baseline) VALUES (?,?,?,'channels',?,?)
      ON CONFLICT(guild_id,user_id) DO UPDATE SET token=excluded.token,step='channels',data=excluded.data,baseline=excluded.baseline`,gid,actor.userId,token,JSON.stringify(data),this.configuration(gid));
    return this.modal(gid,actor,token,'channels');
  }
  session(gid,actor,token) {
    this.engine.requireManager(gid,actor);
    check(!this.publishing.has(gid),'설정 완료와 안내 게시를 처리 중이에요. 잠시 기다려주세요.');
    const session=this.store.get('SELECT * FROM setup_sessions WHERE guild_id=? AND user_id=? AND token=?',gid,actor.userId,token);
    check(session,'이 초기설정 화면은 만료됐어요. /gon init을 다시 실행해주세요.');
    return {...session,data:JSON.parse(session.data)};
  }
  modal(gid,actor,token,step) {
    const s=this.session(gid,actor,token),data=s.data;
    check(['channels','roles'].includes(step),'유효하지 않은 초기설정 팝업이에요.');
    check(step!=='roles'||['roles','review'].includes(s.step),'먼저 채널 설정을 완료해주세요.');
    const modal=new ModalBuilder().setCustomId(`form:setup${step}:${token}`).setTitle(step==='channels'?'1/3 · GiveON 채널 설정':'2/3 · GiveON 역할 설정');
    if(step==='channels') {
      modal.addTextDisplayComponents(new TextDisplayBuilder().setContent('완료 전에는 신청 안내를 게시하지 않습니다.\n신청 안내와 이벤트 채널은 같아도 됩니다. 검수 채널은 별도로 선택하세요.'));
      for(const [key,label] of Object.entries(CHANNELS)) {
        const menu=new ChannelSelectMenuBuilder().setCustomId(key).setPlaceholder('채널 선택').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1).setRequired(true);
        if(data[key])menu.setDefaultChannels(data[key]);modal.addLabelComponents(new LabelBuilder().setLabel(label).setChannelSelectMenuComponent(menu));
      }
    } else {
      modal.addTextDisplayComponents(new TextDisplayBuilder().setContent('필요한 역할만 선택하고 제출하세요. 모두 비워둬도 됩니다.\n조건 후보 역할은 신청자가 참여·차단 조건에서 고를 수 있는 목록입니다.'));
      for(const [key,label] of Object.entries(ROLES))if(key!=='manager_roles'||this.engine.owner(actor)) {
        const menu=new RoleSelectMenuBuilder().setCustomId(key).setMinValues(0).setMaxValues(20).setRequired(false);
        if(data[key].length)menu.setDefaultRoles(data[key]);modal.addLabelComponents(new LabelBuilder().setLabel(label).setRoleSelectMenuComponent(menu));
      }
    }
    return modal;
  }
  view(gid,actor,token,notice='') {
    const s=this.session(gid,actor,token),data=s.data,nav=[];
    let text;
    if(s.step==='review') {
      text=`**3/3 · 초기설정 — 최종 확인**\n${Object.entries(CHANNELS).map(([key,label])=>`${label}: <#${data[key]}>`).join('\n')}\n\n${Object.entries(ROLES).map(([key,label])=>`${label}: ${summary(data[key])}`).join('\n')}\n\n**완료·게시**를 누르면 설정을 저장하고 선택한 채널에 신청 안내를 게시합니다.`;
      nav.push(btn(`setup:finish:${token}`,'완료·게시',ButtonStyle.Success));
    } else {
      text=s.step==='roles'?'**채널 선택 완료**\n다음 버튼을 눌러 역할 설정 팝업을 여세요. 아직 신청 안내는 게시하지 않았습니다.':'**초기설정**\n채널 설정 팝업에서 다시 선택해주세요.';
    }
    if(s.step!=='channels')nav.push(btn(`setup:open:${token}:roles`,s.step==='review'?'역할 수정':'다음 · 역할 설정',ButtonStyle.Primary));
    nav.push(btn(`setup:open:${token}:channels`,'채널 수정',ButtonStyle.Secondary),btn(`setup:cancel:${token}`,'취소',ButtonStyle.Secondary));
    return payload((notice?notice+'\n\n':'')+text,[row(...nav)]);
  }
  async submitChannels(gid,actor,token,fields,guild) {
    check(guild.id===gid,'이 서버의 초기설정에서 진행해주세요.');
    const s=this.session(gid,actor,token),data={...s.data};
    for(const key of Object.keys(CHANNELS)) {
      const ids=[...(fields.getSelectedChannels(key,true)?.keys()||[])];
      check(ids.length===1&&/^\d{15,22}$/.test(ids[0]),'채널을 하나씩 선택해주세요.');data[key]=ids[0];
    }
    await this.validateChannels(guild,data);
    const latest=this.session(gid,actor,token);
    check(JSON.stringify(latest.data)===JSON.stringify(s.data),'설정이 변경됐어요. 채널 팝업을 다시 열어주세요.');
    this.store.run("UPDATE setup_sessions SET data=?,step='roles' WHERE guild_id=? AND user_id=? AND token=?",JSON.stringify(data),gid,actor.userId,token);
    return this.view(gid,actor,token);
  }
  submitRoles(gid,actor,token,fields) {
    const s=this.session(gid,actor,token);check(['roles','review'].includes(s.step),'먼저 채널 설정을 완료해주세요.');
    for(const key of Object.keys(ROLES)) {
      if(key==='manager_roles'&&!this.engine.owner(actor))continue;
      const values=[...(fields.getSelectedRoles(key)?.keys()||[])];
      check(values.length<=20&&values.every(id=>/^\d{15,22}$/.test(id)&&id!==gid),'역할은 @everyone을 제외하고 최대 20개까지 선택해주세요.');s.data[key]=[...new Set(values)];
    }
    this.store.run("UPDATE setup_sessions SET data=?,step='review' WHERE guild_id=? AND user_id=? AND token=?",JSON.stringify(s.data),gid,actor.userId,token);
    return this.view(gid,actor,token);
  }
  async validateChannels(guild,data) {
    check(Object.keys(CHANNELS).every(key=>data[key]),'신청 안내·이벤트 공개·승인 검수 채널을 모두 선택해주세요.');
    check(data.manager_channel!==data.event_channel&&data.manager_channel!==data.panel_channel,'승인·검수 채널은 신청 안내 및 이벤트 공개 채널과 달라야 해요.');
    const me=await guild.members.fetchMe();
    for(const [key,label] of Object.entries(CHANNELS)) {
      const channel=await guild.channels.fetch(data[key]).catch(()=>null);
      check(channel?.type===ChannelType.GuildText&&channel.guildId===guild.id,`${label}을 이 서버의 텍스트 채널로 선택해주세요.`);
      const permissions=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory];
      if(key!=='panel_channel')permissions.push(PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles);
      check(channel.permissionsFor(me)?.has(permissions),`${label}에서 봇의 보기·전송·기록 읽기 권한을 확인해주세요.${key!=='panel_channel'?' 임베드·파일 첨부 권한도 필요해요.':''}`);
      if(key==='manager_channel')check(!channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel),'승인·검수 채널은 @everyone의 채널 보기 권한을 차단해주세요.');
    }
  }
  cancel(gid,actor,token) {
    this.session(gid,actor,token);this.store.run('DELETE FROM setup_sessions WHERE guild_id=? AND user_id=? AND token=?',gid,actor.userId,token);
    return payload('초기설정을 닫았어요. 다시 시작하려면 /gon init을 실행해주세요.');
  }
  async finish(gid,actor,token,guild) {
    check(guild.id===gid,'이 서버의 초기설정에서 진행해주세요.');
    const s=this.session(gid,actor,token);check(s.step==='review','최종 확인 단계까지 진행한 뒤 완료해주세요.');
    check(this.transport.panel,'안내 게시 기능을 준비하지 못했어요.');
    this.publishing.add(gid);
    try {
      await this.validateChannels(guild,s.data);
      const currentActor=await this.transport.member(gid,actor.userId);check(currentActor,'서버 멤버 정보를 확인하지 못했어요.');this.engine.requireManager(gid,currentActor);
      check(s.baseline===this.configuration(gid),'다른 관리자가 설정을 변경했어요. /gon init을 다시 실행해 최신 설정을 확인해주세요.');
      this.store.tx(()=>{
        for(const key of ['event_channel','manager_channel',...Object.keys(ROLES)]) {
          if(key==='manager_roles'&&!this.engine.owner(currentActor))continue;
          this.engine.configure(gid,currentActor,key,s.data[key]);
        }
        this.store.run('UPDATE setup_sessions SET baseline=? WHERE guild_id=? AND user_id=? AND token=?',this.configuration(gid),gid,actor.userId,token);
      });
      let posted;
      try { posted=await this.transport.panel.ensure(guild,s.data.panel_channel); }
      catch {
        this.publishing.delete(gid);
        return this.view(gid,currentActor,token,'설정은 저장했지만 안내 게시를 확인하지 못했어요. 채널 권한을 확인한 뒤 **완료·게시**를 다시 눌러주세요. 기존 안내를 먼저 확인하므로 중복 게시를 방지합니다.');
      }
      this.store.run('DELETE FROM setup_sessions WHERE guild_id=? AND user_id=? AND token=?',gid,actor.userId,token);
      return payload(`초기설정을 완료하고 신청 안내를 게시했어요.\nhttps://discord.com/channels/${gid}/${posted.channelId}/${posted.id}\n신청은 안내 메시지의 버튼으로, 설정·관리는 /gon settings으로 진행하세요.`);
    } finally { this.publishing.delete(gid); }
  }
}
