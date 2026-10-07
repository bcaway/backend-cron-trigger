# backend-cron-trigger

> **BCAway External Cron Dispatcher — Cloudflare Worker**  
> Provides precision scheduled execution for the BCAway Teacher Absence synchronization pipeline by triggering GitHub Actions workflows via the GitHub REST API.

---

## 🧭 Why This Exists

GitHub Actions native cron schedules (`schedule: [cron: ...]`) are shared across all of GitHub and often suffer from severe delays (sometimes 15 to 90+ minutes) or get dropped entirely during peak traffic.

By running this lightweight Cloudflare Worker on Cloudflare's global edge network:
1. **Sub-second Cron Trigger Precision:** Triggers fire at the exact minute required.
2. **Minimal Cloudflare Overhead:** The worker merely makes a $\sim 200\text{ ms}$ outbound `POST` request to GitHub's workflow dispatch API, using virtually zero CPU time ($\le 0.5\text{ ms}$) and remaining well within the Cloudflare Workers Free Tier ($< 0.05\%$ of daily quota).
3. **Optimized Runner Usage:** At **11:00 AM UTC (7:00 AM EDT)** on weekdays, Cloudflare triggers the **Peak Continuous Workflow**, which launches a single 150-minute GitHub Actions runner that loops every 60 seconds internally. During this window, subsequent off-peak triggers are automatically skipped. Outside the peak window, Cloudflare triggers periodic single-shot off-peak syncs.

---

## ⏰ Schedule Architecture

| Time (UTC) | Time (EDT) | Days | Action Taken | Target GitHub Workflow |
| :--- | :--- | :--- | :--- | :--- |
| **11:00 AM** | 7:00 AM | Mon – Fri | **Dispatches Peak Continuous Loop** (150 min runtime) | `teacher_sync_peak.yml` |
| **11:10 AM – 1:20 PM** | 7:10 AM – 9:20 AM | Mon – Fri | **Skipped (No-Op)** — Peak runner is already actively polling every 60s | *None* |
| **1:30 PM – 10:50 AM** | 9:30 AM – 6:50 AM | Mon – Fri | **Dispatches Off-Peak Single-Shot Sync** (every 10 mins) | `teacher_sync_offpeak.yml` |
| **All Day** | All Day | Sat – Sun | **Dispatches Off-Peak Single-Shot Sync** (every 10 mins) | `teacher_sync_offpeak.yml` |

---

## 🚀 Setup & Deployment Guide

### Prerequisites
1. **Node.js 18+** & **npm** installed.
2. **Cloudflare Account** with Wrangler logged in:
   ```bash
   npx wrangler login
   ```
3. **GitHub Personal Access Token (PAT)**:
   * Go to **GitHub Settings** $\rightarrow$ **Developer settings** $\rightarrow$ **Personal access tokens**.
   * You can use either:
     * **Fine-grained Personal Access Token**:
       * Repository access: Only `bcaway/backend-sync`
       * Permissions: **Actions** $\rightarrow$ **Read and write**
     * **Classic Personal Access Token**:
       * Scopes: Select `repo` (Full control of private repositories) or `workflow`.
   * Copy the generated token (`ghp_...` or `github_pat_...`).

---

### Step 1: Install Dependencies
```bash
cd backend-cron-trigger
npm install
```

---

### Step 2: Configure Worker Secrets on Cloudflare

Set the GitHub token as an encrypted Cloudflare secret:
```bash
npx wrangler secret put GH_DISPATCH_TOKEN
```
*(When prompted, paste your GitHub PAT)*.

*(Optional)* If you want to protect the manual HTTP `/trigger` test endpoint:
```bash
npx wrangler secret put TRIGGER_AUTH_SECRET
```

---

### Step 3: Local Testing

Run the worker locally using Wrangler:
```bash
npm run dev
```

In another terminal, test the endpoints:

#### 1. Check Service Health & Current Schedule Context
```bash
curl http://localhost:8787/
```
Expected response:
```json
{
  "service": "BCAway Backend Cron Trigger",
  "status": "operational",
  "version": "1.0.0",
  "time": {
    "utc": "2026-10-07T10:00:00.000Z",
    "eastern": "Oct 7, 2026, 6:00:00 AM",
    "weekday": true,
    "peakActiveNow": false
  },
  "nextCronAction": {
    "type": "dispatch_offpeak",
    "workflow": "teacher_sync_offpeak.yml",
    "explanation": "Off-peak schedule tick (...). Running periodic single-shot sync."
  }
}
```

#### 2. Test Manual Workflow Dispatch
```bash
# Test off-peak single-shot trigger on GitHub Actions
curl -X POST "http://localhost:8787/trigger?workflow=offpeak"

# Test peak continuous trigger
curl -X POST "http://localhost:8787/trigger?workflow=peak"
```

If successful, you will receive `200 OK` and a response indicating GitHub accepted the dispatch (`HTTP 204`). You can immediately verify a new workflow run appearing under the **Actions** tab of `bcaway/backend-sync`.

---

### Step 4: Deploy to Cloudflare

Deploy the worker to Cloudflare's global edge:
```bash
npm run deploy
```

Once deployed, Cloudflare will automatically register the cron trigger:
```text
Cron Triggers:
  - */10 * * * *
```

---

## 📡 HTTP Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` or `/status` | Returns live system status, current timezones, evaluated schedule action, and configuration. |
| `GET` | `/health` | Lightweight `200 OK` liveness health probe. |
| `POST` / `GET` | `/trigger` | Manually dispatches a workflow to GitHub. Query params: `workflow=peak\|offpeak\|auto`, `force=true`. |
| `POST` | `/cron` | Simulates a scheduled cron event immediately and executes the planned action. |

---

## 🛠 Project Structure

```text
backend-cron-trigger/
├── src/
│   └── index.ts          # Cron and HTTP request handlers
├── .gitignore
├── package.json
├── tsconfig.json
├── wrangler.jsonc        # Cloudflare Worker & Cron Trigger configuration
└── README.md
```
