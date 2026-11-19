import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mysqlTestOptions, GUILD, OWNER, actor } from './helpers.js';
import { MySQLStore } from '../src/mysql-store.js';
import { spawnSync } from 'node:child_process';

test('MySQL 워커는 부모 CLI의 input-type 옵션을 상속하지 않고 기동한다',()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',"import {MySQLStore} from './src/mysql-store.js';import {mysqlTestOptions} from './test/helpers.js';const store=new MySQLStore(mysqlTestOptions());store.close();"],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stderr);
});

test('MySQL은 같은 DB의 복수 연결 기동을 막고 트랜잭션 실패를 롤백한다',t=>{
  const f=fixture(t);assert.ok(f.store instanceof MySQLStore);
  assert.throws(()=>new MySQLStore(mysqlTestOptions()),/MYSQL_DATABASE_IN_USE/);
  const before=f.store.guild(GUILD);
  f.store.acquireLease('test-lease',f.now());f.store.heartbeat('test-lease',f.now());f.store.checkLease('test-lease',f.now());f.store.releaseLease('test-lease');
  assert.throws(()=>f.store.tx(()=>{f.engine.configure(GUILD,OWNER,'condition_roles',['100000000000099']);throw new Error('intentional-test-rollback');}),/intentional/);
  assert.deepEqual(f.store.guild(GUILD),before);
});

test('MySQL은 최대 이미지 크기의 암호문도 잘림 없이 왕복 저장한다',async t=>{
  const f=fixture(t),eid=await f.event({start:false});
  const data=Buffer.alloc(8*1024*1024,7).toString('base64');
  f.engine.setPrize(GUILD,actor(2),eid,1,{text:'large-test',images:[{ext:'png',data}]});
  const encrypted=f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret;
  assert.equal(f.encryption.open(encrypted,`prize:${eid}:1`).images[0].data,data);
});
test('MySQL의 당첨 자리 고유 제약은 동시 활성 당첨을 막고 암호문 BLOB을 보존한다',async t=>{
  const f=fixture(t),eid=await f.event({participants:[actor(10),actor(11)]});f.advance(60_001);await f.engine.tick();const claim=f.claims(eid)[0];
  assert.throws(()=>f.store.run(`INSERT INTO claims(id,event_id,slot,user_id,status,claim_deadline,created_at,delivery_nonce)
    VALUES (?,?,?,?,'CLAIMABLE',?,?,?)`,'a'.repeat(16),eid,claim.slot,actor(12).userId,f.now()+60000,f.now(),'b'.repeat(16)),/ER_DUP_ENTRY/);
  const encrypted=f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=?',eid,claim.slot).secret;
  assert.ok(Buffer.isBuffer(encrypted));assert.ok(f.encryption.open(encrypted,`prize:${eid}:${claim.slot}`).text.includes(eid));
});
