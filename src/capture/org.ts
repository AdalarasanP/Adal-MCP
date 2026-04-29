/**
 * Microsoft Graph org structure — fetches user profile, manager chain, and team.
 * Used to determine email priority (messages from manager = high priority).
 */

import { graphFetch } from "./graph-auth.js";
import fs from "fs";
import path from "path";

const ORG_CACHE_FILE = "C:/Users/apand270/.adal-agent/org-cache.json";
const ORG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface UserProfile {
  id: string;
  displayName: string;
  mail: string;
  jobTitle: string;
  department: string;
}

export interface OrgContext {
  me: UserProfile;
  manager: UserProfile | null;
  managerManager: UserProfile | null;   // skip-level
  peers: UserProfile[];                  // teammates (manager's direct reports excl. me)
  directReports: UserProfile[];          // my direct reports (if any)
  priorityEmails: Set<string>;           // email addresses that get high priority
}

async function fetchUser(id: string): Promise<UserProfile | null> {
  try {
    const u = await graphFetch(`/users/${id}?$select=id,displayName,mail,jobTitle,department`);
    return { id: u.id, displayName: u.displayName, mail: u.mail?.toLowerCase() ?? "", jobTitle: u.jobTitle ?? "", department: u.department ?? "" };
  } catch { return null; }
}

async function fetchDirectReports(userId: string): Promise<UserProfile[]> {
  try {
    const res = await graphFetch(`/users/${userId}/directReports?$select=id,displayName,mail,jobTitle,department`);
    return (res.value ?? []).map((u: any) => ({
      id: u.id, displayName: u.displayName, mail: u.mail?.toLowerCase() ?? "",
      jobTitle: u.jobTitle ?? "", department: u.department ?? "",
    }));
  } catch { return []; }
}

/** Fetch full org context — cached for 1 day */
export async function getOrgContext(): Promise<OrgContext> {
  // Check cache
  if (fs.existsSync(ORG_CACHE_FILE)) {
    const stat = fs.statSync(ORG_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < ORG_CACHE_TTL_MS) {
      const cached = JSON.parse(fs.readFileSync(ORG_CACHE_FILE, "utf8"));
      cached.priorityEmails = new Set(cached.priorityEmailsList);
      return cached as OrgContext;
    }
  }

  // Fetch me
  const meRaw = await graphFetch("/me?$select=id,displayName,mail,jobTitle,department");
  const me: UserProfile = {
    id: meRaw.id, displayName: meRaw.displayName,
    mail: meRaw.mail?.toLowerCase() ?? "", jobTitle: meRaw.jobTitle ?? "",
    department: meRaw.department ?? "",
  };

  // Fetch manager
  let manager: UserProfile | null = null;
  let managerManager: UserProfile | null = null;
  let peers: UserProfile[] = [];
  try {
    const mgr = await graphFetch("/me/manager?$select=id,displayName,mail,jobTitle,department");
    manager = { id: mgr.id, displayName: mgr.displayName, mail: mgr.mail?.toLowerCase() ?? "", jobTitle: mgr.jobTitle ?? "", department: mgr.department ?? "" };

    // Fetch skip-level
    try {
      const mmRaw = await graphFetch(`/users/${manager.id}/manager?$select=id,displayName,mail,jobTitle,department`);
      managerManager = { id: mmRaw.id, displayName: mmRaw.displayName, mail: mmRaw.mail?.toLowerCase() ?? "", jobTitle: mmRaw.jobTitle ?? "", department: mmRaw.department ?? "" };
    } catch { /* no skip-level */ }

    // Fetch peers (manager's direct reports)
    const allReports = await fetchDirectReports(manager.id);
    peers = allReports.filter(u => u.id !== me.id);
  } catch { /* no manager found */ }

  // Fetch my direct reports
  const directReports = await fetchDirectReports(me.id);

  // Build priority email set
  const priorityEmails = new Set<string>();
  if (manager?.mail) priorityEmails.add(manager.mail);
  if (managerManager?.mail) priorityEmails.add(managerManager.mail);
  // Peers are medium priority — not in high set

  const ctx: OrgContext = { me, manager, managerManager, peers, directReports, priorityEmails };

  // Cache it
  const dir = path.dirname(ORG_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ORG_CACHE_FILE, JSON.stringify({ ...ctx, priorityEmailsList: Array.from(priorityEmails) }), "utf8");

  return ctx;
}
