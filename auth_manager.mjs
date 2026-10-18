import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_STORE_FILE = process.env.AUTH_STORE_FILE || path.resolve(__dirname, "auth_store.json");

// Check if auth is explicitly disabled (e.g. For isolated test environments)
export function isAuthDisabled() {
  return process.env.AUTH_DISABLED === "true";
}

// Load auth store from disk
export function loadAuthStore() {
  let store = { pendingPairings: [], activeSessions: [] };
  if (fs.existsSync(AUTH_STORE_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(AUTH_STORE_FILE, "utf8"));
    } catch (_) {}
  }
  if (!Array.isArray(store.pendingPairings)) store.pendingPairings = [];
  if (!Array.isArray(store.activeSessions)) store.activeSessions = [];

  // Automatically purge expired pairings (> 2 minutes old)
  const now = Date.now();
  store.pendingPairings = store.pendingPairings.filter(p => p.expiresAt > now);
  return store;
}

// Save auth store to disk
export function saveAuthStore(store) {
  try {
    fs.writeFileSync(AUTH_STORE_FILE, JSON.stringify(store, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[AuthManager] Failed to save auth store:", err);
    return false;
  }
}

// Helper to hash token with SHA-256
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Generate a pairing request with a 6-digit PIN
export function generatePairingRequest(clientName = "Mobile Device", ip = "127.0.0.1") {
  const store = loadAuthStore();
  const pin = crypto.randomInt(100000, 999999).toString();
  const pairId = "pair_" + crypto.randomBytes(6).toString("hex");
  const expiresAt = Date.now() + 120000; // 2 minutes

  const pairing = {
    pairId,
    pin,
    clientName,
    ip: ip.replace(/^::ffff:/, ""),
    createdAt: Date.now(),
    expiresAt,
    approved: false
  };

  store.pendingPairings.push(pairing);
  saveAuthStore(store);

  // Trigger non-blocking native host prompt on macOS
  promptHostApproval(pairId, pin, clientName, pairing.ip);

  return { pairId, pin, expiresAt };
}

// Native macOS Dialog prompt & Console logging
function promptHostApproval(pairId, pin, clientName, ip) {
  const formattedPin = `${pin.slice(0, 3)}-${pin.slice(3)}`;
  console.log(`\n==================================================`);
  console.log(`🔒 [SECURITY] Mobile Pairing Request Received:`);
  console.log(`   • Device: ${clientName} (${ip})`);
  console.log(`   • PIN:    ${formattedPin}`);
  console.log(`   • PairID: ${pairId}`);
  console.log(`==================================================\n`);

  if (process.platform === "darwin" && !process.env.CI) {
    const safeName = clientName.replace(/["\\]/g, "");
    const script = `
tell application "System Events"
    activate
    set res to display dialog "📱 Antigravity Remote Pairing Request\\n\\nDevice: ${safeName} (${ip})\\nPIN: ${formattedPin}\\n\\nAuthorize this device to control your Mac workstation?" buttons {"Deny", "Approve"} default button "Approve" with title "Antigravity Security" with icon caution giving up after 90
    if button returned of res is "Approve" then
        return "APPROVED"
    else
        return "DENIED"
    end if
end tell`;

    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.on("close", code => {
      if (code === 0 && stdout.includes("APPROVED")) {
        console.log(`✅ [SECURITY] User approved pairing for ${clientName} (${pairId})`);
        approvePairing(pairId);
      } else {
        console.log(`🛑 [SECURITY] Pairing denied or timed out for ${clientName} (${pairId})`);
      }
    });
  }
}

// Approve pending pairing (invoked by Mac dialog or CLI command)
export function approvePairing(target = null) {
  const store = loadAuthStore();
  let pairing = null;

  if (target) {
    const clean = String(target).trim().replace(/-/g, "");
    pairing = store.pendingPairings.find(p => (p.pairId === target || p.pin === clean) && p.expiresAt > Date.now());
  } else {
    // If no argument, pick the newest active pending pairing
    pairing = store.pendingPairings.filter(p => p.expiresAt > Date.now()).pop();
  }

  if (!pairing) return null;

  pairing.approved = true;
  saveAuthStore(store);
  return pairing;
}

// Finalize session once approved, issuing a cryptographically secure token
export function finalizeSession(pairId) {
  const store = loadAuthStore();
  const idx = store.pendingPairings.findIndex(p => p.pairId === pairId && p.approved);
  if (idx === -1) return null;

  const pairing = store.pendingPairings[idx];
  store.pendingPairings.splice(idx, 1);

  const rawToken = "ag_sec_" + crypto.randomBytes(24).toString("hex");
  const tokenHash = hashToken(rawToken);

  const session = {
    id: "sess_" + crypto.randomBytes(6).toString("hex"),
    tokenHash,
    clientName: pairing.clientName,
    ip: pairing.ip,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString()
  };

  store.activeSessions.push(session);
  saveAuthStore(store);

  return { token: rawToken, session };
}

// Authenticate an incoming HTTP request
export function authenticateRequest(req) {
  if (isAuthDisabled()) return { authenticated: true, session: { id: "dev_bypass" } };

  const authHeader = req.headers["authorization"] || "";
  let token = null;

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    // Check query parameter (required for SSE EventSource)
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      token = url.searchParams.get("token");
    } catch (_) {}
  }

  if (!token) return { authenticated: false };

  const tokenHash = hashToken(token);
  const store = loadAuthStore();
  const session = store.activeSessions.find(s => s.tokenHash === tokenHash);

  if (session) {
    session.lastUsedAt = new Date().toISOString();
    saveAuthStore(store);
    return { authenticated: true, session };
  }

  return { authenticated: false };
}

// Revoke a specific session
export function revokeSession(token) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  const store = loadAuthStore();
  const initialLen = store.activeSessions.length;
  store.activeSessions = store.activeSessions.filter(s => s.tokenHash !== tokenHash);
  saveAuthStore(store);
  return store.activeSessions.length < initialLen;
}

// Revoke all active sessions (nuclear reset)
export function revokeAllSessions() {
  const store = loadAuthStore();
  store.activeSessions = [];
  store.pendingPairings = [];
  saveAuthStore(store);
  return true;
}

// Get list of active sessions for display (safe: excludes hashes)
export function getActiveSessions() {
  const store = loadAuthStore();
  return store.activeSessions.map(s => ({
    id: s.id,
    clientName: s.clientName,
    ip: s.ip,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt
  }));
}
