// SQLite와 MySQL에서 공유하는 저장소 동작입니다. 트랜잭션 콜백은 동기 함수입니다.
export class StoreBase {
  guild(id) {
    this.run('INSERT OR IGNORE INTO guilds(id) VALUES (?)',id);
    return this.get('SELECT * FROM guilds WHERE id=?',id);
  }
  event(id) {return this.get('SELECT * FROM events WHERE id=?',id);}
  claim(id) {return this.get('SELECT * FROM claims WHERE id=?',id);}
  audit(eventId,claimId,action,actorId,now) {this.run('INSERT INTO audit(event_id,claim_id,action,actor_id,created_at) VALUES (?,?,?,?,?)',eventId,claimId,action,actorId,now);}
  queue(kind,refId,now,suffix='') {this.run('INSERT OR IGNORE INTO jobs(id,kind,ref_id,created_at) VALUES (?,?,?,?)',`${kind}:${refId}${suffix}`,kind,refId,now);}
  acquireLease(token,now) {
    return this.tx(()=>{
      const lock=this.get('SELECT * FROM runtime_lock WHERE id=1');
      if(lock&&lock.heartbeat>now-60_000)throw new Error('이미 봇이 실행 중입니다. 비정상 종료했다면 60초 후 다시 실행해주세요.');
      this.run('INSERT OR REPLACE INTO runtime_lock(id,token,heartbeat) VALUES (1,?,?)',token,now);
    });
  }
  heartbeat(token,now) {
    const result=this.run('UPDATE runtime_lock SET heartbeat=? WHERE id=1 AND token=? AND heartbeat>?',now,token,now-60_000);
    if(!result.changes)this.checkLease(token,now);
  }
  checkLease(token,now) {
    const lock=this.get('SELECT * FROM runtime_lock WHERE id=1');
    if(lock?.token!==token||lock.heartbeat<=now-60_000)throw new Error('DB 실행 잠금을 잃었습니다.');
  }
  releaseLease(token) {this.run('DELETE FROM runtime_lock WHERE token=?',token);}
}
