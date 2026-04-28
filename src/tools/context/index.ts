import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setActiveStory, getActiveStory, clearActiveStory } from "../../context.js";

export function register(server: McpServer): void {
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

  server.tool(
    "clear_active_story",
    "Clear the currently active Jira story from context",
    {},
    async () => {
      clearActiveStory();
      return {
        content: [{ type: "text", text: "Active story cleared." }],
      };
    }
  );
}
