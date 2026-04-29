/**
 * Outlook email triage via PowerShell COM automation.
 * Reads from the already-running Outlook desktop app — no OAuth/Graph API needed.
 * Works on Marriott-managed machines where Conditional Access blocks device code flow.
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getOrgContext } from "./org.js";

export type TriageBucket = "now" | "eod" | "tomorrow" | "this-week" | "fyi";

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  isToMe: boolean;
  bodyPreview: string;
  jiraKeys: string[];
  ritm: string[];
  bucket: TriageBucket;
  reason: string;
  hoursWaiting: number;
}

const URGENT_KEYWORDS = ["action required", "urgent", "please approve", "approval needed", "asap", "critical", "p1", "p0", "sev1", "sev2", "incident", "outage"];
const FYI_KEYWORDS = ["fyi", "no action", "newsletter", "digest", "automated notification"];

// ── PowerShell runner ──────────────────────────────────────────────────────

function runPS(script: string): Promise<string> {
  const tmpFile = join(tmpdir(), `mcp-ps-${Date.now()}.ps1`);
  writeFileSync(tmpFile, script, "utf8");
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile]);
    let out = "", err = "";
    ps.stdout.on("data", d => out += d.toString());
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", code => {
      try { unlinkSync(tmpFile); } catch {}
      if (code !== 0) {
        const msg = err.trim() || `PowerShell exited ${code}`;
        if (msg.includes("null-valued") || msg.includes("Cannot call a method")) {
          reject(new Error("Outlook is not running or not connected to Exchange. Please open Outlook and ensure it is fully loaded, then retry."));
        } else {
          reject(new Error(msg));
        }
      } else {
        resolve(out.trim());
      }
    });
  });
}

// ── Scoring logic (pure TypeScript) ───────────────────────────────────────

function extractRefs(text: string): { jiraKeys: string[]; ritm: string[] } {
  return {
    jiraKeys: [...new Set((text.match(/NTWK-\d+/gi) ?? []).map(k => k.toUpperCase()))],
    ritm: [...new Set((text.match(/RITM\d+/gi) ?? []).map(k => k.toUpperCase()))],
  };
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function scoreEmail(e: any, priorityEmails: Set<string>, peers: string[]): { bucket: TriageBucket; reason: string } {
  const subjectLc = (e.subject ?? "").toLowerCase();
  const fromEmail = (e.fromEmail ?? "").toLowerCase();
  const { isToMe, isFlagged } = e;
  const hours = hoursSince(e.receivedAt);
  const refs = extractRefs((e.subject ?? "") + " " + (e.bodyPreview ?? ""));
  const hasRefs = refs.jiraKeys.length > 0 || refs.ritm.length > 0;

  if (!isToMe) {
    if (FYI_KEYWORDS.some(k => subjectLc.includes(k))) return { bucket: "fyi", reason: "CC only, FYI keyword" };
    if (!isFlagged && !hasRefs) return { bucket: "fyi", reason: "CC only" };
  }
  if (priorityEmails.has(fromEmail) && URGENT_KEYWORDS.some(k => subjectLc.includes(k))) return { bucket: "now", reason: "Manager + urgent keyword" };
  if (isFlagged && hours > 4) return { bucket: "now", reason: "Flagged and waiting >4h" };
  if (URGENT_KEYWORDS.some(k => subjectLc.includes(k)) && isToMe) return { bucket: "now", reason: "Urgent keyword" };
  if (priorityEmails.has(fromEmail) && isToMe) return { bucket: "eod", reason: "From manager/skip-level" };
  if (hours > 48 && isToMe) return { bucket: "now", reason: `Waiting ${Math.round(hours)}h — overdue` };
  if (hours > 24 && isToMe) return { bucket: "eod", reason: `Waiting ${Math.round(hours)}h` };
  if (peers.includes(fromEmail) && hasRefs && isToMe) return { bucket: "eod", reason: "Teammate + Jira/RITM ref" };
  if (isFlagged) return { bucket: "eod", reason: "Flagged" };
  if (hasRefs && isToMe) return { bucket: "tomorrow", reason: "Has Jira/RITM reference" };
  if (isToMe && !e.isRead) return { bucket: "this-week", reason: "Unread, addressed to you" };
  return { bucket: "fyi", reason: "No action signal" };
}

// ── PowerShell COM script ──────────────────────────────────────────────────

const FETCH_EMAILS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    $ol = New-Object -ComObject Outlook.Application
    $ns = $ol.GetNamespace("MAPI")
    $inbox = $ns.GetDefaultFolder(6)

    # Get current user email for isToMe check
    $myEmail = ""
    try { $myEmail = $ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress.ToLower() } catch {}

    function Get-SenderSMTP($item) {
        try {
            if ($item.SenderEmailType -eq "EX") {
                $eu = $item.Sender.GetExchangeUser()
                if ($eu) { return $eu.PrimarySmtpAddress.ToLower() }
            }
        } catch {}
        $a = $item.SenderEmailAddress
        if ($a) { return $a.ToLower() }
        return ""
    }

    function Get-IsToMe($item, $myEmail) {
        try {
            foreach ($r in $item.Recipients) {
                if ($r.Type -eq 1) {
                    $addr = ""
                    try { $eu = $r.AddressEntry.GetExchangeUser(); if ($eu) { $addr = $eu.PrimarySmtpAddress.ToLower() } } catch {}
                    if (!$addr) { $addr = $r.Address.ToLower() }
                    if ($myEmail -and $addr -eq $myEmail) { return $true }
                    if ($addr -like ("*" + $env:USERNAME.ToLower() + "*")) { return $true }
                }
            }
        } catch {}
        return $false
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $emails = @()

    foreach ($filter in @("[UnRead] = True", "[FlagStatus] = 2")) {
        $items = $inbox.Items.Restrict($filter)
        $items.Sort("[ReceivedTime]", $true)
        $n = 0
        foreach ($item in $items) {
            if ($n -ge 50) { break }
            if ($item.Class -ne 43) { continue }
            if (!$seen.Add($item.EntryID)) { continue }
            $body = try { $item.Body -replace "[\r\n\t ]+", " " } catch { "" }
            $preview = if ($body.Length -gt 200) { $body.Substring(0,200) } else { $body }
            $emails += [PSCustomObject]@{
                id          = $item.EntryID
                subject     = if ($item.Subject)    { $item.Subject }    else { "" }
                from        = if ($item.SenderName) { $item.SenderName } else { "" }
                fromEmail   = (Get-SenderSMTP $item)
                receivedAt  = $item.ReceivedTime.ToString("o")
                isRead      = (!$item.UnRead)
                isFlagged   = ($item.FlagStatus -eq 2)
                isToMe      = (Get-IsToMe $item $myEmail)
                bodyPreview = $preview
            }
            $n++
        }
    }

    if ($emails.Count -eq 0) { Write-Output "[]"; exit 0 }
    $json = ([array]$emails) | ConvertTo-Json -Depth 2 -Compress
    if (!$json.StartsWith("[")) { $json = "[$json]" }
    Write-Output $json
} catch {
    $errMsg = 'Outlook COM error'
    try { if ($_.Exception -and $_.Exception.Message) { $errMsg = $_.Exception.Message } } catch {}
    Write-Error $errMsg
    exit 1
}
`;

// ── Public API ─────────────────────────────────────────────────────────────

export async function getTriagedEmails(maxEmails = 100): Promise<{
  buckets: Record<TriageBucket, EmailSummary[]>;
  total: number;
}> {
  const org = await getOrgContext();
  const peerEmails = org.peers.map(p => p.mail.toLowerCase());

  const raw = await runPS(FETCH_EMAILS_SCRIPT);
  let items: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    throw new Error(`Failed to parse Outlook COM data: ${raw.slice(0, 300)}`);
  }

  const buckets: Record<TriageBucket, EmailSummary[]> = { now: [], eod: [], tomorrow: [], "this-week": [], fyi: [] };

  for (const e of items.slice(0, maxEmails)) {
    const { bucket, reason } = scoreEmail(e, org.priorityEmails, peerEmails);
    const refs = extractRefs((e.subject ?? "") + " " + (e.bodyPreview ?? ""));
    buckets[bucket].push({ ...e, jiraKeys: refs.jiraKeys, ritm: refs.ritm, bucket, reason, hoursWaiting: Math.round(hoursSince(e.receivedAt)) });
  }

  return { buckets, total: items.length };
}

export async function flagEmail(emailId: string): Promise<void> {
  const safeId = emailId.replace(/'/g, "");
  await runPS(`
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$item = $ns.GetItemFromID('${safeId}')
$item.FlagStatus = 2
$item.Save()
`);
}

export async function markRead(emailId: string): Promise<void> {
  const safeId = emailId.replace(/'/g, "");
  await runPS(`
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$item = $ns.GetItemFromID('${safeId}')
$item.UnRead = $false
$item.Save()
`);
}

export async function createDraftReply(emailId: string, body: string): Promise<string> {
  const safeId = emailId.replace(/'/g, "");
  const bodyFile = join(tmpdir(), `mcp-draft-${Date.now()}.txt`).replace(/\\/g, "/");
  writeFileSync(bodyFile, body, "utf8");
  const script = `
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$item = $ns.GetItemFromID('${safeId}')
$reply = $item.Reply()
$draftBody = [System.IO.File]::ReadAllText('${bodyFile}')
$reply.Body = $draftBody + [Environment]::NewLine + [Environment]::NewLine + $reply.Body
$reply.Save()
Write-Output $reply.EntryID
`;
  try {
    return (await runPS(script)).trim();
  } finally {
    try { unlinkSync(bodyFile.replace(/\//g, "\\")); } catch {}
  }
}

