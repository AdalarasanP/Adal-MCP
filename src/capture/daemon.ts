/**
 * Activity daemon — polls Windows for active window, process launches, clipboard,
 * and file system events, and writes structured JSONL activity log.
 *
 * Log: C:\Users\apand270\.adal-agent\activity-{YYYY-MM-DD}.jsonl
 *
 * Run: node dist/capture/daemon.js
 * Add to Windows Task Scheduler to run at login.
 *
 * Each event line:
 * { ts, type, app, title, pid, clipboard?, path?, detail }
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync, exec } from "child_process";

const USER_HOME = "C:/Users/apand270";
const LOG_DIR = path.join(USER_HOME, ".adal-agent");
const POLL_MS = 3000;          // active window poll interval
const CLIPBOARD_MS = 2000;     // clipboard poll interval
const MAX_CLIP_LEN = 500;      // max chars to store from clipboard

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function todayLog(): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `activity-${d}.jsonl`);
}

function appendEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  fs.appendFileSync(todayLog(), line, "utf8");
}

// ── Active Window Tracking ──────────────────────────────────────────────────

// Uses PowerShell to get the process with the topmost main window
const PS_ACTIVE_WIN = `$p = Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne ''} | Sort-Object StartTime -Descending | Select-Object -First 1; if ($p) { Write-Output ($p.Name + '|' + $p.MainWindowTitle) }`;

let lastWindow = "";
let lastWindowTime = 0;

function pollActiveWindow() {
  try {
    const result = execSync(`powershell -NoProfile -Command "${PS_ACTIVE_WIN}"`, { timeout: 3000 }).toString().trim();
    const [procName, ...titleParts] = result.split("|");
    const title = titleParts.join("|").trim();
    const key = `${procName}|${title}`;
    if (key !== lastWindow) {
      const now = Date.now();
      if (lastWindow && lastWindowTime) {
        const durationMs = now - lastWindowTime;
        appendEvent({ type: "window_focus_end", app: lastWindow.split("|")[0], title: lastWindow.split("|").slice(1).join("|"), durationMs });
      }
      appendEvent({ type: "window_focus", app: procName, title });
      lastWindow = key;
      lastWindowTime = now;
    }
  } catch { /* ignore transient errors */ }
}

// ── Clipboard Tracking ─────────────────────────────────────────────────────

let lastClip = "";

function pollClipboard() {
  try {
    const clip = execSync(`powershell -NoProfile -Command "Get-Clipboard"`, { timeout: 1500 }).toString().trim();
    if (clip && clip !== lastClip) {
      const truncated = clip.slice(0, MAX_CLIP_LEN);
      appendEvent({ type: "clipboard", value: truncated, truncated: clip.length > MAX_CLIP_LEN });
      lastClip = clip;
    }
  } catch { /* ignore */ }
}

// ── Process Launch Tracking ────────────────────────────────────────────────

// Poll Win32_Process for newly started processes (simpler than WMI events)
let knownPids = new Set<number>();

function pollProcesses() {
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty Id"`, { timeout: 2000 }).toString();
    const pids = new Set(out.split("\n").map(l => parseInt(l.trim(), 10)).filter(n => !isNaN(n)));
    for (const pid of pids) {
      if (!knownPids.has(pid)) {
        // New process — get its name
        try {
          const name = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Name"`, { timeout: 1000 }).toString().trim();
          if (name) appendEvent({ type: "process_start", pid, app: name });
        } catch { /* ignore */ }
      }
    }
    // Remove dead pids
    for (const pid of knownPids) {
      if (!pids.has(pid)) knownPids.delete(pid);
    }
    knownPids = pids;
  } catch { /* ignore */ }
}

// ── File System Watcher ────────────────────────────────────────────────────

const WATCH_DIRS = [
  path.join(USER_HOME, "Desktop"),
  path.join(USER_HOME, "Documents"),
  path.join(USER_HOME, "Downloads"),
];

for (const dir of WATCH_DIRS) {
  if (!fs.existsSync(dir)) continue;
  try {
    fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      // Skip temp/swap files
      if (ext === ".tmp" || filename.startsWith("~$")) return;
      appendEvent({ type: "file_" + eventType, path: path.join(dir, filename) });
    });
  } catch { /* ignore dirs we can't watch */ }
}

// ── Startup event ──────────────────────────────────────────────────────────

appendEvent({ type: "daemon_start", user: os.userInfo().username, hostname: os.hostname() });
console.log(`[daemon] Started. Logging to ${LOG_DIR}`);

// ── Poll loops ─────────────────────────────────────────────────────────────

setInterval(pollActiveWindow, POLL_MS);
setInterval(pollClipboard, CLIPBOARD_MS);
setInterval(pollProcesses, 10000);   // process poll every 10s (expensive)

// Graceful shutdown
process.on("SIGINT", () => {
  appendEvent({ type: "daemon_stop" });
  process.exit(0);
});
process.on("SIGTERM", () => {
  appendEvent({ type: "daemon_stop" });
  process.exit(0);
});
