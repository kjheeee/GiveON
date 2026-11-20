import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, TextDisplayBuilder, FileUploadBuilder, StringSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import { statuses, time } from './discord-transport.js';

export const btn = (id,label,style=ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
export const row = (...components) => new ActionRowBuilder().addComponents(components);
export const back = () => row(btn('ui:home','닫기',ButtonStyle.Secondary));
export const payload = (content,components=[],embeds=[]) => ({content,components,embeds,allowedMentions:{parse:[]}});
const input = (id,label,max=100,paragraph=false,required=true,value) => {
  const field = new TextInputBuilder().setCustomId(id).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short).setMaxLength(max).setRequired(required);
  if (value) field.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(field);
};
export function createModal(event=null) {
  return new ModalBuilder().setCustomId(event?`form:details:${event.id}`:'form:create').setTitle('1/5 · 이벤트 기본 정보').addLabelComponents(
    input('title','이벤트명',100,false,true,event?.title), input('description','상세 설명',1800,true,true,event?.description),
    input('duration','이벤트 진행 시간 (분)',5,false,true,String(event?event.duration_ms/60000:60)),
    input('claim','당첨 후 수령 제한시간 (분)',5,false,true,String(event?event.claim_ms/60000:30)),
    input('winners','당첨 인원 / 등록할 상품 수',3,false,true,String(event?.winner_count||1)),
  );
}
export function templateCreateModal(template,event=null) {
  return new ModalBuilder().setCustomId(event?`form:templatedetails:${event.id}`:`form:templatecreate:${template.id}`).setTitle('이벤트 기본 정보')
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${template.name}**\n${template.description}\n\n등록된 참여·차단 역할과 인증 설정이 함께 적용됩니다.`))
    .addLabelComponents(input('title','이벤트명',100,false,true,event?.title),input('duration','진행 시간 (분)',5,false,true,String(event?event.duration_ms/60000:60)),input('claim','수령 제한시간 (분)',5,false,true,String(event?event.claim_ms/60000:30)),input('winners','당첨 인원',3,false,true,String(event?.winner_count||1)));
}
export function productModal(event,product) {
  return new ModalBuilder().setCustomId(`form:product:${event.id}:${product.slot}`).setTitle(`${product.slot}번 상품 정보`)
    .addLabelComponents(input('name','상품명 (당첨자에게는 항상 표시)',100,false,true,product.named?product.name:undefined),
      new LabelBuilder().setLabel('공개 목록에 상품명을 표시할까요?').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('visibility').setRequired(true).setMinValues(1).setMaxValues(1)
        .addOptions({label:'공개',value:'public',default:product.publicName},{label:'비공개 · 당첨자와 관리 화면에만 표시',value:'private',default:!product.publicName})));
}
export function templateMetaModal(template=null) {
  return new ModalBuilder().setCustomId(template?`form:templatemeta:${template.id}`:'form:templatenew').setTitle('안내 템플릿')
    .addLabelComponents(input('name','템플릿 이름',80,false,true,template?.name),input('description','공개 안내 문구',1800,true,true,template?.description));
}
export function templateProofModal(template) {
  return new ModalBuilder().setCustomId(`form:templateproof:${template.id}`).setTitle('템플릿 인증 설정')
    .addLabelComponents(input('instructions','인증 안내 (비우면 인증 없음)',1000,true,false,template.proof_instructions));
}
export function contentModal(id,title,slot=null,instructions='') {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  if(instructions) modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(instructions));
  if (slot !== null) modal.addLabelComponents(input('slot','상품 번호',3,false,true,String(slot)));
  return modal.addLabelComponents(
    input('text',id.startsWith('form:proof:')?'인증 메시지 (사진만 제출해도 됩니다)':'전달할 메시지 (이미지만 첨부해도 됩니다)',1800,true,false),
    new LabelBuilder().setLabel('이미지 첨부').setDescription('최대 2장, 합계 8MiB. PNG·JPG·GIF·WebP')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('images').setMinValues(0).setMaxValues(2).setRequired(false).setFileTypes('.png','.jpg','.jpeg','.gif','.webp')),
  );
}
export function reasonModal(id,title,label='사유',value='') {
  return new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(input('reason',label,500,true,true,value));
}
export function proofSettingsModal(event) {
  return new ModalBuilder().setCustomId(`form:proofsettings:${event.id}`).setTitle('수령 전 인증 설정')
    .addLabelComponents(input('instructions','인증 안내 (비우면 인증 없이 수령)',1000,true,false,event.proof_instructions));
}
export function slotModal(id,title) { return new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(input('slot','상품 번호',3)); }
export function roleMenu(id,placeholder,roles=[]) {
  const menu = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(0).setMaxValues(20);
  if (roles.length) menu.setDefaultRoles(...roles);
  return row(menu);
}
export function conditionMenu(id,placeholder,roles,selected=[]) {
  const defaults=new Set(selected);
  return row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(0).setMaxValues(roles.length)
    .addOptions(roles.map(role=>({label:role.name.slice(0,100),value:role.id,default:defaults.has(role.id)}))));
}
export function channelMenu(key,label,current,context='condition_roles') {
  const menu = new ChannelSelectMenuBuilder().setCustomId(`ui:channelset:${key}:${context}`).setPlaceholder(label).setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
  if (current) menu.setDefaultChannels(current);
  return row(menu);
}
export function listView(title,rows,page,prefix,optionPrefix,format) {
  const components=[];
  const shown=rows.slice(0,20);
  if (shown.length) components.push(row(new StringSelectMenuBuilder().setCustomId(optionPrefix).setPlaceholder('항목을 선택해주세요').addOptions(shown.map(record => ({
    label:(record.title || record.id).slice(0,100),value:record.id,description:format(record).slice(0,100),
  })))));
  const nav=[];
  if (page>0) nav.push(btn(`${prefix}:${page-1}`,'이전',ButtonStyle.Secondary));
  if (rows.length>20) nav.push(btn(`${prefix}:${page+1}`,'다음',ButtonStyle.Secondary));
  nav.push(btn('ui:home','닫기',ButtonStyle.Secondary)); components.push(row(...nav));
  return payload(`**${title} · ${page+1}페이지**\n${shown.length ? '아래 목록에서 선택하세요.' : '표시할 항목이 없어요.'}`,components);
}
export function eventView(engine,transport,guildId,actor,eventId,page=0,manage=false) {
  if(manage)engine.requireManager(guildId,actor);
  const event=engine.visibleEvent(guildId,actor,eventId), own=event.owner_id===actor.userId,isManager=engine.manager(guildId,actor), manager=manage&&isManager,eventPrefix=manage?'manageevent':'event';
  const components=[];
  const count=engine.store.get('SELECT count(*) n FROM prizes WHERE event_id=? AND secret IS NOT NULL',eventId).n;
  if (own && event.status==='DRAFT') components.push(row(
    btn(`ui:prizeform:${eventId}`,'상품 등록',ButtonStyle.Success),btn(`ui:proofsettings:${eventId}`,'인증 설정'),
    btn(`ui:submit:${eventId}`,'승인 요청',ButtonStyle.Success),
  ));
  if (event.status==='DRAFT' && (own||manager)) components.push(row(btn(`ui:conditions:${eventId}`,'참여 역할 조건')));
  if (manager && event.status==='PENDING') components.push(row(btn(`eapprove:${eventId}`,'승인·시작',ButtonStyle.Success),btn(`ereject:${eventId}`,'신청 거절',ButtonStyle.Danger)));
  const management=[];
  if(!manage&&event.status==='PENDING')management.push(btn(`ui:event:${eventId}`,'상태 새로고침',ButtonStyle.Secondary));
  if (manager) management.push(btn(`ui:eventclaims:${eventId}:0`,'당첨 관리'));
  if ((own||manager) && !['COMPLETED','CANCELLED'].includes(event.status)) management.push(btn(`ui:cancel:${eventId}`,'이벤트 취소',ButtonStyle.Danger));
  if (management.length) components.push(row(...management));
  const embed=transport.eventEmbed(event,{revealPrivate:own||isManager});
  if(event.public_message_id) {
    const people=engine.participants(guildId,actor,eventId,page);
    embed.addFields({name:`참여자 목록 · 총 ${people.total}명 · ${people.page+1}/${people.pages}페이지`,
      value:people.users.length?people.users.map((id,index)=>`${people.page*25+index+1}. <@${id}>`).join('\n'):'아직 참여자가 없어요.'});
    const nav=[];
    if(people.page>0)nav.push(btn(`ui:${eventPrefix}:${eventId}:${people.page-1}`,'이전',ButtonStyle.Secondary));
    if(people.page+1<people.pages)nav.push(btn(`ui:${eventPrefix}:${eventId}:${people.page+1}`,'다음',ButtonStyle.Secondary));
    nav.push(btn(`ui:${eventPrefix}:${eventId}:${people.page}`,'새로고침',ButtonStyle.Secondary));components.push(row(...nav));
  }
  components.push(row(btn(`ui:${manage?'manageproducts':'products'}:${eventId}:0`,'상품 목록',ButtonStyle.Secondary)));
  components.push(back());
  return payload(`${!manage&&event.status==='PENDING'?'**관리자 승인 대기 중**\n관리자의 승인을 기다리고 있어요.\n':''}이벤트 번호: ${eventId}${own||manager ? `\n보관 중인 상품: ${count}건` : ''}${event.rejection_reason ? `\n거절 사유: ${event.rejection_reason}` : ''}`,components,[embed]);
}
export function claimView(engine,guildId,actor,claimId,managerView=false) {
  const {claim,event}=engine.claim(claimId,guildId);
  let description=`**${event.title}**\n당첨 번호: ${claim.id}\n${claim.slot}번 상품: **${engine.product(event,claim.slot,true).name}**\n상태: **${claim.status==='DELIVERED'&&engine.direct(event.id,claim.slot)?'주최자 연락 안내 완료':statuses[claim.status]}**`;
  const actions=[];
  if (!managerView) {
    if (claim.status==='CLAIMABLE') { description+=`\n수령 기한: ${time(claim.claim_deadline)}`; actions.push(btn(`claim:${claimId}`,'수령',ButtonStyle.Success)); }
    if (claim.status==='SUBMITTING') {
      description+=`\n제출 기한: ${time(claim.submit_deadline)}\n인증 안내: ${event.proof_instructions}`;
      if (claim.feedback) description+=`\n보완 요청: ${engine.vault.open(claim.feedback,`feedback:${claimId}`).text}`;
      actions.push(btn(`ui:proofupload:${claimId}`,'인증 자료 제출',ButtonStyle.Success));
    }
    if (claim.status==='DELIVERY_FAILED') { description+='\nDM을 허용한 뒤 다시 시도해주세요.'; actions.push(btn(`ui:retry:${claimId}`,'상품 전달 다시 시도')); }
    if (claim.status==='DELIVERY_UNKNOWN') description+='\n관리자에게 지급 확인을 요청해주세요.';
  } else {
    description+=`\n당첨자: <@${claim.user_id}>`;
    if (claim.status==='REVIEW'&&event.owner_id===actor.userId) actions.push(btn(`pview:${claimId}`,'인증 검수'));
    if (claim.status==='DELIVERY_UNKNOWN') actions.push(btn(`ui:reconcile:${claimId}`,'기존 지급 확인'));
    if (['ANNOUNCING','CLAIMABLE','SUBMITTING','REVIEW'].includes(claim.status)) actions.push(btn(`ui:reroll:${claimId}`,'이 자리 리롤',ButtonStyle.Danger));
  }
  const components=actions.length ? [row(...actions)] : [];
  components.push(back());
  return payload(description,components);
}

export function productsView(engine,guildId,actor,eventId,page=0,manage=false){
  if(manage)engine.requireManager(guildId,actor);
  const data=engine.products(guildId,actor,eventId,page),nav=[],prefix=manage?'manageproducts':'products';
  if(data.page>0)nav.push(btn(`ui:${prefix}:${eventId}:${data.page-1}`,'이전',ButtonStyle.Secondary));
  if(data.page+1<data.pages)nav.push(btn(`ui:${prefix}:${eventId}:${data.page+1}`,'다음',ButtonStyle.Secondary));
  nav.push(btn(`ui:${manage?'manageevent':'event'}:${eventId}`,'이벤트로',ButtonStyle.Secondary));
  return payload(`**${data.event.title} · 상품 목록 (${data.page+1}/${data.pages})**\n`+data.products.map(p=>`${p.slot}번 상품: **${p.name}**\n${p.direct?'실물·직접 전달':'디지털 자동 전달'}${p.publicName?'':' · 상품명 비공개'}`).join('\n\n'),[row(...nav),back()]);
}
