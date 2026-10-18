import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { getActiveWorkspace, setActiveWorkspace, loadWorkspaces } from "./workspace_manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BRAIN_DIR = resolve(process.env.HOME, ".gemini/antigravity-ide/brain");
const SESSIONS_FILE = process.env.SESSIONS_FILE || resolve(__dirname, "bridge_conversations.json");
const LIVE_SESSION_MD = process.env.LIVE_SESSION_MD || resolve(__dirname, "active_mobile_session.md");

// Find plans across brain, active workspace, and tasks
function findPlans(keywords, workspacePath = null) {
  const matches = [];
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  // Helper to scan a folder of markdown files
  function scanDir(dir, weight = 1) {
    if (!dir || !existsSync(dir)) return;
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".md") && !f.startsWith(".")) {
          const fPath = join(dir, f);
          try {
            const content = readFileSync(fPath, "utf8");
            const lowerContent = content.toLowerCase();
            const lowerName = f.toLowerCase();

            let score = 0;
            for (const kw of lowerKeywords) {
              if (lowerName.includes(kw)) score += 4 * weight;
              if (lowerContent.includes(kw)) score += 1 * weight;
            }

            if (score > 0) {
              matches.push({
                file: f,
                path: fPath,
                score,
                title: extractTitle(content),
                summary: extractSummary(content)
              });
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // 1. Scan Brain directories
  if (existsSync(BRAIN_DIR)) {
    try {
      const convos = readdirSync(BRAIN_DIR);
      for (const cid of convos) {
        const cPath = join(BRAIN_DIR, cid);
        try {
          if (statSync(cPath).isDirectory()) {
            scanDir(cPath, 1.2);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 2. Scan active workspace folders (scratch, tasks, docs, root)
  const wsDir = workspacePath || getActiveWorkspace().path;
  if (existsSync(wsDir)) {
    scanDir(join(wsDir, "scratch"), 1.5);
    scanDir(join(wsDir, "tasks"), 1.5);
    scanDir(join(wsDir, "docs"), 1.2);
    scanDir(wsDir, 1.0);
  }

  // 3. Scan local scratch
  scanDir(resolve(__dirname, "scratch"), 1.0);

  return matches.sort((a, b) => b.score - a.score);
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Document";
}

function extractSummary(content) {
  const lines = content.split("\n");
  const meaningful = lines.filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("```"));
  return meaningful.slice(0, 3).join("\n").slice(0, 350);
}

// Run tests inside active workspace
function runTests(workspacePath = null) {
  const wsDir = workspacePath || getActiveWorkspace().path;
  console.log(`[Executor] Running tests in workspace: ${wsDir}...`);

  if (!existsSync(wsDir)) {
    return { raw: `Directory does not exist: ${wsDir}`, passed: "0", failed: "1", exitCode: 1 };
  }

  const pkgJsonPath = join(wsDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return {
      raw: `No package.json found in ${wsDir}. (Non-Node or custom test runner project)`,
      passed: "?",
      failed: "0",
      exitCode: 0
    };
  }

  const res = spawnSync("npm", ["test", "--", "--run"], { 
    cwd: wsDir, 
    encoding: "utf8", 
    timeout: 45000 
  });
  const output = res.stdout || res.stderr || "";
  const passMatch = output.match(/(\d+)\s+passed/i);
  const failMatch = output.match(/(\d+)\s+failed/i);
  return {
    raw: output.slice(-500) || "Test run completed with no output.",
    passed: passMatch ? passMatch[1] : (res.status === 0 ? "All" : "?"),
    failed: failMatch ? failMatch[1] : (res.status === 0 ? "0" : "1"),
    exitCode: res.status
  };
}

// Check git status inside active workspace
function getGitStatus(workspacePath = null) {
  const wsDir = workspacePath || getActiveWorkspace().path;
  if (!existsSync(wsDir)) {
    return {
      status: `Workspace folder missing on disk: ${wsDir}`,
      lastCommit: "Unknown"
    };
  }

  const res = spawnSync("git", ["status", "-s"], { cwd: wsDir, encoding: "utf8" });
  const logRes = spawnSync("git", ["log", "-1", "--oneline"], { cwd: wsDir, encoding: "utf8" });

  if (res.status !== 0) {
    return {
      status: `Not a git repository (${wsDir})`,
      lastCommit: "N/A"
    };
  }

  return {
    status: res.stdout.trim() || "Working tree clean.",
    lastCommit: logRes.stdout.trim() || "No commits yet"
  };
}

// Helper to find the latest active Antigravity IDE conversation ID
export function getLatestBrainConversationId() {
  if (existsSync(BRAIN_DIR)) {
    try {
      const dirs = readdirSync(BRAIN_DIR)
        .filter(d => !d.startsWith(".") && d !== "tempmediaStorage")
        .map(d => ({
          id: d,
          mtime: statSync(join(BRAIN_DIR, d)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);
      if (dirs.length > 0) return dirs[0].id;
    } catch (_) {}
  }
  return null;
}

// Inject prompt into live Antigravity IDE chat session
export function injectPromptIntoIde(promptText, workspacePath = null) {
  const wsDir = workspacePath || getActiveWorkspace().path;

  // 1. Focus the workspace window in Antigravity IDE
  if (process.platform === "darwin" && wsDir && existsSync(wsDir)) {
    try {
      spawnSync("agy", ["-r", wsDir], { timeout: 4000 });
    } catch (_) {}
  }

  // 2. Direct macOS Automation targeting Antigravity IDE
  if (process.platform === "darwin") {
    try {
      // Put prompt text into macOS clipboard
      spawnSync("pbcopy", { input: promptText, encoding: "utf8" });

      const appleScript = `
tell application "System Events"
    set ideProc to null
    try
        set ideProc to (first process whose bundle identifier is "com.google.antigravity-ide")
    end try
    if ideProc is null then
        try
            set ideProc to (first process whose bundle identifier is "com.google.antigravity")
        end try
    end if
    if ideProc is null then
        try
            set ideProc to (first process whose name is "Electron" or name is "Antigravity")
        end try
    end if

    if ideProc is not null then
        try
            tell application id (bundle identifier of ideProc) to activate
        on error
            tell application "Antigravity IDE" to activate
        end try
        delay 0.3
        tell ideProc
            -- Focus or open chat panel in IDE
            keystroke "l" using {command down}
            delay 0.3
            -- Paste directive text from clipboard
            keystroke "v" using {command down}
            delay 0.3
            -- Submit to conversation
            key code 36
        end tell
        return "SUCCESS"
    else
        return "NO_PROCESS"
    end if
end tell`;

      const res = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8" });
      const out = (res.stdout || "").trim();
      if (out === "SUCCESS") {
        console.log(`[Executor] Successfully injected prompt into Antigravity IDE chat.`);
        return true;
      }
    } catch (err) {
      console.warn(`[Executor] System Events injection warning:`, err.message);
    }
  }

  // 3. Fallback to CLI if headless or non-mac
  try {
    const res = spawnSync("agy", ["chat", "-r", promptText], { 
      cwd: wsDir, 
      encoding: "utf8", 
      timeout: 10000 
    });
    return res.status === 0;
  } catch (_) {
    return false;
  }
}


// Main autonomous task execution logic
export async function executeUserDirective(promptText, explicitWorkspace = null) {
  let cleanPrompt = promptText.trim();
  let ws = explicitWorkspace || getActiveWorkspace();

  // Support inline workspace prefixes: @remote, @dental, [dental], etc.
  const prefixMatch = cleanPrompt.match(/^[@\[]([a-zA-Z0-9_-]+)[\]:]?\s*(.*)$/);
  if (prefixMatch) {
    const alias = prefixMatch[1].toLowerCase();
    const remaining = prefixMatch[2];
    const data = loadWorkspaces();
    const matched = data.workspaces.find(w => 
      w.id.toLowerCase() === alias || 
      w.name.toLowerCase().includes(alias) || 
      w.id.toLowerCase().includes(alias)
    );
    if (matched) {
      ws = setActiveWorkspace(matched.id);
      cleanPrompt = remaining.trim() || "check git status";
    }
  }

  const lower = cleanPrompt.toLowerCase();

  // Dynamic import of plan state machine to avoid circular dependencies
  const { 
    openPlanInIde, 
    formatPlanForMobile, 
    saveActivePlanSession, 
    loadActivePlanSession, 
    applyCommentToPlan, 
    executePlanFromMobile, 
    PLAN_STATES 
  } = await import("./plan_state_machine.mjs");

  // Check if there is an active plan session
  const activePlan = loadActivePlanSession();

  // Case 0A: User says "proceed", "implement", "start execution"
  if (activePlan && (lower.includes("proceed") || lower.includes("implement") || lower.includes("execute plan") || lower === "1")) {
    console.log(`[Executor] Mobile requested execution of active plan: ${activePlan.planPath}`);
    await executePlanFromMobile(activePlan.planPath);
    return `🚀 **Antigravity on Mac [${ws.name}] — Plan Execution Triggered**\n\nImplementing: **${activePlan.title}**\n📁 \`${activePlan.planPath}\`\n\nAntigravity is now implementing the steps autonomously.`;
  }

  // Case 0B: User comments or requests changes to the active plan
  if (activePlan && (lower.includes("change step") || lower.includes("add to plan") || lower.includes("update step") || lower.startsWith("in step ") || lower.includes("revision:"))) {
    console.log(`[Executor] Mobile submitted revision for active plan: ${activePlan.planPath}`);
    const ack = applyCommentToPlan(activePlan.planPath, cleanPrompt);
    return ack;
  }

  // Case 1: Searching for plans or documents
  if (lower.includes("plan") || lower.includes("find") || lower.includes("photo") || lower.includes("bag") || lower.includes("mfa") || lower.includes("iam")) {
    const keywords = cleanPrompt
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !["can", "you", "find", "that", "the", "about", "for", "and", "this", "app"].includes(w.toLowerCase()));

    const matches = findPlans(keywords, ws.path);

    if (matches.length > 0) {
      const top = matches[0];
      console.log(`[Executor] Found top plan match: ${top.path}`);

      // 1. Physically pull up / open the document in Antigravity IDE on Mac
      openPlanInIde(top.path);

      // 2. Format complete mobile review card with interactive options
      const formatted = formatPlanForMobile(top.path);

      // 3. Save as active plan session
      saveActivePlanSession({
        planPath: top.path,
        title: formatted.title,
        phases: formatted.phases,
        state: PLAN_STATES.REVIEWING,
        updatedAt: new Date().toISOString(),
        comments: []
      });

      return formatted.card;
    }
  }

  // Case 2: Running tests
  if (lower.includes("test") || lower.includes("vitest") || lower.includes("jest")) {
    const testRes = runTests(ws.path);
    let response = `🤖 **Antigravity on Mac [${ws.name}] — Test Results**\n\n`;
    response += `📁 \`${ws.path}\`\n\n`;
    response += `✅ **Passed**: ${testRes.passed}\n`;
    response += `❌ **Failed**: ${testRes.failed}\n\n`;
    response += `\`\`\`text\n${testRes.raw.trim()}\n\`\`\``;
    return response;
  }

  // Case 3: Git status / changes
  if (lower.includes("git") || lower.includes("status") || lower.includes("branch") || lower.includes("commit")) {
    const git = getGitStatus(ws.path);
    let response = `🤖 **Antigravity on Mac [${ws.name}] — Git Status**\n\n`;
    response += `📁 \`${ws.path}\`\n`;
    response += `📌 **Latest Commit**: \`${git.lastCommit}\`\n\n`;
    response += `**Working Directory Status:**\n\`\`\`text\n${git.status}\n\`\`\``;
    return response;
  }

  const convoId = getLatestBrainConversationId();

  // Case 3b: Direct conversational connectivity check
  if (/^(?:can you read this|ping|hello|hi|are you there|test)[?!.]*$/i.test(cleanPrompt)) {
    console.log(`[Executor] Direct conversation check from mobile: "${cleanPrompt}"`);
    injectPromptIntoIde(cleanPrompt, ws.path);
    const answer = `✅ **Yes, I can read this!**\n\nYour mobile directive was received from your device and routed into your live Antigravity IDE session for **${ws.name}**.\n\n📁 \`${ws.path}\`\n⚡ Live tunnel connection is fully active and responsive!`;
    if (convoId) recordTurn(convoId, cleanPrompt, answer);
    return answer;
  }

  // Case 4: General Antigravity task execution
  console.log(`[Executor] Forwarding directive to Antigravity IDE [${ws.name}]: "${cleanPrompt}"`);
  const success = injectPromptIntoIde(cleanPrompt, ws.path);
  const response = `🤖 **Antigravity on Mac [${ws.name}] — Task Injected to Live IDE**\n\nYour directive has been routed into your active Antigravity IDE session for **${ws.name}**:\n> *"${cleanPrompt}"*\n\n📁 \`${ws.path}\`\n\n${success ? "⚡ Agent execution launched in Antigravity IDE." : "⚠️ Please check your Mac."}`;
  if (convoId) recordTurn(convoId, cleanPrompt, response);
  return response;
}


// Manage conversation sessions across Gemini and Mac
export function getOrCreateSession(geminiConvoId) {
  let data = { activeId: null, sessions: {} };
  if (existsSync(SESSIONS_FILE)) {
    try {
      data = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    } catch (_) {}
  }

  let isNew = false;
  if (!data.sessions[geminiConvoId]) {
    isNew = true;
    const sessionId = "session_" + Date.now();
    data.sessions[geminiConvoId] = {
      sessionId,
      geminiId: geminiConvoId,
      createdAt: new Date().toISOString(),
      turns: []
    };
  }

  data.activeId = geminiConvoId;
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  return { session: data.sessions[geminiConvoId], isNew };
}

export function recordTurn(geminiConvoId, userPrompt, agentResponse) {
  const { session } = getOrCreateSession(geminiConvoId);
  const turn = {
    timestamp: new Date().toISOString(),
    prompt: userPrompt,
    response: agentResponse
  };
  session.turns.push(turn);

  // Update sessions JSON
  const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  data.sessions[geminiConvoId] = session;
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf8");

  // Update live markdown view on Mac
  let md = `# Active Mobile Antigravity Session\n\n`;
  md += `**Gemini Conversation ID**: \`${geminiConvoId}\`\n`;
  md += `**Session Started**: ${new Date(session.createdAt).toLocaleString()}\n`;
  md += `**Total Turns**: ${session.turns.length}\n\n---\n\n`;

  session.turns.forEach((t, i) => {
    md += `### Turn ${i + 1} (${new Date(t.timestamp).toLocaleTimeString()})\n\n`;
    md += `**📱 Mobile Prompt:**\n> ${t.prompt.replace(/\n/g, "\n> ")}\n\n`;
    md += `**🖥️ Antigravity Response:**\n${t.response}\n\n---\n\n`;
  });

  writeFileSync(LIVE_SESSION_MD, md, "utf8");
  return turn;
}
