const path = require('node:path');

// 실제 토큰·키는 환경 파일에만 두고 PM2 설정에는 경로만 전달합니다.
const envFile = process.env.GIVEON_ENV_FILE || path.join(__dirname, '.env');
const logDir = process.env.GIVEON_LOG_DIR || path.join(__dirname, 'data', 'logs');

module.exports = {
  apps: [{
    name: 'giveon',
    cwd: __dirname,
    script: 'src/main.js',
    interpreter: process.env.GIVEON_NODE || process.execPath,
    node_args: [`--env-file=${envFile}`],
    exec_mode: 'fork', instances: 1,
    autorestart: true, watch: false,
    min_uptime: 10000, max_restarts: 5,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: '512M',
    wait_ready: true, listen_timeout: 60000,
    shutdown_with_message: true, kill_timeout: 15000,
    out_file: path.join(logDir, 'giveon-out.log'),
    error_file: path.join(logDir, 'giveon-error.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    env: { NODE_ENV: 'production' },
  }],
};
