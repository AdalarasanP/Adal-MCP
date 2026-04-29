/**
 * Parses mtputty.xml to build an IP/hostname → display name + group mapping.
 * The XML tree structure is: Servers > Putty > Node(folder) > Node(folder) > ... > Node(Type=1, leaf=server)
 * Type=0 = folder, Type=1 = server leaf.
 * ServerName may be an IP or a hostname; DisplayName is the human label.
 */

import fs from "fs";

const MTPUTTY_XML = "C:/Users/apand270/OneDrive - Marriott International/M A R R I O T T/S E S S I O N/mtputty.xml";

export interface HostEntry {
  ip: string;            // value from ServerName (may be IP or hostname)
  hostname: string;      // DisplayName from mtputty
  group: string;         // slash-joined folder path e.g. "MCNC/CheckPoint/MDS"
  username: string;
}

/** Walk the nested Node tree and collect all Type=1 leaf entries */
function walk(nodes: any[], groupPath: string[], out: HostEntry[]) {
  if (!nodes) return;
  for (const node of nodes) {
    const type = node.$.Type;
    if (type === "0") {
      // folder
      const name = (node.DisplayName?.[0] ?? "").trim();
      walk(node.Node ?? [], [...groupPath, name], out);
    } else if (type === "1") {
      const hostname = (node.DisplayName?.[0] ?? "").trim();
      const serverName = (node.ServerName?.[0] ?? "").trim();
      const username = (node.UserName?.[0] ?? "").trim();
      if (serverName) {
        out.push({
          ip: serverName,
          hostname: hostname || serverName,
          group: groupPath.join("/"),
          username,
        });
      }
    }
  }
}

let _cache: Map<string, HostEntry> | null = null;

/** Returns a map keyed by ServerName (IP or hostname) */
export function parseHostMap(): Map<string, HostEntry> {
  if (_cache) return _cache;

  const map = new Map<string, HostEntry>();

  if (!fs.existsSync(MTPUTTY_XML)) return map;

  // Synchronous XML parse using xml2js's parseStringPromise isn't sync, so use
  // the sync DOMParser approach with a regex fallback.
  // We'll do a simple regex parse since xml2js is async.
  const content = fs.readFileSync(MTPUTTY_XML, "utf8");

  // Extract all server nodes between <Node Type="1"> ... </Node>
  // using a regex that captures the relevant fields
  const serverBlockRe = /<Node Type="1">([\s\S]*?)<\/Node>/g;
  const fieldRe = (tag: string) => new RegExp(`<${tag}>(.*?)<\/${tag}>`);

  let m: RegExpExecArray | null;
  // Also track folder context using a simpler stack approach
  // Since XML is nested and regex can't properly track depth, we use a line-by-line approach.

  const lines = content.split("\n");
  const groupStack: string[] = [];
  let inServer = false;
  let serverBuf = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('<Node Type="0"')) {
      // Peek at DisplayName on next lines — we read it when we hit DisplayName
      groupStack.push("?");
    } else if (line === "</Node>") {
      if (inServer) {
        // End of a server node — parse buffer
        const get = (tag: string) => {
          const mx = serverBuf.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
          return mx ? mx[1].trim() : "";
        };
        const serverName = get("ServerName");
        const displayName = get("DisplayName");
        const username = get("UserName");
        if (serverName) {
          const entry: HostEntry = {
            ip: serverName,
            hostname: displayName || serverName,
            group: groupStack.filter(g => g !== "?").join("/"),
            username,
          };
          map.set(serverName, entry);
        }
        inServer = false;
        serverBuf = "";
      } else {
        // Closing a folder
        if (groupStack.length > 0) groupStack.pop();
      }
    } else if (line.startsWith('<Node Type="1"')) {
      inServer = true;
      serverBuf = "";
    } else if (inServer) {
      serverBuf += line + "\n";
    } else {
      // Check if this is a DisplayName inside a folder node
      const dnMatch = line.match(/^<DisplayName>(.*?)<\/DisplayName>/);
      if (dnMatch && groupStack.length > 0 && groupStack[groupStack.length - 1] === "?") {
        groupStack[groupStack.length - 1] = dnMatch[1].trim();
      }
    }
  }

  _cache = map;
  return map;
}

/** Resolve an IP or hostname to a HostEntry */
export function resolveHost(ipOrHostname: string): HostEntry | undefined {
  const map = parseHostMap();
  // Exact match first
  if (map.has(ipOrHostname)) return map.get(ipOrHostname);
  // Case-insensitive partial match on hostname
  const lc = ipOrHostname.toLowerCase();
  for (const entry of map.values()) {
    if (entry.hostname.toLowerCase().includes(lc) || entry.ip.toLowerCase().includes(lc)) {
      return entry;
    }
  }
  return undefined;
}

/** Return all hosts in a given group (partial match) */
export function getHostsByGroup(groupKeyword: string): HostEntry[] {
  const map = parseHostMap();
  const lc = groupKeyword.toLowerCase();
  return Array.from(map.values()).filter(e => e.group.toLowerCase().includes(lc));
}
