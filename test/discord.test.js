import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { handler } from '../src/interactions.js';
import { fixture, actor, content, GUILD, HOST, MANAGER, OWNER } from './helpers.js';

function clientFixture() {
  const sent = [], history = new Collection();
  const channel = {
    async send(options) {
      sent.push(options);
      const message = { id: String(sent.length), channelId: 'channel', nonce: options.nonce,
        author: { id: 'bot' }, createdTimestamp: Date.now(),content:options.content||'',components:(options.components||[]).map(c=>c.toJSON()),embeds: (options.embeds||[]).map(e => e.toJSON()) };
      history.set(message.id, message);
      return message;
    },
    messages: { async fetch(value) {return typeof value==='string'?history.get(value):history;}, async edit(id,value) {channel.lastEdit={id,...value};} },
  };
  const client = { user: { id: 'bot' }, channels: { async fetch() { return channel; } },
    users: { async fetch() { return { async createDM() { return { id: 'dm' }; } }; } } };
  return { client, channel, sent, history };
}

export function interaction(user, customId, options = {}, type = 'button') {
  return {
    guildId: GUILD, user: { id: user.userId, bot: false }, customId, deferred: false, replies: [],
    commandName:type==='chat'?'gon':undefined,options:{getSubcommandGroup:()=>null,getSubcommand:()=>customId},channelId:'100000000000022',
    inGuild: () => true, isChatInputCommand: () => type==='chat', isButton: () => type==='button', isModalSubmit: () => type==='modal',isAnySelectMenu:()=>type==='select',
    values:options.values||[],
    fields:{getTextInputValue:name=>options[name]||'',getUploadedFiles:()=>null},
    async showModal(value) {this.modal=value;this.replied=true;},
    async deferReply(options) { this.deferOptions = options; this.deferred = true; },
    async deferUpdate() {this.updated=true;this.deferred=true;},
    async editReply(options) { this.replies.push(options); },
    async reply(options) {this.replies.push(options);this.replied=true;},
  };
}

test('실제 알림 어댑터는 승인·공개 화면에 상품 원문을 넣지 않고 멘션 대상을 제한한다', async t => {
  const f = fixture(t), c = clientFixture(), eid = await f.event({ start: false });
  const transport = new DiscordTransport(c.client, f.store, f.encryption);
  f.engine.configure(GUILD, OWNER, 'mention_roles', ['100000000000030']);
  f.engine.setPrize(GUILD, HOST, eid, 1, content('DO-NOT-LEAK-PRIZE-SECRET'));
  const event = f.store.event(eid);
  await transport.sendNotification({ id: `application:${eid}`, kind: 'application', ref_id: eid }, event);
  assert.equal(JSON.stringify(c.sent[0]).includes('DO-NOT-LEAK'), false);
  assert.deepEqual(c.sent[0].allowedMentions, { parse: [], users: [], roles: [] });
  f.store.run("UPDATE events SET status='STARTING',ends_at=? WHERE id=?", Date.now() + 60_000, eid);
  await transport.sendNotification({ id: `start:${eid}`, kind: 'start', ref_id: eid }, f.store.event(eid));
  assert.equal(JSON.stringify(c.sent[1]).includes('DO-NOT-LEAK'), false);
  assert.deepEqual(c.sent[1].allowedMentions, { parse: [], users: [], roles: ['100000000000030'] });
  assert.equal(c.sent[1].flags,MessageFlags.IsComponentsV2);
  assert.equal(c.sent[1].embeds,undefined);
  assert.equal(JSON.stringify(c.sent[1]).split(`<@${HOST.userId}>`).length-1,1);
  assert.equal(c.sent[1].enforceNonce, true);
});

test('상품 이미지는 독립적인 DM 첨부로 업로드하고 nonce·지급 번호로 기존 전송을 찾는다', async t => {
  const f = fixture(t), c = clientFixture(), eid = await f.event({ start: false });
  const transport = new DiscordTransport(c.client, f.store, f.encryption);
  const claim = { id: 'claim-one', slot: 1, delivery_nonce: 'fixednonce', dm_channel_id: 'dm', send_started: Date.now() };
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  const payload = { text: 'DM-ONLY', images: [{ ext: 'png', data: bytes.toString('base64') }] };
  const message = await transport.sendPrize('dm', f.store.event(eid), claim, payload);
  assert.deepEqual(c.sent[0].files[0].attachment, bytes);
  assert.equal(c.sent[0].files[0].name, 'prize-1.png');
  assert.equal(c.sent[0].nonce, 'fixednonce');
  assert.deepEqual(c.sent[0].allowedMentions, { parse: [] });
  assert.equal((await transport.findPrize(claim)).id, message.id);
  assert.equal(await transport.findPrize({ ...claim, id: 'other', delivery_nonce: 'other' }), null);
});

test('당첨·마감 알림은 설정 채널이 바뀌어도 원본 이벤트 채널에서 원본에 답장하고 답장 멘션은 하지 않는다',async t=>{
  const f=fixture(t),c=clientFixture(),eid=await f.event({start:false}),transport=new DiscordTransport(c.client,f.store,f.encryption),fetched=[];
  f.store.run("INSERT INTO jobs(id,kind,ref_id,status,created_at,channel_id) VALUES (?,'start',?,'DONE',?,'original-channel')",`start:${eid}`,eid,Date.now());
  f.store.run("UPDATE events SET public_message_id='original-message' WHERE id=?",eid);
  f.engine.configure(GUILD,OWNER,'event_channel','100000000000099');
  c.client.channels.fetch=async id=>{fetched.push(id);return c.channel;};
  const event=f.store.event(eid),claim={id:'winner-one',slot:1,user_id:HOST.userId};
  for(const kind of ['winner','closed'])await transport.sendNotification({id:`${kind}:${eid}`,kind,ref_id:kind==='winner'?claim.id:eid},event,claim);
  assert.deepEqual(fetched,['original-channel','original-channel']);
  for(const data of c.sent){assert.deepEqual(data.reply,{messageReference:'original-message',failIfNotExists:false});assert.equal(data.allowedMentions.repliedUser,false);assert.equal(data.enforceNonce,true);}
  assert.deepEqual(c.sent[0].allowedMentions.users,[HOST.userId]);assert.deepEqual(c.sent[1].allowedMentions.users,[]);
});

test('원본이 없는 미게시 이벤트의 마감은 잘못된 답장 대상을 만들지 않는다',async t=>{
  const f=fixture(t),c=clientFixture(),eid=await f.event({start:false}),transport=new DiscordTransport(c.client,f.store,f.encryption);
  await transport.sendNotification({id:`closed:${eid}`,kind:'closed',ref_id:eid},f.store.event(eid));assert.equal(c.sent[0].reply,undefined);
});

test('전송 호출 전 실패와 Discord 거절은 확정 실패, 호출 후 타임아웃은 결과 불명으로 구분한다', async t => {
  const f = fixture(t), eid = await f.event({ start: false }), event = f.store.event(eid);
  const c = clientFixture(), transport = new DiscordTransport(c.client, f.store, f.encryption);
  c.client.channels.fetch = async () => { throw new Error('network before send'); };
  await assert.rejects(transport.sendPrize('dm', event, { id: 'c', slot: 1 }, content()), e => e.definite === true);
  c.client.channels.fetch = async () => c.channel;
  c.channel.send = async () => { throw Object.assign(new Error('rejected'), { status: 403 }); };
  await assert.rejects(transport.sendPrize('dm', event, { id: 'c', slot: 1 }, content()), e => e.definite === true);
  c.channel.send = async () => { throw new Error('timeout after send'); };
  await assert.rejects(transport.sendPrize('dm', event, { id: 'c', slot: 1 }, content()), e => !e.definite);
});

test('인증 자료 UI는 주최자에게만 ephemeral로 표시하며 관리자 조회는 첨부를 반환하지 않는다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [claim] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, claim.id);
  f.engine.submitProof(GUILD, user, claim.id, { text: 'PRIVATE-PROOF', images: [{ ext: 'png', data: 'aW1hZ2U=' }] });
  const handle = handler(f.engine, f.transport);
  const denied = interaction(MANAGER, `pview:${claim.id}`);
  await handle(denied);
  assert.equal(denied.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(denied.replies[0].files, undefined);
  assert.equal(JSON.stringify(denied.replies).includes('PRIVATE-PROOF'), false);
  const allowed = interaction(HOST, `pview:${claim.id}`);
  await handle(allowed);
  assert.equal(allowed.deferOptions.flags, MessageFlags.Ephemeral);
  assert.ok(JSON.stringify(allowed.replies[0]).includes('PRIVATE-PROOF'));
  assert.equal(allowed.replies[0].files.length, 1);
  assert.ok(allowed.replies[0].components[0].toJSON().components[1].custom_id.endsWith(':1'));
});

test('인증 입력창은 텍스트만으로도 예약·검수 전환을 완료하고 비공개로 응답한다', async t => {
  const f = fixture(t), user = actor(4), eid = await f.event({ proof: true, participants: [user] });
  f.advance(60_001); await f.engine.tick();
  const [claim] = f.claims(eid);
  await f.engine.startClaim(GUILD, user, claim.id);
  const i = interaction(user, `form:proof:${claim.id}`, {text:'텍스트 인증 내용'},'modal');
  await handler(f.engine, f.transport)(i);
  assert.equal(i.deferOptions.flags, MessageFlags.Ephemeral);
  assert.equal(f.store.claim(claim.id).status, 'REVIEW');
  assert.equal(f.store.claim(claim.id).upload_token, null);
  assert.ok(!JSON.stringify(i.replies).includes('텍스트 인증 내용'));
});

test('역할 후보 조회는 등록된 ID만 반환하고 삭제된 역할과 everyone은 제외한다',async t=>{
  const f=fixture(t),roles=new Collection([['role-1',{id:'role-1',name:'지하 1층 입장권'}],['role-2',{id:'role-2',name:'지하 2층 입장권'}],['unregistered',{id:'unregistered',name:'지하 100층 입장권'}],[GUILD,{id:GUILD,name:'everyone'}]]);
  const client={guilds:{async fetch(){return{roles:{async fetch(){return roles;}}};}}};
  const transport=new DiscordTransport(client,f.store,f.encryption);
  assert.deepEqual(await transport.roles(GUILD,['role-1','role-2','deleted',GUILD]),[{id:'role-1',name:'지하 1층 입장권'},{id:'role-2',name:'지하 2층 입장권'}]);
  assert.deepEqual(await transport.roles(GUILD,[]),[]);
});

test('기존 공개 이벤트는 같은 메시지에서 임베드를 제거하고 주최자 한 번·알림 역할만 표시한다',async t=>{
  const f=fixture(t),c=clientFixture(),eid=await f.event({start:false}),event=f.store.event(eid);
  f.store.run("INSERT INTO jobs(id,kind,ref_id,status,created_at,channel_id) VALUES (?,'start',?,'DONE',?,'channel')",`start:${eid}`,eid,Date.now());
  c.history.set('old',{id:'old',content:`<@${HOST.userId}> <@&100000000000030>`,author:c.client.user,embeds:[],components:[]});
  await new DiscordTransport(c.client,f.store,f.encryption).updateEvent({...event,public_message_id:'old'});
  assert.equal(c.channel.lastEdit.flags,MessageFlags.IsComponentsV2);assert.deepEqual(c.channel.lastEdit.embeds,[]);assert.equal(c.channel.lastEdit.content,null);
  const body=JSON.stringify(c.channel.lastEdit.components);assert.equal(body.split(`<@${HOST.userId}>`).length-1,1);assert.ok(body.includes('<@&100000000000030>'));
  assert.deepEqual(c.channel.lastEdit.allowedMentions,{parse:[]});
});
