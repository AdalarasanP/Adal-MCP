import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  externalCapabilities,
  assertExternalWrite,
  unlockExternalWrite,
} from "./capabilities.js";
import {
  setActiveStory,
  getActiveStory,
  clearActiveStory,
} from "./context.js";

/**
 * MCP SERVER
 */
const server = new McpServer(
  {
    name: "secops-orchestrator",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/* ==========================================
   CONTEXT: Set / Get Active Story
========================================== */

server.tool(
  "set_active_story",
  "Set the Jira story you are currently working on",
  {
    jiraKey: z.string(),
    sprint: z.string().optional(),
    epic: z.string().optional(),
    title: z.string().optional(),
  },
  async (args) => {
    const story = setActiveStory({
      jiraKey: args.jiraKey,
      sprint: args.sprint,
      epic: args.epic,
      title: args.title,
      startedAt: "",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(story, null, 2) }],
    };
  }
);

server.tool(
  "get_active_story",
  "Get the currently active Jira story",
  {},
  async () => {
    const story = getActiveStory();
    if (!story) {
      return {
        content: [{ type: "text", text: "No active story set. Use set_active_story first." }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(story, null, 2) }],
    };
  }
);

/* ==========================================
   READ TOOLS (Always Safe)
========================================== */

server.tool(
  "read_panorama_config",
  "Read Panorama firewall configuration (read-only)",
  {
    firewall: z.string(),
  },
  async ({ firewall }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          source: "panorama",
          firewall,
          status: "read-only snapshot",
          note: "Replace with real Panorama XML API later",
        }, null, 2),
      },
    ],
  })
);

server.tool(
  "read_firemon_analysis",
  "Read FireMon policy analysis (read-only)",
  {
    firewall: z.string(),
  },
  async ({ firewall }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          source: "firemon",
          firewall,
          unusedRules: 0,
          risk: "LOW",
          note: "Replace with real FireMon REST API later",
        }, null, 2),
      },
    ],
  })
);

server.tool(
  "read_ise_policies",
  "Read Cisco ISE auth policies (read-only)",
  {
    scope: z.string().optional(),
  },
  async ({ scope }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          source: "ise",
          scope: scope || "all",
          note: "Replace with real ISE ERS API later",
        }, null, 2),
      },
    ],
  })
);

/* ==========================================
   ANALYZE TOOLS
========================================== */

server.tool(
  "analyze_story_progress",
  "Analyze current progress for the active Jira story",
  {},
  async () => {
    const story = getActiveStory();
    if (!story) {
      return {
        content: [{ type: "text", text: "No active story. Use set_active_story first." }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            story: story.jiraKey,
            sprint: story.sprint,
            progress: "Analysis based on available signals",
            confidence: 0.75,
            gaps: ["Peer review not confirmed"],
            recommendation: "Collect peer signoff before moving to Review",
          }, null, 2),
        },
      ],
    };
  }
);

/* ==========================================
   LOCAL WRITE TOOLS (Always Allowed)
========================================== */

server.tool(
  "write_jira_update",
  "Update Jira story with progress",
  {
    jiraKey: z.string(),
    comment: z.string(),
    proposedStatus: z.string().optional(),
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "WRITE",
          system: "jira",
          ...args,
          updatedAt: new Date().toISOString(),
          note: "Replace with real Jira REST API later",
        }, null, 2),
      },
    ],
  })
);

server.tool(
  "write_outlook_draft",
  "Create an Outlook email draft (never sends)",
  {
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "DRAFT_ONLY",
          system: "outlook",
          ...args,
          reviewNote: "Review before sending. This is a draft only.",
        }, null, 2),
      },
    ],
  })
);

server.tool(
  "write_word_solution",
  "Generate a Word solution document structure",
  {
    jiraKey: z.string(),
    title: z.string(),
    sections: z.array(z.string()).optional(),
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "WRITE",
          system: "word",
          document: `${args.jiraKey}_Solution.docx`,
          title: args.title,
          sections: args.sections || [
            "Background",
            "Analysis",
            "Proposed Solution",
            "Execution Steps",
            "Validation",
            "Rollback Plan",
          ],
          note: "Replace with real Graph API / Word Copilot later",
        }, null, 2),
      },
    ],
  })
);

server.tool(
  "write_excel_procedure",
  "Generate an Excel execution procedure",
  {
    jiraKey: z.string(),
    steps: z.array(
      z.object({
        action: z.string(),
        validation: z.string(),
        rollback: z.string(),
      })
    ),
  },
  async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode: "WRITE",
          system: "excel",
          workbook: `${args.jiraKey}_Procedure.xlsx`,
          steps: args.steps,
          note: "Replace with real Graph API / Excel Copilot later",
        }, null, 2),
      },
    ],
  })
);

/* ==========================================
   EXTERNAL WRITE TOOLS (LOCKED by default)
========================================== */

server.tool(
  "write_external_panorama",
  "Commit Panorama changes (LOCKED by default)",
  {
    firewall: z.string(),
    description: z.string(),
  },
  async ({ firewall, description }) => {
    assertExternalWrite("panorama");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "EXTERNAL_WRITE",
            system: "panorama",
            firewall,
            description,
            executedAt: new Date().toISOString(),
            note: "Replace with real Panorama XML API later",
          }, null, 2),
        },
      ],
    };
  }
);

/* ==========================================
   CONTROL: Unlock External Writes
========================================== */

server.tool(
  "control_unlock_external",
  "Temporarily unlock write access for an external system",
  {
    system: z.enum(["panorama", "paloaltoApps", "ise", "firemon"]),
    reason: z.string(),
    requestedBy: z.string(),
    durationMinutes: z.number().max(30),
  },
  async ({ system, reason, requestedBy, durationMinutes }) => {
    const result = unlockExternalWrite(system, reason, requestedBy, durationMinutes);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "UNLOCKED",
            system,
            reason,
            requestedBy,
            durationMinutes,
            expiresAt: result.expiresAt,
            warning: "All actions are audited. Auto-relocks after expiry.",
          }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "control_get_capabilities",
  "Show current read/write status for all systems",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          local: {
            jira: "✅ write allowed",
            word: "✅ write allowed",
            excel: "✅ write allowed",
            outlook: "✅ draft only",
          },
          external: Object.fromEntries(
            Object.entries(externalCapabilities).map(([k, v]) => [
              k,
              v.write
                ? `🔓 UNLOCKED until ${new Date(v.expiresAt!).toISOString()}`
                : "🔒 LOCKED (read-only)",
            ])
          ),
        }, null, 2),
      },
    ],
  })
);

/* ==========================================
   START SERVER
========================================== */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();