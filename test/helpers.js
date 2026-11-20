import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { vault } from '../src/vault.js';
import { MySQLStore } from '../src/mysql-store.js';

export function mysqlTestOptions() {
  const database=process.env.MYSQL_TEST_DATABASE;
  if(!/^giveon_test(?:_[a-z0-9]+)?$/.test(database||''))throw new Error('격리 테스트용 MYSQL_TEST_DATABASE=giveon_test 이름이 필요합니다.');
  return {host:process.env.MYSQL_TEST_HOST||'127.0.0.1',port:Number(process.env.MYSQL_TEST_PORT||3306),
    user:process.env.MYSQL_TEST_USER||'root',password:process.env.MYSQL_TEST_PASSWORD||'',database,connectTimeout:10000};
}
function testStore() {
  if(process.env.GIVEON_TEST_DRIVER!=='mysql')return new Store();
  const store=new MySQLStore(mysqlTestOptions());
  // 위에서 검증한 전용 테스트 DB만 초기화합니다. 운영 DB 이름은 허용하지 않습니다.
  for(const table of ['reports','host_blocks','direct_events','audit','jobs','claims','entries','draft_steps','prizes','events','panels','setup_sessions','event_templates','guilds','runtime_lock'])store.run(`DELETE FROM ${table}`);
  return store;
}

export const GUILD = '100000000000000';
export const OTHER_GUILD = '200000000000000';
export const MANAGER_ROLE = '100000000000010';
export const ALLOW_ROLE = '100000000000011';
export const DENY_ROLE = '100000000000012';
export const BLOCK_ROLE = '100000000000013';
export const actor = (n, roles = []) => ({ userId: `10000000000${String(n).padStart(4, '0')}`, roles, isBot: false });
export const OWNER = actor(1), HOST = actor(2), MANAGER = actor(3, [MANAGER_ROLE]);
export const content = (text = '상품 비밀 코드 TEST-COUPON-1234') => ({ text, images: [] });

export function interaction(user,customId,options={},type='button') {
  return {guildId:GUILD,user:{id:user.userId,bot:false},customId,deferred:false,replies:[],
    commandName:type==='chat'?customId:undefined,channelId:'100000000000022',
    inGuild:()=>true,isChatInputCommand:()=>type==='chat',isButton:()=>type==='button',isModalSubmit:()=>type==='modal',isAnySelectMenu:()=>type==='select',
    values:options.values||[],fields:{getTextInputValue:name=>options[name]||'',getUploadedFiles:()=>null},
    async showModal(value){this.modal=value;this.replied=true;},async deferReply(options){this.deferOptions=options;this.deferred=true;},
    async deferUpdate(){this.updated=true;this.deferred=true;},async editReply(options){this.replies.push(options);},async reply(options){this.replies.push(options);this.replied=true;}};
}

export function fixture(t, suppliedStore) {
  let clock = 2_000_000_000_000, messageSeq = 0;
  const store = suppliedStore || testStore();
  const encryption = vault(Buffer.alloc(32, 7));
  if (!suppliedStore) t.after(() => store.close());
  const members = new Map([OWNER, HOST, MANAGER].map(a => [a.userId, a]));
  const prizeMessages = new Map(), notifications = new Map();
  const transport = {
    sends: 0, behavior: 'success', notifyBehavior: 'success',
    async member(gid, uid) { return members.get(uid) || null; },
    async roles(gid, ids) { return ids.map(id => ({ id,name:`역할 ${id}` })); },
    async prepareDM() { return 'test-dm'; },
    async sendPrize(channelId, event, claim, payload) {
      this.sends++;
      if (this.behavior === 'definite') throw Object.assign(new Error('failed'), { definite: true });
      const message = { id: `message-${++messageSeq}`, channelId };
      prizeMessages.set(claim.id, message);
      if (this.behavior === 'unknown') throw new Error('timeout after send');
      return message;
    },
    async findPrize(claim) { return prizeMessages.get(claim.id) || null; },
    async sendNotification(job) {
      if (this.notifyBehavior === 'definite') throw Object.assign(new Error('missing permission'), { definite: true });
      const message = { id: `notice-${++messageSeq}`, channelId: 'test-channel' };
      notifications.set(job.id, message);
      if (this.notifyBehavior === 'unknown') throw new Error('timeout');
      return message;
    },
    async findNotification(job) { return notifications.get(job.id) || null; },
    async updateEvent() {},
  };
  const engine = new Engine(store, encryption, transport, { owners: [OWNER.userId], now: () => clock, rng: () => 0 });
  engine.configure(GUILD, OWNER, 'manager_roles', [MANAGER_ROLE]);
  engine.configure(GUILD, OWNER, 'event_channel', '100000000000020');
  engine.configure(GUILD, OWNER, 'manager_channel', '100000000000021');
  return {
    store, engine, transport, encryption, members, prizeMessages, notifications,
    add(...actors) { for (const a of actors) members.set(a.userId, a); },
    advance(ms) { clock += ms; }, now: () => clock,
    async event({ winners = 1, proof = false, participants = [], start = true } = {}) {
      const eventId = engine.create(GUILD, HOST, { title: '테스트 상품', description: '테스트 설명', durationMinutes: 1, claimMinutes: 1, winners, proofRequired: proof, proofInstructions: proof ? '필요한 정보만 제출하세요' : '' });
      for (let slot = 1; slot <= winners; slot++) engine.setPrize(GUILD, HOST, eventId, slot, content(`상품-${eventId}-${slot}`));
      if (!start) return eventId;
      engine.submit(GUILD, HOST, eventId);
      await engine.tick();
      engine.approveEvent(GUILD, MANAGER, eventId);
      await engine.tick();
      for (const a of participants) { members.set(a.userId, a); engine.join(GUILD, a, eventId); }
      return eventId;
    },
    claims(eventId) { return store.all('SELECT * FROM claims WHERE event_id=? ORDER BY created_at,id', eventId); },
  };
}
