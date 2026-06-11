// PM2 Ecosystem Config
// Usage:
//   pm2 start ecosystem.config.cjs       ← start / restart
//   pm2 stop vigilance-bridge            ← stop
//   pm2 logs vigilance-bridge            ← live logs
//   pm2 save                             ← persist across reboots
//   pm2 startup                          ← register PM2 as a Windows service

module.exports = {
  apps: [
    {
      name: "vigilance-bridge",
      script: "./sync.mjs",

      // --- Restart policy ---
      // Restart automatically if it crashes; back off after 5 quick crashes
      restart_delay: 5000, // Wait 5s before restarting after a crash
      max_restarts: 10, // Give up after 10 consecutive crashes (misconfiguration likely)
      min_uptime: "10s", // A run shorter than 10s counts as a crash

      // --- Logging ---
      // PM2 manages its own logs; winston also writes to ./logs/
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // --- Environment ---
      // Loads your .env file automatically
      env: {
        NODE_ENV: "production",
      },

      // --- Windows 8.1 compatibility ---
      // Keep interpreter default (node); don't use cluster mode on old hardware
      exec_mode: "fork",
      instances: 1,
    },
  ],
};
