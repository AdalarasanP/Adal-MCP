import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register as registerContext } from "./tools/context/index.js";
import { register as registerRead } from "./tools/read/index.js";
import { register as registerAnalyze } from "./tools/analyze/index.js";
import { register as registerWrite } from "./tools/write/index.js";
import { register as registerControl } from "./tools/control/index.js";

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

registerContext(server);
registerRead(server);
registerAnalyze(server);
registerWrite(server);
registerControl(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();