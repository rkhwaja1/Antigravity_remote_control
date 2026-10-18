import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { executeUserDirective, injectPromptIntoIde } from "./task_executor.mjs";
import { 
  loadActivePlanSession, 
  saveActivePlanSession, 
  formatPlanForMobile, 
  executePlanFromMobile, 
  applyCommentToPlan, 
  PLAN_STATES 
} from "./plan_state_machine.mjs";
import { 
  loadWorkspaces, 
  getActiveWorkspace, 
  setActiveWorkspace, 
  addWorkspace, 
  getWorkspaceGitInfo 
} from "./workspace_manager.mjs";
import { 
  generatePairingRequest, 
  approvePairing, 
  finalizeSession, 
  authenticateRequest, 
  revokeSession, 
  getActiveSessions, 
  isAuthDisabled,
  verifyHostSecret 
} from "./auth_manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DECISIONS_FILE = process.env.DECISIONS_FILE || path.resolve(__dirname, "decisions.json");

export function loadDecisions() {
  if (fs.existsSync(DECISIONS_FILE)) {
    try { return JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8")); } catch (_) {}
  }
  return { activeDecision: null, history: [] };
}
export function saveDecisions(data) {
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(data, null, 2), "utf8");
}
const PUBLIC_DIR = path.resolve(__dirname, "public");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3847;

// SSE Client Connections (Mobile Web Browsers)
const sseClients = new Set();

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

// In-Memory Recent Activity Logs
const activityLogs = [];
export function logActivity(type, message, details = null) {
  const entry = {
    id: "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    type, // 'prompt' | 'response' | 'plan' | 'decision' | 'system'
    message,
    details
  };
  activityLogs.push(entry);
  if (activityLogs.length > 200) activityLogs.shift();
  broadcast("log", entry);
  return entry;
}

// ==========================================
// Host Mac Workstation Reverse Tunnel State
// ==========================================
let macTunnelClient = null;
const pendingRpc = new Map();
let cachedMacState = {
  workspaces: [],
  activeWorkspace: null,
  activePlan: null,
  activeDecision: null,
  git: null,
  caffeinate: false,
  recentLogs: []
};

export function isMacConnected() {
  return macTunnelClient !== null && !macTunnelClient.destroyed;
}

export function forwardCommandToMac(action, payload, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!isMacConnected()) {
      return reject(new Error("Host Mac Workstation is offline. Please launch `./run.sh tunnel` on your Mac."));
    }
    const reqId = "rpc_" + crypto.randomBytes(6).toString("hex");
    const timer = setTimeout(() => {
      pendingRpc.delete(reqId);
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s on Mac host.`));
    }, timeoutMs);

    pendingRpc.set(reqId, { resolve, reject, timer });
    try {
      macTunnelClient.write(`event: command\ndata: ${JSON.stringify({ reqId, action, payload })}\n\n`);
    } catch (err) {
      clearTimeout(timer);
      pendingRpc.delete(reqId);
      reject(err);
    }
  });
}

// Get Local LAN IP
export function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

// Get Git Status Summary for a workspace
function getGitInfo(dirPath = null) {
  try {
    const targetDir = dirPath || getActiveWorkspace().path;
    const info = getWorkspaceGitInfo(targetDir);
    return {
      branch: info.branch || "HEAD",
      hasChanges: info.hasChanges,
      modifiedCount: info.modifiedCount
    };
  } catch (_) {
    return { branch: "HEAD", hasChanges: false, modifiedCount: 0 };
  }
}

// MIME Types
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

// Request Handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers for LAN/Mobile access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Host-Secret");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ==========================================
  // Host Mac Tunnel Reverse Proxy Endpoints (Protected by HOST_SECRET)
  // ==========================================

  // 1. Outbound SSE Downlink from Cloud Run to Host Mac
  if (pathname === "/api/tunnel/stream" && req.method === "GET") {
    if (!verifyHostSecret(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid Host Secret" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

    if (macTunnelClient && !macTunnelClient.destroyed) {
      try { macTunnelClient.end(); } catch (_) {}
    }
    macTunnelClient = res;
    logActivity("system", "🖥️ Host Mac Workstation connected to Cloud Relay tunnel.");
    broadcast("state_change", { reason: "mac_tunnel_connected", macConnected: true });

    req.on("close", () => {
      if (macTunnelClient === res) {
        macTunnelClient = null;
        logActivity("system", "⚠️ Host Mac Workstation disconnected from Cloud Relay.");
        broadcast("state_change", { reason: "mac_tunnel_disconnected", macConnected: false });
      }
    });
    return;
  }

  // 2. Mac Pushes Full Cached State Snapshot
  if (pathname === "/api/tunnel/sync" && req.method === "POST") {
    if (!verifyHostSecret(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid Host Secret" }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        cachedMacState = Object.assign(cachedMacState, data);
        broadcast("state_change", { reason: "mac_state_synced", macConnected: true });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 3. Mac Returns Command RPC Result
  if (pathname === "/api/tunnel/response" && req.method === "POST") {
    if (!verifyHostSecret(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid Host Secret" }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { reqId, ok, result, error, state } = JSON.parse(body || "{}");
        if (state) {
          cachedMacState = Object.assign(cachedMacState, state);
          broadcast("state_change", { reason: "mac_state_updated", macConnected: true });
        }
        if (reqId && pendingRpc.has(reqId)) {
          const { resolve, timer } = pendingRpc.get(reqId);
          clearTimeout(timer);
          pendingRpc.delete(reqId);
          resolve({ ok: ok !== false, result, error });
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. Mac Resolves Pairing Request (Approved or Denied)
  if (pathname === "/api/tunnel/pair-decision" && req.method === "POST") {
    if (!verifyHostSecret(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid Host Secret" }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { pairId, approved } = JSON.parse(body || "{}");
        if (approved) {
          approvePairing(pairId);
          logActivity("system", `✅ Device pairing approved by host Mac (${pairId})`);
          broadcast("state_change", { reason: "pairing_approved", pairId });
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. Mac Dispatches Live Event/Log to Mobile
  if (pathname === "/api/tunnel/event" && req.method === "POST") {
    if (!verifyHostSecret(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid Host Secret" }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { event, data } = JSON.parse(body || "{}");
        if (event === "log" && data) {
          logActivity(data.type || "system", data.message, data.details);
        } else if (event && data) {
          broadcast(event, data);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ==========================================
  // Authentication & Pairing Endpoints (Public)
  // ==========================================
  if (pathname === "/api/auth/pair" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { clientName } = JSON.parse(body || "{}");
        const ip = req.socket.remoteAddress || "127.0.0.1";
        const pairing = generatePairingRequest(clientName || "Mobile Device", ip);

        // Push pairing request down active Mac tunnel
        if (isMacConnected()) {
          try {
            macTunnelClient.write(`event: pair_request\ndata: ${JSON.stringify({
              pairId: pairing.pairId,
              pin: pairing.pin,
              clientName: clientName || "Mobile Device",
              ip: ip.replace(/^::ffff:/, "")
            })}\n\n`);
          } catch (_) {}
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          pairId: pairing.pairId,
          pin: `${pairing.pin.slice(0, 3)}-${pairing.pin.slice(3)}`,
          rawPin: pairing.pin,
          expiresAt: pairing.expiresAt,
          macConnected: isMacConnected() || process.platform === "darwin"
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/auth/verify" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { pairId } = JSON.parse(body || "{}");
        if (!pairId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "pairId is required" }));
          return;
        }
        const result = finalizeSession(pairId);
        if (result && result.token) {
          logActivity("system", `📱 Paired device authenticated: ${result.session.clientName}`);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, token: result.token, session: result.session }));
        } else {
          res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, pending: true, message: "Awaiting approval on your Mac workstation." }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/auth/status" && req.method === "GET") {
    const auth = authenticateRequest(req);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      authenticated: auth.authenticated,
      authDisabled: isAuthDisabled(),
      session: auth.session || null,
      activeSessions: auth.authenticated ? getActiveSessions() : [],
      macConnected: isMacConnected() || process.platform === "darwin"
    }));
    return;
  }

  if (pathname === "/api/auth/revoke" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { token } = JSON.parse(body || "{}");
        const authHeader = req.headers["authorization"] || "";
        const targetToken = token || (authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null);
        const revoked = revokeSession(targetToken);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, revoked }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ==========================================
  // Authentication Guard for Protected Routes
  // ==========================================
  const isProtectedApiOrEvents = pathname.startsWith("/api/") || pathname === "/events";
  if (isProtectedApiOrEvents) {
    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: false,
        authRequired: true,
        error: "Unauthorized. Please pair this device with your Mac workstation."
      }));
      return;
    }
  }

  // SSE Channel (Protected: requires valid token)
  if (pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // Protected API Endpoints
  if (pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // GET /api/state: Comprehensive system, workspace and bridge state
    if (pathname === "/api/state" && req.method === "GET") {
      const macConnected = isMacConnected() || process.platform === "darwin";

      // If Mac tunnel is active, serve cached state pushed from Mac
      if (isMacConnected()) {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          localIp: getLocalIp(),
          port: PORT,
          macConnected: true,
          activeWorkspace: cachedMacState.activeWorkspace,
          workspaces: cachedMacState.workspaces,
          activePlan: cachedMacState.activePlan,
          activeDecision: cachedMacState.activeDecision,
          git: cachedMacState.git,
          caffeinate: cachedMacState.caffeinate,
          recentLogs: activityLogs.slice(-30)
        }));
        return;
      }

      // If running locally on Mac, collect local state directly
      if (process.platform === "darwin") {
        const activeWs = getActiveWorkspace();
        const workspacesData = loadWorkspaces();
        const planSession = loadActivePlanSession();
        let formattedPlan = null;
        if (planSession && planSession.planPath && fs.existsSync(planSession.planPath)) {
          try {
            formattedPlan = formatPlanForMobile(planSession.planPath);
          } catch (_) {}
        }
        const decData = loadDecisions();
        const git = getGitInfo(activeWs.path);

        const caffeinateRes = spawnSync("pgrep", ["caffeinate"], { encoding: "utf8" });
        const isCaffeinateActive = (caffeinateRes.stdout || "").trim().length > 0;

        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          localIp: getLocalIp(),
          port: PORT,
          macConnected: true,
          activeWorkspace: activeWs,
          workspaces: workspacesData.workspaces,
          activePlan: planSession ? {
            ...planSession,
            formatted: formattedPlan
          } : null,
          activeDecision: decData.activeDecision,
          git,
          caffeinate: isCaffeinateActive,
          recentLogs: activityLogs.slice(-30)
        }));
        return;
      }

      // Relay mode without connected Mac
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        localIp: getLocalIp(),
        port: PORT,
        macConnected: false,
        activeWorkspace: cachedMacState.activeWorkspace,
        workspaces: cachedMacState.workspaces,
        activePlan: cachedMacState.activePlan,
        activeDecision: null,
        git: cachedMacState.git,
        caffeinate: false,
        recentLogs: activityLogs.slice(-30)
      }));
      return;
    }

    // GET /api/workspaces: List all workspaces
    if (pathname === "/api/workspaces" && req.method === "GET") {
      if (isMacConnected()) {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          activeWorkspace: cachedMacState.activeWorkspace,
          workspaces: cachedMacState.workspaces,
          macConnected: true
        }));
        return;
      }

      if (process.platform === "darwin") {
        const data = loadWorkspaces();
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          activeWorkspace: getActiveWorkspace(),
          workspaces: data.workspaces,
          macConnected: true
        }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        activeWorkspace: cachedMacState.activeWorkspace,
        workspaces: cachedMacState.workspaces,
        macConnected: false
      }));
      return;
    }

    // POST /api/workspaces/select: Select active workspace
    if (pathname === "/api/workspaces/select" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { id, path: wsPath } = JSON.parse(body || "{}");

          if (isMacConnected()) {
            const rpc = await forwardCommandToMac("select_workspace", { id, path: wsPath });
            if (rpc.ok) {
              cachedMacState.activeWorkspace = rpc.result;
              broadcast("workspace_changed", { activeWorkspace: rpc.result, reason: "user_selected" });
              broadcast("state_change", { reason: "workspace_swapped" });
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, activeWorkspace: rpc.result }));
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: rpc.error || "Failed to switch workspace" }));
            }
            return;
          }

          if (process.platform === "darwin") {
            const target = setActiveWorkspace(id || wsPath);
            logActivity("system", `Switched workspace to: ${target.name}`, { path: target.path });
            broadcast("workspace_changed", { activeWorkspace: target, reason: "user_selected" });
            broadcast("state_change", { reason: "workspace_swapped" });

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, activeWorkspace: target }));
            return;
          }

          res.writeHead(503);
          res.end(JSON.stringify({ error: "Host Mac Workstation is offline. Please launch ./run.sh tunnel on your Mac." }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/workspaces/add: Add custom workspace directory
    if (pathname === "/api/workspaces/add" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { path: wsPath, name } = JSON.parse(body || "{}");
          if (!wsPath || !wsPath.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Workspace path is required" }));
            return;
          }

          if (isMacConnected()) {
            const rpc = await forwardCommandToMac("add_workspace", { path: wsPath.trim(), name: name ? name.trim() : null });
            if (rpc.ok) {
              cachedMacState.activeWorkspace = rpc.result;
              broadcast("workspace_changed", { activeWorkspace: rpc.result, reason: "workspace_added" });
              broadcast("state_change", { reason: "workspace_added" });
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, activeWorkspace: rpc.result }));
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: rpc.error || "Failed to add workspace" }));
            }
            return;
          }

          if (process.platform === "darwin") {
            const added = addWorkspace(wsPath.trim(), name ? name.trim() : null);
            logActivity("system", `Added workspace: ${added.name}`, { path: added.path });
            broadcast("workspace_changed", { activeWorkspace: added, reason: "workspace_added" });
            broadcast("state_change", { reason: "workspace_added" });

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, activeWorkspace: added }));
            return;
          }

          res.writeHead(503);
          res.end(JSON.stringify({ error: "Host Mac Workstation is offline. Please launch ./run.sh tunnel on your Mac." }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/prompt: Submit a directive to Antigravity
    if (pathname === "/api/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { prompt, workspaceId } = JSON.parse(body || "{}");
          if (!prompt || !prompt.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Prompt is required" }));
            return;
          }

          logActivity("prompt", prompt.trim());
          const clean = prompt.trim().replace(/^(?:agy|stocktooth|agent)[:\s]+/i, "");

          // 1. If Mac Tunnel is connected, forward command to Mac host
          if (isMacConnected()) {
            try {
              const rpc = await forwardCommandToMac("prompt", { prompt: clean, rawPrompt: prompt.trim(), workspaceId });
              if (rpc.ok) {
                logActivity("response", (rpc.result || "").slice(0, 300), { fullLength: (rpc.result || "").length });
                broadcast("state_change", { reason: "prompt_answered" });
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, type: "task_response", answer: rpc.result }));
              } else {
                res.writeHead(500);
                res.end(JSON.stringify({ error: rpc.error || "Command execution failed on Mac host" }));
              }
            } catch (rpcErr) {
              res.writeHead(503);
              res.end(JSON.stringify({ error: rpcErr.message }));
            }
            return;
          }

          // 2. Local Mac standalone execution
          if (process.platform === "darwin") {
            if (workspaceId) {
              try { setActiveWorkspace(workspaceId); } catch (_) {}
            }

            const isExplicitDirective = /^(?:agy|stocktooth|agent)[:\s]+/i.test(prompt.trim());
            const activePlan = loadActivePlanSession();
            if (!isExplicitDirective && activePlan && (activePlan.state === PLAN_STATES.REVIEWING || activePlan.state === PLAN_STATES.READY) && !prompt.startsWith("/")) {
              const commentRes = applyCommentToPlan(activePlan.planPath, clean);
              logActivity("plan", `Added revision: "${clean}"`, { planPath: activePlan.planPath });
              broadcast("state_change", { reason: "plan_commented" });
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, type: "plan_comment", answer: commentRes }));
              return;
            }

            const answer = await executeUserDirective(clean);
            logActivity("response", answer.slice(0, 300), { fullLength: answer.length });
            broadcast("state_change", { reason: "prompt_answered" });

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, type: "task_response", answer }));
            return;
          }

          // 3. Cloud Run with no Mac tunnel
          res.writeHead(503);
          res.end(JSON.stringify({
            ok: false,
            error: "Host Mac Workstation is offline. Please launch `./run.sh tunnel` on your Mac."
          }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/decision: Resolve an active approval or multiple-choice question
    if (pathname === "/api/decision" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { value, isApproval } = JSON.parse(body || "{}");

          if (isMacConnected()) {
            const rpc = await forwardCommandToMac("decision", { value, isApproval });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, resolved: true }));
            return;
          }

          if (process.platform === "darwin") {
            const decData = loadDecisions();
            const active = decData.activeDecision;

            if (active) {
              decData.history = decData.history || [];
              decData.history.push({
                ...active,
                resolvedValue: value,
                resolvedAt: new Date().toISOString()
              });
              decData.activeDecision = null;
              saveDecisions(decData);

              const promptForIde = isApproval 
                ? `[Mobile Permission] User responded with: ${value ? "YES (Approve)" : "NO (Deny)"}`
                : `[Mobile Decision] User selected Option ${value}`;
              
              injectPromptIntoIde(promptForIde);
              logActivity("decision", promptForIde);
              broadcast("state_change", { reason: "decision_resolved" });

              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, resolved: true, promptForIde }));
              return;
            }

            res.writeHead(400);
            res.end(JSON.stringify({ error: "No active decision pending" }));
            return;
          }

          res.writeHead(503);
          res.end(JSON.stringify({ error: "Host Mac Workstation is offline. Please launch ./run.sh tunnel on your Mac." }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/plan/action: Proceed, comment, or cancel active implementation plan
    if (pathname === "/api/plan/action" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { action, comment } = JSON.parse(body || "{}");

          if (isMacConnected()) {
            const rpc = await forwardCommandToMac("plan_action", { action, comment });
            res.writeHead(200);
            res.end(JSON.stringify(rpc.result || { ok: true }));
            return;
          }

          if (process.platform === "darwin") {
            const session = loadActivePlanSession();
            if (!session || !session.planPath) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "No active plan session found" }));
              return;
            }

            if (action === "proceed") {
              logActivity("plan", `🚀 Proceed & Implement clicked for: ${session.title}`);
              broadcast("state_change", { reason: "plan_implementing" });
              
              executePlanFromMobile(session.planPath).catch(err => {
                logActivity("system", `Plan execution error: ${err.message}`);
              });

              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, state: PLAN_STATES.IMPLEMENTING }));
              return;
            } else if (action === "comment" && comment) {
              applyCommentToPlan(session.planPath, comment);
              logActivity("plan", `Revision added: "${comment}"`);
              broadcast("state_change", { reason: "plan_revised" });

              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, state: PLAN_STATES.READY }));
              return;
            } else if (action === "cancel") {
              session.state = PLAN_STATES.CANCELLED;
              saveActivePlanSession(session);
              logActivity("plan", `🛑 Plan Cancelled: ${session.title}`);
              broadcast("state_change", { reason: "plan_cancelled" });

              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, state: PLAN_STATES.CANCELLED }));
              return;
            }

            res.writeHead(400);
            res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
            return;
          }

          res.writeHead(503);
          res.end(JSON.stringify({ error: "Host Mac Workstation is offline. Please launch ./run.sh tunnel on your Mac." }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 404 for unknown API
    res.writeHead(404);
    res.end(JSON.stringify({ error: "API route not found" }));
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    // Fallback to index.html for SPA routing
    const fallbackPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(fallbackPath)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      fs.createReadStream(fallbackPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

// Periodic Heartbeat for SSE connections
setInterval(() => {
  broadcast("heartbeat", { time: new Date().toISOString() });
}, 15000);

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      const localIp = getLocalIp();
      console.log("==================================================");
      console.log("📱 ANTIGRAVITY MOBILE WEB DASHBOARD (PWA)");
      console.log("==================================================");
      console.log(`🚀 Server listening on:`);
      console.log(`   • Local:   http://localhost:${port}`);
      console.log(`   • Network: http://${localIp}:${port}`);
      console.log(`\n👉 Open http://${localIp}:${port} on your phone's browser!`);
      console.log(`   (Tip: Tap 'Share' -> 'Add to Home Screen' on iOS for full-screen PWA)\n`);
      resolve({ server, port, localIp });
    });
    server.on("error", reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
