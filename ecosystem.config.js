require('dotenv').config();

module.exports = {
  apps: [
    {
      name: process.env.SYSTEM_NAME || 'omnizap-default',
      script: './src/connection/index.js',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-dev`,
      },
      env_production: {
        NODE_ENV: 'production',
        INSTANCE_ID: `${process.env.SYSTEM_NAME || 'omnizap'}-prod`,
      },
    },
  ],
};
