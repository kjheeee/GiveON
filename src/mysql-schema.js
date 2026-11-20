// MySQL 8.0.19 이상 / InnoDB. Discord ID는 정밀도 손실 없이 문자열로 저장합니다.
const id='VARCHAR(22) CHARACTER SET ascii COLLATE ascii_bin';
const ref='VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin';
const roles="VARCHAR(1024) NOT NULL DEFAULT '[]'";
const table=body=>body+' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
export const mysqlSchema=[
  table('CREATE TABLE IF NOT EXISTS giveon_metadata (id TINYINT PRIMARY KEY, version INT NOT NULL)'),
  table(`CREATE TABLE IF NOT EXISTS guilds (
    id ${id} PRIMARY KEY, manager_channel ${id}, event_channel ${id},
    manager_roles ${roles}, condition_roles ${roles}, blocked_roles ${roles}, mention_roles ${roles})`),
  table(`CREATE TABLE IF NOT EXISTS events (
    id ${ref} PRIMARY KEY,guild_id ${id} NOT NULL,owner_id ${id} NOT NULL,
    title VARCHAR(100) NOT NULL,description TEXT NOT NULL,duration_ms BIGINT NOT NULL,claim_ms BIGINT NOT NULL,
    winner_count INT NOT NULL,proof_required TINYINT NOT NULL,proof_instructions TEXT NOT NULL,
    allow_roles ${roles},deny_roles ${roles},status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',created_at BIGINT NOT NULL,
    started_at BIGINT,ends_at BIGINT,approved_by ${id},rejection_reason TEXT,public_message_id ${id},
    FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
  table(`CREATE TABLE IF NOT EXISTS prizes (event_id ${ref} NOT NULL,slot INT NOT NULL,secret MEDIUMBLOB,
    status VARCHAR(32) NOT NULL DEFAULT 'AVAILABLE',delivery_mode VARCHAR(16) NOT NULL DEFAULT 'DIGITAL',name BLOB,name_public TINYINT NOT NULL DEFAULT 1,PRIMARY KEY(event_id,slot),FOREIGN KEY(event_id) REFERENCES events(id))`),
  table(`CREATE TABLE IF NOT EXISTS entries (event_id ${ref} NOT NULL,user_id ${id} NOT NULL,joined_at BIGINT NOT NULL,
    PRIMARY KEY(event_id,user_id),FOREIGN KEY(event_id) REFERENCES events(id))`),
  table(`CREATE TABLE IF NOT EXISTS claims (
    id ${ref} PRIMARY KEY,event_id ${ref} NOT NULL,slot INT NOT NULL,user_id ${id} NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CLAIMABLE',claim_deadline BIGINT NOT NULL,
    submit_deadline BIGINT,upload_until BIGINT,upload_token VARCHAR(64),proof MEDIUMBLOB,feedback MEDIUMBLOB,
    proof_version INT NOT NULL DEFAULT 0,reviewer_id ${id},created_at BIGINT NOT NULL,completed_at BIGINT,
    dm_channel_id ${id},dm_message_id VARCHAR(64),send_started BIGINT,delivery_nonce VARCHAR(64) NOT NULL,last_error VARCHAR(128),
    active_slot INT GENERATED ALWAYS AS (CASE WHEN status NOT IN ('EXPIRED','DENIED') THEN slot ELSE NULL END) STORED,
    UNIQUE KEY winner_once(event_id,user_id),UNIQUE KEY active_slot(event_id,active_slot),
    FOREIGN KEY(event_id,slot) REFERENCES prizes(event_id,slot))`),
  table(`CREATE TABLE IF NOT EXISTS audit (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,event_id ${ref} NOT NULL,
    claim_id ${ref},action VARCHAR(64) NOT NULL,actor_id ${id},created_at BIGINT NOT NULL)`),
  table(`CREATE TABLE IF NOT EXISTS jobs (id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    kind VARCHAR(32) NOT NULL,ref_id ${ref} NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    message_id VARCHAR(64),channel_id VARCHAR(64),created_at BIGINT NOT NULL,next_at BIGINT NOT NULL DEFAULT 0,error_code VARCHAR(128))`),
  table('CREATE TABLE IF NOT EXISTS runtime_lock (id TINYINT PRIMARY KEY,token VARCHAR(64),heartbeat BIGINT,CHECK(id=1))'),
  table(`CREATE TABLE IF NOT EXISTS panels (guild_id ${id} PRIMARY KEY,channel_id ${id} NOT NULL,message_id VARCHAR(64),
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING',updated_at BIGINT NOT NULL,previous_channel_id ${id},previous_message_id VARCHAR(64),
    FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
  table(`CREATE TABLE IF NOT EXISTS draft_steps (event_id ${ref} PRIMARY KEY,step VARCHAR(32) NOT NULL,slot INT NOT NULL DEFAULT 1,
    template_id ${ref},template_revision INT,FOREIGN KEY(event_id) REFERENCES events(id))`),
  table(`CREATE TABLE IF NOT EXISTS event_templates (id ${ref} PRIMARY KEY,guild_id ${id} NOT NULL,name VARCHAR(80) NOT NULL,
    description TEXT NOT NULL,allow_roles ${roles},deny_roles ${roles},proof_required TINYINT NOT NULL DEFAULT 0,
    proof_instructions TEXT NOT NULL,enabled TINYINT NOT NULL DEFAULT 0,revision INT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL,created_by ${id} NOT NULL,FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
  table(`CREATE TABLE IF NOT EXISTS setup_sessions (guild_id ${id} NOT NULL,user_id ${id} NOT NULL,token VARCHAR(64) NOT NULL,
    step VARCHAR(32) NOT NULL,data TEXT NOT NULL,baseline TEXT NOT NULL,PRIMARY KEY(guild_id,user_id),FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
  table(`CREATE TABLE IF NOT EXISTS direct_events (event_id ${ref} PRIMARY KEY,FOREIGN KEY(event_id) REFERENCES events(id))`),
  table(`CREATE TABLE IF NOT EXISTS notification_prefs (user_id ${id} PRIMARY KEY,enabled TINYINT NOT NULL DEFAULT 1,updated_at BIGINT NOT NULL)`),
  table(`CREATE TABLE IF NOT EXISTS guild_time_limits (guild_id ${id} PRIMARY KEY,
    duration_min INT NOT NULL,duration_max INT NOT NULL,claim_min INT NOT NULL,claim_max INT NOT NULL,
    updated_by ${id} NOT NULL,updated_at BIGINT NOT NULL,FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
  table(`CREATE TABLE IF NOT EXISTS host_blocks (guild_id ${id} NOT NULL,user_id ${id} NOT NULL,actor_id ${id} NOT NULL,
    created_at BIGINT NOT NULL,reason VARCHAR(500) NOT NULL DEFAULT '',active TINYINT NOT NULL DEFAULT 1,
    released_by ${id},released_at BIGINT,PRIMARY KEY(guild_id,user_id),FOREIGN KEY(guild_id) REFERENCES guilds(id))`),
];

// 기존 저장소에서 사용하는 제한된 upsert 문법만 변환합니다. 값은 전부 준비된 문의 매개변수입니다.
export function mysqlSql(sql) {
  if(/^INSERT OR IGNORE INTO /i.test(sql)) {
    const table=sql.match(/^INSERT OR IGNORE INTO\s+([a-z_]+)/i)[1];
    const key={guilds:'id',jobs:'id',entries:'event_id',prizes:'event_id'}[table];
    if(!key)throw new Error('지원하지 않는 중복 방지 SQL');
    return sql.replace(/^INSERT OR IGNORE INTO /i,'INSERT INTO ')+` ON DUPLICATE KEY UPDATE ${key}=${table}.${key}`;
  }
  return sql.replace(/^INSERT OR REPLACE INTO /i,'REPLACE INTO ')
    .replace(/ON CONFLICT\s*\([^)]*\)\s*DO UPDATE SET\s*/i,'AS incoming ON DUPLICATE KEY UPDATE ')
    .replace(/\bexcluded\.([a-z_]+)/gi,'incoming.$1');
}
