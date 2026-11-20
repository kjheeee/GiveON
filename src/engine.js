import { randomBytes } from 'node:crypto';
import { draw } from './draw.js';

export const PROOF_MS = 5 * 60_000;
export class UserError extends Error {}
const fail = message => { throw new UserError(message); };
const list = value => JSON.parse(value || '[]');
const hasRole = (actor, roles) => roles.some(id => actor.roles.includes(id));
const id = () => randomBytes(8).toString('hex');
const activeClaim = "status NOT IN ('EXPIRED','DENIED','DELIVERED')";

export class Engine {
  constructor(store, vault, transport, { owners = [], now = Date.now, guard = () => {}, rng } = {}) {
    Object.assign(this, { store, vault, transport, owners, now, guard, rng });
    this.drawing = new Set();
    this.dirty = new Set();
    this.ticking = false;
  }
  owner(actor) { return this.owners.includes(actor.userId); }
  manager(guildId, actor) {
    return this.owner(actor) || hasRole(actor, list(this.store.guild(guildId).manager_roles));
  }
  requireManager(guildId, actor) {
    if (!this.manager(guildId, actor)) fail('이 작업은 지정된 관리자만 할 수 있어요.');
  }
  event(eventId, guildId) {
    const event = this.store.event(eventId);
    if (!event || event.guild_id !== guildId) fail('이 서버의 이벤트를 찾을 수 없어요.');
    return event;
  }
  visibleEvent(guildId,actor,eventId) {
    const event=this.event(eventId,guildId);
    if(event.owner_id!==actor.userId&&!this.manager(guildId,actor)&&!(event.public_message_id&&['RUNNING','DRAWN','COMPLETED','CANCELLED'].includes(event.status)))fail('이 이벤트를 조회할 수 없어요.');
    return event;
  }
  participants(guildId,actor,eventId,page=0) {
    this.guard();this.visibleEvent(guildId,actor,eventId);
    if(!Number.isSafeInteger(page)||page<0)fail('참여자 페이지 번호가 잘못되었어요.');
    const total=this.store.get('SELECT count(*) n FROM entries WHERE event_id=?',eventId).n;
    const pages=Math.max(1,Math.ceil(total/25)),current=Math.min(page,pages-1);
    const users=this.store.all('SELECT user_id FROM entries WHERE event_id=? ORDER BY joined_at,user_id LIMIT 25 OFFSET ?',eventId,current*25).map(row=>row.user_id);
    return {total,page:current,pages,users};
  }
  claim(claimId, guildId) {
    const claim = this.store.claim(claimId);
    if (!claim) fail('당첨 정보를 찾을 수 없어요.');
    return { claim, event: this.event(claim.event_id, guildId) };
  }
  validateConditionRoles(guildId, roleIds) {
    const allowed = new Set(list(this.store.guild(guildId).condition_roles));
    if (roleIds.some(role => !allowed.has(role))) fail('관리자가 등록하지 않은 조건 역할이 포함되어 있어요. 참여 조건을 다시 선택해주세요.');
  }
  validateConditionPair(guildId,allowed,denied) {
    this.validateConditionRoles(guildId,[...allowed,...denied]);
    if(allowed.some(role=>denied.includes(role))) fail('같은 역할을 참여 가능과 차단 조건에 동시에 넣을 수 없어요.');
    if(allowed.some(role=>list(this.store.guild(guildId).blocked_roles).includes(role))) fail('공통 참여 금지 역할은 참여 가능 조건으로 사용할 수 없어요.');
  }
  requireCustomDraft(event) {
    if(this.store.get('SELECT template_id FROM draft_steps WHERE event_id=?',event.id)?.template_id) fail('템플릿의 문구·역할·인증은 함께 적용됩니다. 다른 템플릿을 선택하거나 직접 설정으로 전환해주세요.');
  }
  template(templateId,guildId) {
    const value=this.store.get('SELECT * FROM event_templates WHERE id=? AND guild_id=?',templateId,guildId);
    if(!value) fail('이 서버의 템플릿을 찾을 수 없어요.');
    return value;
  }
  templateForUse(templateId,guildId) {
    const value=this.template(templateId,guildId);
    if(!value.enabled) fail('현재 사용 중인 템플릿이 아니에요. 다른 템플릿을 선택해주세요.');
    this.validateConditionPair(guildId,list(value.allow_roles),list(value.deny_roles));
    return value;
  }
  validateEventTemplate(event) {
    const selected=this.store.get('SELECT * FROM draft_steps WHERE event_id=?',event.id);
    if(selected?.template_id) {
      const template=this.templateForUse(selected.template_id,event.guild_id);
      if(template.revision!==selected.template_revision) fail('선택한 템플릿이 변경됐어요. 최신 템플릿을 다시 선택해 내용을 확인해주세요.');
    }
  }
  createTemplate(guildId,actor,name,description) {
    this.guard();this.requireManager(guildId,actor);
    if(!name?.trim()||name.length>80||!description?.trim()||description.length>1800) fail('템플릿 이름은 80자, 안내 문구는 1,800자 이내로 입력해주세요.');
    const templateId=id();
    this.store.run("INSERT INTO event_templates(id,guild_id,name,description,proof_instructions,updated_at,created_by) VALUES (?,?,?,?,'',?,?)",templateId,guildId,name.trim(),description.trim(),this.now(),actor.userId);
    return templateId;
  }
  updateTemplate(guildId,actor,templateId,changes) {
    this.guard();this.requireManager(guildId,actor);
    const current=this.template(templateId,guildId);
    const allowedKeys=['name','description','allow_roles','deny_roles','proof_instructions','enabled'];
    if(Object.keys(changes).some(key=>!allowedKeys.includes(key))) fail('지원하지 않는 템플릿 설정이에요.');
    const next={...current,...changes};
    if(!next.name?.trim()||next.name.length>80||!next.description?.trim()||next.description.length>1800||typeof next.proof_instructions!=='string'||next.proof_instructions.length>1000) fail('템플릿 이름·문구·인증 안내 길이를 확인해주세요.');
    const permitted=Array.isArray(next.allow_roles)?next.allow_roles:list(next.allow_roles),denied=Array.isArray(next.deny_roles)?next.deny_roles:list(next.deny_roles);
    if(permitted.length>20||denied.length>20) fail('조건 역할은 각각 최대 20개예요.');
    if(!(Object.keys(changes).length===1&&changes.enabled===false))this.validateConditionPair(guildId,permitted,denied);
    this.store.run('UPDATE event_templates SET name=?,description=?,allow_roles=?,deny_roles=?,proof_required=?,proof_instructions=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?',next.name.trim(),next.description.trim(),JSON.stringify([...new Set(permitted)]),JSON.stringify([...new Set(denied)]),Number(Boolean(next.proof_instructions.trim())),next.proof_instructions.trim(),Number(Boolean(next.enabled)),this.now(),templateId);
  }
  applyTemplate(guildId,actor,eventId,templateId) {
    this.guard();const event=this.event(eventId,guildId);
    if(event.owner_id!==actor.userId||event.status!=='DRAFT') fail('본인의 초안에서만 템플릿을 선택할 수 있어요.');
    const template=templateId?this.templateForUse(templateId,guildId):null;
    this.store.tx(()=>{
      if(template) this.store.run('UPDATE events SET description=?,allow_roles=?,deny_roles=?,proof_required=?,proof_instructions=? WHERE id=?',template.description,template.allow_roles,template.deny_roles,template.proof_required,template.proof_instructions,eventId);
      this.store.run(`INSERT INTO draft_steps(event_id,step,slot,template_id,template_revision) VALUES (?,?,1,?,?)
        ON CONFLICT(event_id) DO UPDATE SET step=excluded.step,template_id=excluded.template_id,template_revision=excluded.template_revision`,eventId,template?'items':'conditions',template?.id||null,template?.revision||null);
    });
  }
  configure(guildId, actor, key, value) {
    this.guard();
    this.requireManager(guildId, actor);
    const allowed = ['manager_channel', 'event_channel', 'manager_roles', 'condition_roles', 'blocked_roles', 'mention_roles'];
    if (!allowed.includes(key)) fail('지원하지 않는 설정이에요.');
    if (key === 'manager_roles' && !this.owner(actor)) fail('관리 역할은 봇 소유자만 변경할 수 있어요.');
    this.store.guild(guildId);
    if (key.endsWith('_roles')) {
      if (!Array.isArray(value) || value.length > 20 || value.some(role => !/^\d{15,22}$/.test(role) || role === guildId)) {
        fail('역할은 @everyone을 제외하고 최대 20개까지 설정할 수 있어요.');
      }
      value = JSON.stringify([...new Set(value)]);
    }
    this.store.run(`UPDATE guilds SET ${key}=? WHERE id=?`, value, guildId);
  }
  create(guildId, actor, options) {
    this.guard();
    this.requireHostAllowed(guildId,actor.userId);
    const template=options.templateId?this.templateForUse(options.templateId,guildId):null;
    const { title, description, durationMinutes, claimMinutes, winners, proofRequired = false, proofInstructions = '' } = template?{...options,description:template.description,proofRequired:Boolean(template.proof_required),proofInstructions:template.proof_instructions}:options;
    if (!title?.trim() || title.length > 100 || !description?.trim() || description.length > 1800) fail('상품명은 100자, 설명은 1,800자 이내로 입력해주세요.');
    if (!Number.isInteger(winners) || winners < 1 || winners > 100) fail('당첨 인원은 1~100명이에요.');
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200) fail('진행 시간은 1분~30일이에요.');
    if (!Number.isInteger(claimMinutes) || claimMinutes < 1 || claimMinutes > 10080) fail('수령 시간은 1분~7일이에요.');
    if (proofInstructions.length > 1000 || (proofRequired && !proofInstructions.trim())) fail('인증 이벤트에는 1,000자 이내 인증 안내가 필요해요.');
    this.store.guild(guildId);
    const eventId = id();
    this.store.tx(() => {
      this.store.run(`INSERT INTO events(id,guild_id,owner_id,title,description,duration_ms,claim_ms,
        winner_count,proof_required,proof_instructions,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      eventId, guildId, actor.userId, title.trim(), description.trim(), durationMinutes * 60000,
      claimMinutes * 60000, winners, Number(proofRequired), proofInstructions, this.now());
      for (let slot = 1; slot <= winners; slot++) this.store.run('INSERT INTO prizes(event_id,slot) VALUES (?,?)', eventId, slot);
      if(template) {
        this.store.run('UPDATE events SET allow_roles=?,deny_roles=? WHERE id=?',template.allow_roles,template.deny_roles,eventId);
        this.store.run("INSERT INTO draft_steps(event_id,step,slot,template_id,template_revision) VALUES (?,'items',1,?,?)",eventId,template.id,template.revision);
      }
      this.store.audit(eventId, null, 'CREATED', actor.userId, this.now());
    });
    return eventId;
  }
  validateContent(content) {
    if (!content || typeof content.text !== 'string' || content.text.length > 1800 || !Array.isArray(content.images) || content.images.length > 2) fail('텍스트 1,800자와 이미지 최대 2장을 입력할 수 있어요.');
    if (!content.text.trim() && !content.images.length) fail('텍스트나 이미지를 하나 이상 입력해주세요.');
    let size = 0;
    for (const image of content.images) {
      if (!/^(png|jpg|gif|webp)$/.test(image.ext) || typeof image.data !== 'string') fail('지원하지 않는 이미지예요.');
      size += Buffer.byteLength(image.data, 'base64');
    }
    if (size > 8 * 1024 * 1024) fail('이미지 합계는 8MiB 이하여야 해요.');
  }
  updateDraftDetails(guildId, actor, eventId, options) {
    this.guard();
    const event=this.event(eventId,guildId);
    if(event.owner_id!==actor.userId||event.status!=='DRAFT') fail('본인의 초안에서만 기본 정보를 바꿀 수 있어요.');
    const {title,durationMinutes,claimMinutes,winners}=options;
    const description=this.store.get('SELECT template_id FROM draft_steps WHERE event_id=?',eventId)?.template_id?event.description:options.description;
    if(!title?.trim()||title.length>100||!description?.trim()||description.length>1800) fail('상품명은 100자, 설명은 1,800자 이내로 입력해주세요.');
    if(!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>43200||!Number.isInteger(claimMinutes)||claimMinutes<1||claimMinutes>10080||!Number.isInteger(winners)||winners<1||winners>100) fail('시간과 당첨 인원을 올바르게 입력해주세요.');
    if(!this.direct(eventId)&&this.store.get('SELECT slot FROM prizes WHERE event_id=? AND slot>? AND secret IS NOT NULL LIMIT 1',eventId,winners)) fail('줄어드는 자리에 등록된 상품이 있어 당첨 인원을 줄일 수 없어요. 등록한 상품 내용은 유지됩니다.');
    this.store.tx(()=>{
      this.store.run('UPDATE events SET title=?,description=?,duration_ms=?,claim_ms=?,winner_count=? WHERE id=?',title.trim(),description.trim(),durationMinutes*60000,claimMinutes*60000,winners,eventId);
      for(let slot=1;slot<=winners;slot++) this.store.run('INSERT OR IGNORE INTO prizes(event_id,slot) VALUES (?,?)',eventId,slot);
      if(this.direct(eventId))this.store.run('UPDATE prizes SET secret=NULL WHERE event_id=? AND slot>?',eventId,winners);
      this.store.run('DELETE FROM prizes WHERE event_id=? AND slot>? AND secret IS NULL',eventId,winners);
      if(this.direct(eventId))for(let slot=1;slot<=winners;slot++)this.store.run('UPDATE prizes SET secret=? WHERE event_id=? AND slot=?',this.vault.seal(this.contactContent(event),`prize:${eventId}:${slot}`),eventId,slot);
    });
  }
  setPrize(guildId, actor, eventId, slot, content) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId) fail('상품 내용은 주최자만 등록할 수 있어요.');
    if (event.status !== 'DRAFT') fail('신청 전 초안에서만 상품을 등록할 수 있어요.');
    if(this.direct(eventId))fail('직접 전달 방식은 개별 상품 대신 주최자 연락 안내를 전달해요.');
    if (!Number.isInteger(slot) || slot < 1 || slot > event.winner_count) fail('당첨 인원 안의 자리 번호를 입력해주세요.');
    this.validateContent(content);
    this.store.run('UPDATE prizes SET secret=? WHERE event_id=? AND slot=?', this.vault.seal(content, `prize:${eventId}:${slot}`), eventId, slot);
  }
  setCondition(guildId, actor, eventId, type, roleId, remove = false) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId && !this.manager(guildId, actor)) fail('다른 사람의 이벤트 조건은 변경할 수 없어요.');
    if (event.status !== 'DRAFT') fail('초안에서만 조건을 변경할 수 있어요.');
    this.requireCustomDraft(event);
    if (!['allow_roles', 'deny_roles'].includes(type) || !/^\d{15,22}$/.test(roleId) || roleId === guildId) fail('조건 역할이 잘못되었어요.');
    const roles = new Set(list(event[type]));
    if (remove) roles.delete(roleId); else roles.add(roleId);
    if (roles.size > 20) fail('각 조건 역할은 최대 20개예요.');
    this.validateConditionRoles(guildId,[...roles]);
    if([...roles].some(role=>list(event[type==='allow_roles'?'deny_roles':'allow_roles']).includes(role))) fail('같은 역할을 참여 가능과 차단 조건에 동시에 넣을 수 없어요.');
    if(type==='allow_roles'&&[...roles].some(role=>list(this.store.guild(guildId).blocked_roles).includes(role))) fail('공통 참여 금지 역할은 참여 가능 조건으로 사용할 수 없어요.');
    this.store.run(`UPDATE events SET ${type}=? WHERE id=?`, JSON.stringify([...roles]), eventId);
  }
  submit(guildId, actor, eventId) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId || event.status !== 'DRAFT') fail('본인의 초안만 신청할 수 있어요.');
    this.requireHostAllowed(guildId,event.owner_id);
    const settings = this.store.guild(guildId);
    if (!settings.manager_channel || !settings.event_channel) fail('관리자가 먼저 관리 채널과 이벤트 채널을 설정해야 해요.');
    this.validateConditionPair(guildId,list(event.allow_roles),list(event.deny_roles));
    this.validateEventTemplate(event);
    if (this.store.get('SELECT count(*) n FROM prizes WHERE event_id=? AND secret IS NOT NULL', eventId).n !== event.winner_count) fail('당첨 인원만큼 상품 전달 내용을 모두 등록해주세요.');
    this.store.tx(() => {
      this.store.run("UPDATE events SET status='PENDING' WHERE id=?", eventId);
      this.store.queue('application', eventId, this.now());
      this.store.audit(eventId, null, 'SUBMITTED', actor.userId, this.now());
    });
  }
  setProofRequirement(guildId, actor, eventId, instructions) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId || event.status !== 'DRAFT') fail('본인의 초안에서만 인증 설정을 바꿀 수 있어요.');
    this.requireCustomDraft(event);
    if (typeof instructions !== 'string' || instructions.length > 1000) fail('인증 안내는 1,000자 이내로 입력해주세요.');
    const value = instructions.trim();
    this.store.run('UPDATE events SET proof_required=?,proof_instructions=? WHERE id=?', Number(Boolean(value)), value, eventId);
  }
  replaceConditions(guildId, actor, eventId, type, roleIds) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId && !this.manager(guildId, actor)) fail('다른 사람의 이벤트 조건은 변경할 수 없어요.');
    if (event.status !== 'DRAFT') fail('초안에서만 조건을 변경할 수 있어요.');
    this.requireCustomDraft(event);
    if (!['allow_roles','deny_roles'].includes(type) || !Array.isArray(roleIds) || roleIds.length > 20 ||
      roleIds.some(role => !/^\d{15,22}$/.test(role) || role === guildId)) fail('조건 역할은 @everyone을 제외하고 최대 20개까지 설정해주세요.');
    this.validateConditionRoles(guildId,roleIds);
    if(roleIds.some(role=>list(event[type==='allow_roles'?'deny_roles':'allow_roles']).includes(role))) fail('같은 역할을 참여 가능과 차단 조건에 동시에 넣을 수 없어요.');
    if(type==='allow_roles'&&roleIds.some(role=>list(this.store.guild(guildId).blocked_roles).includes(role))) fail('공통 참여 금지 역할은 참여 가능 조건으로 사용할 수 없어요.');
    this.store.run(`UPDATE events SET ${type}=? WHERE id=?`, JSON.stringify([...new Set(roleIds)]), eventId);
  }
  approveEvent(guildId, actor, eventId) {
    this.guard();
    this.requireManager(guildId, actor);
    const event = this.event(eventId, guildId);
    if (event.status !== 'PENDING') fail('승인 대기 중인 이벤트가 아니에요.');
    this.requireHostAllowed(guildId,event.owner_id);
    this.validateConditionPair(guildId,list(event.allow_roles),list(event.deny_roles));
    this.validateEventTemplate(event);
    this.store.tx(() => {
      this.store.run("UPDATE events SET status='STARTING',approved_by=? WHERE id=?", actor.userId, eventId);
      this.store.queue('start', eventId, this.now());
      this.store.audit(eventId, null, 'APPROVED', actor.userId, this.now());
    });
  }
  rejectEvent(guildId, actor, eventId, reason = '관리자 검토 결과 거절되었습니다.') {
    this.guard();
    this.requireManager(guildId, actor);
    const event = this.event(eventId, guildId);
    if (event.status !== 'PENDING') fail('승인 대기 중인 이벤트가 아니에요.');
    if (reason.length > 500) fail('사유는 500자 이내로 입력해주세요.');
    this.store.tx(() => {
      this.store.run("UPDATE events SET status='REJECTED',rejection_reason=? WHERE id=?", reason, eventId);
      this.store.run('UPDATE prizes SET secret=NULL WHERE event_id=?',eventId);
      this.store.queue('rejected', eventId, this.now());
      this.store.audit(eventId, null, 'REJECTED', actor.userId, this.now());
    });
  }
  eligibility(event, actor) {
    if (!actor || actor.isBot) return false;
    const settings = this.store.guild(event.guild_id);
    if (hasRole(actor, list(settings.blocked_roles)) || hasRole(actor, list(event.deny_roles))) return false;
    const allowed = list(event.allow_roles);
    return !allowed.length || hasRole(actor, allowed);
  }
  join(guildId, actor, eventId) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.status !== 'RUNNING' || event.ends_at <= this.now()) fail('참여가 마감된 이벤트예요.');
    if (!this.eligibility(event, actor)) fail('이 이벤트의 참여 조건을 충족하지 못했어요.');
    const result = this.store.run('INSERT OR IGNORE INTO entries(event_id,user_id,joined_at) VALUES (?,?,?)', eventId, actor.userId, this.now());
    this.dirty.add(eventId);
    return Boolean(result.changes);
  }
  leave(guildId, actor, eventId) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.status !== 'RUNNING' || event.ends_at <= this.now()) fail('참여 마감 전까지만 취소할 수 있어요.');
    this.store.run('DELETE FROM entries WHERE event_id=? AND user_id=?', eventId, actor.userId);
    this.dirty.add(eventId);
  }
  async fillVacancies(eventId) {
    if (this.drawing.has(eventId)) return;
    this.drawing.add(eventId);
    try {
      const event = this.store.event(eventId);
      if (event?.status !== 'DRAWN') return;
      const slots = this.store.all("SELECT slot FROM prizes WHERE event_id=? AND status='AVAILABLE' ORDER BY slot", eventId);
      if (!slots.length) return this.closeIfDone(eventId);
      // 과거 당첨자는 이 이벤트에서만 제외합니다. 다른 이벤트의 이력은 조회하지 않습니다.
      const entries = this.store.all(`SELECT user_id FROM entries e WHERE event_id=? AND NOT EXISTS
        (SELECT 1 FROM claims c WHERE c.event_id=e.event_id AND c.user_id=e.user_id)`, eventId);
      const eligible = [];
      for (const entry of entries) {
        const member = await this.transport.member(event.guild_id, entry.user_id);
        if (this.eligibility(event, member)) eligible.push(entry.user_id);
      }
      this.guard();
      this.store.tx(() => {
        if (this.store.event(eventId).status !== 'DRAWN') return;
        const vacant = this.store.all("SELECT slot FROM prizes WHERE event_id=? AND status='AVAILABLE' ORDER BY slot", eventId);
        const previous = new Set(this.store.all('SELECT user_id FROM claims WHERE event_id=?', eventId).map(row => row.user_id));
        const winners = draw(eligible.filter(userId => !previous.has(userId)), vacant.length, this.rng);
        for (let i = 0; i < vacant.length; i++) {
          const slot = vacant[i].slot;
          const winner = winners[i];
          if (!winner) {
            this.store.run("UPDATE prizes SET status='EXHAUSTED',secret=NULL WHERE event_id=? AND slot=?", eventId, slot);
            continue;
          }
          const claimId = id();
          this.store.run(`INSERT INTO claims(id,event_id,slot,user_id,status,claim_deadline,created_at,delivery_nonce)
            VALUES (?,?,?,?,'ANNOUNCING',0,?,?)`, claimId, eventId, slot, winner, this.now(), id());
          this.store.run("UPDATE prizes SET status='ASSIGNED' WHERE event_id=? AND slot=?", eventId, slot);
          this.store.queue('winner', claimId, this.now());
          this.store.audit(eventId, claimId, 'DRAWN', winner, this.now());
        }
      });
      this.dirty.add(eventId);
      this.closeIfDone(eventId);
    } finally { this.drawing.delete(eventId); }
  }
  async startClaim(guildId, actor, claimId) {
    this.guard();
    const { claim, event } = this.claim(claimId, guildId);
    if (claim.user_id !== actor.userId) fail('당첨자 본인만 수령할 수 있어요.');
    if (claim.status !== 'CLAIMABLE' || claim.claim_deadline <= this.now()) fail('수령 가능 시간이 지났거나 이미 진행 중인 당첨 건이에요. 내 당첨 버튼으로 확인해주세요.');
    if (!this.eligibility(event, actor)) fail('현재 참여 자격을 충족하지 못해 수령할 수 없어요.');
    if (event.proof_required) {
      this.store.run("UPDATE claims SET status='SUBMITTING',submit_deadline=? WHERE id=? AND status='CLAIMABLE'", this.now() + PROOF_MS, claimId);
      this.store.audit(event.id, claimId, 'PROOF_STARTED', actor.userId, this.now());
      return 'SUBMITTING';
    }
    this.store.run("UPDATE claims SET status='READY' WHERE id=? AND status='CLAIMABLE'", claimId);
    await this.deliver(claimId);
    return this.store.claim(claimId).status;
  }
  reserveProof(guildId, actor, claimId) {
    this.guard();
    const { claim } = this.claim(claimId, guildId);
    if (claim.user_id !== actor.userId) fail('본인의 당첨 건에만 제출할 수 있어요.');
    if (claim.status !== 'SUBMITTING' || claim.submit_deadline <= this.now()) fail('인증 제출 가능 시간이 아니에요.');
    const ticket = id();
    this.store.run("UPDATE claims SET status='UPLOADING',upload_until=?,upload_token=? WHERE id=? AND status='SUBMITTING'", this.now() + 60_000, ticket, claimId);
    return ticket;
  }
  abortProof(claimId, ticket) {
    this.guard();
    this.store.run("UPDATE claims SET status='SUBMITTING',upload_until=NULL,upload_token=NULL WHERE id=? AND status='UPLOADING' AND upload_token=?", claimId, ticket);
  }
  submitProof(guildId, actor, claimId, content, ticket = null) {
    this.guard();
    const { claim, event } = this.claim(claimId, guildId);
    if (claim.user_id !== actor.userId) fail('본인의 당첨 건에만 제출할 수 있어요.');
    const uploading = ticket && claim.status === 'UPLOADING' && claim.upload_token === ticket && claim.upload_until > this.now();
    if (!uploading && (ticket || claim.status !== 'SUBMITTING' || claim.submit_deadline <= this.now())) fail('인증 제출 가능 시간이 아니에요.');
    this.validateContent(content);
    const version = claim.proof_version + 1;
    this.store.tx(() => {
      this.store.run("UPDATE claims SET status='REVIEW',proof=?,feedback=NULL,proof_version=?,submit_deadline=NULL,upload_until=NULL,upload_token=NULL WHERE id=?",
        this.vault.seal(content, `proof:${claimId}:${version}`), version, claimId);
      this.store.queue('proof', claimId, this.now(), `:host:${version}`);
      this.store.audit(event.id, claimId, 'PROOF_SUBMITTED', actor.userId, this.now());
    });
  }
  proofReviewer(guildId,actor,claimId) {
    const value=this.claim(claimId,guildId);
    if(value.event.owner_id!==actor.userId)fail('이 이벤트의 주최자만 인증을 검수할 수 있어요.');
    return value;
  }
  viewProof(guildId, actor, claimId) {
    this.guard();
    const { claim } = this.proofReviewer(guildId,actor,claimId);
    if (claim.status !== 'REVIEW' || !claim.proof) fail('검수 대기 중인 인증 자료가 없어요.');
    return { content: this.vault.open(claim.proof, `proof:${claimId}:${claim.proof_version}`), version: claim.proof_version };
  }
  async review(guildId, actor, claimId, version, action, reason = '') {
    this.guard();
    const { claim, event } = this.proofReviewer(guildId,actor,claimId);
    if (claim.status !== 'REVIEW' || claim.proof_version !== version) fail('이미 처리되었거나 새 인증 자료가 제출되었어요. 다시 조회해주세요.');
    if (!['approve', 'rework', 'deny'].includes(action)) fail('지원하지 않는 검수 작업이에요.');
    if (reason.length > 500) fail('사유는 500자 이내로 입력해주세요.');
    this.store.tx(() => {
      if (action === 'approve') {
        this.store.run("UPDATE claims SET status='READY',proof=NULL,feedback=NULL,reviewer_id=? WHERE id=?", actor.userId, claimId);
      } else if (action === 'rework') {
        this.store.run("UPDATE claims SET status='SUBMITTING',proof=NULL,feedback=?,submit_deadline=?,reviewer_id=? WHERE id=?",
          this.vault.seal({ text: reason || '인증 내용을 보완해 다시 제출해주세요.' }, `feedback:${claimId}`),
          this.now() + PROOF_MS, actor.userId, claimId);
        this.store.queue('rework', claimId, this.now(), `:dm:${version}`);
      } else {
        this.store.run("UPDATE claims SET status='DENIED',proof=NULL,feedback=NULL,reviewer_id=? WHERE id=?", actor.userId, claimId);
        this.store.run("UPDATE prizes SET status='AVAILABLE' WHERE event_id=? AND slot=?", event.id, claim.slot);
        this.store.queue('denied', claimId, this.now());
      }
      this.store.audit(event.id, claimId, `PROOF_${action.toUpperCase()}`, actor.userId, this.now());
    });
    if (action === 'approve') await this.deliver(claimId);
    if (action === 'deny') await this.fillVacancies(event.id);
  }
  async retry(guildId, actor, claimId) {
    this.guard();
    const { claim } = this.claim(claimId, guildId);
    if (claim.user_id !== actor.userId) fail('당첨자만 재전송을 요청할 수 있어요.');
    if (claim.status !== 'DELIVERY_FAILED') fail('확실히 전송에 실패한 건만 재전송할 수 있어요. 전송 결과 불명 상태는 관리자의 지급 확인이 필요해요.');
    await this.deliver(claimId);
    return this.store.claim(claimId).status;
  }
  async deliver(claimId) {
    this.guard();
    const acquired = this.store.run("UPDATE claims SET status='PREPARING' WHERE id=? AND status IN ('READY','DELIVERY_FAILED')", claimId);
    if (!acquired.changes) return;
    let claim = this.store.claim(claimId);
    const event = this.store.event(claim.event_id);
    let channelId, content;
    try {
      channelId = await this.transport.prepareDM(claim.user_id);
      this.guard();
      const prize = this.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=?', claim.event_id, claim.slot);
      content = this.direct(event.id)?this.contactContent(event):this.vault.open(prize.secret, `prize:${claim.event_id}:${claim.slot}`);
    } catch {
      this.store.run("UPDATE claims SET status='DELIVERY_FAILED',last_error='PREPARE_FAILED' WHERE id=? AND status='PREPARING'", claimId);
      this.store.queue('deliveryIssue', claimId, this.now(), `:prepare:${this.now()}`);
      return;
    }
    this.store.run("UPDATE claims SET status='SENDING',dm_channel_id=?,send_started=?,last_error=NULL WHERE id=? AND status='PREPARING'", channelId, this.now(), claimId);
    claim = this.store.claim(claimId);
    let message;
    try { message = await this.transport.sendPrize(channelId, event, claim, content); }
    catch (error) {
      this.guard();
      const status = error.definite ? 'DELIVERY_FAILED' : 'DELIVERY_UNKNOWN';
      this.store.run('UPDATE claims SET status=?,last_error=? WHERE id=? AND status=\'SENDING\'', status, error.definite ? 'DISCORD_REJECTED' : 'RESULT_UNKNOWN', claimId);
      this.store.queue('deliveryIssue', claimId, this.now(), `:${claim.send_started}`);
      return;
    }
    this.guard();
    this.finishDelivery(claimId, message.id);
  }
  finishDelivery(claimId, messageId) {
    const claim = this.store.claim(claimId);
    if (!claim || !['SENDING', 'DELIVERY_UNKNOWN'].includes(claim.status)) return;
    this.store.tx(() => {
      this.store.run("UPDATE claims SET status='DELIVERED',proof=NULL,feedback=NULL,completed_at=?,dm_message_id=?,last_error=NULL WHERE id=?", this.now(), messageId, claimId);
      this.store.run("UPDATE prizes SET status='DELIVERED',secret=NULL WHERE event_id=? AND slot=?", claim.event_id, claim.slot);
      this.store.audit(claim.event_id, claimId, 'DELIVERED', claim.user_id, this.now());
      this.store.queue('received', claimId, this.now());
    });
    this.closeIfDone(claim.event_id);
  }
  async reconcile(guildId, actor, claimId) {
    this.guard();
    this.requireManager(guildId, actor);
    const { claim } = this.claim(claimId, guildId);
    if (claim.status !== 'DELIVERY_UNKNOWN') fail('전송 결과 확인이 필요한 상태가 아니에요.');
    const message = await this.transport.findPrize(claim);
    this.guard();
    if (!message) fail('최근 DM에서 지급 기록을 확인하지 못했어요. 중복 지급을 막기 위해 자동 재전송하지 않습니다. 운영 문서를 확인해주세요.');
    this.finishDelivery(claimId, message.id);
  }
  expireClaim(claimId, manual = false, actorId = null) {
    this.guard();
    const claim = this.store.claim(claimId);
    if (!claim || !['ANNOUNCING', 'CLAIMABLE', 'SUBMITTING', 'UPLOADING', 'REVIEW'].includes(claim.status)) fail('리롤할 수 없는 상태예요.');
    this.store.tx(() => {
      this.store.run("UPDATE claims SET status='EXPIRED',proof=NULL,feedback=NULL,submit_deadline=NULL,upload_until=NULL,upload_token=NULL WHERE id=?", claimId);
      this.store.run("UPDATE prizes SET status='AVAILABLE' WHERE event_id=? AND slot=?", claim.event_id, claim.slot);
      this.store.audit(claim.event_id, claimId, manual ? 'MANUAL_REROLL' : 'EXPIRED', actorId, this.now());
      this.store.queue('expired', claimId, this.now());
    });
  }
  async reroll(guildId, actor, claimId) {
    this.requireManager(guildId, actor);
    const { claim } = this.claim(claimId, guildId);
    this.expireClaim(claimId, true, actor.userId);
    await this.fillVacancies(claim.event_id);
  }
  cancel(guildId, actor, eventId) {
    this.guard();
    const event = this.event(eventId, guildId);
    if (event.owner_id !== actor.userId && !this.manager(guildId, actor)) fail('주최자나 관리자만 취소할 수 있어요.');
    if (['COMPLETED', 'CANCELLED'].includes(event.status)) fail('이미 종료된 이벤트예요.');
    if (this.store.get("SELECT id FROM claims WHERE event_id=? AND status IN ('PREPARING','SENDING','DELIVERY_UNKNOWN')", eventId)) fail('상품 전송 중이거나 결과 확인이 필요해 지금은 취소할 수 없어요.');
    this.store.tx(() => {
      this.store.run("UPDATE events SET status='CANCELLED' WHERE id=?", eventId);
      this.store.run(`UPDATE claims SET status='DENIED',proof=NULL,feedback=NULL,upload_until=NULL,upload_token=NULL WHERE event_id=? AND ${activeClaim}`, eventId);
      this.store.run("UPDATE prizes SET status='EXHAUSTED',secret=NULL WHERE event_id=? AND status IN ('ASSIGNED','AVAILABLE')", eventId);
      this.store.audit(eventId, null, 'CANCELLED', actor.userId, this.now());
      this.store.queue('closed', eventId, this.now());
    });
    this.dirty.add(eventId);
  }
  direct(eventId) {return Boolean(this.store.get('SELECT event_id FROM direct_events WHERE event_id=?',eventId));}
  contactContent(event) {return {text:`실물·직접 전달 상품입니다.\n주최자 <@${event.owner_id}>에게 개인 DM으로 연락해주세요.\n이름·주소·연락처는 봇에 제출하지 마세요.\n이 안내는 배송·실물 수령 완료를 뜻하지 않습니다.\n\n이벤트 번호: ${event.id}`,images:[]};}
  setDeliveryMode(guildId,actor,eventId,direct) {
    this.guard();const event=this.event(eventId,guildId);
    if(event.owner_id!==actor.userId||event.status!=='DRAFT')fail('본인의 초안에서만 전달 방식을 바꿀 수 있어요.');
    this.store.tx(()=>{
      if(direct) {
        this.store.run('INSERT INTO direct_events(event_id) VALUES (?) ON CONFLICT(event_id) DO UPDATE SET event_id=excluded.event_id',eventId);
        // 디지털 상품을 이미 등록했다면 명시적으로 확인한 방식 변경 시 삭제합니다.
        for(let slot=1;slot<=event.winner_count;slot++)this.store.run('UPDATE prizes SET secret=? WHERE event_id=? AND slot=?',this.vault.seal(this.contactContent(event),`prize:${eventId}:${slot}`),eventId,slot);
      } else if(this.direct(eventId)) {
        this.store.run('DELETE FROM direct_events WHERE event_id=?',eventId);
        this.store.run('UPDATE prizes SET secret=NULL WHERE event_id=?',eventId);
      }
    });
  }
  requireHostAllowed(guildId,userId) {
    if(this.store.get('SELECT user_id FROM host_blocks WHERE guild_id=? AND user_id=?',guildId,userId))fail('이 서버에서 이벤트 주최가 제한된 계정이에요. 관리자에게 문의해주세요.');
  }
  restrictHost(guildId,actor,userId,blocked) {
    this.guard();this.requireManager(guildId,actor);
    if(!/^\d{15,22}$/.test(userId))fail('대상 사용자를 확인해주세요.');
    if(blocked)this.store.run('INSERT INTO host_blocks(guild_id,user_id,actor_id,created_at) VALUES (?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,created_at=excluded.created_at',guildId,userId,actor.userId,this.now());
    else this.store.run('DELETE FROM host_blocks WHERE guild_id=? AND user_id=?',guildId,userId);
  }
  lookup(guildId,actor,query) {
    this.guard();const raw=query.trim();
    const match=/^(?:giveaway-delivery:)?([a-f0-9]{16})$/.exec(raw);
    if(!match)fail('이벤트·당첨 번호 또는 giveaway-delivery:번호를 입력해주세요.');
    const key=match[1],claim=this.store.claim(key);
    if(claim) {
      const event=this.event(claim.event_id,guildId);
      if(actor.userId!==claim.user_id&&actor.userId!==event.owner_id&&!this.manager(guildId,actor))fail('본인과 관련된 기록만 조회할 수 있어요.');
      return {event,claim,audit:this.store.all('SELECT action,actor_id,created_at FROM audit WHERE claim_id=? ORDER BY created_at DESC,id DESC LIMIT 8',key)};
    }
    return {event:this.visibleEvent(guildId,actor,key),claim:null,audit:[]};
  }
  closeIfDone(eventId) {
    const event = this.store.event(eventId);
    if (event?.status !== 'DRAWN') return;
    if (this.store.get("SELECT slot FROM prizes WHERE event_id=? AND status IN ('AVAILABLE','ASSIGNED') LIMIT 1", eventId)) return;
    this.store.run("UPDATE events SET status='COMPLETED' WHERE id=?", eventId);
    this.store.queue('closed', eventId, this.now());
    this.dirty.add(eventId);
  }
  recover() {
    this.guard();
    this.store.run("UPDATE prizes SET secret=NULL WHERE event_id IN (SELECT id FROM events WHERE status IN ('REJECTED','CANCELLED','COMPLETED'))");
    this.store.run("UPDATE prizes SET secret=NULL WHERE status IN ('EXHAUSTED','RETURNED','DELIVERED')");
    this.store.run("UPDATE claims SET status='DELIVERY_FAILED',last_error='RESTART_BEFORE_SEND' WHERE status='PREPARING'");
    this.store.run("UPDATE claims SET status='SUBMITTING',upload_until=NULL,upload_token=NULL WHERE status='UPLOADING'");
    this.store.run("UPDATE claims SET status='DELIVERY_UNKNOWN',last_error='RESTART_DURING_SEND' WHERE status='SENDING'");
    this.store.run("UPDATE jobs SET status='UNKNOWN' WHERE status='SENDING'");
    this.store.run("UPDATE reports SET status='UNKNOWN' WHERE status='SENDING'");
    for(const claim of this.store.all("SELECT id,proof_version FROM claims WHERE status='REVIEW' AND proof IS NOT NULL"))this.store.queue('proof',claim.id,this.now(),`:host:${claim.proof_version}`);
    for(const claim of this.store.all("SELECT id,proof_version FROM claims WHERE status='SUBMITTING' AND feedback IS NOT NULL"))this.store.queue('rework',claim.id,this.now(),`:dm:${claim.proof_version}`);
    for (const row of this.store.all('SELECT id FROM events WHERE public_message_id IS NOT NULL')) this.dirty.add(row.id);
  }
  finishJob(job, message) {
    this.store.tx(() => {
      this.store.run("UPDATE jobs SET status='DONE',message_id=?,channel_id=?,error_code=NULL WHERE id=?", message.id, message.channelId, job.id);
      if (job.kind === 'start') {
        const event = this.store.event(job.ref_id);
        this.store.run('UPDATE events SET public_message_id=? WHERE id=?', message.id, event.id);
        if (event.status === 'STARTING') this.store.run("UPDATE events SET status='RUNNING' WHERE id=?", event.id);
        this.dirty.add(event.id);
      }
      if (job.kind === 'winner') {
        const claim = this.store.claim(job.ref_id);
        const event = this.store.event(claim.event_id);
        this.store.run("UPDATE claims SET status='CLAIMABLE',claim_deadline=? WHERE id=? AND status='ANNOUNCING'", this.now() + event.claim_ms, claim.id);
      }
    });
  }
  async processJobs() {
    for (const job of this.store.all("SELECT * FROM jobs WHERE status IN ('PENDING','UNKNOWN') AND next_at<=? ORDER BY created_at,id LIMIT 25", this.now())) {
      this.guard();
      const claim = ['winner', 'proof', 'rework', 'denied', 'expired', 'received', 'deliveryIssue'].includes(job.kind) ? this.store.claim(job.ref_id) : null;
      const event = this.store.event(claim?.event_id || job.ref_id);
      if (!event) continue;
      if ((job.kind === 'application' && event.status !== 'PENDING') ||
        (job.kind === 'start' && event.status !== 'STARTING') ||
        (job.kind === 'winner' && claim.status !== 'ANNOUNCING') ||
        (job.kind === 'proof' && (claim.status !== 'REVIEW' || !job.id.includes(':host:') || !job.id.endsWith(`:${claim.proof_version}`))) ||
        (job.kind === 'rework' && (claim.status !== 'SUBMITTING' || !job.id.includes(':dm:') || !job.id.endsWith(`:${claim.proof_version}`)))) {
        this.store.run("UPDATE jobs SET status='DONE' WHERE id=?", job.id);
        continue;
      }
      try {
        if (job.status === 'UNKNOWN') {
          const found = await this.transport.findNotification(job, event, claim);
          this.guard();
          if (found) this.finishJob(job, found);
          else this.store.run('UPDATE jobs SET next_at=? WHERE id=?', this.now() + 60_000, job.id);
          continue;
        }
        if (job.kind === 'start') this.store.run('UPDATE events SET started_at=?,ends_at=? WHERE id=?', this.now(), this.now() + event.duration_ms, event.id);
        this.store.run("UPDATE jobs SET status='SENDING' WHERE id=? AND status='PENDING'", job.id);
        const message = await this.transport.sendNotification(job, this.store.event(event.id), claim);
        this.guard();
        this.finishJob(job, message);
      } catch (error) {
        this.guard();
        this.store.run('UPDATE jobs SET status=?,error_code=?,next_at=? WHERE id=?', job.status === 'UNKNOWN' ? 'UNKNOWN' : error.definite ? 'PENDING' : 'UNKNOWN', error.definite ? 'DISCORD_REJECTED' : 'RESULT_UNKNOWN', this.now() + 60_000, job.id);
      }
    }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.guard();
      for (const claim of this.store.all(`SELECT id FROM claims WHERE
        (status='CLAIMABLE' AND claim_deadline<=?) OR (status='SUBMITTING' AND submit_deadline<=?)
        OR (status='UPLOADING' AND upload_until<=?)`, this.now(), this.now(), this.now())) this.expireClaim(claim.id);
      this.store.run("UPDATE events SET status='DRAWN' WHERE status='RUNNING' AND ends_at<=?", this.now());
      for (const event of this.store.all("SELECT id FROM events WHERE status='DRAWN'")) {
        try { await this.fillVacancies(event.id); }
        catch {
          this.guard();
          this.store.queue('drawIssue', event.id, this.now());
        }
      }
      for (const claim of this.store.all("SELECT id FROM claims WHERE status='READY'")) await this.deliver(claim.id);
      for (const claim of this.store.all("SELECT * FROM claims WHERE status='DELIVERY_UNKNOWN'")) {
        try {
          const found = await this.transport.findPrize(claim);
          this.guard();
          if (found) this.finishDelivery(claim.id, found.id);
        } catch { /* 결과 불명인 상품은 확인될 때까지 지급·리롤하지 않습니다. */ }
      }
      await this.processJobs();
      for (const eventId of this.dirty) {
        const event = this.store.event(eventId);
        if (!event?.public_message_id) { this.dirty.delete(eventId); continue; }
        try { await this.transport.updateEvent(event); this.dirty.delete(eventId); }
        catch { /* 공개 상태 갱신은 다음 주기에 재시도합니다. */ }
      }
    } finally { this.ticking = false; }
  }
}
