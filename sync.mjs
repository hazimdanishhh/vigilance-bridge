import dotenv from "dotenv";
dotenv.config();

// DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1514539372974706708/T4Iy4W8Vkf_9M373NhfAVJIlRUZd1Anj6L-R7PjJEYDjew_j6eCJaHffKrYvXJiE84Xm

// --- WINDOWS 8.1 / NODE 16 POLYFILLS ---
import fetch, { Headers, Request, Response } from "node-fetch";
if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}
import ws from "ws";
// ----------------------------------------

import ZKLib from "node-zklib";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";
import winston from "winston";

// ─── LOGGER SETUP ───────────────────────────────────────────────────────────
// Logs to console AND a rotating file. PM2 also captures stdout separately.
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `[${timestamp}] [${level.toUpperCase()}] ${message}`,
    ),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "logs/sync-error.log",
      level: "error",
      maxsize: 5 * 1024 * 1024, // 5MB cap
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/sync-combined.log",
      maxsize: 10 * 1024 * 1024, // 10MB cap
      maxFiles: 7,
    }),
  ],
});

// ─── CONFIG VALIDATION ──────────────────────────────────────────────────────
// Fail loudly at startup if required env vars are missing
const REQUIRED_ENV = [
  "SCANNER_IP",
  "LOCATION_NAME",
  "SUPABASE_URL",
  "SUPABASE_KEY",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  logger.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1); // Hard exit — don't run with broken config
}

const SCANNER_IP = process.env.SCANNER_IP;
const SCANNER_PORT = parseInt(process.env.SCANNER_PORT, 10) || 4371;
const LOCATION_NAME = process.env.LOCATION_NAME;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // Optional
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/1 * * * *"; // Default: every 1 min

// ─── SUPABASE CLIENT ────────────────────────────────────────────────────────
// Realtime WebSocket is not needed for a write-only sync job.
// Using a plain client avoids the unnecessary WS connection overhead.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  // auth: { persistSession: false }, // Stateless — no session file on disk
  realtime: {transport: ws },
});

// ─── DISCORD NOTIFICATION ───────────────────────────────────────────────────
async function sendDiscordNotification(type, message, details = null) {
  if (!DISCORD_WEBHOOK_URL) return; // Silently skip if not configured

  const colors = { success: 0x57f287, error: 0xed4245, warning: 0xfee75c };
  const icons = { success: "✅", error: "❌", warning: "⚠️" };

  const embed = {
    title: `${icons[type] || "ℹ️"} Scanner Sync — ${LOCATION_NAME}`,
    description: message,
    color: colors[type] || 0x5865f2,
    timestamp: new Date().toISOString(),
    footer: { text: `Scanner: ${SCANNER_IP}:${SCANNER_PORT}` },
    ...(details && {
      fields: Object.entries(details).map(([name, value]) => ({
        name,
        value: String(value),
        inline: true,
      })),
    }),
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      logger.warn(`Discord notification failed — HTTP ${res.status}`);
    }
  } catch (err) {
    // Never let a notification failure break the main sync loop
    logger.warn(`Discord notification threw an error: ${err.message}`);
  }
}

// ─── MAIN SYNC FUNCTION ─────────────────────────────────────────────────────
let isSyncRunning = false; // Guard against overlapping runs (if sync takes > 1 min)

async function syncAttendance() {
  if (isSyncRunning) {
    logger.warn("Previous sync is still running. Skipping this cycle.");
    return;
  }
  isSyncRunning = true;
  const startTime = Date.now();
  logger.info("─── Sync cycle starting ──────────────────────────");

  let zkInstance = new ZKLib(SCANNER_IP, SCANNER_PORT, 10000, 4000);

  try {
    // 1. Connect
    logger.info(`Connecting to scanner at ${SCANNER_IP}:${SCANNER_PORT}...`);
    await zkInstance.createSocket();
    logger.info("Connected to scanner.");

    // 2. Fetch logs
    logger.info("Fetching attendance logs...");
    const logs = await zkInstance.getAttendances();
    logger.info(`Fetched ${logs.data.length} total logs from scanner.`);

    if (logs.data.length === 0) {
      logger.info("No logs found. Sync complete.");
      return;
    }

    // 3. Transform & deduplicate
    const uniqueLogsMap = new Map();

    logs.data.forEach((log) => {
      let finalizedTimestamp;

      if (log.recordTime instanceof Date) {
        finalizedTimestamp = log.recordTime.toISOString();
      } else {
        // Treat scanner time as local +08:00 (Malaysia/Singapore time)
        const localTimeString = String(log.recordTime).replace("Z", "+08:00");
        finalizedTimestamp = new Date(localTimeString).toISOString();
      }

      const cleanEmployeeId = String(log.deviceUserId)
        .replace(/^@/, "")
        .replace(/\x00/g, "")
        .trim();

      const uniqueKey = `${cleanEmployeeId}_${finalizedTimestamp}`;

      if (!uniqueLogsMap.has(uniqueKey)) {
        uniqueLogsMap.set(uniqueKey, {
          employee_id: cleanEmployeeId,
          scanned_at: finalizedTimestamp,
          scanner_location: LOCATION_NAME,
        });
      }
    });

    const finalLogsToInsert = Array.from(uniqueLogsMap.values());
    const duplicatesRemoved = logs.data.length - finalLogsToInsert.length;
    logger.info(
      `Deduplication: ${duplicatesRemoved} duplicates removed. ${finalLogsToInsert.length} unique logs ready.`,
    );

    // 4. Upsert to Supabase
    logger.info("Pushing to Supabase...");
    const { error } = await supabase
      .from("attendance_logs")
      .upsert(finalLogsToInsert, {
        onConflict: "employee_id, scanned_at",
      });

    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(
      `Sync complete. ${finalLogsToInsert.length} logs synced in ${elapsed}s.`,
    );

    // Only notify Discord on notable syncs (new records found), not every heartbeat
    if (finalLogsToInsert.length > 0) {
      await sendDiscordNotification("success", `Sync completed successfully.`, {
        "New Records": finalLogsToInsert.length,
        "Duplicates Skipped": duplicatesRemoved,
        Duration: `${elapsed}s`,
        Location: LOCATION_NAME,
      });
    }
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.error(`Sync failed after ${elapsed}s: ${error.message}`);

    // Always notify on errors — this is the most important alert
    await sendDiscordNotification(
      "error",
      `Sync failed. Manual check required.`,
      {
        Error: error.message,
        Duration: `${elapsed}s`,
        Location: LOCATION_NAME,
      },
    );
  } finally {
    try {
      await zkInstance.disconnect();
      logger.info("Disconnected from scanner.");
    } catch (disconnectError) {
      logger.warn(`Clean disconnect failed: ${disconnectError.message}`);
    }
    isSyncRunning = false;
    logger.info("─── Sync cycle complete ──────────────────────────");
  }
}

// ─── CRON SCHEDULER ─────────────────────────────────────────────────────────
// node-cron is far more robust than recursive setTimeout:
//   - Won't drift over time
//   - Won't silently die if the callback throws
//   - Schedule is human-readable and configurable via .env
if (!cron.validate(CRON_SCHEDULE)) {
  logger.error(
    `Invalid CRON_SCHEDULE: "${CRON_SCHEDULE}". Example: "*/5 * * * *"`,
  );
  process.exit(1);
}

logger.info(`🚀 Attendance sync service starting...`);
logger.info(`   Location : ${LOCATION_NAME}`);
logger.info(`   Scanner  : ${SCANNER_IP}:${SCANNER_PORT}`);
logger.info(`   Schedule : ${CRON_SCHEDULE}`);
logger.info(`   Discord  : ${DISCORD_WEBHOOK_URL ? "Enabled" : "Disabled"}`);

// Run once immediately on startup, then follow the cron schedule
syncAttendance();
cron.schedule(CRON_SCHEDULE, syncAttendance);

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
// Handles Ctrl+C and PM2 stop/restart signals cleanly
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  await sendDiscordNotification(
    "warning",
    `Sync service is shutting down (${signal}).`,
  );
  // Give any in-flight sync up to 15 seconds to finish
  const timeout = setTimeout(() => {
    logger.warn("Forced shutdown after timeout.");
    process.exit(0);
  }, 15000);
  timeout.unref(); // Don't let this timer keep Node alive on its own
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
