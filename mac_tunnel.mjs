import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { executeUserDirective, injectPromptIntoIde } from "./task_executor.mjs";
import { 
  loadWorkspaces, 
  getActiveWorkspace, 
  setActiveWorkspace, 
  addWorkspace, 
  getWorkspaceGitInfo 
} from "./workspace_manager.mjs";
import { 
  loadActivePlanSession, 
  saveActivePlanSession, 
  formatPlanForMobile, 
  executePlanFromMobile, 
  applyCommentToPlan, 
  PLAN_STATES 
} from "./plan_state_machine.mjs";
import { getHostSecret, approvePairing, loadAuthStore, saveAuthStore } from "./auth_manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DECISIONS_FILE = process.env.DECISIONS_FILE || path.resolve(__dirname, "decisions.json");

const CLOUD_RUN_URL = (process.env.CLOUD_RUN_URL || "https://antigravity-remote-356302263933.europe-west2.run.app").replace(/\/$/, "");
const HOST_SECRET = process.env.HOST_SECRET || getHostSecret();

function loadDecisions() {
  if (fs.existsSync(DECISIONS_FILE)) {
    try { return JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8")); } catch (_) {}
  }
  return { activeDecision: null, history: [] };
}

function saveDecisions(data) {
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function collectLocalState() {
  const activeWs = getActiveWorkspace();
  const wsData = loadWorkspaces();
  const planSession = loadActivePlanSession();
  let formattedPlan = null;
  if (planSession && planSession.planPath && fs.existsSync(planSession.planPath)) {
    try {
      formattedPlan = formatPlanForMobile(planSession.planPath);
    } catch (_) {}
  }
  const decData = loadDecisions();
  const git = getWorkspaceGitInfo(activeWs.path);

  const caffeinateRes = spawnSync("pgrep", ["caffeinate"], { encoding: "utf8" });
  const isCaffeinateActive = (caffeinateRes.stdout || "").trim().length > 0;

  return {
    activeWorkspace: activeWs,
    workspaces: wsData.workspaces,
    activePlan: planSession ? {
      ...planSession,
      formatted: formattedPlan
    } : null,
    activeDecision: decData.activeDecision,
    git: {
      branch: git.branch || "HEAD",
      hasChanges: git.hasChanges,
      modifiedCount: git.modifiedCount
    },
    caffeinate: isCaffeinateActive
  };
}

export async function postToCloud(endpoint, payload) {
  const url = `${CLOUD_RUN_URL}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HOST_SECRET}`
      },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({ ok: true }));
  } catch (err) {
    console.error(`[MacTunnel] Post to ${endpoint} error:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Native macOS Approval Dialog
export function promptMacApproval(pairId, pin, clientName, ip) {
  const formattedPin = `${pin.slice(0, 3)}-${pin.slice(3)}`;
  console.log(`\n==================================================`);
  console.log(`🔒 [CLOUD RELAY] Remote Pairing Request Received:`);
  console.log(`   • Device: ${clientName} (${ip})`);
  console.log(`   • PIN:    ${formattedPin}`);
  console.log(`   • PairID: ${pairId}`);
  console.log(`==================================================\n`);

  // Record in local auth store so CLI `./run.sh pair [PIN]` can also approve
  try {
    const store = loadAuthStore();
    store.pendingPairings = store.pendingPairings || [];
    if (!store.pendingPairings.some(p => p.pairId === pairId)) {
      store.pendingPairings.push({
        pairId,
        pin,
        clientName,
        ip,
        isRemote: true,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 120,
        approved: false
      });
      saveAuthStore(store);
    }
  } catch (_) {}

  if (process.platform === "darwin" && !process.env.CI) {
    const safeName = (clientName || "Mobile Device").replace(/["\\]/g, "");
    const script = `
tell application "System Events"
    activate
    set res to display dialog "📱 Antigravity Remote (Cloud Run) Pairing Request\\n\\nDevice: ${safeName} (${ip})\\nPIN: ${formattedPin}\\n\\nAuthorize this device to control your Mac workstation?" buttons {"Deny", "Approve"} default button "Approve" with title "Antigravity Cloud Bridge" with icon caution giving up after 90
    if button returned of res is "Approve" then
        return "APPROVED"
    else
        return "DENIED"
    end if
end tell`;

    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.on("close", async code => {
      const approved = code === 0 && stdout.includes("APPROVED");
      console.log(approved ? `✅ Approved pairing ${pairId} on host Mac` : `🛑 Denied pairing ${pairId} on host Mac`);
      if (approved) {
        approvePairing(pairId);
      }
      await postToCloud("/api/tunnel/pair-decision", { pairId, approved });
    });
  }
}

// Handle command RPC dispatched from Cloud Run
async function handleCloudCommand(command) {
  const { reqId, action, payload } = command;
  console.log(`[MacTunnel] Executing RPC action: "${action}" (reqId: ${reqId})`);

  try {
    let result = null;

    if (action === "prompt") {
      const { prompt, workspaceId } = payload;
      if (workspaceId) {
        try { setActiveWorkspace(workspaceId); } catch (_) {}
      }
      result = await executeUserDirective(prompt);
    } else if (action === "select_workspace") {
      const { id, path: wsPath } = payload;
      result = setActiveWorkspace(id || wsPath);
    } else if (action === "add_workspace") {
      const { path: wsPath, name } = payload;
      result = addWorkspace(wsPath, name);
    } else if (action === "decision") {
      const { value, isApproval } = payload;
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
        result = { resolved: true, promptForIde };
      }
    } else if (action === "plan_action") {
      const { action: planAction, comment } = payload;
      const session = loadActivePlanSession();
      if (session && session.planPath) {
        if (planAction === "proceed") {
          executePlanFromMobile(session.planPath).catch(console.error);
          result = { ok: true, state: PLAN_STATES.IMPLEMENTING };
        } else if (planAction === "comment" && comment) {
          applyCommentToPlan(session.planPath, comment);
          result = { ok: true, state: PLAN_STATES.READY };
        } else if (planAction === "cancel") {
          session.state = PLAN_STATES.CANCELLED;
          saveActivePlanSession(session);
          result = { ok: true, state: PLAN_STATES.CANCELLED };
        }
      }
    }

    const state = collectLocalState();
    await postToCloud("/api/tunnel/response", {
      reqId,
      ok: true,
      result,
      state
    });
  } catch (err) {
    console.error(`[MacTunnel] Command error (${action}):`, err);
    await postToCloud("/api/tunnel/response", {
      reqId,
      ok: false,
      error: err.message,
      state: collectLocalState()
    });
  }
}

// Persistent Outbound SSE Reverse Tunnel
export function startMacTunnel() {
  console.log("==================================================");
  console.log("🚀 ANTIGRAVITY MAC WORKSTATION TUNNEL");
  console.log(`• Cloud Relay: ${CLOUD_RUN_URL}`);
  console.log(`• Host Secret: ${HOST_SECRET.slice(0, 6)}...${HOST_SECRET.slice(-4)}`);
  console.log("==================================================");

  let isRunning = true;

  async function connectLoop() {
    while (isRunning) {
      console.log(`\n[MacTunnel] Connecting outbound reverse tunnel to Cloud Run...`);
      try {
        await new Promise((resolve) => {
          const parsed = new URL(`${CLOUD_RUN_URL}/api/tunnel/stream`);
          const isHttps = parsed.protocol === "https:";
          const clientModule = isHttps ? https : http;

          const req = clientModule.request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: "GET",
            headers: {
              "Authorization": `Bearer ${HOST_SECRET}`,
              "Accept": "text/event-stream"
            }
          }, async res => {
            if (res.statusCode === 403) {
              console.error("[MacTunnel] ❌ Authentication failed: Invalid HOST_SECRET. Please ensure HOST_SECRET matches Cloud Run.");
              resolve();
              return;
            }

            if (res.statusCode !== 200) {
              console.warn(`[MacTunnel] Cloud Run returned HTTP ${res.statusCode}. Reconnecting in 3s...`);
              resolve();
              return;
            }

            console.log("✅ [MacTunnel] Tunnel connected! Syncing local Mac workstation state to Cloud Run...");
            await postToCloud("/api/tunnel/sync", collectLocalState());

            let buffer = "";
            res.on("data", chunk => {
              buffer += chunk.toString();
              const lines = buffer.split("\n\n");
              buffer = lines.pop(); // Retain remainder

              for (const block of lines) {
                if (!block.trim()) continue;
                const eventMatch = block.match(/event:\s*([^\n]+)/);
                const dataMatch = block.match(/data:\s*([^\n]+)/);
                const eventName = eventMatch ? eventMatch[1].trim() : "message";
                let eventData = null;
                try { eventData = JSON.parse(dataMatch ? dataMatch[1].trim() : "{}"); } catch (_) {}

                if (eventName === "command" && eventData) {
                  handleCloudCommand(eventData);
                } else if (eventName === "pair_request" && eventData) {
                  promptMacApproval(eventData.pairId, eventData.pin, eventData.clientName, eventData.ip);
                }
              }
            });

            res.on("end", () => {
              console.log("[MacTunnel] Tunnel connection ended by Cloud Run. Reconnecting...");
              resolve();
            });

            res.on("error", err => {
              console.warn("[MacTunnel] Stream connection error:", err.message);
              resolve();
            });
          });

          req.on("error", err => {
            console.warn("[MacTunnel] Request error:", err.message);
            resolve();
          });

          req.end();
        });
      } catch (err) {
        console.error("[MacTunnel] Connection loop exception:", err.message);
      }

      // Reconnect backoff
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  connectLoop();

  return {
    stop: () => { isRunning = false; }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMacTunnel();
}
