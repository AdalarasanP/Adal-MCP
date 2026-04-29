/**
 * Org structure via Outlook COM + Exchange Global Address List.
 * No Graph API or OAuth needed — reads from the running Outlook session.
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import fs from "fs";
import path from "path";

const ORG_CACHE_FILE = "C:/Users/apand270/.adal-agent/org-cache.json";
const ORG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UserProfile {
  id: string;          // empty string for COM-sourced entries (no Azure AD ID needed)
  displayName: string;
  mail: string;
  jobTitle: string;
  department: string;
}

export interface OrgContext {
  me: UserProfile;
  manager: UserProfile | null;
  managerManager: UserProfile | null;
  peers: UserProfile[];
  directReports: UserProfile[];
  priorityEmails: Set<string>;
}

// ── PowerShell runner (shared with outlook.ts) ────────────────────────────

function runPS(script: string): Promise<string> {
  const tmpFile = path.join(tmpdir(), `mcp-org-${Date.now()}.ps1`);
  writeFileSync(tmpFile, script, "utf8");
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile]);
    let out = "", err = "";
    ps.stdout.on("data", d => out += d.toString());
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", code => {
      try { unlinkSync(tmpFile); } catch {}
      if (code !== 0) reject(new Error(err.trim() || `PowerShell exited ${code}`));
      else resolve(out.trim());
    });
  });
}

const ORG_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    $ol = New-Object -ComObject Outlook.Application
    $ns = $ol.GetNamespace("MAPI")
    $me = $ns.CurrentUser.AddressEntry.GetExchangeUser()
    if ($null -eq $me) { Write-Error "Could not get Exchange user"; exit 1 }

    function User-ToObj($eu) {
        if ($null -eq $eu) { return $null }
        [PSCustomObject]@{
            displayName = if ($eu.Name)                 { $eu.Name }                 else { "" }
            mail        = if ($eu.PrimarySmtpAddress)   { $eu.PrimarySmtpAddress.ToLower() } else { "" }
            jobTitle    = if ($eu.JobTitle)             { $eu.JobTitle }             else { "" }
            department  = if ($eu.Department)           { $eu.Department }           else { "" }
        }
    }

    $mgr = $null
    try { $mgr = $me.GetExchangeUserManager() } catch {}
    $mgrMgr = $null
    if ($null -ne $mgr) { try { $mgrMgr = $mgr.GetExchangeUserManager() } catch {} }

    $peers = @()
    if ($null -ne $mgr) {
        try {
            foreach ($r in @($mgr.GetDirectReports())) {
                $dr = $r.GetExchangeUser()
                if ($null -ne $dr -and $dr.PrimarySmtpAddress -ne $me.PrimarySmtpAddress) {
                    $peers += User-ToObj $dr
                }
            }
        } catch {}
    }

    $dirReports = @()
    try {
        foreach ($r in @($me.GetDirectReports())) {
            $dr = $r.GetExchangeUser()
            if ($null -ne $dr) { $dirReports += User-ToObj $dr }
        }
    } catch {}

    $result = [PSCustomObject]@{
        me            = User-ToObj $me
        manager       = User-ToObj $mgr
        managerManager = User-ToObj $mgrMgr
        peers         = if ($peers.Count -gt 0) { [array]$peers } else { @() }
        directReports = if ($dirReports.Count -gt 0) { [array]$dirReports } else { @() }
    }
    $result | ConvertTo-Json -Depth 4 -Compress
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`;

function toProfile(raw: any): UserProfile | null {
  if (!raw) return null;
  return { id: "", displayName: raw.displayName ?? "", mail: (raw.mail ?? "").toLowerCase(), jobTitle: raw.jobTitle ?? "", department: raw.department ?? "" };
}

/** Fetch org context from Outlook Exchange GAL — cached for 1 day */
export async function getOrgContext(): Promise<OrgContext> {
  // Serve from cache
  if (fs.existsSync(ORG_CACHE_FILE)) {
    const stat = fs.statSync(ORG_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < ORG_CACHE_TTL_MS) {
      const cached = JSON.parse(fs.readFileSync(ORG_CACHE_FILE, "utf8"));
      cached.priorityEmails = new Set<string>(cached.priorityEmailsList ?? []);
      return cached as OrgContext;
    }
  }

  const raw = JSON.parse(await runPS(ORG_SCRIPT));
  const me = toProfile(raw.me)!;
  const manager = toProfile(raw.manager);
  const managerManager = toProfile(raw.managerManager);
  const peers: UserProfile[] = Array.isArray(raw.peers) ? raw.peers.map(toProfile).filter(Boolean) as UserProfile[] : [];
  const directReports: UserProfile[] = Array.isArray(raw.directReports) ? raw.directReports.map(toProfile).filter(Boolean) as UserProfile[] : [];

  const priorityEmails = new Set<string>();
  if (manager?.mail) priorityEmails.add(manager.mail);
  if (managerManager?.mail) priorityEmails.add(managerManager.mail);

  const ctx: OrgContext = { me, manager, managerManager, peers, directReports, priorityEmails };

  const dir = path.dirname(ORG_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ORG_CACHE_FILE, JSON.stringify({ ...ctx, priorityEmailsList: Array.from(priorityEmails) }), "utf8");

  return ctx;
}

