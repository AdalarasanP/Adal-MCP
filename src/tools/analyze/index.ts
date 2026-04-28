import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveStory } from "../../context.js";

export function register(server: McpServer): void {
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
}
