import { ButtonStyle, MessageFlags, PermissionFlagsBits, ChannelType,StringSelectMenuBuilder } from 'discord.js';
import { UserError } from './engine.js';
import { readContent } from './media.js';
import { btn, row, back, payload, createModal, contentModal, reasonModal, proofSettingsModal, roleMenu, channelMenu, listView, eventView, claimView,templateCreateModal,templateMetaModal,templateProofModal,productModal,productsView } from './ui.js';
import { statuses } from './discord-transport.js';
import { DraftFlow } from './drafts.js';
import { SetupFlow } from './setup.js';
import { ProofFlow } from './proof-flow.js';
import { ModerationFlow } from './moderation.js';
import { commandAction } from './commands.js';

const requireThat = (condition,message) => { if (!condition) throw new UserError(message); };
const ROLES = { manager_roles:'관리 역할',condition_roles:'조건에 사용할 역할 목록',blocked_roles:'공통 참여 금지 역할',mention_roles:'시작 알림 역할' };
const parseInteger = value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
const pageNumber = value => { const n=parseInteger(value || '0'); requireThat(Number.isSafeInteger(n)&&n>=0&&n<=50000,'페이지 번호가 잘못되었어요.'); return n; };
const contentFromModal = i => readContent(i.fields.getTextInputValue('text'), [...(i.fields.getUploadedFiles('images')?.values() || [])]);

export function handler(engine,transport) {
  const store=engine.store;
  const flow=new DraftFlow(engine,transport);
  const setup=new SetupFlow(engine,transport);
  const proof=new ProofFlow(engine),moderation=new ModerationFlow(engine,transport);
  const respond=(i,value) => i.editReply({ content:'',embeds:[],components:[],attachments:[],allowedMentions:{parse:[]},...value });
  const draft=(gid,actor,eid) => {
    const event=engine.event(eid,gid);
    requireThat(event.owner_id===actor.userId&&event.status==='DRAFT','본인의 신청 전 초안에서만 설정할 수 있어요.');
    return event;
  };
  const own=(gid,actor,cid) => {
    const value=engine.claim(cid,gid);
    requireThat(value.claim.user_id===actor.userId,'당첨자 본인만 사용할 수 있어요.');
    return value;
  };
  const renderEvent=async(i,a,eid,page=0) => {
    const e=engine.visibleEvent(i.guildId,a,eid);
    return respond(i,e.status==='DRAFT'&&e.owner_id===a.userId?await flow.view(i.guildId,a,eid):eventView(engine,transport,i.guildId,a,eid,page));
  };
  const renderClaim=(i,a,cid,manage=false) => {
    if (manage) engine.requireManager(i.guildId,a); else own(i.guildId,a,cid);
    return respond(i,claimView(engine,i.guildId,a,cid,manage));
  };
  function eventsList(i,a,mode,page) {
    if (mode!=='mine') engine.requireManager(i.guildId,a);
    const records=mode==='pending'?store.all("SELECT id,title,status FROM events WHERE guild_id=? AND status='PENDING' ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?",i.guildId,page*20):mode==='events' ? store.all('SELECT id,title,status FROM events WHERE guild_id=? ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?',i.guildId,page*20) :
      store.all('SELECT id,title,status FROM events WHERE guild_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?',i.guildId,a.userId,page*20);
    const view=listView(mode==='events'?'전체 이벤트':mode==='pending'?'승인 대기':'내 신청',records,page,`ui:${mode}`,'pick:event',e=>statuses[e.status]);
    if(mode==='mine')view.components.unshift(row(btn('ui:reviews:0','내 이벤트 인증 대기')));
    return respond(i,view);
  }
  function claimsList(i,a,mode,page,eid=null) {
    const clauses=['e.guild_id=?'],args=[i.guildId];
    if (mode==='wins') { clauses.push('c.user_id=?'); args.push(a.userId); }
    else if(mode==='reviews'){clauses.push("e.owner_id=? AND c.status='REVIEW'");args.push(a.userId);}
    else {
      engine.requireManager(i.guildId,a);
      if (mode==='reviews') clauses.push("c.status='REVIEW'");
      else if (mode==='issues') clauses.push("c.status='DELIVERY_UNKNOWN'");
      else { engine.event(eid,i.guildId); clauses.push('c.event_id=?'); args.push(eid); }
    }
    const records=store.all(`SELECT c.id,e.title,c.slot,c.status FROM claims c JOIN events e ON c.event_id=e.id WHERE ${clauses.join(' AND ')} ORDER BY c.created_at DESC,c.id DESC LIMIT 21 OFFSET ?`,...args,page*20);
    const prefix=mode==='eventclaims'?`ui:eventclaims:${eid}`:`ui:${mode}`;
    return respond(i,listView({wins:'내 당첨',reviews:'내 이벤트 인증 검수 대기',issues:'지급 결과 확인',eventclaims:'이벤트 당첨 관리'}[mode],records,page,prefix,`pick:claim:${mode==='wins'?'own':mode==='reviews'?'reviewer':'manager'}`,c=>`${c.slot}번 · ${statuses[c.status]}`));
  }
  function adminView(i,a) {
    setup.requireReady(i.guildId,a);
    const settings=store.guild(i.guildId);
    return respond(i,payload(`**GiveON 관리자**\n공개 채널: ${settings.event_channel?`<#${settings.event_channel}>`:'미설정'}\n이벤트 승인 채널: ${settings.manager_channel?`<#${settings.manager_channel}>`:'미설정'}\n상품 전달 원문과 당첨자 인증 원문은 관리자 화면에 표시되지 않습니다.`,[
      row(btn('ui:pending:0','승인 대기'),btn('host:list:0','주최 제한'),btn('ui:channels','설정')),
      row(btn('tpl:list:0','템플릿'),btn('ui:events:0','전체 이벤트'),btn('ui:issues:0','지급 결과 확인')),back(),
    ]));
  }
  function settingsView(i,a,key='condition_roles') {
    engine.requireManager(i.guildId,a);
    requireThat(Object.hasOwn(ROLES,key),'지원하지 않는 역할 설정이에요.');
    if(key==='manager_roles')requireThat(engine.owner(a),'관리 역할은 봇 소유자만 설정할 수 있어요.');
    const s=store.guild(i.guildId);
    return respond(i,payload(`**서버 설정**\n채널과 역할을 여기서 바로 선택하세요. 선택 즉시 저장됩니다.\n현재 역할 설정: **${ROLES[key]}**${key==='condition_roles'?'\n참여 가능·차단 조건에 표시할 후보 목록입니다.':''}`, [
      channelMenu('event_channel','이벤트 공개 채널',s.event_channel,key),channelMenu('manager_channel','이벤트 승인 채널',s.manager_channel,key),
      row(new StringSelectMenuBuilder().setCustomId('ui:settingskind').setPlaceholder('설정할 역할 종류').addOptions(Object.entries(ROLES).filter(([name])=>name!=='manager_roles'||engine.owner(a)).map(([name,label])=>({label,value:name,default:name===key})))),
      roleMenu(`ui:roleset:${key}`,ROLES[key],JSON.parse(s[key])),row(btn('ui:admin','관리자로',ButtonStyle.Secondary)),
    ]));
  }
  async function configureChannel(i,a,key,roleKind='condition_roles') {
    engine.requireManager(i.guildId,a);
    requireThat(['event_channel','manager_channel'].includes(key),'지원하지 않는 채널 설정이에요.');
    const guild=await i.client.guilds.fetch(i.guildId), channel=await guild.channels.fetch(i.values[0]);
    const me=await guild.members.fetchMe();
    requireThat(channel?.type===ChannelType.GuildText&&channel.guildId===i.guildId,'이 서버의 텍스트 채널을 선택해주세요.');
    requireThat(channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.ReadMessageHistory]),'봇에게 채널 보기·전송·임베드·첨부·기록 읽기 권한이 필요해요.');
    const s=store.guild(i.guildId),other=key==='event_channel'?'manager_channel':'event_channel';
    requireThat(channel.id!==s[other],'공개 채널과 관리 채널은 서로 달라야 해요.');
    if(key==='manager_channel')requireThat(channel.id!==store.get('SELECT channel_id FROM panels WHERE guild_id=?',i.guildId)?.channel_id,'승인 채널은 신청 안내 채널과 달라야 해요.');
    if (key==='manager_channel') requireThat(!channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel),'관리 채널은 @everyone의 채널 보기 권한을 차단해주세요.');
    engine.configure(i.guildId,a,key,channel.id);
    return settingsView(i,a,roleKind);
  }
  function rolesView(i,a,key) {
    engine.requireManager(i.guildId,a);
    requireThat(Object.hasOwn(ROLES,key),'지원하지 않는 역할 설정이에요.');
    if (key==='manager_roles') requireThat(engine.owner(a),'관리 역할은 봇 소유자만 설정할 수 있어요.');
    return settingsView(i,a,key);
  }
  async function conditionView(i,a,eid) {
    return await respond(i,await flow.conditions(i.guildId,a,eid));
  }
  return async i => {
    const chat=i.isChatInputCommand(),button=i.isButton(),modal=i.isModalSubmit(),select=i.isAnySelectMenu?.()||false;
    if (!chat&&!button&&!modal&&!select) return;
    if(proof.matches(i))return proof.handle(i);
    if((i.customId||'').startsWith('mod:')||(i.customId||'').startsWith('form:report:')) {
      try{return await i.reply({...payload('이 버튼은 더 이상 사용하지 않습니다. 이벤트·당첨 번호는 서버의 /gon log로 조회해주세요.'),...(i.inGuild()?{flags:MessageFlags.Ephemeral}:{})});}catch{return;}
    }
    let a;
    try {
      requireThat(i.inGuild(),'이벤트가 열리는 서버에서 사용해주세요.'); engine.guard();
      const parts=(i.customId||'').split(':'),[kind,action,arg,extra]=parts;
      const command=chat?commandAction(i):null;
      const mayOpenModal=(chat&&command==='init')||(button&&((kind==='host'&&['new','edit'].includes(action))||(kind==='setup'&&action==='open')||(kind==='ui'&&['prizeform','proofsettings'].includes(action))||['claim','ereject'].includes(kind)||(kind==='flow'&&(['details','prize','product'].includes(action)||(action==='custom'&&arg==='new')))||(kind==='tpl'&&['new','meta','proof'].includes(action))))||(select&&kind==='flow'&&action==='template'&&arg==='new');
      const defer=()=>i.message?.flags?.has(MessageFlags.Ephemeral)&&typeof i.deferUpdate==='function' ? i.deferUpdate() : i.deferReply({flags:MessageFlags.Ephemeral});
      if(!mayOpenModal) await defer();
      a=modal&&kind==='form'&&action==='proof'?{userId:i.user.id,roles:[],isBot:i.user.bot}:await transport.member(i.guildId,i.user.id);
      requireThat(a,'서버 멤버 정보를 확인하지 못했어요.');
      if(command==='reqblock')setup.requireReady(i.guildId,a);
      if(moderation.matches(i)){
        if(mayOpenModal)return await moderation.handle(i,a);
        return await respond(i,await moderation.handle(i,a));
      }
      if(chat&&command==='init')return await i.showModal(setup.start(i.guildId,a,i.channelId));
      if(button&&kind==='setup'&&action==='open')return await i.showModal(setup.modal(i.guildId,a,arg,extra));
      // 모달은 최초 응답으로 열어야 합니다. 데이터 접근 권한은 제출 시에도 다시 확인합니다.
      if (button||select) {
        let form;
        if(kind==='flow'&&action==='custom'&&arg==='new')form=createModal();
        if(kind==='flow'&&action==='details'){
          const e=draft(i.guildId,a,arg),selected=store.get('SELECT template_id FROM draft_steps WHERE event_id=?',arg);
          form=selected?.template_id?templateCreateModal(engine.template(selected.template_id,i.guildId),e):createModal(e);
        }
        if(kind==='flow'&&action==='template'&&arg==='new')form=templateCreateModal(engine.templateForUse(i.values[0],i.guildId));
        if(kind==='flow'&&action==='product'){const e=draft(i.guildId,a,arg),slot=Number(extra);requireThat(Number.isInteger(slot)&&slot>=1&&slot<=e.winner_count,'상품 번호를 확인해주세요.');form=productModal(e,engine.product(e,slot,true));}
        if(kind==='flow'&&action==='prize'){
          const e=draft(i.guildId,a,arg),slot=Number(extra);requireThat(Number.isInteger(slot)&&slot>=1&&slot<=e.winner_count,'상품 자리 번호가 잘못되었어요.');
          requireThat(!engine.direct(e.id,slot),'실물 자리는 연락 안내가 자동 준비되어 디지털 상품 입력이 필요하지 않아요.');
          form=contentModal(`form:prize:${arg}:${slot}`,`${slot}번 상품 내용`);
        }
        if(kind==='tpl'&&['new','meta','proof'].includes(action)){
          engine.requireManager(i.guildId,a);
          form=action==='new'?templateMetaModal():action==='meta'?templateMetaModal(engine.template(arg,i.guildId)):templateProofModal(engine.template(arg,i.guildId));
        }
        if (kind==='ui'&&action==='prizeform') {
          const e=draft(i.guildId,a,arg),slot=store.get("SELECT slot FROM prizes WHERE event_id=? AND delivery_mode='DIGITAL' ORDER BY secret IS NOT NULL,slot LIMIT 1",e.id)?.slot;
          requireThat(slot,'모든 자리가 실물·직접 전달이에요. 상품 단계에서 자리별 방식을 확인해주세요.');
          form=contentModal(`form:prize:${arg}`,'자리별 상품 전달 내용',slot);
        }
        if (kind==='ui'&&action==='proofsettings') form=proofSettingsModal(draft(i.guildId,a,arg));
        if (kind==='ereject') { engine.requireManager(i.guildId,a);engine.event(action,i.guildId);form=reasonModal(`form:reject:${action}`,'이벤트 신청 거절'); }
        if (kind==='claim') {
          const cid=kind==='claim'?action:arg,value=own(i.guildId,a,cid);
          if (kind==='claim'&&value.event.proof_required&&value.claim.status==='CLAIMABLE') await engine.startClaim(i.guildId,a,cid);
          const current=store.claim(cid);
          if (current.status==='SUBMITTING') {
            requireThat(current.submit_deadline>engine.now(),'인증 제출 시간이 지났어요.');
            form=contentModal(`form:proof:${cid}:${current.proof_version}`,'인증 자료 제출',null,`${current.slot}번 상품: ${engine.product(value.event,current.slot,true).name}\n${value.event.proof_instructions}`);
          } else if (kind==='ui') throw new UserError('지금은 인증 자료를 제출할 수 없어요.');
        }
        if (form) return await i.showModal(form);
      }
      if(mayOpenModal) await defer();
      if (chat) {
        if(command==='settings')return adminView(i,a);
        if(command==='alert:on'||command==='alert:off') {
          engine.setNotices(a,command==='alert:on');
          return respond(i,payload(`내 이벤트 생성·진행 승인·당첨자 수령 알림 DM을 **${command==='alert:on'?'켰어요':'껐어요'}**.\n계정별로 모든 서버에 적용됩니다.\n상품 전달과 인증·보완 안내는 별도로 수신합니다.`,[back()]));
        }
        throw new UserError('안내 메시지의 버튼을 사용해주세요.');
      }
      if(kind==='setup') {
        if(button&&action==='cancel')return respond(i,setup.cancel(i.guildId,a,arg));
        if(button&&action==='finish') {
          const guild=await i.client.guilds.fetch(i.guildId);
          return await respond(i,await setup.finish(i.guildId,a,arg,guild));
        }
        throw new UserError('유효하지 않은 초기설정 요청이에요.');
      }
      if (modal) {
        requireThat(kind==='form','유효하지 않은 입력창이에요.');
        if(action==='setupchannels')return await respond(i,await setup.submitChannels(i.guildId,a,arg,i.fields,await i.client.guilds.fetch(i.guildId)));
        if(action==='setuproles')return respond(i,setup.submitRoles(i.guildId,a,arg,i.fields));
        if (action==='create'||action==='templatecreate') {
          const eid=engine.create(i.guildId,a,{title:i.fields.getTextInputValue('title'),...(action==='templatecreate'?{templateId:arg}:{description:i.fields.getTextInputValue('description')}),durationMinutes:parseInteger(i.fields.getTextInputValue('duration')),claimMinutes:parseInteger(i.fields.getTextInputValue('claim')),winners:parseInteger(i.fields.getTextInputValue('winners'))});
          return await renderEvent(i,a,eid);
        }
        if(action==='details'||action==='templatedetails'){
          const e=draft(i.guildId,a,arg);engine.updateDraftDetails(i.guildId,a,arg,{title:i.fields.getTextInputValue('title'),description:action==='details'?i.fields.getTextInputValue('description'):e.description,durationMinutes:parseInteger(i.fields.getTextInputValue('duration')),claimMinutes:parseInteger(i.fields.getTextInputValue('claim')),winners:parseInteger(i.fields.getTextInputValue('winners'))});
          return await renderEvent(i,a,arg);
        }
        if(action==='product'){const visibility=i.fields.getStringSelectValues('visibility')[0];requireThat(['public','private'].includes(visibility),'상품명 공개 여부를 확인해주세요.');engine.setProductInfo(i.guildId,a,arg,Number(extra),i.fields.getTextInputValue('name'),visibility==='public');return respond(i,await flow.view(i.guildId,a,arg,'items',Number(extra)));}
        if (action==='prize') {
          draft(i.guildId,a,arg);engine.setPrize(i.guildId,a,arg,extra?Number(extra):parseInteger(i.fields.getTextInputValue('slot')),await contentFromModal(i));
          const next=store.get('SELECT slot FROM prizes WHERE event_id=? AND (secret IS NULL OR name IS NULL) ORDER BY slot LIMIT 1',arg)?.slot;
          return await respond(i,await flow.view(i.guildId,a,arg,next?'items':'review',next||1));
        }
        if (action==='proofsettings') { engine.setProofRequirement(i.guildId,a,arg,i.fields.getTextInputValue('instructions'));return await respond(i,await flow.view(i.guildId,a,arg,'items')); }
        if(action==='templatenew'||action==='templatemeta'){
          let tid=arg;
          if(action==='templatenew')tid=engine.createTemplate(i.guildId,a,i.fields.getTextInputValue('name'),i.fields.getTextInputValue('description'));
          else engine.updateTemplate(i.guildId,a,tid,{name:i.fields.getTextInputValue('name'),description:i.fields.getTextInputValue('description')});
          return await respond(i,await flow.templateView(i.guildId,a,tid));
        }
        if(action==='templateproof'){engine.updateTemplate(i.guildId,a,arg,{proof_instructions:i.fields.getTextInputValue('instructions')});return await respond(i,await flow.templateView(i.guildId,a,arg));}
        if (action==='reject') {engine.rejectEvent(i.guildId,a,arg,i.fields.getTextInputValue('reason'));return await renderEvent(i,a,arg);}
        throw new UserError('지원하지 않는 입력창이에요.');
      }
      if (select) {
        if(kind==='flow'&&action==='template'){engine.applyTemplate(i.guildId,a,arg,i.values[0]);return await renderEvent(i,a,arg);}
        if(kind==='tpl'&&action==='edit')return await respond(i,await flow.templateView(i.guildId,a,i.values[0]));
        if(kind==='tpl'&&action==='roles'){
          requireThat(['allow_roles','deny_roles'].includes(extra),'역할 조건을 확인해주세요.');engine.updateTemplate(i.guildId,a,arg,{[extra]:i.values});return await respond(i,await flow.templateView(i.guildId,a,arg));
        }
        if (kind==='pick'&&action==='event') return await renderEvent(i,a,i.values[0]);
        if (kind==='pick'&&action==='claim') return await renderClaim(i,a,i.values[0],arg==='manager');
        if (kind==='ui'&&action==='channelset') return await configureChannel(i,a,arg,extra||'condition_roles');
        if(kind==='ui'&&action==='settingskind')return settingsView(i,a,i.values[0]);
        if (kind==='ui'&&action==='roleset') {requireThat(Object.hasOwn(ROLES,arg),'역할 설정이 잘못되었어요.');engine.configure(i.guildId,a,arg,i.values);return rolesView(i,a,arg);}
        if (kind==='ui'&&action==='condition') {engine.replaceConditions(i.guildId,a,arg,extra,i.values);return await conditionView(i,a,arg);}
        throw new UserError('지원하지 않는 선택 메뉴예요.');
      }
      if (kind==='eapprove') {engine.approveEvent(i.guildId,a,action);return await renderEvent(i,a,action);}
      if (kind==='claim') {
        const value=own(i.guildId,a,action);
        if (value.claim.status==='CLAIMABLE') await engine.startClaim(i.guildId,a,action);
        return await renderClaim(i,a,action);
      }
      if (kind==='join') {const joined=engine.join(i.guildId,a,action);return respond(i,payload(joined?'참여했어요!':'이미 참여했어요.',[back()]));}
      if (kind==='leave') {engine.leave(i.guildId,a,action);return respond(i,payload('참여를 취소했어요.',[back()]));}
      if(kind==='flow'){
        if(action==='mode'||action==='modeok'){
          const e=draft(i.guildId,a,arg),slot=Number(extra),mode=parts[4];
          requireThat(Number.isInteger(slot)&&slot>=1&&slot<=e.winner_count&&['digital','direct'].includes(mode),'상품 자리와 전달 방식을 다시 선택해주세요.');
          const direct=mode==='direct';
          if(engine.direct(e.id,slot)===direct)return respond(i,await flow.view(i.guildId,a,e.id,'items',slot));
          if(action==='mode'&&direct&&store.get('SELECT secret IS NOT NULL filled FROM prizes WHERE event_id=? AND slot=?',e.id,slot)?.filled) {
            return respond(i,payload(`${slot}번을 실물·직접 전달로 바꾸면 이 자리의 디지털 상품 내용을 삭제합니다. 변경할까요?`,[row(btn(`flow:modeok:${arg}:${slot}:${mode}`,'이 자리 변경 확인',ButtonStyle.Danger),btn(`flow:step:${arg}:items:${slot}`,'돌아가기',ButtonStyle.Secondary))]));
          }
          engine.setDeliveryMode(i.guildId,a,arg,slot,direct);
          const next=direct?store.get('SELECT slot FROM prizes WHERE event_id=? AND (secret IS NULL OR name IS NULL) ORDER BY slot LIMIT 1',arg)?.slot:slot;
          return respond(i,await flow.view(i.guildId,a,arg,next?'items':'review',next||slot));
        }
        if(action==='choose')return respond(i,flow.choose(i.guildId,a,arg,pageNumber(extra)));
        if(action==='custom'){engine.applyTemplate(i.guildId,a,arg,null);return await renderEvent(i,a,arg);}
        if(action==='step')return await respond(i,await flow.view(i.guildId,a,arg,extra,parts[4]?Number(parts[4]):null));
        if(action==='noproof'){engine.setProofRequirement(i.guildId,a,arg,'');return await respond(i,await flow.view(i.guildId,a,arg,'items'));}
      }
      if(kind==='tpl'){
        engine.requireManager(i.guildId,a);
        if(action==='list')return respond(i,flow.templateList(i.guildId,a,pageNumber(arg)));
        if(action==='toggle'){const t=engine.template(arg,i.guildId);engine.updateTemplate(i.guildId,a,arg,{enabled:!t.enabled});return await respond(i,await flow.templateView(i.guildId,a,arg));}
        if(action==='clear'){engine.updateTemplate(i.guildId,a,arg,{allow_roles:[],deny_roles:[]});return await respond(i,await flow.templateView(i.guildId,a,arg));}
      }
      requireThat(kind==='ui','유효하지 않은 버튼이에요.');
      if(action==='create')return respond(i,flow.choose(i.guildId,a));
      if (action==='home') {
        try { await i.deleteReply();return; }
        catch { return respond(i,payload('공개 안내 메시지의 버튼에서 계속 이용해주세요.')); }
      }
      if (action==='help') return respond(i,payload('**GiveON 이용 안내**\n이벤트 신청 → 템플릿 선택 또는 직접 설정 → 상품 순서대로 등록 → 최종 확인 → 승인 요청\n승인되면 공개 이벤트의 참여 버튼을 누를 수 있어요.\n당첨 후 수령 버튼을 누르세요. 인증 이벤트는 입력창에 텍스트·이미지를 5분 내 제출하면 됩니다. 보완 요청도 새로 5분입니다.\n내 신청·내 당첨에서 언제든 이어서 진행할 수 있어요.\n지급 성공 후 봇 보관 원문은 삭제되므로 전달받은 DM을 보관해주세요.\n같은 이벤트에서 한 사람은 한 자리만 당첨되고, 다른 이벤트의 당첨은 독립적입니다.',[back()]));
      if (['mine','events','pending'].includes(action)) return eventsList(i,a,action,pageNumber(arg));
      if (['wins','reviews','issues'].includes(action)) return claimsList(i,a,action,pageNumber(arg));
      if (action==='eventclaims') return claimsList(i,a,action,pageNumber(extra),arg);
      if(action==='products')return respond(i,productsView(engine,i.guildId,a,arg,pageNumber(extra)));
      if (action==='event') return await renderEvent(i,a,arg,pageNumber(extra));
      if (action==='admin') return adminView(i,a);
      if (action==='channels') return settingsView(i,a);
      if (action==='rolehome') {
        engine.requireManager(i.guildId,a);
        return settingsView(i,a);
      }
      if (action==='roles') return rolesView(i,a,arg);
      if (action==='conditions') return await conditionView(i,a,arg);
      if (action==='conditionclear') {
        store.tx(()=>{engine.replaceConditions(i.guildId,a,arg,'allow_roles',[]);engine.replaceConditions(i.guildId,a,arg,'deny_roles',[]);});
        return await conditionView(i,a,arg);
      }
      if (action==='submit') {engine.submit(i.guildId,a,arg);return await renderEvent(i,a,arg);}
      if (action==='retry') {await engine.retry(i.guildId,a,arg);return await renderClaim(i,a,arg);}
      if (action==='reconcile') {await engine.reconcile(i.guildId,a,arg);return await renderClaim(i,a,arg,true);}
      if (action==='cancel') {
        const e=engine.event(arg,i.guildId);requireThat(e.owner_id===a.userId||engine.manager(i.guildId,a),'주최자나 관리자만 취소할 수 있어요.');
        return respond(i,payload('이 이벤트를 취소할까요? 미지급 상품·인증 원문은 즉시 삭제하며 봇에서 복구할 수 없습니다.',[row(btn(`ui:cancelok:${arg}`,'이벤트 취소 확인',ButtonStyle.Danger),btn(`ui:event:${arg}`,'돌아가기',ButtonStyle.Secondary))]));
      }
      if (action==='cancelok') {engine.cancel(i.guildId,a,arg);return await renderEvent(i,a,arg);}
      if (action==='reroll') {
        engine.requireManager(i.guildId,a);engine.claim(arg,i.guildId);
        return respond(i,payload('이 당첨 자리만 리롤할까요? 기존 당첨자는 이 이벤트에서 다시 추첨되지 않아요.',[row(btn(`ui:rerollok:${arg}`,'리롤 확인',ButtonStyle.Danger),btn('ui:admin','관리자 메뉴',ButtonStyle.Secondary))]));
      }
      if (action==='rerollok') {await engine.reroll(i.guildId,a,arg);return await renderClaim(i,a,arg,true);}
      throw new UserError('유효하지 않은 버튼이에요.');
    } catch(error) {
      const message=error instanceof UserError?error.message:'처리 중 오류가 발생했어요. 잠시 후 다시 시도하거나 관리자에게 문의해주세요.';
      if (!(error instanceof UserError)) console.error(`[요청 오류] ${typeof error.code==='number'?error.code:'INTERNAL_OR_NETWORK'}`);
      try {
        const [kind,action,token]=(i.customId||'').split(':');
        if(a&&(kind==='setup'||(kind==='form'&&['setupchannels','setuproles'].includes(action)))) {
          let view;try{view=setup.view(i.guildId,a,token,message);}catch{ /* 권한 없는 설정은 복구 화면에도 노출하지 않습니다. */ }
          if(view) {
            if(i.deferred||i.replied)return await respond(i,view);
            return await i.reply({...view,flags:MessageFlags.Ephemeral});
          }
        }
        if(i.deferred||i.replied) await respond(i,payload(message,[back()]));
        else await i.reply({...payload(message,[back()]),flags:MessageFlags.Ephemeral});
      } catch { /* 만료된 요청과 비밀 본문은 출력하지 않습니다. */ }
    }
  };
}
