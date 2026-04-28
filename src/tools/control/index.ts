import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { externalCapabilities, unlockExternalWrite } from "../../capabilities.js";

export function register(server: McpServer): void {
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
}
