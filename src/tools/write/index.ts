import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertExternalWrite } from "../../capabilities.js";
import { addComment, transitionIssue, createIssue, updateIssue, linkIssues, getLinkTypes } from "../../jira.js";
import { createPage, updatePage, getPage } from "../../confluence.js";

export function register(server: McpServer): void {
  server.tool(
    "create_jira_story",
    "Create a Jira Story (or Task/Epic) under a given epic and optionally assign it to a sprint",
    {
      projectKey: z.string().describe("Jira project key e.g. NTWK"),
      summary: z.string().describe("Story title / summary"),
      description: z.string().optional().describe("Acceptance criteria or description"),
      epicKey: z.string().optional().describe("Parent epic key e.g. NTWK-123"),
      sprintId: z.number().optional().describe("Sprint ID (get from get_jira_sprints)"),
      storyPoints: z.number().optional(),
      issuetype: z.enum(["Story", "Task", "Bug", "Epic"]).optional().default("Story"),
      labels: z.array(z.string()).optional(),
      fixVersions: z.array(z.string()).optional().describe("e.g. ['NTWK.26.PI2']"),
    },
    async (args) => {
      const result = await createIssue({
        projectKey: args.projectKey,
        issuetype: args.issuetype ?? "Story",
        summary: args.summary,
        description: args.description,
        epicKey: args.epicKey,
        sprintId: args.sprintId,
        storyPoints: args.storyPoints,
        labels: args.labels,
        fixVersions: args.fixVersions,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              created: true,
              key: result.key,
              id: result.id,
              summary: args.summary,
              epicKey: args.epicKey,
              sprintId: args.sprintId,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "update_jira_issue",
    "Update fields on an existing Jira issue (description, story points, sprint, labels, etc.)",
    {
      issueKey: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      storyPoints: z.number().optional(),
      sprintId: z.number().optional(),
      labels: z.array(z.string()).optional(),
    },
    async (args) => {
      const fields: Record<string, unknown> = {};
      if (args.summary) fields.summary = args.summary;
      if (args.description) {
        fields.description = {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: args.description }] }],
        };
      }
      if (args.storyPoints !== undefined) {
        fields.customfield_10016 = args.storyPoints;
      }
      if (args.sprintId !== undefined) {
        fields.customfield_10020 = { id: args.sprintId };
      }
      if (args.labels) fields.labels = args.labels;
      await updateIssue(args.issueKey, fields);
      return {
        content: [{ type: "text", text: JSON.stringify({ updated: true, issueKey: args.issueKey, fields: Object.keys(fields) }, null, 2) }],
      };
    }
  );

  server.tool(
    "link_jira_issues",
    "Create a dependency or relationship link between two Jira issues",
    {
      inwardKey: z.string().describe("The issue that is blocked / depends on the outward issue"),
      outwardKey: z.string().describe("The issue that blocks / is depended on"),
      linkType: z.string().describe("Link type e.g. 'Blocks', 'Relates', 'Depends'. Use get_jira_link_types to see all options."),
    },
    async ({ inwardKey, outwardKey, linkType }) => {
      await linkIssues(inwardKey, outwardKey, linkType);
      return {
        content: [{ type: "text", text: JSON.stringify({ linked: true, inwardKey, outwardKey, linkType }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_jira_link_types",
    "List all available Jira issue link types (Blocks, Relates, Depends, etc.)",
    {},
    async () => {
      const types = await getLinkTypes();
      return {
        content: [{ type: "text", text: JSON.stringify(types, null, 2) }],
      };
    }
  );

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
    "write_confluence_page",
    {
      spaceKey: z.string(),
      title: z.string(),
      body: z.string().describe("Page body in Confluence storage format (HTML-like) or plain text"),
      parentId: z.string().optional().describe("Optional parent page ID to nest under"),
    },
    async (args) => {
      const page = await createPage({
        spaceKey: args.spaceKey,
        title: args.title,
        body: `<p>${args.body.replace(/\n/g, "</p><p>")}</p>`,
        parentId: args.parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: page.id,
              title: page.title,
              space: page.space.key,
              version: page.version.number,
              url: page._links.webui,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "write_confluence_update",
    "Update an existing Confluence page by page ID",
    {
      pageId: z.string(),
      title: z.string(),
      body: z.string().describe("New page body in Confluence storage format (HTML-like) or plain text"),
    },
    async (args) => {
      const existing = await getPage(args.pageId);
      const updated = await updatePage(
        args.pageId,
        args.title,
        `<p>${args.body.replace(/\n/g, "</p><p>")}</p>`,
        existing.version.number
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: updated.id,
              title: updated.title,
              version: updated.version.number,
              url: updated._links.webui,
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
