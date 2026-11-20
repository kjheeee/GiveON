import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createStore } from '../src/database.js';
import { Store } from '../src/store.js';

const env={DISCORD_TOKEN:'test-only-placeholder',APPLICATION_ID:'100000000000001',OWNER_IDS:'100000000000002',DATA_KEY:'ab'.repeat(32)};
test('기존 주최 제한 테이블에 사유·해제 필드를 추가하고 제한 중인 사용자를 보존한다',t=>{
  const store=new Store();t.after(()=>store.close());
  store.db.exec("DROP TABLE host_blocks; CREATE TABLE host_blocks(guild_id TEXT,user_id TEXT,actor_id TEXT,created_at INTEGER,PRIMARY KEY(guild_id,user_id)); INSERT INTO host_blocks VALUES ('g','u','a',123)");
  store.upgradeHostBlocks();store.upgradeHostBlocks();
  const block=store.get('SELECT * FROM host_blocks');assert.equal(block.user_id,'u');assert.equal(block.active,1);assert.equal(block.reason,'');assert.equal(block.released_by,null);
});
test('DB 선택 기본값은 SQLite이며 MySQL 정보 없이도 기존 저장소를 사용한다',()=>{
  const settings=config(env);assert.equal(settings.databaseDriver,'sqlite');assert.equal(settings.mysql,undefined);
  const store=createStore({...settings,databasePath:':memory:'});try{assert.ok(store instanceof Store);assert.equal(store.guild('100000000000003').id,'100000000000003');}finally{store.close();}
});
test('프로젝트 DB_DRIVER=mysql일 때만 MySQL 연결 설정과 TLS 옵션을 적용한다',()=>{
  const settings=config({...env,DB_DRIVER:'mysql',MYSQL_HOST:'127.0.0.1',MYSQL_USER:'giveon',MYSQL_DATABASE:'giveon',MYSQL_PASSWORD:'test-only',MYSQL_PORT:'3307',MYSQL_SSL:'true'});
  assert.equal(settings.databaseDriver,'mysql');assert.equal(settings.mysql.port,3307);assert.deepEqual(settings.mysql.ssl,{rejectUnauthorized:true});assert.equal(settings.mysql.database,'giveon');
});
test('잘못된 DB 선택·연결 정보는 SQLite로 자동 대체하지 않고 거절한다',()=>{
  assert.throws(()=>config({...env,DB_DRIVER:'other'}),/DB_DRIVER/);
  assert.throws(()=>config({...env,DB_DRIVER:'mysql'}),/MySQL/);
  assert.throws(()=>config({...env,DB_DRIVER:'mysql',MYSQL_HOST:'host',MYSQL_USER:'user',MYSQL_DATABASE:'db',MYSQL_PORT:'0'}),/MySQL/);
  assert.throws(()=>createStore({databaseDriver:'other'}),/DB_DRIVER/);
});
