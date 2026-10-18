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
import { loadDecisions, saveDecisions } from "./gemini_bridge.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

// Get Git Status Summary
function getGitInfo() {
  try {
    const branchRes = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" });
    const statusRes = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return {
      branch: (branchRes.stdout || "main").trim(),
      hasChanges: (statusRes.stdout || "").trim().length > 0,
      modifiedCount: (statusRes.stdout || "").trim().split("\n").filter(Boolean).length
    };
  } catch (_) {
    return { branch: "main", hasChanges: false, modifiedCount: 0 };
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Channel
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

  // API Endpoints
  if (pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // GET /api/state: Comprehensive system and bridge state
    if (pathname === "/api/state" && req.method === "GET") {
      const planSession = loadActivePlanSession();
      let formattedPlan = null;
      if (planSession && planSession.planPath && fs.existsSync(planSession.planPath)) {
        try {
          formattedPlan = formatPlanForMobile(planSession.planPath);
        } catch (_) {}
      }
      const decData = loadDecisions();
      const git = getGitInfo();

      const caffeinateRes = spawnSync("pgrep", ["caffeinate"], { encoding: "utf8" });
      const isCaffeinateActive = (caffeinateRes.stdout || "").trim().length > 0;

      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        localIp: getLocalIp(),
        port: PORT,
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

    // POST /api/prompt: Submit a directive to Antigravity
    if (pathname === "/api/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { prompt } = JSON.parse(body || "{}");
          if (!prompt || !prompt.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Prompt is required" }));
            return;
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

          // Execute directive
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
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    // Fallback to index.html for SPA routing
    const fallbackPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(fallbackPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
