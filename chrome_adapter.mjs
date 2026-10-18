import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = process.env.BRIDGE_STATE_FILE || resolve(__dirname, "bridge_state.json");

export function hashText(text) {
  return createHash("sha256").update((text || "").trim().toLowerCase()).digest("hex");
}

export function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (!Array.isArray(data.processedHashes)) {
        data.processedHashes = [];
      }
      return data;
    } catch (_) {}
  }
  return { lastTurnId: null, lastProcessedTurnId: null, activeTabUrl: null, processedHashes: [], lastUpdated: new Date().toISOString() };
}

export function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

export function runChromeJs(script) {
  if (process.platform !== "darwin") {
    return "";
  }
  const escaped = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const appleScript = `
tell application "Google Chrome"
    set foundTab to null
    set foundWindow to null
    
    try
        set curUrl to URL of active tab of front window
        if curUrl contains "gemini.google.com" then
            set foundTab to active tab of front window
        end if
    end try
    
    if foundTab is null then
        repeat with w in windows
            repeat with t in tabs of w
                if (URL of t) contains "gemini.google.com" then
                    set foundTab to t
                    set foundWindow to w
                    exit repeat
                end if
            end repeat
            if foundTab is not null then exit repeat
        end repeat
    end if
    
    if foundTab is null then
        error "No Google Chrome tab with gemini.google.com found!"
    end if
    
    tell foundTab
        execute javascript "${escaped}"
    end tell
end tell`;

  try {
    const res = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8" });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(res.stderr || "AppleScript error");
    return (res.stdout || "").trim();
  } catch (err) {
    return "";
  }
}

export function sendNotification(title, message, sound = "Submarine") {
  if (process.platform === "darwin") {
    try {
      const safeTitle = (title || "").replace(/"/g, '\\"');
      const safeMsg = (message || "").replace(/"/g, '\\"');
      const script = `display notification "${safeMsg}" with title "${safeTitle}" sound name "${sound}"`;
      spawnSync("osascript", ["-e", script]);
    } catch (_) {}
  }

  const ntfyTopic = process.env.NTFY_TOPIC;
  if (ntfyTopic) {
    try {
      fetch(`https://ntfy.sh/${ntfyTopic}`, {
        method: "POST",
        headers: {
          "Title": title,
          "Priority": "high",
          "Tags": "bell,robot"
        },
        body: message
      }).catch(() => {});
    } catch (_) {}
  }
}

export function sendTextToGemini(text) {
  if (process.platform !== "darwin") {
    console.log("[Bridge] Headless/Linux environment detected. Skipping direct Chrome automation.");
    return true;
  }

  const nonce = `<!-- agy-outbound -->`;
  const watermarked = text.includes("<!-- agy-") ? text : `${text}\n\n${nonce}`;

  try {
    const s = loadState();
    const h = hashText(watermarked);
    const rawH = hashText(text);
    s.processedHashes = s.processedHashes || [];
    if (!s.processedHashes.includes(h)) s.processedHashes.push(h);
    if (!s.processedHashes.includes(rawH)) s.processedHashes.push(rawH);
    if (s.processedHashes.length > 500) s.processedHashes = s.processedHashes.slice(-500);
    saveState(s);
  } catch (_) {}

  try {
    let editorType = "none";
    for (let i = 0; i < 5; i++) {
      const check = runChromeJs(`(() => {
        const ql = document.querySelector("rich-textarea .ql-editor, [contenteditable='true']");
        if (ql && ql.getAttribute("contenteditable") === "true") return "quill";
        const gds = document.querySelector("textarea.gds-body-l, textarea[aria-label*='prompt'], textarea");
        if (gds && !gds.disabled && !gds.readOnly) return "textarea";
        return "none";
      })()`);
      if (check && check !== "none") {
        editorType = check;
        break;
      }
    }

    if (editorType === "quill") {
      runChromeJs(`(() => {
        const ql = document.querySelector("rich-textarea .ql-editor, [contenteditable='true']");
        if (ql) {
          ql.focus();
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        }
      })()`);

      spawnSync("pbcopy", { input: watermarked, encoding: "utf8" });
      const pasteScript = `
tell application "Google Chrome" to activate
delay 0.2
tell application "Google Chrome"
    tell active tab of front window
        execute javascript "document.querySelector(\\"rich-textarea .ql-editor\\").focus();"
    end tell
end tell
delay 0.2
tell application "System Events"
    tell process "Google Chrome"
        keystroke "v" using command down
    end tell
end tell
delay 0.5
`;
      spawnSync("osascript", ["-e", pasteScript]);

      const sendJs = `(() => {
        const ql = document.querySelector("rich-textarea .ql-editor");
        if (ql) ql.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
        const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button[aria-label*="Submit"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return "SENT";
        }
        return "NO_SEND_BTN";
      })()`;
      runChromeJs(sendJs);
      try {
        spawnSync("osascript", ["-e", 'tell application "Antigravity" to activate']);
      } catch (_) {}
    }
  } catch (err) {
    console.warn("[Bridge] Chrome automation warning:", err.message);
  }

  return true;
}
