import dotenv from "dotenv";
dotenv.config(); // 1. This must be the absolute first line of code

// --- WINDOWS 8.1 / NODE 16 PATCH ---
// This safely forces the missing Fetch/Headers and WebSocket APIs into Node 16 globals
import fetch, { Headers, Request, Response } from "node-fetch";
if (!globalThis.fetch) {
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}

import ws from "ws"; // Explicitly import the WebSocket package for Node 16
// ------------------------------------

import ZKLib from "node-zklib";
import { createClient } from "@supabase/supabase-js";

// --- CONFIGURATION FROM .ENV ---
const SCANNER_IP = process.env.SCANNER_IP;
const SCANNER_PORT = parseInt(process.env.SCANNER_PORT, 10) || 4371;
const LOCATION_NAME = process.env.LOCATION_NAME;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Uncomment this if not using Windows 8.1 / Node 16
// const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- WINDOWS 8.1 / NODE 16 PATCH ---
// Pass the custom WebSocket transport configuration into Supabase here
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws },
});
// -------------------------------

async function syncAttendance() {
  console.log(`⏳ Attempting to connect to scanner at ${SCANNER_IP}...`);

  let zkInstance = new ZKLib(SCANNER_IP, SCANNER_PORT, 10000, 4000);

  try {
    // 1. Connect to the machine
    await zkInstance.createSocket();
    console.log("✅ Connected to scanner successfully!");

    // 2. Fetch attendance logs
    console.log("⏳ Fetching attendance logs...");
    const logs = await zkInstance.getAttendances();
    console.log(
      `✅ Fetched ${logs.data.length} total attendance logs from scanner.`,
    );

    if (logs.data.length === 0) {
      console.log("ℹ️ No logs to sync. Exiting.");
      return;
    }

    // 3. TRANSFORM & DEDUPLICATE THE DATA (ETL Step)
    console.log("⏳ Transforming and removing duplicate logs...");

    const uniqueLogsMap = new Map();

    logs.data.forEach((log) => {
      let finalizedTimestamp;

      // Check if it's already a Date object
      if (log.recordTime instanceof Date) {
        finalizedTimestamp = log.recordTime.toISOString();
      } else {
        const localTimeString = String(log.recordTime).replace("Z", "+08:00");
        finalizedTimestamp = new Date(localTimeString).toISOString();
      }

      // Clean Employee ID
      const cleanEmployeeId = String(log.deviceUserId)
        .replace(/^@/, "")
        .replace(/\x00/g, "")
        .trim();

      // Create a unique key for this specific scan
      const uniqueKey = `${cleanEmployeeId}_${finalizedTimestamp}`;

      // Only add to the map if this exact scan hasn't been added yet
      if (!uniqueLogsMap.has(uniqueKey)) {
        uniqueLogsMap.set(uniqueKey, {
          employee_id: cleanEmployeeId,
          scanned_at: finalizedTimestamp,
          scanner_location: LOCATION_NAME,
        });
      }
    });

    // Convert the Map back into an array for Supabase
    const finalLogsToInsert = Array.from(uniqueLogsMap.values());

    console.log(
      `🧹 Removed ${logs.data.length - finalLogsToInsert.length} duplicates.`,
    );
    console.log(
      `✅ Ready to push ${finalLogsToInsert.length} unique logs to Supabase.`,
    );

    // 4. LOAD TO SUPABASE
    console.log("⏳ Pushing data to Supabase database...");

    const { data, error } = await supabase
      .from("attendance_logs")
      .upsert(finalLogsToInsert, {
        onConflict: "employee_id, scanned_at",
      });

    if (error) {
      console.error("❌ Error pushing to Supabase:");
      console.error(error);
    } else {
      console.log("🚀 SUCCESS: All logs have been synced to Supabase!");
    }
  } catch (error) {
    console.error("❌ Connection or syncing failed:");
    console.error(error);
  } finally {
    // 5. Always disconnect
    await zkInstance.disconnect();
    console.log("🔌 Disconnected from scanner.");
  }
}

// --- CONTINUOUS POLLING SETUP ---
// Set how often you want to check for new logs (in milliseconds)
// 60000 = 1 minute, 300000 = 5 minutes
const POLLING_INTERVAL_MS = 60 * 1000;

async function startContinuousSync() {
  await syncAttendance();

  console.log(
    `⏱️ Waiting ${POLLING_INTERVAL_MS / 1000} seconds before next sync...`,
  );
  console.log("---------------------------------------------------");

  // Recursively call this function after the delay
  setTimeout(startContinuousSync, POLLING_INTERVAL_MS);
}

// Start the loop
startContinuousSync();