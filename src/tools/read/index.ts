import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getIssue, searchIssues } from "../../jira.js";
import { getPage, searchPages } from "../../confluence.js";

export function register(server: McpServer): void {
  server.tool(
    "search_jira_stories",
    "Search Jira issues using JQL or natural filters (project, sprint, assignee, status, team)",
    {
      project: z.string().optional().describe("Jira project key e.g. NTWK"),
      sprint: z.string().optional().describe("Sprint name or partial name e.g. 'Sprint 2 PI2'"),
      team: z.string().optional().describe("Agile team name e.g. Security"),
      assignee: z.string().optional().describe("Assignee display name or 'currentUser'"),
      status: z.string().optional().describe("Status name e.g. 'In Progress', 'To Do'"),
      jql: z.string().optional().describe("Raw JQL override — used as-is if provided"),
      maxResults: z.number().min(1).max(50).optional(),
    },
    async (args) => {
      let jql = args.jql ?? "";
      if (!jql) {
        const clauses: string[] = [];
        if (args.project) clauses.push(`project = "${args.project}"`);
        if (args.sprint) clauses.push(`sprint = "${args.sprint}"`);
        if (args.team) clauses.push(`team = "${args.team}"`);
        if (args.assignee) {
          clauses.push(
            args.assignee === "currentUser"
              ? "assignee = currentUser()"
              : `assignee = "${args.assignee}"`
          );
        }
        if (args.status) clauses.push(`status = "${args.status}"`);
        clauses.push("ORDER BY updated DESC");
        jql = clauses.join(" AND ");
      }
      const issues = await searchIssues(jql, args.maxResults ?? 20);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                jql,
                total: issues.length,
                issues: issues.map((i) => ({
                  key: i.key,
                  type: i.fields.issuetype.name,
                  summary: i.fields.summary,
                  status: i.fields.status.name,
                  assignee: i.fields.assignee?.displayName ?? "Unassigned",
                  priority: i.fields.priority?.name ?? "None",
                })),
              },
              null, 2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "read_jira_story",
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
