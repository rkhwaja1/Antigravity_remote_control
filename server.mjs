import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
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
  isAuthDisabled 
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

// SSE Client Connections
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
  const targetDir = dirPath || getActiveWorkspace().path;
  const info = getWorkspaceGitInfo(targetDir);
  return {
    branch: info.branch || "HEAD",
    hasChanges: info.hasChanges,
    modifiedCount: info.modifiedCount
  };
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          pairId: pairing.pairId,
          pin: `${pairing.pin.slice(0, 3)}-${pairing.pin.slice(3)}`,
          rawPin: pairing.pin,
          expiresAt: pairing.expiresAt
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
      activeSessions: auth.authenticated ? getActiveSessions() : []
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

    // GET /api/workspaces: List all workspaces
    if (pathname === "/api/workspaces" && req.method === "GET") {
      const data = loadWorkspaces();
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        activeWorkspace: getActiveWorkspace(),
        workspaces: data.workspaces
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
          const target = setActiveWorkspace(id || wsPath);
          logActivity("system", `Switched workspace to: ${target.name}`, { path: target.path });
          broadcast("workspace_changed", { activeWorkspace: target, reason: "user_selected" });
          broadcast("state_change", { reason: "workspace_swapped" });

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, activeWorkspace: target }));
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
          const added = addWorkspace(wsPath.trim(), name ? name.trim() : null);
          logActivity("system", `Added workspace: ${added.name}`, { path: added.path });
          broadcast("workspace_changed", { activeWorkspace: added, reason: "workspace_added" });
          broadcast("state_change", { reason: "workspace_added" });

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, activeWorkspace: added }));
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

          if (workspaceId) {
            try { setActiveWorkspace(workspaceId); } catch (_) {}
          }

          logActivity("prompt", prompt.trim());
          const clean = prompt.trim().replace(/^(?:agy|stocktooth|agent)[:\s]+/i, "");

          // Check if active plan is reviewing and user gave free-form feedback (non-directive)
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

          // Execute directive with active workspace context
          const answer = await executeUserDirective(clean);
          logActivity("response", answer.slice(0, 300), { fullLength: answer.length });
          broadcast("state_change", { reason: "prompt_answered" });

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, type: "task_response", answer }));
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
          const session = loadActivePlanSession();

          if (!session || !session.planPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "No active plan session found" }));
            return;
          }

          if (action === "proceed") {
            logActivity("plan", `🚀 Proceed & Implement clicked for: ${session.title}`);
            broadcast("state_change", { reason: "plan_implementing" });
            
            // Execute in background
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
