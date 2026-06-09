# Hyrax Oil Vigilance Scanner to Supabase Bridge

This project is a lightweight Node.js script that acts as a bridge between a local Vigilance biometric attendance scanner and a cloud-hosted Supabase database.

It continuously polls the local scanner for new logs, deduplicates the data, and pushes it to Supabase in real-time.

---

## Prerequisites

Before installing this on a new PC, ensure you have the following:

- **Node.js**: [Download and install Node.js](https://nodejs.org/) (LTS version recommended).
- **Network Access**: The PC running this script must be on the same local network (LAN/WiFi) as the biometric scanner.
- **Scanner IP Address**: Ensure the scanner has a static IP assigned on your network to prevent the IP from changing upon reboot.

---

## Installation & Setup

**1. Clone or copy the project files**
Place the project folder on the local PC (e.g., in the `Documents` folder).

**2. Install Dependencies**
Open your terminal (Command Prompt, PowerShell, or VSCode Terminal), navigate to the project folder, and run:

```bash
npm install
```

**3. Configure Environment Variables**
Create a .env file in the root of the project directory and add your configuration:

```env
# Scanner Configuration
SCANNER_IP="192.168.0.111"
SCANNER_PORT="4371"
LOCATION_NAME="Office" # || "Blending Plant"

# Supabase Configuration
SUPABASE_URL="https://{your-project-id}.supabase.co"
SUPABASE_KEY="your-anon-or-service-role-key"
```

--

## Running the Script

**Option A: Testing / Development**
If you just want to run the script once to see the console output and verify it's working:

```bash
node bridge.js
```

_(Press Ctrl + C to stop the script)._

**Option B: Production (Always-On Background Process via Windows Task Scheduler)**
To ensure this script runs continuously on Windows—even after you log out of the IT Admin user account—we use a combination of a native Windows Batch Script and Task Scheduler.

1. **Create the Batch File:**
   In the root of the project folder (`C:\Users\IT Admin\Documents\vigilance-bridge`), create a file named `start-bridge.bat` and paste the following:

   ```batch
   @echo off
   :: Navigate to your project folder
   cd /d "C:\Users\IT Admin\Documents\vigilance-bridge"

   echo --- Bridge Started at %date% %time% --- >> output.log

   :loop
   :: Run the script and pipe all terminal text and errors into output.log
   node bridge.js >> output.log 2>&1

   :: If the script ever crashes or exits, the batch file will catch it here
   echo ❌ Script crashed or stopped. Restarting in 5 seconds... >> output.log
   timeout /t 5 > nul
   goto loop
   ```

2. **Configure Windows Task Scheduler:**
   - Press `Win + R`, type `taskschd.msc`, and hit `Enter`.
   - Click `Create Task...` (on the right-hand Actions panel).
   - General Tab:
      - `Name: Vigilance Supabase Bridge`.
      - Select `Run whether user is logged on or not` (Crucial for surviving logouts).
      - Check `Run with highest privileges`.
   - Triggers Tab: Click `New...` -> `Set Begin the task to At startup`.
   - Actions Tab: Click `New...` -> `Set Action to Start a program`.
      - Browse to your `start-bridge.bat` file.
      - In the Start in (optional) field, paste: (`C:\Users\IT Admin\Documents\vigilance-bridge`) (No quotes here).
   - Conditions Tab: Uncheck `Start the task only if the computer is on AC power`.
   - Click `OK` and enter your Windows administrator password when prompted.

**Option C: Production (Always-On Background Process)**
To run this continuously on a dedicated PC, we use PM2, a production process manager for Node.js. It runs the script invisibly in the background and automatically restarts it if it crashes.

1. Open Git Bash as 

2. Navigate to `vigilance-bridge` folder

3. Install PM2 globally:

   ```bash
   npm install -g pm2
   ```

4. Start the bridge process in terminal:

   ```bash
   pm2 start bridge.js --name "vigilance-bridge"
   ```

5. Save PM2 processes (Optional but recommended):
   To ensure PM2 automatically starts the script if the Windows PC restarts, install the PM2 Windows startup package:

   ```bash
   npm install -g pm2-windows-startup
   pm2-startup install
   pm2 save
   ```

## Useful PM2 Commands

Once the script is running via PM2, you can manage it using the following terminal commands:

- Monitor: `pm2 monit`
- List: `pm2 list`
- View live logs:`pm2 logs vigilance-bridge`
- Check status: `pm2 status`
- Stop: `pm2 stop vigilance-bridge`
- Restart: `pm2 restart vigilance-bridge`
- Delete: `pm2 delete vigilance-bridge` OR `pm2 delete 0 1` to delete based on ID

## How it Works

1. Connection: Connects to the local biometric scanner via TCP using node-zklib.
2. Fetch: Pulls all raw attendance logs currently stored on the device.
3. ETL (Extract, Transform, Load): \* Standardizes timezones to UTC.
   - Cleans hidden characters and symbols from the employee_id.
   - Deduplicates overlapping scanner hits in-memory using a unique compound key..
4. Push: Upserts the clean, unique data to the attendance_logs table in Supabase.
5. Loop: Waits for the defined POLLING_INTERVAL_MS (e.g., 60 seconds) and repeats.

---

## ⚠️ Legacy OS & Node 16 Compatibility Note
Windows 8.1 enforces a maximum capability of **Node.js v16**. Because modern versions of `@supabase/supabase-js` require Node 18+ web standards (like global `fetch` and native `WebSockets`), this codebase explicitly injects `node-fetch` and `ws` directly into the global environment at the top of `bridge.js` to maintain background runtime stability. Do not remove these dependencies.