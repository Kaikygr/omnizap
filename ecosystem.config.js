require('dotenv').config();

const SYSTEM_NAME = process.env.SYSTEM_NAME || 'omnizap';

module.exports = {
  apps: [
    {
      name: SYSTEM_NAME,
      script: './src/connection/index.js',

      exec_mode: 'fork',
      instances: 1,
      exec_interpreter: 'node',
      node_args: '--max-old-space-size=2048',

      cwd: '/home/omnizap',

      error_file: './logs/connection-error.log',
      out_file: './logs/connection-out.log',
      log_file: './logs/connection-combined.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      pid_file: './pids/connection.pid',

      max_memory_restart: '1G',
      autorestart: true,
      min_uptime: '60s',
      max_restarts: 5,
      restart_delay: 5000,
      kill_timeout: 3000,

      env: {
        NODE_ENV: 'development',
        INSTANCE_ID: `${SYSTEM_NAME}-dev`,
      },
      env_production: {
        NODE_ENV: 'production',
        INSTANCE_ID: `${SYSTEM_NAME}-prod`,
      },
    },
  ],
};
