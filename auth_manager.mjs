import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_STORE_FILE = process.env.AUTH_STORE_FILE || path.resolve(__dirname, "auth_store.json");

// Default pre-shared secret for host-to-cloud tunnel (overridden by process.env.HOST_SECRET)
export function getHostSecret() {
  return process.env.HOST_SECRET || "antigravity_host_secret_default_key_2026";
}

// Check if auth is explicitly disabled (e.g. for local isolated unit tests)
export function isAuthDisabled() {
  return process.env.AUTH_DISABLED === "true";
}

// Verify host Mac tunnel requests using timing-safe comparison
export function verifyHostSecret(req) {
  const secret = getHostSecret();
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") 
    ? authHeader.slice(7).trim() 
    : (req.headers["x-host-secret"] || "").trim();

  if (!token) return false;

  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret);
  if (tokenBuf.length !== secretBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, secretBuf);
}

// Issue a stateless, HMAC-SHA256 signed mobile token (valid across Cloud Run restarts)
export function issueMobileToken(clientName = "Mobile Device", sessionId = null) {
  const secret = getHostSecret();
  const payloadObj = {
    sub: clientName,
    sid: sessionId || "sess_" + crypto.randomBytes(6).toString("hex"),
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30 // 30 days
  };

  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `ag_${payloadB64}.${sig}`;
}

// Verify a stateless HMAC-SHA256 signed mobile token
export function verifyMobileToken(token) {
  if (!token || !token.startsWith("ag_")) return null;
  const parts = token.slice(3).split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const secret = getHostSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
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

  // Trigger non-blocking native host prompt on macOS if on host Mac
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

// Approve pending pairing (invoked by Mac dialog or CLI command or tunnel)
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

// Finalize session once approved, issuing an HMAC-signed Bearer token
export function finalizeSession(pairId) {
  const store = loadAuthStore();
  const idx = store.pendingPairings.findIndex(p => p.pairId === pairId && p.approved);
  if (idx === -1) return null;

  const pairing = store.pendingPairings[idx];
  store.pendingPairings.splice(idx, 1);

  const sessionId = "sess_" + crypto.randomBytes(6).toString("hex");
  const token = issueMobileToken(pairing.clientName, sessionId);
  const tokenHash = hashToken(token);

  const session = {
    id: sessionId,
    tokenHash,
    clientName: pairing.clientName,
    ip: pairing.ip,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString()
  };

  store.activeSessions.push(session);
  saveAuthStore(store);

  return { token, session };
}

// Authenticate an incoming HTTP request (supports HMAC tokens, hashed tokens, and dev bypass)
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

  if (store.revokedTokens && store.revokedTokens.includes(tokenHash)) {
    return { authenticated: false };
  }

  // 1. Verify stateless HMAC-signed token
  const verifiedPayload = verifyMobileToken(token);
  if (verifiedPayload) {
    if (store.revokedSids && store.revokedSids.includes(verifiedPayload.sid)) {
      return { authenticated: false };
    }
    if (store.revokedBefore && verifiedPayload.iat < store.revokedBefore) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      session: {
        id: verifiedPayload.sid,
        clientName: verifiedPayload.sub,
        exp: verifiedPayload.exp
      }
    };
  }

  // 2. Fallback: verify against auth_store.json active sessions
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
  store.revokedTokens = store.revokedTokens || [];
  store.revokedTokens.push(tokenHash);

  const verifiedPayload = verifyMobileToken(token);
  if (verifiedPayload && verifiedPayload.sid) {
    store.revokedSids = store.revokedSids || [];
    store.revokedSids.push(verifiedPayload.sid);
  }

  store.activeSessions = store.activeSessions.filter(s => s.tokenHash !== tokenHash);
  saveAuthStore(store);
  return true;
}

// Revoke all active sessions (nuclear reset)
export function revokeAllSessions() {
  const store = loadAuthStore();
  store.activeSessions = [];
  store.pendingPairings = [];
  store.revokedBefore = Date.now();
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
