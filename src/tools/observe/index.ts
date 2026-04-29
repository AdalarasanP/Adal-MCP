import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listSessions, readSession, searchSessions, listPuttySessions,
} from "../../capture/sessions.js";
import { parseHostMap, getHostsByGroup, resolveHost } from "../../capture/hostmap.js";
import { searchIndex, getIndexStats, buildIndex } from "../../capture/indexer.js";
import fs from "fs";
import path from "path";

const LOG_DIR = "C:/Users/apand270/.adal-agent";

// ── Activity log helpers ────────────────────────────────────────────────────

interface ActivityEvent { ts: string; type: string; app?: string; title?: string; value?: string; path?: string; pid?: number; durationMs?: number; detail?: string; }

function readActivityLog(date: string): ActivityEvent[] {
  const file = path.join(LOG_DIR, `activity-${date}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as ActivityEvent[];
}

function todayStr(): string { return new Date().toISOString().slice(0, 10); }

// ─────────────────────────────────────────────────────────────────────────────

export function registerObserveTools(server: McpServer) {

  // ── Session tools ──────────────────────────────────────────────────────────

  server.tool(
    "list_ssh_sessions",
    "List recent SSH/PuTTY session logs. Filter by IP, hostname, or date range. Returns metadata: host, date, file size.",
    {
      ip: z.string().optional().describe("Filter by exact IP address"),
      hostname: z.string().optional().describe("Filter by hostname substring (e.g. 'NYC94', 'checkpoint')"),
      dateFrom: z.string().optional().describe("Start date YYYY-MM-DD"),
      dateTo: z.string().optional().describe("End date YYYY-MM-DD"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async (opts) => {
      const sessions = listSessions(opts);
      if (sessions.length === 0) return { content: [{ type: "text", text: "No sessions found matching criteria." }] };
      const rows = sessions.map(s =>
        `${s.date} ${s.time}  ${s.hostname.padEnd(30)} ${s.ip.padEnd(18)} ${s.group}  (${(s.sizeBytes / 1024).toFixed(1)}KB)`
      ).join("\n");
      return { content: [{ type: "text", text: `Found ${sessions.length} sessions:\n\n${rows}` }] };
    }
  );

  server.tool(
    "read_ssh_session",
    "Read the full content and extract commands from a specific PuTTY session log file.",
    {
      filename: z.string().describe("Log filename e.g. 10.14.20.67-20260202-124542.txt"),
    },
    async ({ filename }) => {
      const detail = readSession(filename);
      if (!detail) return { content: [{ type: "text", text: `Session file not found: ${filename}` }] };
      const result = {
        host: detail.hostname,
        ip: detail.ip,
        group: detail.group,
        date: detail.date,
        time: detail.time,
        totalCommands: detail.commands.length,
        commands: detail.commands,
        rawSnippet: detail.rawSnippet,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_ssh_sessions",
    "Search all PuTTY session logs for a keyword (command, output text, hostname). Returns matching sessions with the matched commands highlighted.",
    {
      keyword: z.string().describe("Text to search for in commands or session output"),
      ip: z.string().optional().describe("Limit to specific IP"),
      hostname: z.string().optional().describe("Limit to hostname substring"),
      dateFrom: z.string().optional().describe("YYYY-MM-DD"),
      dateTo: z.string().optional().describe("YYYY-MM-DD"),
      limit: z.number().optional().default(10).describe("Max sessions to return"),
    },
    async (opts) => {
      const matches = searchSessions(opts);
      if (matches.length === 0) return { content: [{ type: "text", text: `No sessions found containing "${opts.keyword}".` }] };
      const out = matches.map(m =>
        `📄 ${m.file}  [${m.hostname} | ${m.group}]\n` +
        `   Matched commands (${m.matchedCommands.length}):\n` +
        m.matchedCommands.slice(0, 10).map(c => `     > ${c}`).join("\n")
      ).join("\n\n");
      return { content: [{ type: "text", text: `Found keyword in ${matches.length} sessions:\n\n${out}` }] };
    }
  );

  server.tool(
    "list_known_hosts",
    "List all hosts defined in MTPuTTY (mtputty.xml) with their hostnames, IPs, and group/folder. Optionally filter by group.",
    {
      group: z.string().optional().describe("Filter by group/folder name (e.g. 'CheckPoint', 'ISE', 'Corporate')"),
    },
    async ({ group }) => {
      let entries = group ? getHostsByGroup(group) : Array.from(parseHostMap().values());
      if (entries.length === 0) return { content: [{ type: "text", text: "No hosts found." }] };
      const rows = entries.map(e =>
        `${e.hostname.padEnd(35)} ${e.ip.padEnd(20)} ${e.group}`
      ).join("\n");
      return { content: [{ type: "text", text: `${entries.length} hosts:\n\nHostname                            IP                   Group\n${"─".repeat(80)}\n${rows}` }] };
    }
  );

  server.tool(
    "list_putty_session_configs",
    "List all PuTTY .ini session configs organized by group (AWS, Corporate, Cisco ISE, etc.).",
    {
      group: z.string().optional().describe("Filter by group folder name"),
    },
    async ({ group }) => {
      let sessions = listPuttySessions();
      if (group) sessions = sessions.filter(s => s.group.toLowerCase().includes(group.toLowerCase()));
      if (sessions.length === 0) return { content: [{ type: "text", text: "No session configs found." }] };
      const rows = sessions.map(s =>
        `${s.group.padEnd(20)} ${s.name.padEnd(40)} ${s.hostname.padEnd(30)} user:${s.username}`
      ).join("\n");
      return { content: [{ type: "text", text: `${sessions.length} session configs:\n\n${rows}` }] };
    }
  );

  // ── File index tools ───────────────────────────────────────────────────────

  server.tool(
    "search_machine_files",
    "Search all indexed files on this machine by filename, extension, or path keyword. Run rebuild_file_index first if the index is stale.",
    {
      name: z.string().optional().describe("Filename substring (e.g. 'firewall-config', 'PI2')"),
      ext: z.string().optional().describe("File extension e.g. '.txt', '.xlsx', '.pdf'"),
      path: z.string().optional().describe("Path substring (e.g. 'MARRIOTT', 'Downloads')"),
      modifiedAfter: z.string().optional().describe("ISO date — only files modified after this"),
      limit: z.number().optional().default(50).describe("Max results"),
    },
    async (opts) => {
      const stats = getIndexStats();
      if (stats.totalFiles === 0) return { content: [{ type: "text", text: "File index is empty. Ask me to run rebuild_file_index first." }] };
      const results = searchIndex(opts);
      if (results.length === 0) return { content: [{ type: "text", text: "No files matched your search." }] };
      const rows = results.map(f =>
        `${f.modified.slice(0, 10)}  ${f.ext.padEnd(8)} ${(f.sizeBytes / 1024).toFixed(1).padStart(8)}KB  ${f.path}`
      ).join("\n");
      return { content: [{ type: "text", text: `${results.length} files found (index has ${stats.totalFiles} total, built ${stats.lastBuilt?.slice(0,10)}):\n\n${rows}` }] };
    }
  );

  server.tool(
    "rebuild_file_index",
    "Crawl all user directories on this machine and rebuild the file index. Takes 1-3 minutes for large drives.",
    {},
    async () => {
      buildIndex();
      const stats = getIndexStats();
      return { content: [{ type: "text", text: `File index rebuilt. ${stats.totalFiles} files indexed.` }] };
    }
  );

  server.tool(
    "get_file_index_stats",
    "Get stats about the file index: total files indexed and when it was last built.",
    {},
    async () => {
      const stats = getIndexStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
  );

  // ── Activity log tools ─────────────────────────────────────────────────────

  server.tool(
    "read_activity_log",
    "Read the activity log for a given date showing which apps were used, windows focused, clipboard events, and files touched.",
    {
      date: z.string().optional().describe("Date YYYY-MM-DD (defaults to today)"),
      type: z.string().optional().describe("Filter by event type: window_focus, clipboard, file_change, process_start"),
      app: z.string().optional().describe("Filter by app name substring (e.g. 'putty', 'chrome', 'Code')"),
      limit: z.number().optional().default(100),
    },
    async ({ date, type, app, limit }) => {
      const d = date ?? todayStr();
      const events = readActivityLog(d);
      if (events.length === 0) return { content: [{ type: "text", text: `No activity log found for ${d}. Is the daemon running? Start it with: npm run capture` }] };

      let filtered = events;
      if (type) filtered = filtered.filter(e => e.type.includes(type));
      if (app) filtered = filtered.filter(e => e.app?.toLowerCase().includes(app.toLowerCase()) || e.title?.toLowerCase().includes(app.toLowerCase()));
      filtered = filtered.slice(0, limit ?? 100);

      const rows = filtered.map(e => {
        const base = `${e.ts.slice(11,19)}  ${e.type.padEnd(20)}  ${e.app ?? ""}`;
        if (e.title) return base + `  "${e.title}"`;
        if (e.value) return base + `  clipboard: "${e.value.slice(0, 80)}"`;
        if (e.path) return base + `  ${e.path}`;
        return base;
      }).join("\n");

      return { content: [{ type: "text", text: `Activity log for ${d} (${filtered.length} events):\n\n${rows}` }] };
    }
  );

  server.tool(
    "get_recent_context",
    "What was I doing in the last N minutes? Returns focused apps, active windows, and clipboard activity.",
    {
      minutes: z.number().optional().default(30).describe("How many minutes back to look (default 30)"),
    },
    async ({ minutes }) => {
      const since = new Date(Date.now() - (minutes ?? 30) * 60 * 1000);
      const events = readActivityLog(todayStr()).filter(e => new Date(e.ts) >= since);

      if (events.length === 0) return { content: [{ type: "text", text: `No activity recorded in the last ${minutes} minutes. Is the daemon running?` }] };

      // Summarize: app focus durations
      const appTime: Record<string, number> = {};
      for (const e of events) {
        if (e.type === "window_focus_end" && e.app && e.durationMs) {
          appTime[e.app] = (appTime[e.app] ?? 0) + e.durationMs;
        }
      }
      const appSummary = Object.entries(appTime).sort((a, b) => b[1] - a[1]).map(([app, ms]) => `  ${app}: ${Math.round(ms / 1000)}s`).join("\n");

      // Recent windows
      const recentWindows = events.filter(e => e.type === "window_focus").slice(-10).map(e => `  ${e.ts.slice(11, 19)}  ${e.app}  "${e.title}"`).join("\n");

      // Clipboard
      const clips = events.filter(e => e.type === "clipboard").slice(-5).map(e => `  ${e.ts.slice(11, 19)}  "${e.value?.slice(0, 100)}"`).join("\n");

      const out = [
        `Last ${minutes} minutes of activity:`,
        "",
        "App Focus Time:",
        appSummary || "  (none recorded)",
        "",
        "Recent Windows:",
        recentWindows || "  (none)",
        "",
        "Recent Clipboard:",
        clips || "  (none)",
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );
}
