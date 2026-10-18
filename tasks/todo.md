# Antigravity Remote: Cloud Run Reverse Tunnel & Remote Device Pairing Plan

## Current Status: Planning & Co-Designed with Gemini Argon

### Context & Goal
Enable users to securely control their Mac workstation's Antigravity IDE and local codebases from any mobile phone or tablet accessing the public Google Cloud Run deployment (`https://antigravity-remote-...run.app`) across the internet, protected by cryptographic device pairing and host approval.

---

### Implementation Phases

- [x] Phase 1: Dual-Layer Cryptographic Engine (`auth_manager.mjs`)
  - [x] Layer 1 (Host-to-Cloud Auth): `verifyHostSecret(req)` with timing-safe comparison (`crypto.timingSafeEqual`) using shared `HOST_SECRET`
  - [x] Layer 2 (Mobile-to-Cloud Auth): Stateless HMAC-SHA256 signed tokens (`ag_<payload>.<sig>`) allowing seamless token validation without shared database dependencies across Cloud Run container restarts
  - [x] Pairing request store with 2-minute expiration and PIN formatting

- [x] Phase 2: Cloud Run Relay Multiplexer (`server.mjs`)
  - [x] Add Mac Tunnel endpoints:
    - [x] `GET /api/tunnel/stream`: Outbound SSE downlink from Cloud Run to Mac host (guarded by `HOST_SECRET`)
    - [x] `POST /api/tunnel/sync`: Mac pushes cached state snapshot (workspaces, activeWorkspace, activePlan, git)
    - [x] `POST /api/tunnel/response`: Mac returns command execution results for pending RPC requests (`pendingRpc.get(reqId)`)
    - [x] `POST /api/tunnel/pair-decision`: Mac approves or denies pending pairing request
  - [x] Cloud Run API relay routing:
    - [x] When mobile issues `POST /api/prompt` or `POST /api/workspaces/select`, relay `{ reqId, action, payload }` down the Mac tunnel stream
    - [x] If Mac tunnel is disconnected, return friendly `503 Host Workstation Offline`
    - [x] Relay SSE events from Mac to connected mobile clients (`broadcast`)

- [x] Phase 3: Mac Workstation Outbound Tunnel Daemon (`mac_tunnel.mjs` & `run.sh`)
  - [x] `mac_tunnel.mjs`:
    - [x] Connects outbound to `CLOUD_RUN_URL/api/tunnel/stream` with `Bearer <HOST_SECRET>`
    - [x] Handles automatic reconnect with backoff when Cloud Run recycles
    - [x] On `pair_request`: pops native macOS approval dialog via `osascript` (`display dialog`) + CLI log
    - [x] On `command`: invokes `task_executor.mjs` (`executeUserDirective`, workspace switching, plan actions) and posts response back to `/api/tunnel/response`
    - [x] On local changes: pushes state sync to Cloud Run (`POST /api/tunnel/sync`)
  - [x] CLI updates in `run.sh`:
    - [x] `./run.sh tunnel`: starts both local server and outbound Cloud Run tunnel daemon
    - [x] `./run.sh pair [pin]`: approves pending pairing locally or via tunnel
    - [x] Generate default `HOST_SECRET` in `.env` if not present

- [x] Phase 4: Mobile Web App Status & Pairing UI (`public/index.html`, `public/app.js`, `public/style.css`)
  - [x] Header status indicator showing both Cloud connection and Mac host status (`☁️ Cloud Live | 🖥️ Mac Online 🟢` vs `🔴 Mac Offline`)
  - [x] Pairing overlay displays PIN and awaits Mac approval
  - [x] Seamlessly attaches Bearer token to all `fetch` and query param to `EventSource`

- [x] Phase 5: Verification & Automated Tests (`test.mjs`)
  - [x] Integration test for Cloud Run relay mode with simulated Mac tunnel
  - [x] Test pairing request generation, relay to Mac, host approval, token issuance, and authenticated execution
  - [x] Test 503 rejection when Mac tunnel is offline
  - [x] All 17 end-to-end unit and integration tests passing (`npm test`)

- [x] Phase 6: Deployment & Git Push
  - [x] Redeployed Cloud Run (`antigravity-remote-00004-t2s`) with single-instance affinity (`--max-instances 1`), `--timeout 3600`, and `HOST_SECRET`
  - [x] Started `./run.sh tunnel` on Mac workstation
  - [x] End-to-end live testing from Cloud Run across reverse tunnel verified
  - [x] Commit and push to GitHub `main`

---

## Verification & Architecture Review
1. **Live Cloud Run Deployment**: `https://antigravity-remote-356302263933.europe-west2.run.app`
2. **Reverse Tunnel Handshake**: Outbound HTTP SSE stream (`GET /api/tunnel/stream`) opened from residential/NAT Mac to Cloud Run. Status: `macConnected: true`.
3. **Stateless HMAC Authentication**: Tokens (`ag_<payloadB64>.<sig>`) are mathematically signed and verified without requiring a database, persisting across Cloud Run scale-to-zero container recycles.
4. **End-to-End Live Execution Verified**:
   - Pairing generated on Cloud Run (`POST /api/auth/pair`) -> Pushed to Mac tunnel.
   - Approved by host Mac -> Cloud Run verified and issued HMAC Bearer token.
   - Directive sent to Cloud Run (`POST /api/prompt`) -> Relayed to Mac -> Mac executed local git status -> Result returned to mobile caller over HTTPS.
5. **Local Supervisor**: `./run.sh status`, `./run.sh restart`, `./run.sh tunnel`, and `./run.sh pair [pin]` manage both local web dashboard and reverse tunnel daemon.

---

## Architectural Decisions Backed by Gemini Argon
- **Zero New Dependencies**: Uses native Node.js `http`/`fetch` and Server-Sent Events (SSE) for both downlink and uplink. No external WebSocket libraries or third-party relay subscriptions needed.
- **Stateless HMAC Tokens**: Cloud Run restarts never log out mobile users because tokens are verified mathematically with `HOST_SECRET` without hitting a database.
- **Local Mac Protection**: Only devices approved by the host user (via native macOS popup or CLI) receive valid tokens to execute prompts or view code.
