import { randomUUID } from 'node:crypto';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { config } from './config.js';
import { createStore } from './database.js';
import { vault } from './vault.js';
import { Engine } from './engine.js';
import { DiscordTransport } from './discord-transport.js';
import { handler } from './interactions.js';
import { PanelPublisher } from './panel.js';
import { replyHandler } from './replies.js';

let store, client, heartbeat, scheduler, token, stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat); clearInterval(scheduler);
  client?.destroy();
  // 실행 중인 작업은 SENDING/PREPARING으로 보존하여 다음 실행에서 복구합니다.
  try { if (store) { store.releaseLease(token); store.close(); } } catch { /* 비밀 정보 출력 금지 */ }
  if (process.connected) process.disconnect();
  process.exitCode = code;
}
try {
  const settings = config();
  store = createStore(settings);
  token = randomUUID();
  store.acquireLease(token, Date.now());
  const guard = () => store.checkLease(token, Date.now());
  heartbeat = setInterval(() => {
    try { store.heartbeat(token, Date.now()); }
    catch { console.error('실행 잠금을 잃어 봇을 종료합니다.'); void shutdown(1); }
  }, 5000);
  const encryption = vault(settings.key);
  // 답장 멘션이 켜진 reroll 명령만 처리하며 Message Content 특권은 요청하지 않습니다.
  client = new Client({ intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages], allowedMentions: { parse: [] },
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }) });
  const transport = new DiscordTransport(client, store, encryption);
  transport.panel = new PanelPublisher(client, store);
  const engine = new Engine(store, encryption, transport, { owners: settings.owners, guard });
  engine.recover();
  client.on(Events.InteractionCreate, handler(engine, transport));
  client.on(Events.MessageCreate,replyHandler(engine,transport,client));
  client.on(Events.Error, () => console.error('Discord 연결 오류. 토큰·네트워크·권한을 확인해주세요.'));
  client.once(Events.ClientReady, async ready => {
    console.log(`${ready.user.tag} 준비 완료. ${settings.databaseDriver==='mysql'?'MySQL':'SQLite'} 이벤트 관리 시작 · PID ${process.pid}`);
    const run = () => engine.tick().catch(() => console.error('이벤트 처리 지연. 서버 접근 권한·네트워크·DB 상태를 확인해주세요.'));
    await run();
    scheduler = setInterval(run, 5000);
    if (process.send) process.send('ready');
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Windows PM2는 shutdown_with_message로 정상 종료를 요청합니다.
  process.on('message', message => { if (message === 'shutdown') void shutdown(); });
  await client.login(settings.token);
} catch {
  console.error('시작 실패. .env 필수 항목, DB 접근 권한, 중복 실행 여부를 확인해주세요.');
  await shutdown(1);
}
