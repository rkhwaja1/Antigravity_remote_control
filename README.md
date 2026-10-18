# 📱 Antigravity Remote (Mobile Web Dashboard & PWA)

A dedicated, real-time mobile web dashboard and progressive web app (PWA) for pair-programming with Google Antigravity from your iPhone or Android device.

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

## 🚀 Quick Start (Local Run)

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

## ☁️ Deployment (Cloud Run / Cap Cloud)

```bash
docker build -t antigravity-remote .
docker run -p 3847:3847 antigravity-remote
```

## 🐙 Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit of Antigravity Remote Mobile PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/antigravity-remote.git
git push -u origin main
```
