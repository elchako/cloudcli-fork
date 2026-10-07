// In-process `generate_image` MCP tool that the Claude runtime attaches to every run when
// an image-capable gateway (CLIProxyAPI behind ANTHROPIC_BASE_URL) is configured.
export {
  createImageGenerationMcpServer,
  IMAGE_GENERATION_MCP_SERVER_NAME,
  IMAGE_GENERATION_TOOL_ID,
} from './image-generation.mcp.js';
