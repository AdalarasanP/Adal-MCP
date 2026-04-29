import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertExternalWrite } from "../../capabilities.js";
import { addComment, transitionIssue } from "../../jira.js";

export function register(server: McpServer): void {
  server.tool(
    "write_jira_update",
    "Post a comment on a Jira story and optionally transition its status",
    {
      jiraKey: z.string(),
      comment: z.string(),
      proposedStatus: z.string().optional(),
    },
    async (args) => {
      const commentResult = await addComment(args.jiraKey, args.comment);
      let transitionResult: string | null = null;
      if (args.proposedStatus) {
        transitionResult = await transitionIssue(args.jiraKey, args.proposedStatus);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              jiraKey: args.jiraKey,
              commentId: commentResult.id,
              comment: args.comment,
              statusTransitioned: transitionResult,
              updatedAt: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    }
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
}
