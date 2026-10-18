# 📱 Antigravity Remote (Mobile Web Dashboard & PWA)

A dedicated, real-time mobile web dashboard and progressive web app (PWA) for pair-programming with Google Antigravity from your iPhone or Android device.

## 🌐 Live Cloud Run Deployment

- **Public URL**: https://antigravity-remote-356302263933.europe-west2.run.app
- **Cost Profile**: Ultra-low cost / Free-tier optimized:
  - **Scale to Zero**: `--min-instances 0` (zero charges when idle)
  - **Memory Allocation**: `--memory 128Mi` (smallest tier)
  - **CPU Allocation**: `--cpu 1 --cpu-throttling` (CPU billed strictly during active request handling)
  - **Concurrency**: `--concurrency 80` with `--max-instances 1`

## ✨ Features

- **Sub-50ms Real-Time Streaming**: Bi-directional Server-Sent Events (SSE) stream agent responses and live execution logs to your phone without polling or browser scraping.
- **Interactive Plan Management**: Review implementation plans phase-by-phase with checkable task items.
- **1-Tap Actions**:
  - `[ 🚀 Proceed & Implement ]`: Triggers autonomous execution on your Mac workstation.
  - `[ ✏️ Add Revision ]`: Submit clinical feedback or comments that append directly to the `.md` plan on disk.
  - `[ 🛑 Cancel ]`: Cancel or hold an active plan.
- **1-Tap Approvals & Decisions**: Pop-up banners for `[ YES ]` / `[ NO ]` permission requests and multiple-choice options (`[ 1 ]`, `[ 2 ]`, `[ 3 ]`).
- **Remote Directive Console**: Run any prompt from your phone with quick chips for `Git Status`, `Vitest`, etc.
- **Workstation Monitor**: View Mac caffeinate sleep prevention status, active git branch, and memory.

## 🚀 Local Run (On your Mac)

```bash
# Start with background supervisor & caffeinate sleep inhibitor
./run.sh start

# Check status and view local IP
./run.sh status

# Stop service
./run.sh stop
```

Open `http://<your-mac-ip>:3847` on your phone's browser (Safari / Chrome).
Tap **"Share" -> "Add to Home Screen"** on iOS to run as a full-screen, standalone PWA.

## ☁️ Cloud Run Deployment Command

```bash
gcloud run deploy antigravity-remote \
  --source . \
  --project gen-lang-client-0832343565 \
  --region europe-west2 \
  --allow-unauthenticated \
  --memory 128Mi \
  --cpu 1 \
  --cpu-throttling \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 80
```