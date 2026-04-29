import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTriagedEmails, flagEmail, markRead, createDraftReply, type TriageBucket } from "../../capture/outlook.js";
import { getOrgContext } from "../../capture/org.js";


function formatEmail(e: any, idx: number): string {
  const flag = e.isFlagged ? "🚩 " : "";
  const to = e.isToMe ? "[TO]" : "[CC]";
  const refs = [...e.jiraKeys, ...e.ritm].join(" ");
  return `${idx + 1}. ${flag}${to} From: ${e.from} <${e.fromEmail}>\n   Subject: ${e.subject}\n   Received: ${e.receivedAt.slice(0,16).replace("T"," ")} (${e.hoursWaiting}h ago)\n   Reason: ${e.reason}${refs ? `\n   Refs: ${refs}` : ""}\n   Preview: ${e.bodyPreview.slice(0,120)}`;
}

export function registerCommsTools(server: McpServer) {

  server.tool(
    "get_email_triage",
    "Fetch and triage your Outlook inbox. Returns emails bucketed into: respond now, respond by EOD, respond tomorrow morning, respond this week, FYI only. Reads directly from the running Outlook app — no sign-in needed.",
    {
      bucket: z.enum(["now", "eod", "tomorrow", "this-week", "fyi", "all"]).optional().default("all").describe("Which bucket to show"),
      limit: z.number().optional().default(50),
    },
    async ({ bucket, limit }) => {
      const { buckets, total } = await getTriagedEmails(limit ?? 50);

      const LABELS: Record<TriageBucket | "all", string> = {
        now: "🔴 Respond NOW",
        eod: "🟠 Respond by EOD",
        tomorrow: "🟡 Respond Tomorrow Morning",
        "this-week": "🟢 Respond This Week",
        fyi: "⚪ FYI Only",
        all: "All",
      };

      const show: TriageBucket[] = bucket === "all"
        ? ["now", "eod", "tomorrow", "this-week", "fyi"]
        : [bucket as TriageBucket];

      const sections = show.map(b => {
        const emails = buckets[b];
        if (emails.length === 0) return `${LABELS[b]} — none`;
        return `${LABELS[b]} (${emails.length}):\n${emails.map((e, i) => formatEmail(e, i)).join("\n\n")}`;
      });

      return { content: [{ type: "text", text: `Email Triage — ${total} emails analysed\n${"=".repeat(60)}\n\n${sections.join("\n\n" + "─".repeat(60) + "\n\n")}` }] };
    }
  );

  server.tool(
    "get_my_org",
    "Show your org structure: your profile, manager, manager's manager (skip-level), and teammates. Read from Outlook Exchange address book.",
    {},
    async () => {
      const org = await getOrgContext();

      const lines = [
        `👤 You: ${org.me.displayName} (${org.me.mail})`,
        `   Title: ${org.me.jobTitle} | Dept: ${org.me.department}`,
        "",
        org.manager
          ? `📊 Manager: ${org.manager.displayName} (${org.manager.mail})\n   Title: ${org.manager.jobTitle}`
          : "Manager: not found",
        "",
        org.managerManager
          ? `📊 Skip-level: ${org.managerManager.displayName} (${org.managerManager.mail})\n   Title: ${org.managerManager.jobTitle}`
          : "Skip-level: not found",
        "",
        org.peers.length > 0
          ? `👥 Teammates (${org.peers.length}):\n${org.peers.map(p => `   - ${p.displayName} (${p.mail}) — ${p.jobTitle}`).join("\n")}`
          : "Teammates: none found",
        "",
        org.directReports.length > 0
          ? `👇 Your Direct Reports (${org.directReports.length}):\n${org.directReports.map(p => `   - ${p.displayName} (${p.mail})`).join("\n")}`
          : "",
      ];

      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
    }
  );

  server.tool(
    "set_email_reminder",
    "Flag an email in Outlook for follow-up (creates a flag/reminder).",
    {
      emailId: z.string().describe("Email ID from get_email_triage"),
    },
    async ({ emailId }) => {
      await flagEmail(emailId);
      return { content: [{ type: "text", text: "Email flagged for follow-up." }] };
    }
  );

  server.tool(
    "draft_email_reply",
    "Create a draft reply to an email in Outlook. The draft is saved but not sent — you review and send manually.",
    {
      emailId: z.string().describe("Email ID from get_email_triage"),
      body: z.string().describe("The reply text to draft"),
    },
    async ({ emailId, body }) => {
      const draftId = await createDraftReply(emailId, body);
      return { content: [{ type: "text", text: `Draft reply created (ID: ${draftId}). Open Outlook Drafts to review and send.` }] };
    }
  );
}
