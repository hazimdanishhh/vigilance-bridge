const ZKLib = require("node-zklib");
const fs = require("fs");

// --- CONFIGURATION ---
const SCANNER_IP = "192.168.0.241";
const SCANNER_PORT = 4371;
const OUTPUT_FILE = "scanner_data.json";
// ---------------------

async function testConnection() {
  console.log(`⏳ Attempting to connect to scanner at ${SCANNER_IP}...`);

  let zkInstance = new ZKLib(SCANNER_IP, SCANNER_PORT, 10000, 4000);

  try {
    // 1. Connect to the machine
    await zkInstance.createSocket();
    console.log("✅ Connected successfully!");

    // 2. Fetch basic device info
    console.log("⏳ Fetching device info...");
    const info = await zkInstance.getInfo();
    console.log(`   - Users stored: ${info.userCounts}`);
    console.log(`   - Logs stored: ${info.logCounts}`);

    // 3. Fetch attendance logs
    console.log("⏳ Fetching attendance logs...");
    const logs = await zkInstance.getAttendances();
    console.log(`✅ Fetched ${logs.data.length} total attendance logs.`);

    // 4. TRANSFORM THE DATA (ETL Step)
    console.log("⏳ Transforming logs for Supabase compatibility...");

    const transformedLogs = logs.data.map((log) => {
      let finalizedTimestamp;

      // Check if it's already a Date object (which node-zklib usually does)
      if (log.recordTime instanceof Date) {
        // Since your local PC is in Malaysia, this Date object is already in Malaysia Time.
        // .toISOString() will automatically convert it to true UTC for Supabase!
        finalizedTimestamp = log.recordTime.toISOString();
      } else {
        // Fallback: If it ever comes through as a string string
        const localTimeString = String(log.recordTime).replace("Z", "+08:00");
        finalizedTimestamp = new Date(localTimeString).toISOString();
      }

      return {
        employee_id: log.deviceUserId, // Maps to your DB column
        scanned_at: finalizedTimestamp, // Maps to your DB column (timestamptz)
      };
    });

    // 5. Format the data to save locally for testing
    const fileContent = {
      last_tested: new Date().toLocaleString(),
      device_info: info,
      log_count: logs.data.length,
      transformed_logs: transformedLogs, // Look at this array in your JSON output!
    };

    // 6. Write to a JSON file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fileContent, null, 4));
    console.log(`📁 SUCCESS: Transformed data saved to ${OUTPUT_FILE}`);
  } catch (error) {
    console.error("❌ Connection or fetching failed:");
    console.error(error);
  } finally {
    // 7. Always disconnect
    await zkInstance.disconnect();
    console.log("🔌 Disconnected from scanner.");
  }
}

// Run the script
testConnection();
