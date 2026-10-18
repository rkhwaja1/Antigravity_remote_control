// State Container
let appState = {
  activePlan: null,
  activeDecision: null,
  git: null,
  caffeinate: false,
  localIp: window.location.hostname
};

// DOM References
const logStream = document.getElementById("log-stream");
const promptInput = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");
const connPill = document.getElementById("conn-pill");
const statusDot = document.getElementById("status-dot");
const connText = document.getElementById("conn-text");
const decisionBanner = document.getElementById("decision-banner");
const bannerTypeLabel = document.getElementById("banner-type-label");
const bannerQuestionText = document.getElementById("banner-question-text");
const bannerActionsContainer = document.getElementById("banner-actions-container");

// View Switching
function switchTab(tabId) {
  document.querySelectorAll(".view-section").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));

  const targetView = document.getElementById(`view-${tabId}`);
  if (targetView) targetView.classList.add("active");

  const tabs = ["chat", "plan", "system"];
  const idx = tabs.indexOf(tabId);
  if (idx !== -1 && document.querySelectorAll(".nav-item")[idx]) {
    document.querySelectorAll(".nav-item")[idx].classList.add("active");
  }

  if (tabId === "chat") {
    setTimeout(scrollToBottom, 50);
  } else if (tabId === "plan") {
    renderPlanView();
  }
}

function scrollToBottom() {
  const main = document.querySelector("main");
  if (main) main.scrollTop = main.scrollHeight;
}

// SSE Live Stream Connection
let sseSource = null;
function initSSE() {
  if (sseSource) sseSource.close();

  statusDot.className = "status-dot";
  connText.textContent = "Connecting...";

  sseSource = new EventSource("/events");

  sseSource.addEventListener("connected", () => {
    statusDot.className = "status-dot connected";
    connText.textContent = "Live (<50ms)";
    fetchState();
  });

  sseSource.addEventListener("state_change", () => {
    fetchState();
  });

  sseSource.addEventListener("log", e => {
    try {
      const entry = JSON.parse(e.data);
      appendLogEntry(entry);
    } catch (_) {}
  });

  sseSource.addEventListener("heartbeat", () => {
    statusDot.className = "status-dot connected";
    connText.textContent = "Live (<50ms)";
  });

  sseSource.onerror = () => {
    statusDot.className = "status-dot";
    connText.textContent = "Reconnecting...";
    sseSource.close();
    setTimeout(initSSE, 2000);
  };
}

// Fetch Full State from Server
async function fetchState() {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    if (data.ok) {
      appState = data;
      renderDecisionBanner();
      renderPlanView();
      renderSystemView();
    }
  } catch (err) {
    console.error("State fetch error:", err);
  }
}

// Append Log Entry to Console
function appendLogEntry(entry) {
  const card = document.createElement("div");
  card.className = `log-card ${entry.type || "response"}`;
  
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const typeLabel = entry.type === "prompt" ? "📱 Mobile Prompt" : entry.type === "plan" ? "📋 Plan Update" : entry.type === "decision" ? "⚡ Decision" : "🤖 Antigravity on Mac";

  card.innerHTML = `
    <div class="log-meta">
      <span>${typeLabel}</span>
      <span>${time}</span>
    </div>
    <div class="log-content">${formatMarkdown(entry.message)}</div>
  `;

  logStream.appendChild(card);
  scrollToBottom();
}

// Simple Markdown Formatter for Web
function formatMarkdown(text) {
  if (!text) return "";
  let clean = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Bold
  clean = clean.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Inline code
  clean = clean.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Linebreaks
  clean = clean.replace(/\n/g, "<br>");
  return clean;
}

// Prompt Submission
async function handleSendPrompt(e) {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;

  if (navigator.vibrate) navigator.vibrate(20);

  // Optimistic UI
  appendLogEntry({
    timestamp: new Date().toISOString(),
    type: "prompt",
    message: text
  });

  promptInput.value = "";
  sendBtn.disabled = true;

  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text })
    });
    const result = await res.json();
    if (!result.ok) {
      appendLogEntry({
        timestamp: new Date().toISOString(),
        type: "response",
        message: `⚠️ Error: ${result.error || "Command execution failed"}`
      });
    }
  } catch (err) {
    appendLogEntry({
      timestamp: new Date().toISOString(),
      type: "response",
      message: `⚠️ Network error: ${err.message}`
    });
  } finally {
    sendBtn.disabled = false;
  }
}

function setQuickPrompt(text) {
  promptInput.value = text;
  promptInput.focus();
}

function sendQuickAction(directive) {
  promptInput.value = directive;
  handleSendPrompt(new Event("submit"));
  switchTab("chat");
}

// Decision Banner Management
function renderDecisionBanner() {
  const dec = appState.activeDecision;
  if (!dec) {
    decisionBanner.classList.remove("active");
    return;
  }

  decisionBanner.classList.add("active");
  bannerTypeLabel.textContent = dec.isApproval ? "PERMISSION REQUIRED" : "DECISION REQUIRED";
  bannerQuestionText.textContent = dec.question;
  bannerActionsContainer.innerHTML = "";

  if (dec.isApproval) {
    const approveBtn = document.createElement("button");
    approveBtn.className = "btn btn-proceed";
    approveBtn.style.padding = "8px 16px";
    approveBtn.style.fontSize = "0.85rem";
    approveBtn.innerHTML = "<span>✅ YES (Approve)</span>";
    approveBtn.onclick = () => submitDecision(true, true);

    const denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-cancel";
    denyBtn.style.padding = "8px 16px";
    denyBtn.style.fontSize = "0.85rem";
    denyBtn.style.flex = "initial";
    denyBtn.innerHTML = "<span>❌ NO (Deny)</span>";
    denyBtn.onclick = () => submitDecision(false, true);

    bannerActionsContainer.appendChild(approveBtn);
    bannerActionsContainer.appendChild(denyBtn);
  } else if (Array.isArray(dec.options)) {
    dec.options.forEach((opt, idx) => {
      const optBtn = document.createElement("button");
      optBtn.className = "btn btn-edit";
      optBtn.style.padding = "8px 14px";
      optBtn.style.fontSize = "0.85rem";
      optBtn.innerHTML = `<span>[ ${idx + 1} ] ${opt}</span>`;
      optBtn.onclick = () => submitDecision(idx + 1, false);
      bannerActionsContainer.appendChild(optBtn);
    });
  }
}

async function submitDecision(value, isApproval) {
  if (navigator.vibrate) navigator.vibrate(25);
  decisionBanner.classList.remove("active");

  try {
    await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, isApproval })
    });
    fetchState();
  } catch (err) {
    alert("Failed to submit decision: " + err.message);
  }
}

// Plan View Rendering
function renderPlanView() {
  const plan = appState.activePlan;
  const titleEl = document.getElementById("plan-display-title");
  const pathEl = document.getElementById("plan-display-path");
  const badgeEl = document.getElementById("plan-status-badge");
  const phasesList = document.getElementById("plan-phases-list");
  const actionsBar = document.getElementById("plan-actions-bar");

  if (!plan) {
    titleEl.textContent = "No Active Plan";
    pathEl.textContent = "Run push-plan on Mac to load an interactive plan.";
    badgeEl.textContent = "STANDBY";
    badgeEl.className = "plan-status-badge badge-reviewing";
    phasesList.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
        <p>No plan is currently open in review mode.</p>
        <p style="font-size: 0.8rem; margin-top: 8px;">Run <code>push-plan &lt;path&gt;</code> or type <code>AGY: make a plan for X</code> in Console.</p>
      </div>
    `;
    actionsBar.style.display = "none";
    return;
  }

  actionsBar.style.display = "flex";
  titleEl.textContent = plan.title || "Implementation Plan";
  pathEl.textContent = plan.planPath;

  const state = plan.state || "REVIEWING";
  badgeEl.textContent = state;
  badgeEl.className = `plan-status-badge badge-${state.toLowerCase()}`;

  phasesList.innerHTML = "";

  const phases = plan.formatted?.phases || plan.phases || [];
  if (phases.length === 0) {
    phasesList.innerHTML = `<div style="color: var(--text-secondary); padding: 16px;">Plan contents loaded without phases. Review details on Mac.</div>`;
    return;
  }

  phases.forEach((p, idx) => {
    const card = document.createElement("div");
    card.className = "phase-card";

    let tasksHtml = "";
    if (Array.isArray(p.tasks)) {
      p.tasks.forEach((t, tIdx) => {
        tasksHtml += `
          <div class="task-item">
            <input type="checkbox" class="task-checkbox" id="task_${idx}_${tIdx}" />
            <label for="task_${idx}_${tIdx}">${formatMarkdown(t)}</label>
          </div>
        `;
      });
    }

    card.innerHTML = `
      <div class="phase-header" onclick="this.nextElementSibling.classList.toggle('hidden')">
        <span>Phase ${idx + 1}: ${p.title}</span>
        <span>▼</span>
      </div>
      <div class="phase-tasks">
        ${tasksHtml || "<div style='color: var(--text-muted); font-size: 0.8rem;'>No tasks listed</div>"}
      </div>
    `;

    phasesList.appendChild(card);
  });
}

// Plan Action Handlers
async function handlePlanAction(action) {
  if (navigator.vibrate) navigator.vibrate(30);

  if (action === "cancel") {
    if (!confirm("Are you sure you want to cancel this plan?")) return;
  }

  try {
    const res = await fetch("/api/plan/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    const result = await res.json();
    if (result.ok) {
      fetchState();
      if (action === "proceed") {
        alert("🚀 Plan implementation triggered on Mac workstation!");
        switchTab("chat");
      }
    } else {
      alert("Error: " + result.error);
    }
  } catch (err) {
    alert("Network error: " + err.message);
  }
}

// Revision Modal Sheet
function openRevisionModal() {
  document.getElementById("revision-modal").classList.add("active");
  setTimeout(() => document.getElementById("revision-textarea").focus(), 150);
}

function closeRevisionModal() {
  document.getElementById("revision-modal").classList.remove("active");
}

function closeModalOnBg(e) {
  if (e.target.id === "revision-modal") {
    closeRevisionModal();
  }
}

async function submitRevisionComment() {
  const comment = document.getElementById("revision-textarea").value.trim();
  if (!comment) return;

  if (navigator.vibrate) navigator.vibrate(20);
  closeRevisionModal();
  document.getElementById("revision-textarea").value = "";

  try {
    const res = await fetch("/api/plan/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "comment", comment })
    });
    const result = await res.json();
    if (result.ok) {
      appendLogEntry({
        timestamp: new Date().toISOString(),
        type: "plan",
        message: `✏️ Revision sent to Mac: "${comment}"`
      });
      fetchState();
      switchTab("plan");
    } else {
      alert("Error adding comment: " + result.error);
    }
  } catch (err) {
    alert("Failed to submit comment: " + err.message);
  }
}

// System View Rendering
function renderSystemView() {
  const hostEl = document.getElementById("sys-host");
  const caffEl = document.getElementById("sys-caff");
  const gitEl = document.getElementById("sys-git");

  if (hostEl) hostEl.textContent = `${appState.localIp || window.location.hostname}:3847`;
  if (caffEl) {
    caffEl.textContent = appState.caffeinate ? "Active (Sleep Prevented)" : "Inactive";
    caffEl.style.color = appState.caffeinate ? "var(--success)" : "var(--danger)";
  }
  if (gitEl && appState.git) {
    gitEl.textContent = `${appState.git.branch}${appState.git.hasChanges ? ` (${appState.git.modifiedCount} uncommitted)` : " (Clean)"}`;
  }
}

// Initialize on Load
window.addEventListener("DOMContentLoaded", () => {
  initSSE();
  fetchState();
});
