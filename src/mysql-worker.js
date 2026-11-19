import { workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { mysqlSchema,mysqlSql } from './mysql-schema.js';

const {port,signal,options}=workerData,flag=new Int32Array(signal);
let connection;
const fatalCodes=new Set(['PROTOCOL_CONNECTION_LOST','PROTOCOL_SEQUENCE_TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE']);
const params=values=>values.map(value=>value instanceof Uint8Array?Buffer.from(value):value);
async function initialize() {
  connection=await mysql.createConnection({...options,charset:'utf8mb4',supportBigNumbers:true,bigNumberStrings:false,
    flags:'-FOUND_ROWS',multipleStatements:false,enableKeepAlive:true,connectTimeout:options.connectTimeout});
  const [[server]]=await connection.query('SELECT VERSION() version,@@max_allowed_packet packet');
  const version=server.version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!version||/mariadb/i.test(server.version)||Number(version[1])<8||(Number(version[1])===8&&Number(version[2])===0&&Number(version[3])<19))throw Object.assign(new Error('VERSION'),{code:'MYSQL_VERSION_UNSUPPORTED'});
  if(server.packet<16*1024*1024)throw Object.assign(new Error('PACKET'),{code:'MYSQL_PACKET_TOO_SMALL'});
  // 연결에 귀속된 잠금으로 같은 DB를 사용하는 복수 프로세스의 기동을 막습니다.
  const lock='giveon:'+createHash('sha256').update(options.database).digest('hex').slice(0,48);
  const [[row]]=await connection.execute('SELECT GET_LOCK(?,0) acquired',[lock]);
  if(row.acquired!==1)throw Object.assign(new Error('LOCKED'),{code:'MYSQL_DATABASE_IN_USE'});
  await connection.query(mysqlSchema[0]);
  const [[metadata]]=await connection.query('SELECT version FROM giveon_metadata WHERE id=1');
  if(metadata&&metadata.version>1)throw Object.assign(new Error('SCHEMA'),{code:'MYSQL_SCHEMA_NEWER'});
  for(const sql of mysqlSchema.slice(1))await connection.query(sql);
  await connection.query('INSERT INTO giveon_metadata(id,version) VALUES(1,1) ON DUPLICATE KEY UPDATE id=id');
  return {version:server.version,maxAllowedPacket:server.packet};
}
port.on('message',async request=>{
  let response;
  try {
    let value;
    if(request.operation==='initialize')value=await initialize();
    else if(request.operation==='close'){await connection?.end();value=true;}
    else if(request.operation==='begin'){await connection.beginTransaction();value=true;}
    else if(request.operation==='commit'){await connection.commit();value=true;}
    else if(request.operation==='rollback'){await connection.rollback();value=true;}
    else {
      const [result]=await connection.execute({sql:mysqlSql(request.sql),timeout:options.connectTimeout},params(request.args));
      value=request.operation==='get'?result[0]:request.operation==='all'?result:{changes:result.affectedRows,lastInsertRowid:result.insertId};
    }
    response={id:request.id,ok:true,value};
  } catch(error) {
    response={id:request.id,ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'MYSQL_ERROR',fatal:Boolean(error.fatal)||fatalCodes.has(error.code)};
    if(request.operation==='initialize')await connection?.end().catch(()=>{});
  }
  port.postMessage(response);Atomics.store(flag,0,1);Atomics.notify(flag,0);
  if(request.operation==='close')port.close();
});
