# Antigravity Remote: Authentication & Device Pairing Layer Plan

## Current Status: Completed (Phase 1 - Phase 6)

- [x] Phase 1: Core Authentication Engine (`auth_manager.mjs`)
  - [x] Implement `auth_store.json` schema (active sessions with SHA-256 token hashes, pending pairings with 6-digit PIN and expiry)
  - [x] Pairing handshake functions: `generatePairingRequest()`, `approvePairing()`, `finalizeSession()`, `revokeSession()`, `revokeAllSessions()`
  - [x] Host approval mechanisms: macOS non-blocking native dialog (`display dialog`) & terminal fallback
  - [x] Request authenticator middleware: `authenticateRequest(req)` supporting `Authorization: Bearer <token>` and `?token=` query param for SSE
- [x] Phase 2: Server Protection & Routing Integration (`server.mjs`)
  - [x] Add endpoints: `POST /api/auth/pair`, `POST /api/auth/verify`, `POST /api/auth/status`, `POST /api/auth/revoke`
  - [x] Guard all protected routes (`/api/prompt`, `/api/workspaces`, `/api/plan`, `/api/decision`, `/events`) with 401 Unauthorized rejection
  - [x] Keep static files and pairing endpoints public
  - [x] Add `AUTH_DISABLED` environment flag for optional local sandbox bypass
- [x] Phase 3: Mobile PWA Pairing UI & Client Flow (`public/index.html`, `public/style.css`, `public/app.js`)
  - [x] Glassmorphic Pairing Overlay (`#pairing-overlay`) with 6-digit PIN display and live approval pulse
  - [x] Client handshake flow: auto-initiate pairing, poll `/api/auth/verify`, store token in `localStorage`
  - [x] Attach `Authorization: Bearer <token>` to all `fetch()` calls and `?token=<token>` to `EventSource("/events")`
  - [x] Add "Disconnect / Unpair Device" action in System tab with confirmation
  - [x] Handle 401 Unauthorized by clearing token and re-showing pairing overlay
- [x] Phase 4: CLI Ergonomics (`run.sh`)
  - [x] Add `./run.sh pair [pin]` to approve pending pairing or display status
  - [x] Add `./run.sh unpair-all` to clear all active sessions
  - [x] Add `./run.sh sessions` to view connected paired devices
- [x] Phase 5: Verification & Testing
  - [x] Unit & integration tests in `test.mjs` verifying 401 on unauthenticated access, pairing handshake, token issuance, and protected endpoint access (12/12 passing)
  - [x] Verify both mobile client and SSE stream connect with token
  - [x] Restart daemon service (`./run.sh restart`)
- [x] Phase 6: Push to GitHub & Deployment
  - [x] Commit all changes with clear descriptive message
  - [x] Push to `origin/main` on GitHub

---

## Review & Verification

### Test Results
- **Full Test Suite (`npm test`)**: 12/12 automated integration tests passed:
  1. Static file serving (index.html, style.css, manifest.json, icon.svg).
  2. Unauthenticated requests to protected endpoints return 401 Unauthorized (`authRequired: true`).
  3. Public GET `/api/auth/status` reports unauthenticated status.
  4. POST `/api/auth/pair` generates 6-digit PIN and unique pair ID.
  5. Pre-approval verification returns 202 Pending.
  6. Host approval via PIN / pair ID succeeds.
  7. Post-approval verification returns 200 with cryptographically secure Bearer token (`ag_sec_...`).
  8. Authenticated GET `/api/state` with Authorization header returns full workspace & system state.
  9. Authenticated SSE `/events?token=...` stream handshake connects with live event stream.
  10. Authenticated prompt execution and workspace switching succeed.
  11. Authenticated plan revision actions succeed.
  12. POST `/api/auth/revoke` invalidates token and rejects subsequent requests with 401.

### Security Highlights
- **RFC 8628 Device Authorization Flow**: Eliminates password entry on mobile while ensuring unauthorized actors on the local LAN cannot execute directives or browse files on the host Mac.
- **SHA-256 Hash at Rest**: Token secrets are never stored in plaintext on disk (`auth_store.json`), preventing credential leakage.
- **Native Host Confirmation**: Automatically triggers a native macOS approval dialog (`display dialog`) with auto-timeout.
- **Convenient CLI Management**: `./run.sh pair`, `./run.sh sessions`, and `./run.sh unpair-all` allow effortless command-line oversight.
