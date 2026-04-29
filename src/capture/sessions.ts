/**
 * PuTTY / MTPuTTY session log parser.
 *
 * Log files are named: {IP}-{YYYYMMDD}-{HHMMSS}.txt
 * Each file starts with: =~=~=~ PuTTY log {YYYY.MM.DD HH:MM:SS} =~=~=~
 * Remainder is raw terminal output including commands typed at prompts.
 */

import fs from "fs";
import path from "path";
import { parseHostMap, type HostEntry } from "./hostmap.js";

export interface SessionMeta {
  file: string;       // basename
  ip: string;
  hostname: string;   // from hostmap or ip if unknown
  group: string;      // folder group from mtputty tree
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM:SS
  timestamp: Date;
  sizeBytes: number;
}

export interface SessionDetail extends SessionMeta {
  commands: string[];         // lines that appear to be commands at a prompt
  rawSnippet: string;         // first 3000 chars of content
}

const SESSION_LOG_DIR = "C:/Users/apand270/OneDrive - Marriott International/M A R R I O T T/S E S S I O N/Putty";
const PUTTY_SESSIONS_DIR = "C:/Users/apand270/OneDrive - Marriott International/M A R R I O T T/S E S S I O N/putty_sessions";

// Prompt pattern: ends with # (IOS/Nexus enable), > (IOS user/exec mode), $ (Linux), % (csh)
const PROMPT_RE = /^[\w\-.]+[#>$%]\s*(.+)$/;

let _hostMap: Map<string, HostEntry> | null = null;
function getHostMap(): Map<string, HostEntry> {
  if (!_hostMap) _hostMap = parseHostMap();
  return _hostMap;
}

/** Parse filename into metadata */
export function parseFilename(filename: string): { ip: string; date: string; time: string; timestamp: Date } | null {
  // Pattern: {IP}-{YYYYMMDD}-{HHMMSS}.txt
  const m = filename.match(/^([\d.]+)-(\d{8})-(\d{6})\.txt$/);
  if (!m) return null;
  const ip = m[1];
  const d = m[2]; // YYYYMMDD
  const t = m[3]; // HHMMSS
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const time = `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  const timestamp = new Date(`${date}T${time}`);
  return { ip, date, time, timestamp };
}

/** List all session log files, sorted newest first */
export function listSessions(opts: {
  ip?: string;
  hostname?: string;
  dateFrom?: string;   // YYYY-MM-DD
  dateTo?: string;
  limit?: number;
} = {}): SessionMeta[] {
  const hostMap = getHostMap();
  const files = fs.readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith(".txt"));

  const results: SessionMeta[] = [];
  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) continue;

    const entry = hostMap.get(parsed.ip);
    const hostname = entry?.hostname ?? parsed.ip;
    const group = entry?.group ?? "Unknown";

    if (opts.ip && parsed.ip !== opts.ip) continue;
    if (opts.hostname && !hostname.toLowerCase().includes(opts.hostname.toLowerCase())) continue;
    if (opts.dateFrom && parsed.date < opts.dateFrom) continue;
    if (opts.dateTo && parsed.date > opts.dateTo) continue;

    const stat = fs.statSync(path.join(SESSION_LOG_DIR, file));
    results.push({ file, ip: parsed.ip, hostname, group, date: parsed.date, time: parsed.time, timestamp: parsed.timestamp, sizeBytes: stat.size });
  }

  // Sort newest first
  results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return opts.limit ? results.slice(0, opts.limit) : results;
}

/** Extract commands from a session log file */
export function extractCommands(content: string): string[] {
  const lines = content.split("\n");
  const commands: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(PROMPT_RE);
    if (m && m[1].trim().length > 0) {
      commands.push(m[1].trim());
    }
  }
  return commands;
}

/** Read and parse a session log in detail */
export function readSession(filename: string): SessionDetail | null {
  const parsed = parseFilename(filename);
  if (!parsed) return null;

  const filePath = path.join(SESSION_LOG_DIR, filename);
  if (!fs.existsSync(filePath)) return null;

  const hostMap = getHostMap();
  const entry = hostMap.get(parsed.ip);
  const hostname = entry?.hostname ?? parsed.ip;
  const group = entry?.group ?? "Unknown";
  const stat = fs.statSync(filePath);

  const raw = fs.readFileSync(filePath, "latin1"); // PuTTY logs may have non-UTF chars
  const commands = extractCommands(raw);
  const rawSnippet = raw.slice(0, 3000);

  return {
    file: filename,
    ip: parsed.ip,
    hostname,
    group,
    date: parsed.date,
    time: parsed.time,
    timestamp: parsed.timestamp,
    sizeBytes: stat.size,
    commands,
    rawSnippet,
  };
}

/** Search session logs for a keyword in commands or content */
export function searchSessions(opts: {
  keyword: string;
  ip?: string;
  hostname?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}): Array<SessionDetail & { matchedCommands: string[] }> {
  const sessions = listSessions({ ip: opts.ip, hostname: opts.hostname, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
  const kw = opts.keyword.toLowerCase();
  const results: Array<SessionDetail & { matchedCommands: string[] }> = [];

  for (const s of sessions) {
    const detail = readSession(s.file);
    if (!detail) continue;
    const matchedCommands = detail.commands.filter(c => c.toLowerCase().includes(kw));
    if (matchedCommands.length > 0 || detail.rawSnippet.toLowerCase().includes(kw)) {
      results.push({ ...detail, matchedCommands });
    }
    if (opts.limit && results.length >= opts.limit) break;
  }
  return results;
}

/** Read all PuTTY .ini session configs from putty_sessions/ subdirectories */
export interface PuttySessionConfig {
  group: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
}

export function listPuttySessions(): PuttySessionConfig[] {
  const results: PuttySessionConfig[] = [];
  if (!fs.existsSync(PUTTY_SESSIONS_DIR)) return results;

  const groups = fs.readdirSync(PUTTY_SESSIONS_DIR);
  for (const group of groups) {
    const groupDir = path.join(PUTTY_SESSIONS_DIR, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    const files = fs.readdirSync(groupDir).filter(f => f.endsWith(".ini"));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(groupDir, file), "utf8");
        const get = (key: string) => {
          const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
          return m ? m[1].trim() : "";
        };
        results.push({
          group,
          name: file.replace(/\.ini$/, ""),
          hostname: get("Hostname"),
          port: parseInt(get("Port") || "22", 10),
          username: get("Username"),
        });
      } catch { /* skip unreadable */ }
    }
  }
  return results;
}
