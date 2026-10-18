import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..");

const BRAIN_DIR = resolve(process.env.HOME, ".gemini/antigravity-ide/brain");
const SESSIONS_FILE = process.env.SESSIONS_FILE || resolve(__dirname, "bridge_conversations.json");
const LIVE_SESSION_MD = process.env.LIVE_SESSION_MD || resolve(__dirname, "active_mobile_session.md");

// Find plans across brain and tasks
function findPlans(keywords) {
  const matches = [];
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  // 1. Scan Brain directories
  if (existsSync(BRAIN_DIR)) {
    try {
      const convos = readdirSync(BRAIN_DIR);
      for (const cid of convos) {
        const cPath = join(BRAIN_DIR, cid);
        try {
          if (statSync(cPath).isDirectory()) {
            const files = readdirSync(cPath);
            for (const f of files) {
              if (f.endsWith(".md") && !f.startsWith(".")) {
                const fPath = join(cPath, f);
                const content = readFileSync(fPath, "utf8");
                const lowerContent = content.toLowerCase();
                const lowerName = f.toLowerCase();

                let score = 0;
                for (const kw of lowerKeywords) {
                  if (lowerName.includes(kw)) score += 5;
                  if (lowerContent.includes(kw)) score += 1;
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
              }
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 2. Scan scratch/
  const scratchDir = resolve(process.cwd(), "scratch");
  if (existsSync(scratchDir)) {
    try {
      const files = readdirSync(scratchDir);
      for (const f of files) {
        if (f.endsWith(".md")) {
          const fPath = join(scratchDir, f);
          const content = readFileSync(fPath, "utf8");
          const lowerContent = content.toLowerCase();
          const lowerName = f.toLowerCase();

          let score = 0;
          for (const kw of lowerKeywords) {
            if (lowerName.includes(kw)) score += 4;
            if (lowerContent.includes(kw)) score += 1;
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
        }
      }
    } catch (_) {}
  }

  return matches.sort((a, b) => b.score - a.score);
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Document";
}

function extractSummary(content) {
  // Grab first 300 characters after title or under overview
  const lines = content.split("\n");
  const meaningful = lines.filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("```"));
  return meaningful.slice(0, 3).join("\n").slice(0, 350);
}

// Run tests
function runTests() {
  console.log("[Executor] Running tests...");
  const res = spawnSync("npm", ["test", "--", "--run"], { encoding: "utf8", timeout: 45000 });
  const output = res.stdout || res.stderr || "";
  const passMatch = output.match(/(\d+)\s+passed/i);
  const failMatch = output.match(/(\d+)\s+failed/i);
  return {
    raw: output.slice(-500),
    passed: passMatch ? passMatch[1] : "?",
    failed: failMatch ? failMatch[1] : "0",
    exitCode: res.status
  };
}

// Check git status
function getGitStatus() {
  const res = spawnSync("git", ["status", "-s"], { encoding: "utf8" });
  const logRes = spawnSync("git", ["log", "-1", "--oneline"], { encoding: "utf8" });
  return {
    status: res.stdout.trim() || "Working tree clean.",
    lastCommit: logRes.stdout.trim()
  };
}

// Inject prompt into live Antigravity IDE chat session
export function injectPromptIntoIde(promptText) {
  try {
    console.log(`[Executor] Passing prompt to Antigravity IDE via agy chat CLI...`);
    const res = spawnSync("agy", ["chat", "-r", promptText], { encoding: "utf8", timeout: 15000 });
    if (res.status === 0) {
      return true;
    }
  } catch (err) {
    console.warn(`[Executor] agy chat CLI failed, trying System Events fallback:`, err.message);
  }

  // Fallback to System Events targeting "Antigravity"
  const appleScript = `
set the clipboard to ${JSON.stringify(promptText)}
tell application "Antigravity" to activate
delay 0.4
tell application "System Events"
    tell process "Antigravity"
        keystroke "l" using {command down}
        delay 0.3
        keystroke "v" using {command down}
        delay 0.3
        key code 36
    end tell
end tell
`;
  const res = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8" });
  return res.status === 0;
}

// Main autonomous task execution logic
export async function executeUserDirective(promptText) {
  const lower = promptText.toLowerCase();

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
    return `🚀 **Antigravity on Mac — Plan Execution Triggered**\n\nImplementing: **${activePlan.title}**\n📁 \`${activePlan.planPath}\`\n\nAntigravity is now implementing the steps autonomously.`;
  }

  // Case 0B: User comments or requests changes to the active plan
  if (activePlan && (lower.includes("change step") || lower.includes("add to plan") || lower.includes("update step") || lower.startsWith("in step ") || lower.includes("revision:"))) {
    console.log(`[Executor] Mobile submitted revision for active plan: ${activePlan.planPath}`);
    const ack = applyCommentToPlan(activePlan.planPath, promptText);
    return ack;
  }

  // Case 1: Searching for plans or documents
  if (lower.includes("plan") || lower.includes("find") || lower.includes("photo") || lower.includes("bag") || lower.includes("mfa") || lower.includes("iam")) {
    const keywords = promptText
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !["can", "you", "find", "that", "the", "about", "for", "and", "this", "app"].includes(w.toLowerCase()));

    const matches = findPlans(keywords);

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
  if (lower.includes("test") || lower.includes("vitest")) {
    const testRes = runTests();
    let response = `🤖 **Antigravity on Mac — Test Execution Results**\n\n`;
    response += `✅ **Passed**: ${testRes.passed}\n`;
    response += `❌ **Failed**: ${testRes.failed}\n\n`;
    response += `\`\`\`text\n${testRes.raw.trim()}\n\`\`\``;
    return response;
  }

  // Case 3: Git status / changes
  if (lower.includes("git") || lower.includes("status") || lower.includes("branch") || lower.includes("commit")) {
    const git = getGitStatus();
    let response = `🤖 **Antigravity on Mac — Git Status**\n\n`;
    response += `📌 **Latest Commit**: \`${git.lastCommit}\`\n\n`;
    response += `**Working Directory Status:**\n\`\`\`text\n${git.status}\n\`\`\``;
    return response;
  }

  // Case 4: General Antigravity task execution
  console.log(`[Executor] Forwarding general directive to Antigravity IDE session: "${promptText}"`);
  const success = injectPromptIntoIde(promptText);
  return `🤖 **Antigravity on Mac — Task Injected to Live IDE**\n\nYour directive has been routed into your active Antigravity IDE session on Mac:\n> *"${promptText}"*\n\n${success ? "⚡ Agent execution launched in Antigravity IDE." : "⚠️ Please check your Mac."}`;
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
