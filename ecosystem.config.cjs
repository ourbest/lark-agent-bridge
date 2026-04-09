module.exports = {
  apps: [
    {
      name: 'lark-agent-bridge',
      cwd: __dirname,
      script: 'npm',
      args: 'start',
      env_file: '.env',
      env: {
        BRIDGE_APP_NAME: 'lark-agent-bridge',
      },
      autorestart: true,
      restart_delay: 1000,
      kill_timeout: 5000,
      max_restarts: 20,
      min_uptime: '10s',
      time: true,
    },
  ],
};
