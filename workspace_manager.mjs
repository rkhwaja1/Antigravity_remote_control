import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACES_FILE = process.env.WORKSPACES_FILE || path.resolve(__dirname, "workspaces.json");

// Default initial seeded workspaces on Rashid's Mac
const SEED_WORKSPACES = [
  {
    id: "dental-1",
    name: "Dental (Active Clinical)",
    path: "/Users/rashid/dental/Dental-1/Dental",
    isDefault: true,
    source: "seed"
  },
  {
    id: "antigravity-remote",
    name: "Antigravity Remote",
    path: path.resolve(__dirname),
    isDefault: false,
    source: "seed"
  },
  {
    id: "dental-root",
    name: "Dental",
    path: "/Users/rashid/dental/Dental",
    isDefault: false,
    source: "seed"
  },
  {
    id: "beast-bomber",
    name: "Beast Bomber",
    path: "/Users/rashid/Beast_Bomber",
    isDefault: false,
    source: "seed"
  },
  {
    id: "applypilot",
    name: "ApplyPilot Workers",
    path: "/Users/rashid/applypilot-workers",
    isDefault: false,
    source: "seed"
  }
];

// Helper to inspect git status for a specific workspace directory safely
export function getWorkspaceGitInfo(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { branch: null, hasChanges: false, modifiedCount: 0, exists: false };
  }

  try {
    const branchRes = spawnSync("git", ["branch", "--show-current"], {
      cwd: dirPath,
      encoding: "utf8",
      timeout: 3000
    });
    const statusRes = spawnSync("git", ["status", "--porcelain"], {
      cwd: dirPath,
      encoding: "utf8",
      timeout: 3000
    });

    const branch = (branchRes.stdout || "").trim();
    const statusOut = (statusRes.stdout || "").trim();
    const modifiedCount = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;

    return {
      branch: branch || (branchRes.status === 0 ? "HEAD" : null),
      hasChanges: modifiedCount > 0,
      modifiedCount,
      exists: true
    };
  } catch (_) {
    return { branch: null, hasChanges: false, modifiedCount: 0, exists: true };
  }
}

const IGNORED_FOLDER_NAMES = new Set([
  "documents", "downloads", "library", "applications", "movies", "music",
  "pictures", "public", "desktop", "anaconda3", "google-cloud-sdk",
  "node_modules", ".git", ".gemini", ".vscode", "tmp", "temp"
]);

// Auto-discovery for candidate project directories
export function discoverWorkspaces(existingPaths = new Set()) {
  const discovered = [];
  const home = os.homedir();
  const searchRoots = [
    home,
    path.join(home, "dental"),
    path.join(home, "Documents"),
    path.join(home, "Downloads")
  ];

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (IGNORED_FOLDER_NAMES.has(entry.name.toLowerCase())) continue;

        const fullPath = path.join(root, entry.name);
        if (existingPaths.has(fullPath)) continue;

        // Check if project candidate (has .git or package.json)
        const hasGit = fs.existsSync(path.join(fullPath, ".git"));
        const hasPackage = fs.existsSync(path.join(fullPath, "package.json"));

        if (hasGit || hasPackage) {
          const id = entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          discovered.push({
            id: `discovered-${id}`,
            name: entry.name,
            path: fullPath,
            isDefault: false,
            source: "discovered",
            lastUsed: null
          });
          existingPaths.add(fullPath);
        }
      }
    } catch (_) {}
  }

  return discovered;
}

// Load workspaces configuration
export function loadWorkspaces() {
  let data = null;

  if (fs.existsSync(WORKSPACES_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf8"));
    } catch (_) {}
  }

  if (!data || !Array.isArray(data.workspaces) || data.workspaces.length === 0) {
    // Initialize with seeds that exist on this system
    const validSeeds = SEED_WORKSPACES.filter(w => fs.existsSync(w.path));
    data = {
      activeWorkspaceId: validSeeds[0]?.id || "antigravity-remote",
      workspaces: validSeeds.length > 0 ? validSeeds : SEED_WORKSPACES
    };
  }

  // Ensure all known workspaces have updated git info and existence flags
  const existingPathSet = new Set(data.workspaces.map(w => w.path));
  
  // Discover any new projects
  const newDiscovered = discoverWorkspaces(existingPathSet);
  if (newDiscovered.length > 0) {
    data.workspaces.push(...newDiscovered);
  }

  // Refresh git info & existence for each workspace
  data.workspaces = data.workspaces.map(w => {
    const gitInfo = getWorkspaceGitInfo(w.path);
    return {
      ...w,
      gitBranch: gitInfo.branch,
      hasChanges: gitInfo.hasChanges,
      uncommittedCount: gitInfo.modifiedCount,
      exists: gitInfo.exists
    };
  });

  // Verify active workspace exists; if not, fallback to first existing
  const activeExists = data.workspaces.find(w => w.id === data.activeWorkspaceId && w.exists);
  if (!activeExists) {
    const fallback = data.workspaces.find(w => w.exists) || data.workspaces[0];
    if (fallback) {
      data.activeWorkspaceId = fallback.id;
    }
  }

  return data;
}

// Save workspaces configuration
export function saveWorkspaces(data) {
  try {
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[WorkspaceManager] Failed to save workspaces:", err);
    return false;
  }
}

// Get the currently active workspace object
export function getActiveWorkspace() {
  const data = loadWorkspaces();
  const active = data.workspaces.find(w => w.id === data.activeWorkspaceId);
  if (active) return active;

  return {
    id: "default",
    name: "Current Directory",
    path: process.cwd(),
    gitBranch: "main",
    hasChanges: false,
    uncommittedCount: 0,
    exists: true
  };
}

// Set active workspace by ID or path
export function setActiveWorkspace(idOrPath) {
  const data = loadWorkspaces();
  const target = data.workspaces.find(w => w.id === idOrPath || w.path === idOrPath);

  if (!target) {
    throw new Error(`Workspace not found for id/path: ${idOrPath}`);
  }

  if (!fs.existsSync(target.path)) {
    throw new Error(`Workspace directory does not exist on disk: ${target.path}`);
  }

  data.activeWorkspaceId = target.id;
  target.lastUsed = new Date().toISOString();

  // Bring project window to front in Antigravity IDE if on macOS
  if (process.platform === "darwin") {
    try {
      spawnSync("agy", ["-r", target.path], { timeout: 3000 });
    } catch (_) {}
  }

  saveWorkspaces(data);
  return target;
}

// Add a custom workspace
export function addWorkspace(dirPath, customName = null) {
  const resolved = path.resolve(dirPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Specified path is not a directory: ${resolved}`);
  }

  const data = loadWorkspaces();
  const existing = data.workspaces.find(w => w.path === resolved);

  if (existing) {
    existing.lastUsed = new Date().toISOString();
    if (customName) existing.name = customName;
    data.activeWorkspaceId = existing.id;
    saveWorkspaces(data);
    return existing;
  }

  const baseName = customName || path.basename(resolved);
  const id = "custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5);
  const gitInfo = getWorkspaceGitInfo(resolved);

  const newWs = {
    id,
    name: baseName,
    path: resolved,
    isDefault: false,
    source: "manual",
    lastUsed: new Date().toISOString(),
    gitBranch: gitInfo.branch,
    hasChanges: gitInfo.hasChanges,
    uncommittedCount: gitInfo.modifiedCount,
    exists: true
  };

  data.workspaces.unshift(newWs);
  data.activeWorkspaceId = id;
  saveWorkspaces(data);

  if (process.platform === "darwin") {
    try {
      spawnSync("agy", ["-r", resolved], { timeout: 3000 });
    } catch (_) {}
  }

  return newWs;
}
