import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { StoreBase } from './store-base.js';

export class Store extends StoreBase {
  constructor(path = ':memory:') {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // WAL에 삭제 전 자료가 남지 않도록 rollback journal을 사용합니다.
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;`);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    const version = this.get('PRAGMA user_version').user_version;
    if (version > 1) throw new Error('이 DB는 더 최신 버전의 봇이 필요합니다.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY, manager_channel TEXT, event_channel TEXT,
        manager_roles TEXT NOT NULL DEFAULT '[]', condition_roles TEXT NOT NULL DEFAULT '[]',
        blocked_roles TEXT NOT NULL DEFAULT '[]', mention_roles TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id), owner_id TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        claim_ms INTEGER NOT NULL, winner_count INTEGER NOT NULL,
        proof_required INTEGER NOT NULL, proof_instructions TEXT NOT NULL,
        allow_roles TEXT NOT NULL DEFAULT '[]', deny_roles TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'DRAFT', created_at INTEGER NOT NULL,
        started_at INTEGER, ends_at INTEGER, approved_by TEXT, rejection_reason TEXT,
        public_message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS prizes (
        event_id TEXT NOT NULL REFERENCES events(id), slot INTEGER NOT NULL,
        secret BLOB, status TEXT NOT NULL DEFAULT 'AVAILABLE', delivery_mode TEXT NOT NULL DEFAULT 'DIGITAL', PRIMARY KEY(event_id,slot)
      );
      CREATE TABLE IF NOT EXISTS entries (
        event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL, PRIMARY KEY(event_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, slot INTEGER NOT NULL, user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CLAIMABLE', claim_deadline INTEGER NOT NULL,
        submit_deadline INTEGER, upload_until INTEGER, upload_token TEXT,
        proof BLOB, feedback BLOB, proof_version INTEGER NOT NULL DEFAULT 0,
        reviewer_id TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
        dm_channel_id TEXT, dm_message_id TEXT, send_started INTEGER, delivery_nonce TEXT NOT NULL,
        last_error TEXT, FOREIGN KEY(event_id,slot) REFERENCES prizes(event_id,slot),
        UNIQUE(event_id,user_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_slot ON claims(event_id,slot)
        WHERE status NOT IN ('EXPIRED','DENIED');
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, claim_id TEXT, action TEXT NOT NULL,
        actor_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', message_id TEXT, channel_id TEXT,
        created_at INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, heartbeat INTEGER);
      CREATE TABLE IF NOT EXISTS panels (
        guild_id TEXT PRIMARY KEY REFERENCES guilds(id), channel_id TEXT NOT NULL,
        message_id TEXT, state TEXT NOT NULL DEFAULT 'PENDING', updated_at INTEGER NOT NULL,
        previous_channel_id TEXT, previous_message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS draft_steps (
        event_id TEXT PRIMARY KEY REFERENCES events(id), step TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 1,
        template_id TEXT, template_revision INTEGER
      );
      CREATE TABLE IF NOT EXISTS event_templates (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(id), name TEXT NOT NULL,
        description TEXT NOT NULL, allow_roles TEXT NOT NULL DEFAULT '[]', deny_roles TEXT NOT NULL DEFAULT '[]',
        proof_required INTEGER NOT NULL DEFAULT 0, proof_instructions TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setup_sessions (
        guild_id TEXT NOT NULL REFERENCES guilds(id), user_id TEXT NOT NULL,
        token TEXT NOT NULL, step TEXT NOT NULL, data TEXT NOT NULL, baseline TEXT NOT NULL,
        PRIMARY KEY(guild_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS direct_events (event_id TEXT PRIMARY KEY REFERENCES events(id));
      CREATE TABLE IF NOT EXISTS notification_prefs (
        user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_blocks (
        guild_id TEXT NOT NULL REFERENCES guilds(id), user_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        released_by TEXT, released_at INTEGER, PRIMARY KEY(guild_id,user_id)
      );
      PRAGMA user_version=1;
    `);
    this.upgradeHostBlocks();
    this.upgradePrizeDelivery();
  }
  upgradePrizeDelivery() {
    this.tx(()=>{
      if(!this.columns('prizes').includes('delivery_mode'))this.db.exec("ALTER TABLE prizes ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'DIGITAL'");
      this.db.exec("UPDATE prizes SET delivery_mode='DIRECT' WHERE event_id IN (SELECT event_id FROM direct_events); DELETE FROM direct_events;");
    });
  }
  upgradeHostBlocks() {
    const columns=new Set(this.columns('host_blocks'));
    for(const [name,definition] of Object.entries({reason:"TEXT NOT NULL DEFAULT ''",active:'INTEGER NOT NULL DEFAULT 1',released_by:'TEXT',released_at:'INTEGER'})) {
      if(!columns.has(name))this.db.exec(`ALTER TABLE host_blocks ADD COLUMN ${name} ${definition}`);
    }
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  columns(table) {
    if(!/^[a-z_]+$/.test(table))throw new Error('잘못된 테이블 이름');
    return this.all(`PRAGMA table_info(${table})`).map(column=>column.name);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
