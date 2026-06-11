# Hyrax Oil — Vigilance Scanner Bridge

A production Node.js service that bridges local Vigilance biometric attendance scanners to a cloud Supabase database. It polls each scanner on a cron schedule, deduplicates and transforms the raw logs, upserts them to Supabase, and fires Discord alerts on errors or new records.

---

## Table of Contents

- [Hyrax Oil — Vigilance Scanner Bridge](#hyrax-oil--vigilance-scanner-bridge)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Service](#running-the-service)
    - [Option A — Testing \& Development](#option-a--testing--development)
    - [Option B — Production (PM2)](#option-b--production-pm2)
  - [PM2 Reference](#pm2-reference)
  - [How It Works](#how-it-works)
  - [Discord Notifications](#discord-notifications)
  - [Logs](#logs)
  - [Legacy OS Notice (Windows 8.1 / Node 16)](#legacy-os-notice-windows-81--node-16)
  - [Roadmap — Docker on Raspberry Pi or Mini PC](#roadmap--docker-on-raspberry-pi-or-mini-pc)
    - [Recommended Hardware](#recommended-hardware)
    - [Target Architecture (Docker + Linux)](#target-architecture-docker--linux)

---

## Architecture Overview

```
┌─────────────────────┐     TCP      ┌──────────────────────┐
│  Vigilance Scanner  │ ◄──────────► │   sync.mjs (Node)    │
│  (Biometric Device) │              │   Cron: */1 * * * *  │
└─────────────────────┘              └──────────┬───────────┘
                                                │  HTTPS upsert
                                     ┌──────────▼───────────┐
                                     │   Supabase (Cloud)   │
                                     │   attendance_logs    │
                                     └──────────────────────┘
                                                │
                                     ┌──────────▼───────────┐
                                     │   Discord Webhook    │
                                     │   (Alerts & Errors)  │
                                     └──────────────────────┘
```

One instance of this service = one scanner. For multiple scanners (e.g. main entrance + blending plant), run multiple PM2 processes, each with its own `.env` file pointing to a different scanner IP and location name.

---

## Prerequisites

- **Node.js v16** (required for Windows 8.1; see [Legacy OS Notice](#legacy-os-notice-windows-81--node-16))
- The host PC must be on the **same LAN** as the scanner
- The scanner must have a **static IP** assigned on your router — if the IP changes on reboot, the service will fail silently
- A [Supabase](https://supabase.com) project with the `attendance_logs` table and a unique constraint on `(employee_id, scanned_at)`
- _(Optional)_ A Discord server with a webhook URL for alerts

---

## Installation

**1. Place the project on the PC**

Copy the project folder to a stable path, e.g.:

```
C:\Users\IT Admin\Documents\vigilance-bridge
```

Avoid `Desktop` or `Downloads` — these get cleaned up.

**2. Install dependencies**

```bash
npm install
```

**3. Create your `.env` file**

Copy the example and fill in your values:

```bash
copy .env.example .env
```

Then edit `.env` — see [Configuration](#configuration) below.

---

## Configuration

All configuration lives in `.env`. Never commit this file to version control.

```env
# ── Scanner ──────────────────────────────────────────
SCANNER_IP=192.168.0.111
SCANNER_PORT=4371
LOCATION_NAME=Main Entrance       # Human-readable label, stored in every log row

# ── Supabase ─────────────────────────────────────────
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=your-service-role-key

# ── Schedule ─────────────────────────────────────────
# Standard cron syntax. Default: every 1 minute.
# Use https://crontab.guru to build a schedule.
CRON_SCHEDULE=*/1 * * * *

# ── Discord Alerts (optional but recommended) ─────────
# See: Discord Notifications section below for setup steps.
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

**For a second scanner**, duplicate the entire project folder with a separate `.env`:

```
vigilance-bridge-entrance/   → LOCATION_NAME=Main Entrance,  SCANNER_IP=192.168.0.111
vigilance-bridge-plant/      → LOCATION_NAME=Blending Plant, SCANNER_IP=192.168.0.112
```

---

## Running the Service

### Option A — Testing & Development

Run once, output to terminal, stop with `Ctrl+C`:

```bash
node sync.mjs
```

### Option B — Production (PM2)

PM2 is the recommended way to run this in production on Windows. It manages the process invisibly in the background, restarts on crash, rotates logs, and survives reboots.

**First-time setup:**

```bash
# Install PM2 globally (only needed once per machine)
npm install -g pm2
npm install -g pm2-windows-startup

# Start the service using the ecosystem config
pm2 start ecosystem.config.cjs

# Register PM2 as a Windows startup service
pm2-startup install
pm2 save
```

From this point on, the service will start automatically whenever Windows boots, even without anyone logging in.

**Starting a second scanner instance:**

```bash
# From inside the second scanner's project folder
pm2 start ecosystem.config.cjs
pm2 save
```

PM2 tracks all instances by name (`attendance-sync`) — rename the `name` field in each folder's `ecosystem.config.cjs` to keep them distinct (e.g. `attendance-sync-entrance`, `attendance-sync-plant`).

---

## PM2 Reference

| Command                                | Description                                           |
| -------------------------------------- | ----------------------------------------------------- |
| `pm2 list`                             | Show all running processes and their status           |
| `pm2 monit`                            | Live CPU/memory dashboard                             |
| `pm2 logs attendance-sync`             | Stream live logs                                      |
| `pm2 logs attendance-sync --lines 200` | View last 200 log lines                               |
| `pm2 restart attendance-sync`          | Restart the service                                   |
| `pm2 stop attendance-sync`             | Stop without removing from PM2                        |
| `pm2 delete attendance-sync`           | Remove from PM2 entirely                              |
| `pm2 save`                             | Persist current process list for auto-start on reboot |

---

## How It Works

Each cron tick runs the following pipeline:

1. **Connect** — Opens a TCP socket to the scanner via `node-zklib`
2. **Fetch** — Pulls all raw attendance logs currently stored on the device
3. **Transform & Deduplicate**
   - Timestamps are normalised to UTC (scanner output is treated as `+08:00` / Malaysia time)
   - Employee IDs are sanitised (strips leading `@`, null bytes, and whitespace)
   - Duplicate scans are collapsed in-memory using a `employee_id + scanned_at` compound key
4. **Upsert** — Pushes unique records to `attendance_logs` in Supabase using `onConflict` so re-runs are always safe and idempotent
5. **Notify** — Sends a Discord summary if new records were synced, or an error alert if the sync failed
6. **Disconnect** — Closes the scanner TCP connection cleanly in a `finally` block, even on failure

An **overlap guard** prevents a new cron tick from starting if the previous sync is still running (e.g. slow scanner response on a busy morning).

---

## Discord Notifications

Discord webhooks are used for operational alerts — zero infrastructure, free, and delivers instant mobile push notifications.

**Setup:**

1. In your Discord server, go to **Server Settings → Integrations → Webhooks**
2. Click **New Webhook**, give it a name (e.g. `Scanner Alert`), choose a `#scanner-alerts` channel
3. Click **Copy Webhook URL** and paste it into `.env` as `DISCORD_WEBHOOK_URL`

**When you'll get notified:**

- ✅ A sync run that found and pushed new records (includes count, duplicates removed, and duration)
- ❌ Any sync failure — connection refused, Supabase error, etc.
- ⚠️ Service shutdown (graceful stop or restart via PM2)

Healthy runs with zero new records (scanner idle) do **not** send a notification, to avoid alert fatigue.

---

## Logs

Logs are written to `./logs/` in the project folder and auto-rotate to prevent the disk from filling up:

| File                     | Contents                  | Cap             |
| ------------------------ | ------------------------- | --------------- |
| `logs/sync-combined.log` | All info + error messages | 10 MB × 7 files |
| `logs/sync-error.log`    | Errors only               | 5 MB × 5 files  |
| `logs/pm2-out.log`       | PM2 stdout capture        | Managed by PM2  |
| `logs/pm2-error.log`     | PM2 stderr capture        | Managed by PM2  |

To read the most recent errors quickly:

```bash
pm2 logs attendance-sync --err --lines 50
```

---

## Legacy OS Notice (Windows 8.1 / Node 16)

Windows 8.1 supports a maximum of **Node.js v16**. Modern `@supabase/supabase-js` requires Node 18+ web standards (`fetch`, `Headers`, native WebSockets) that are absent in Node 16.

This codebase applies two shims at the very top of `sync.mjs` to compensate:

- **`node-fetch`** — polyfills `globalThis.fetch`, `Headers`, `Request`, and `Response`
- **`ws`** — provides a WebSocket implementation

Do not remove these packages or reorder the imports — they must execute before any Supabase client code runs.

If this service is ever migrated to a machine running Node 18+, both shims and the `realtime: { transport: ws }` option in the Supabase client constructor can be safely removed.

---

## Roadmap — Docker on Raspberry Pi or Mini PC

The current Windows 8.1 setup works but has constraints: no Docker support, Node 16 polyfills required, and manual PM2 management per scanner. When hardware is upgraded, the following architecture is recommended.

### Recommended Hardware

| Option                                              | Verdict                                                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raspberry Pi 4 (2GB+)**                           | Best for low cost and low power draw. Runs Linux natively. Ideal if the scanner room has no existing hardware. ~$55–80.                                                                                              |
| **Mini PC (Intel N100 / N95, Windows 11 or Linux)** | Better if you need Windows compatibility for other tools on the same machine, or if USB scanner access is needed. ~$120–180.                                                                                         |
| **OS choice**                                       | **Linux (Ubuntu Server 24.04 LTS)** is the clear winner for Docker — no licensing cost, better container performance, and no GUI overhead eating RAM. Only choose Windows 11 if there's a hard business requirement. |

### Target Architecture (Docker + Linux)

Each scanner gets its own isolated Docker container. All containers are orchestrated by a single `docker-compose.yml` on the host machine.

```
host machine (Raspberry Pi / Mini PC — Ubuntu Server)
│
├── docker-compose.yml
│
├── scanner-entrance/
│   ├── Dockerfile
│   ├── sync.mjs
│   └── .env                  ← SCANNER_IP, LOCATION_NAME, etc.
│
└── scanner-plant/
    ├── Dockerfile
    ├── sync.mjs
    └── .env
```

**`docker-compose.yml` (future reference):**

```yaml
services:
  scanner-entrance:
    build: ./scanner-entrance
    container_name: scanner-entrance
    restart: unless-stopped
    env_file: ./scanner-entrance/.env
    network_mode: host # Required for LAN access to scanner TCP port

  scanner-plant:
    build: ./scanner-plant
    container_name: scanner-plant
    restart: unless-stopped
    env_file: ./scanner-plant/.env
    network_mode: host
```

**`Dockerfile` (future reference):**

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY sync.mjs .

CMD ["node", "sync.mjs"]
```

On Linux with Node 20, the Windows 8.1 polyfills (`node-fetch`, `ws` shims) are removed entirely. The `Dockerfile` also drops `node-cron` being pulled from a Windows-only build path — it runs cleanly on Alpine Linux.

**Benefits over the current setup:**

- `docker compose up -d` starts all scanners in one command
- `restart: unless-stopped` replaces PM2 — Docker itself handles crash recovery and startup on boot
- Each scanner is fully isolated — a crash or config error in one container never affects another
- Adding a new scanner = copy a folder, update `.env`, run `docker compose up -d`
- No Node version management on the host — the Node version is pinned per container in the `Dockerfile`
