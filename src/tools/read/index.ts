import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getIssue } from "../../jira.js";
import { getPage, searchPages } from "../../confluence.js";

export function register(server: McpServer): void {
  server.tool(
    "read_jira_story",
    "Fetch a Jira story's details (summary, status, assignee, priority, comment count)",
    {
      jiraKey: z.string(),
    },
    async ({ jiraKey }) => {
      const issue = await getIssue(jiraKey);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status.name,
              assignee: issue.fields.assignee?.displayName ?? "Unassigned",
              priority: issue.fields.priority?.name ?? "None",
              comments: issue.fields.comment.total,
            }, null, 2),
          },
        ],
      };
    }
  );

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
    "read_confluence_page",
    "Fetch a Confluence page by its page ID (title, space, version, body excerpt)",
    {
      pageId: z.string(),
    },
    async ({ pageId }) => {
      const page = await getPage(pageId);
      const bodyExcerpt = page.body.storage.value.replace(/<[^>]+>/g, "").slice(0, 500);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: page.id,
              title: page.title,
              space: page.space.name,
              version: page.version.number,
              bodyExcerpt,
              url: page._links.webui,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "read_confluence_search",
    "Search Confluence pages by keyword",
    {
      query: z.string(),
      limit: z.number().min(1).max(20).optional(),
    },
    async ({ query, limit }) => {
      const pages = await searchPages(query, limit ?? 10);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              pages.map((p) => ({
                id: p.id,
                title: p.title,
                space: p.space?.name,
                version: p.version?.number,
              })),
              null, 2
            ),
          },
        ],
      };
    }
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
}
