/**
 * File system indexer — crawls user directories and builds a searchable index
 * of every file on the machine.
 *
 * Index is stored at: C:\Users\apand270\.adal-agent\file-index.jsonl
 * Each line is a JSON object with: path, name, ext, sizeBytes, created, modified, accessed
 *
 * Run `npm run index` to rebuild. The MCP tool reads directly from the index file.
 */

import fs from "fs";
import path from "path";
import os from "os";

const USER_HOME = "C:/Users/apand270";
const INDEX_DIR = path.join(USER_HOME, ".adal-agent");
const INDEX_FILE = path.join(INDEX_DIR, "file-index.jsonl");

// Directories to crawl (relative to user home)
const CRAWL_ROOTS = [
  USER_HOME + "/Desktop",
  USER_HOME + "/Documents",
  USER_HOME + "/Downloads",
  USER_HOME + "/OneDrive - Marriott International",
];

// Extensions / dirs to skip
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".vscode-server", "AppData/Local/Temp"]);
const SKIP_EXTS = new Set([".exe", ".dll", ".sys", ".pdb", ".obj", ".lnk", ".ico"]);

export interface FileEntry {
  path: string;
  name: string;
  ext: string;
  sizeBytes: number;
  created: string;   // ISO
  modified: string;  // ISO
}

function shouldSkipDir(dirPath: string): boolean {
  const parts = dirPath.replace(/\\/g, "/").split("/");
  return parts.some(p => SKIP_DIRS.has(p));
}

function* walkDir(dir: string): Generator<FileEntry> {
  if (shouldSkipDir(dir)) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const ent of entries) {
    const full = path.join(dir, ent.name).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      yield* walkDir(full);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(full);
        yield {
          path: full,
          name: ent.name,
          ext,
          sizeBytes: stat.size,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
        };
      } catch { /* skip */ }
    }
  }
}

/** Rebuild the full file index. Writes to INDEX_FILE. */
export function buildIndex(): void {
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
  const out = fs.createWriteStream(INDEX_FILE, { encoding: "utf8" });
  let count = 0;
  for (const root of CRAWL_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of walkDir(root)) {
      out.write(JSON.stringify(entry) + "\n");
      count++;
    }
  }
  out.end();
  console.log(`[indexer] Indexed ${count} files → ${INDEX_FILE}`);
}

/** Search the index for files matching name/extension/keyword */
export function searchIndex(opts: {
  name?: string;       // substring match on filename
  ext?: string;        // e.g. ".txt", ".log", ".pdf"
  path?: string;       // substring match on full path
  modifiedAfter?: string; // ISO date
  limit?: number;
}): FileEntry[] {
  if (!fs.existsSync(INDEX_FILE)) return [];

  const results: FileEntry[] = [];
  const lines = fs.readFileSync(INDEX_FILE, "utf8").split("\n").filter(Boolean);
  const lim = opts.limit ?? 100;

  for (const line of lines) {
    try {
      const e: FileEntry = JSON.parse(line);
      if (opts.ext && e.ext !== opts.ext.toLowerCase()) continue;
      if (opts.name && !e.name.toLowerCase().includes(opts.name.toLowerCase())) continue;
      if (opts.path && !e.path.toLowerCase().includes(opts.path.toLowerCase())) continue;
      if (opts.modifiedAfter && e.modified < opts.modifiedAfter) continue;
      results.push(e);
      if (results.length >= lim) break;
    } catch { /* skip */ }
  }
  return results;
}

/** Get index stats */
export function getIndexStats(): { totalFiles: number; lastBuilt: string | null } {
  if (!fs.existsSync(INDEX_FILE)) return { totalFiles: 0, lastBuilt: null };
  const stat = fs.statSync(INDEX_FILE);
  const lines = fs.readFileSync(INDEX_FILE, "utf8").split("\n").filter(Boolean).length;
  return { totalFiles: lines, lastBuilt: stat.mtime.toISOString() };
}
