/**
 * Outlook email triage via Microsoft Graph.
 * Fetches unread + flagged emails, scores each for urgency,
 * and buckets into: now / eod / tomorrow / this-week / fyi
 */

import { graphFetch } from "./graph-auth.js";
import { getOrgContext } from "./org.js";

export type TriageBucket = "now" | "eod" | "tomorrow" | "this-week" | "fyi";

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedAt: string;       // ISO
  isRead: boolean;
  isFlagged: boolean;
  isToMe: boolean;          // true = in To:, false = CC
  bodyPreview: string;
  jiraKeys: string[];       // extracted NTWK-XXXX references
  ritm: string[];           // ServiceNow RITMs
  bucket: TriageBucket;
  reason: string;           // why it got this bucket
  hoursWaiting: number;
}

// Keywords that push emails to "now"
const URGENT_SUBJECTS = ["action required", "urgent", "please approve", "approval needed", "asap", "critical", "p1", "p0", "sev1", "sev2", "incident", "outage"];
const FYI_SUBJECTS = ["fyi", "no action", "unsubscribe", "newsletter", "digest", "automated notification", "noreply"];

// Extract Jira keys and RITM numbers from text
function extractRefs(text: string): { jiraKeys: string[]; ritm: string[] } {
  const jiraKeys = [...new Set((text.match(/NTWK-\d+/gi) ?? []).map(k => k.toUpperCase()))];
  const ritm = [...new Set((text.match(/RITM\d+/gi) ?? []).map(k => k.toUpperCase()))];
  return { jiraKeys, ritm };
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

function isWorkHours(): boolean {
  const h = new Date().getHours();
  const day = new Date().getDay(); // 0=Sun 6=Sat
  return day >= 1 && day <= 5 && h >= 8 && h < 17;
}

function scoreEmail(email: any, priorityEmails: Set<string>, peers: string[]): { bucket: TriageBucket; reason: string } {
  const subjectLc = (email.subject ?? "").toLowerCase();
  const fromEmail = (email.from?.emailAddress?.address ?? "").toLowerCase();
  const isToMe = (email.toRecipients ?? []).some((r: any) => r.emailAddress?.address?.toLowerCase().includes("apand270"));
  const flagged = email.flag?.flagStatus === "flagged";
  const hours = hoursSince(email.receivedDateTime);
  const refs = extractRefs(email.subject + " " + email.bodyPreview);
  const hasJiraOrRitm = refs.jiraKeys.length > 0 || refs.ritm.length > 0;

  // FYI-only signals
  if (!isToMe) {
    if (FYI_SUBJECTS.some(k => subjectLc.includes(k))) return { bucket: "fyi", reason: "CC only, FYI keyword" };
    if (!flagged && !hasJiraOrRitm) return { bucket: "fyi", reason: "CC only, no action needed" };
  }

  // Immediate signals
  if (priorityEmails.has(fromEmail) && URGENT_SUBJECTS.some(k => subjectLc.includes(k))) {
    return { bucket: "now", reason: "Manager/skip-level + urgent keyword" };
  }
  if (flagged && hours > 4) return { bucket: "now", reason: "Flagged and waiting >4h" };
  if (URGENT_SUBJECTS.some(k => subjectLc.includes(k)) && isToMe) return { bucket: "now", reason: "Urgent keyword in To:" };
  if (priorityEmails.has(fromEmail) && isToMe) return { bucket: "eod", reason: "From manager/skip-level" };

  // Waiting too long
  if (hours > 48 && isToMe) return { bucket: "now", reason: `Waiting ${Math.round(hours)}h — overdue` };
  if (hours > 24 && isToMe) return { bucket: "eod", reason: `Waiting ${Math.round(hours)}h` };

  // Peer emails with Jira/RITM refs
  if (peers.includes(fromEmail) && hasJiraOrRitm && isToMe) return { bucket: "eod", reason: "Teammate + Jira/RITM reference" };

  // Flagged
  if (flagged) return { bucket: "eod", reason: "Flagged by you" };

  // Has Jira/RITM ref
  if (hasJiraOrRitm && isToMe) return { bucket: "tomorrow", reason: "Has Jira/RITM reference" };

  // Regular unread To: email
  if (isToMe && !email.isRead) return { bucket: "this-week", reason: "Unread, addressed to you" };

  return { bucket: "fyi", reason: "No action signal detected" };
}

/** Fetch and triage emails */
export async function getTriagedEmails(maxEmails = 100): Promise<{
  buckets: Record<TriageBucket, EmailSummary[]>;
  total: number;
}> {
  const org = await getOrgContext();
  const peerEmails = org.peers.map(p => p.mail);

  // Fetch unread inbox + flagged
  const [unreadRes, flaggedRes] = await Promise.all([
    graphFetch(`/me/mailFolders/Inbox/messages?$filter=isRead eq false&$top=${maxEmails}&$select=id,subject,from,toRecipients,receivedDateTime,isRead,flag,bodyPreview`),
    graphFetch(`/me/messages?$filter=flag/flagStatus eq 'flagged'&$top=50&$select=id,subject,from,toRecipients,receivedDateTime,isRead,flag,bodyPreview`),
  ]);

  // Deduplicate by id
  const seen = new Set<string>();
  const emails: any[] = [];
  for (const e of [...(unreadRes.value ?? []), ...(flaggedRes.value ?? [])]) {
    if (!seen.has(e.id)) { seen.add(e.id); emails.push(e); }
  }

  const buckets: Record<TriageBucket, EmailSummary[]> = { now: [], eod: [], tomorrow: [], "this-week": [], fyi: [] };

  for (const e of emails) {
    const { bucket, reason } = scoreEmail(e, org.priorityEmails, peerEmails);
    const refs = extractRefs((e.subject ?? "") + " " + (e.bodyPreview ?? ""));
    buckets[bucket].push({
      id: e.id,
      subject: e.subject ?? "(no subject)",
      from: e.from?.emailAddress?.name ?? "",
      fromEmail: (e.from?.emailAddress?.address ?? "").toLowerCase(),
      receivedAt: e.receivedDateTime,
      isRead: e.isRead,
      isFlagged: e.flag?.flagStatus === "flagged",
      isToMe: (e.toRecipients ?? []).some((r: any) => r.emailAddress?.address?.toLowerCase().includes("apand270")),
      bodyPreview: (e.bodyPreview ?? "").slice(0, 200),
      jiraKeys: refs.jiraKeys,
      ritm: refs.ritm,
      bucket,
      reason,
      hoursWaiting: Math.round(hoursSince(e.receivedDateTime)),
    });
  }

  return { buckets, total: emails.length };
}

/** Flag an email for follow-up */
export async function flagEmail(emailId: string): Promise<void> {
  await graphFetch(`/me/messages/${emailId}`, {
    method: "PATCH",
    body: JSON.stringify({ flag: { flagStatus: "flagged" } }),
  });
}

/** Mark email as read */
export async function markRead(emailId: string): Promise<void> {
  await graphFetch(`/me/messages/${emailId}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead: true }),
  });
}

/** Create a draft reply */
export async function createDraftReply(emailId: string, body: string): Promise<string> {
  const draft = await graphFetch(`/me/messages/${emailId}/createReply`, { method: "POST", body: "{}" });
  await graphFetch(`/me/messages/${draft.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body: { contentType: "Text", content: body } }),
  });
  return draft.id;
}
