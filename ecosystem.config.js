require('dotenv').config();

const SYSTEM_NAME = process.env.SYSTEM_NAME || 'omnizap';

module.exports = {
  apps: [
    {
      name: `${SYSTEM_NAME}-default`,
      script: './src/connection/index.js',

      // Execution settings
      exec_mode: 'fork',
      instances: 1,
      exec_interpreter: 'node',
      node_args: '--max-old-space-size=2048',

      // Working directory
      cwd: '/home/omnizap',

      // Logging configuration
      error_file: './logs/connection-error.log',
      out_file: './logs/connection-out.log',
      log_file: './logs/connection-combined.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      pid_file: './pids/connection.pid',

      // Memory and restart settings
      max_memory_restart: '1G',
      autorestart: true,
      min_uptime: '60s',
      max_restarts: 5,
      restart_delay: 5000,
      kill_timeout: 3000,

      // Environment configurations
      env: {
        NODE_ENV: 'development',
        INSTANCE_ID: `${SYSTEM_NAME}-dev`,
      },
      env_test: {
        NODE_ENV: 'test',
        INSTANCE_ID: `${SYSTEM_NAME}-test`,
      },
      env_staging: {
        NODE_ENV: 'staging',
        INSTANCE_ID: `${SYSTEM_NAME}-staging`,
      },
      env_production: {
        NODE_ENV: 'production',
        INSTANCE_ID: `${SYSTEM_NAME}-prod`,
      },
    },
  ],
};
