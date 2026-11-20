import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { StoreBase } from './store-base.js';

const restore=value=>value instanceof Uint8Array?Buffer.from(value):Array.isArray(value)?value.map(restore):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item)])):value;

export class MySQLStore extends StoreBase {
  constructor(options) {
    super();this.timeout=options.connectTimeout||5000;this.sequence=0;this.closed=false;this.failed=false;
    const {port1,port2}=new MessageChannel();this.port=port1;this.flag=new Int32Array(new SharedArrayBuffer(4));
    this.worker=new Worker(new URL('./mysql-worker.js',import.meta.url),{execArgv:[],workerData:{port:port2,signal:this.flag.buffer,options:{...options,connectTimeout:this.timeout}},transferList:[port2]});
    this.worker.on('error',()=>{this.failed=true;});
    try{this.serverInfo=this.request('initialize');}catch(error){this.closed=true;this.port.close();void this.worker.terminate();throw error;}
  }
  request(operation,sql,args=[]) {
    if(this.closed||this.failed)throw Object.assign(new Error('MySQL 연결을 사용할 수 없습니다. 봇을 다시 시작해주세요.'),{code:'MYSQL_CONNECTION_UNAVAILABLE'});
    const id=++this.sequence;Atomics.store(this.flag,0,0);
    this.port.postMessage({id,operation,sql,args});
    if(Atomics.wait(this.flag,0,0,this.timeout)==='timed-out'){
      this.failed=true;void this.worker.terminate();
      throw Object.assign(new Error('MySQL 응답 시간이 초과됐습니다. 처리 결과를 확인한 후 봇을 다시 시작해주세요.'),{code:'MYSQL_TIMEOUT'});
    }
    const response=receiveMessageOnPort(this.port)?.message;
    if(!response||response.id!==id){this.failed=true;void this.worker.terminate();throw Object.assign(new Error('MySQL 응답을 대조하지 못했습니다.'),{code:'MYSQL_PROTOCOL_ERROR'});}
    if(!response.ok){if(response.fatal)this.failed=true;throw Object.assign(new Error(`MySQL 작업 실패 (${response.code})`),{code:response.code});}
    return restore(response.value);
  }
  get(sql,...args){return this.request('get',sql,args);}
  all(sql,...args){return this.request('all',sql,args);}
  run(sql,...args){return this.request('run',sql,args);}
  columns(table){
    if(!/^[a-z_]+$/.test(table))throw new Error('잘못된 테이블 이름');
    return this.all('SELECT COLUMN_NAME name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',table).map(column=>column.name);
  }
  tx(fn){
    this.request('begin');
    try{const result=fn();if(result?.then)throw new Error('트랜잭션 콜백은 동기 함수여야 합니다.');this.request('commit');return result;}
    catch(error){if(!this.failed)try{this.request('rollback');}catch{this.failed=true;}throw error;}
  }
  close(){
    if(this.closed)return;
    try{if(!this.failed)this.request('close');}finally{this.closed=true;this.port.close();void this.worker.terminate();}
  }
}
