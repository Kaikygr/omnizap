require('dotenv').config();

module.exports = {
  apps: [
    {
      name: process.env.SYSTEM_NAME || 'omnizap-default',
      script: './src/connection/index.js',

      // === modo fork (1 instância apenas) ===
      exec_mode: 'fork',
      instances: 1,

      // == diretório de trabalho ==
      cwd: '/home/omnizap',

      // == logs e arquivos de PID ==
      error_file: './logs/connection-error.log',
      out_file: './logs/connection-out.log',
      log_file: './logs/connection-combined.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      pid_file: './pids/connection.pid',

      // == memória / reinícios ==
      max_memory_restart: '1G', // se usar >1GB, reinicia
      autorestart: true,
      min_uptime: '60s',
      max_restarts: 5,
      restart_delay: 5000, // espera 5s antes de reiniciar

      // == tempo para kill gracioso ==
      kill_timeout: 3000, // 3s antes de forçar kill

      // == passar flags para o Node ==
      exec_interpreter: 'node',
      node_args: '--max-old-space-size=2048',

      // == ambientes ==
      env: {
        NODE_ENV: 'development',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-dev`,
      },
      env_test: {
        NODE_ENV: 'test',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-test`,
      },
      env_staging: {
        NODE_ENV: 'staging',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-staging`,
      },
      env_production: {
        NODE_ENV: 'production',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-prod`,
      },
    },
  ],
};
