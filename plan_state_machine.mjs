import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { sendTextToGemini, sendNotification } from "./chrome_adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..");
const ACTIVE_PLAN_FILE = resolve(WORKSPACE_ROOT, "scratch/active_plan_session.json");

export const PLAN_STATES = {
  DRAFTED: "DRAFTED",
  REVIEWING: "REVIEWING",
  EDITING: "EDITING",
  READY: "READY",
  IMPLEMENTING: "IMPLEMENTING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED"
};

export function loadActivePlanSession() {
  if (existsSync(ACTIVE_PLAN_FILE)) {
    try {
      return JSON.parse(readFileSync(ACTIVE_PLAN_FILE, "utf8"));
    } catch (_) {}
  }
  return null;
}

export function saveActivePlanSession(session) {
  try {
    writeFileSync(ACTIVE_PLAN_FILE, JSON.stringify(session, null, 2), "utf8");
  } catch (_) {}
}

export function openPlanInIde(planPath) {
  try {
    console.log(`[Plan Manager] Opening plan in Antigravity IDE: ${planPath}`);
    const res = spawnSync("agy", ["-r", planPath], { encoding: "utf8" });
    if (res.status === 0) {
      console.log(`[Plan Manager] Successfully opened plan in IDE.`);
      return true;
    }
  } catch (err) {
    console.error("[Plan Manager] Failed to open with agy CLI:", err.message);
  }
  return false;
}

export function formatPlanForMobile(planPath) {
  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found at: ${planPath}`);
  }

  const content = readFileSync(planPath, "utf8");
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Implementation Plan";

  // Extract Executive Summary / Overview
  let summary = "";
  const execMatch = content.match(/##\s+Executive Summary\s*\n+([\s\S]*?)(?=\n##|\n---|$)/i);
  if (execMatch) {
    summary = execMatch[1].trim().slice(0, 500);
  } else {
    // Grab first non-header lines
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    summary = lines.slice(0, 4).join("\n").slice(0, 400);
  }

  // Extract Phases / Checklist
  const phases = [];
  const phaseRegex = /###?\s+Phase\s+([^\n]+)\n+([\s\S]*?)(?=\n###?\s+Phase|\n##|\n---|$)/gi;
  let match;
  while ((match = phaseRegex.exec(content)) !== null) {
    const phaseTitle = match[1].trim();
    const phaseBody = match[2].trim();
    // Extract task bullet points
    const taskLines = phaseBody
      .split("\n")
      .filter(l => l.trim().startsWith("- [ ]") || l.trim().startsWith("- [x]"))
      .map(l => l.trim().replace(/^-\s*\[([ x])\]\s*/i, (m, c) => (c.toLowerCase() === 'x' ? '✅ ' : '⏳ ')))
      .slice(0, 4);

    phases.push({
      title: phaseTitle,
      tasks: taskLines
    });
  }

  // Build Mobile-Optimized Review Card
  let card = `📋 **ANTIGRAVITY IMPLEMENTATION PLAN REVIEW**\n\n`;
  card += `📌 **Title**: **${title}**\n`;
  card += `📁 **File**: \`${planPath}\`\n\n`;
  card += `---\n\n`;
  card += `### 🎯 Executive Summary & Clinical Scope:\n${summary}\n\n`;

  if (phases.length > 0) {
    card += `### 🛠️ Key Implementation Phases:\n`;
    phases.forEach((p, idx) => {
      const cleanTitle = p.title.replace(/^\d+[:\-\s]+/, '');
      card += `**Phase ${idx + 1}: ${cleanTitle}**\n`;
      if (p.tasks.length > 0) {
        p.tasks.forEach(t => {
          card += `  ${t}\n`;
        });
      }
      card += `\n`;
    });
  }

  card += `---\n\n`;
  card += `👉 **How would you like to proceed from your phone?**\n\n`;
  card += `**[ 1 ] 🚀 Proceed & Implement Plan** (Antigravity will begin automated execution)\n`;
  card += `**[ 2 ] ✏️ Request Changes / Add Comments** (Reply with "AGY: Change step X to...")\n`;
  card += `**[ 3 ] 🛑 Cancel / Put on Hold**\n\n`;
  card += `👉 *Reply on your phone with "1", "2", or "3" (or dictate comments).*`;

  return { title, card, phases };
}

export async function pushPlanReviewCard(planPath) {
  // 1. Format card
  const { title, card, phases } = formatPlanForMobile(planPath);

  // 2. Open file in Antigravity IDE on Mac
  openPlanInIde(planPath);

  // 3. Save active plan session
  const session = {
    planPath,
    title,
    phases,
    state: PLAN_STATES.REVIEWING,
    updatedAt: new Date().toISOString(),
    comments: []
  };
  saveActivePlanSession(session);

  // 4. Send to Chrome tab
  console.log(`[Plan Manager] Pushing plan review card to phone for: "${title}"`);
  sendTextToGemini(card);
  sendNotification("Plan Ready for Review", title);
  return session;
}

export function applyCommentToPlan(planPath, commentText) {
  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }

  const content = readFileSync(planPath, "utf8");
  const timestamp = new Date().toLocaleString();
  const feedbackBlock = `\n\n---\n\n## 📱 Mobile Revisions & Clinical Feedback (${timestamp})\n- ${commentText}\n`;

  let updatedContent = "";
  if (content.includes("## 📱 Mobile Revisions")) {
    updatedContent = content.replace(/(## 📱 Mobile Revisions[^\n]*\n)/, `$1- [${timestamp}] ${commentText}\n`);
  } else {
    updatedContent = content + feedbackBlock;
  }

  writeFileSync(planPath, updatedContent, "utf8");

  // Update session
  const session = loadActivePlanSession() || { planPath };
  session.comments = session.comments || [];
  session.comments.push({ text: commentText, timestamp: new Date().toISOString() });
  session.state = PLAN_STATES.READY;
  saveActivePlanSession(session);

  // Post confirmation to phone
  let ack = `✏️ **Antigravity on Mac — Plan Updated with Your Feedback**\n\n`;
  ack += `Added revision to \`${planPath}\`:\n`;
  ack += `> *"${commentText}"*\n\n`;
  ack += `---\n\n`;
  ack += `👉 **Ready to implement?**\n`;
  ack += `**[ 1 ] 🚀 Proceed & Implement Plan**\n`;
  ack += `**[ 2 ] ✏️ Add More Comments**\n`;
  ack += `**[ 3 ] 🛑 Cancel**\n\n`;
  ack += `👉 *Reply "1" to start implementation, or type more feedback.*`;

  try {
    sendTextToGemini(ack);
  } catch (_) {}
  sendNotification("Plan Updated", `Added comment: ${commentText.slice(0, 60)}`);
  return ack;
}

export async function executePlanFromMobile(planPath) {
  const session = loadActivePlanSession() || { planPath };
  session.state = PLAN_STATES.IMPLEMENTING;
  session.startedAt = new Date().toISOString();
  saveActivePlanSession(session);

  let startNotice = `🚀 **Antigravity on Mac — Implementation Started!**\n\n`;
  startNotice += `Executing plan: **${session.title || "Implementation Plan"}**\n`;
  startNotice += `📄 Document: \`${planPath}\`\n\n`;
  startNotice += `Live progress updates will stream here to your phone as tasks complete...`;

  try {
    sendTextToGemini(startNotice);
  } catch (_) {}
  sendNotification("Implementation Started", session.title || "Plan Execution");

  // Trigger agent execution in Antigravity IDE
  const directive = `Execute the implementation plan at ${planPath}. Run required tests and verify changes cleanly.`;
  console.log(`[Plan Manager] Triggering agent in IDE for: ${directive}`);
  try {
    const res = spawnSync("agy", ["chat", "-r", directive], { encoding: "utf8", timeout: 15000 });
    if (res.status !== 0) {
      const { injectPromptIntoIde } = await import("./task_executor.mjs");
      injectPromptIntoIde(directive);
    }
  } catch (err) {
    console.warn("[Plan Manager] agy chat failed, using fallback:", err.message);
    const { injectPromptIntoIde } = await import("./task_executor.mjs");
    injectPromptIntoIde(directive);
  }

  return true;
}
