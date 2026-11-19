import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export function config(env = process.env) {
  const ids = value => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const owners = ids(env.OWNER_IDS);
  const snowflake = /^\d{15,22}$/;
  if (!env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN을 설정해주세요.');
  if (!snowflake.test(env.APPLICATION_ID ?? '')) throw new Error('APPLICATION_ID를 확인해주세요.');
  if (!owners.length || !owners.every(id => snowflake.test(id))) throw new Error('OWNER_IDS를 확인해주세요.');
  if (!/^[a-fA-F0-9]{64}$/.test(env.DATA_KEY ?? '')) throw new Error('DATA_KEY에 32바이트 키를 설정해주세요. npm run keygen');
  if (env.DEV_GUILD_ID && !snowflake.test(env.DEV_GUILD_ID)) throw new Error('DEV_GUILD_ID를 확인해주세요.');
  const databaseDriver=(env.DB_DRIVER||'sqlite').toLowerCase();
  if(!['sqlite','mysql'].includes(databaseDriver))throw new Error('DB_DRIVER는 sqlite 또는 mysql이어야 합니다.');
  let mysql;
  if(databaseDriver==='mysql'){
    const port=Number(env.MYSQL_PORT||3306),timeout=Number(env.MYSQL_TIMEOUT_MS||5000);
    if(!env.MYSQL_HOST||!env.MYSQL_USER||!env.MYSQL_DATABASE||!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(timeout)||timeout<500||timeout>30000)throw new Error('MySQL 호스트·포트·사용자·DB 이름·제한시간을 확인해주세요.');
    if(env.MYSQL_SSL&&!['true','false'].includes(env.MYSQL_SSL))throw new Error('MYSQL_SSL은 true 또는 false여야 합니다.');
    mysql={host:env.MYSQL_HOST,port,user:env.MYSQL_USER,password:env.MYSQL_PASSWORD||'',database:env.MYSQL_DATABASE,connectTimeout:timeout,
      ...(env.MYSQL_SSL==='true'?{ssl:{rejectUnauthorized:true,...(env.MYSQL_SSL_CA_FILE?{ca:readFileSync(env.MYSQL_SSL_CA_FILE,'utf8')}:{})}}:{})};
  }
  return {
    token: env.DISCORD_TOKEN, applicationId: env.APPLICATION_ID, owners,
    key: Buffer.from(env.DATA_KEY, 'hex'),
    databasePath: resolve(env.DATABASE_PATH || './data/giveaway.sqlite'),
    databaseDriver,mysql,
    devGuildId: env.DEV_GUILD_ID || undefined,
  };
}
