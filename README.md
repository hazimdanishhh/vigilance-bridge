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

```bash
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

**Option B: Production (Always-On Background Process)**
To run this continuously on a dedicated PC, we use PM2, a production process manager for Node.js. It runs the script invisibly in the background and automatically restarts it if it crashes.

1. Install PM2 globally:

   ```bash
   npm install -g pm2
   ```

2. Start the bridge process in terminal:

   ```bash
   pm2 start bridge.js --name "vigilance-bridge"
   ```

3. Save PM2 processes (Optional but recommended):
   To ensure PM2 automatically starts the script if the Windows PC restarts, install the PM2 Windows startup package:

   ```bash
   npm install -g pm2-windows-startup
   pm2-startup install
   pm2 save
   ```

## Useful PM2 Commands

Once the script is running via PM2, you can manage it using the following terminal commands:

- View live logs:`pm2 logs vigilance-bridge`
- Check status: `pm2 status`
- Stop the script: `pm2 stop vigilance-bridge`
- Restart the script: `pm2 restart vigilance-bridge`

## How it Works

1. Connection: Connects to the local biometric scanner via TCP using node-zklib.
2. Fetch: Pulls all raw attendance logs currently stored on the device.
3. ETL (Extract, Transform, Load): \* Standardizes timezones to UTC.
   - Cleans hidden characters and symbols from the employee_id.
   - Deduplicates overlapping scanner hits in-memory using a unique compound key..
4. Push: Upserts the clean, unique data to the attendance_logs table in Supabase.
5. Loop: Waits for the defined POLLING_INTERVAL_MS (e.g., 60 seconds) and repeats.
