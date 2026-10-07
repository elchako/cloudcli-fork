import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  generateImage,
  IMAGE_BACKGROUNDS,
  IMAGE_QUALITIES,
  IMAGE_REQUEST_TIMEOUT_MS,
  IMAGE_SIZES,
  MAX_INPUT_IMAGES,
  resolveImageGateway,
} from '@/modules/image-generation/image-generation.service.js';
import type { GeneratedImage } from '@/modules/image-generation/image-generation.service.js';

/**
 * In-process MCP server that gives every Claude run started from CloudCLI a
 * `generate_image` tool. It runs inside the server (no ~/.claude.json registration, no
 * extra process) and works with any chat model, since the model only decides when to call
 * it — the picture itself always comes from the gateway's image model.
 */

export const IMAGE_GENERATION_MCP_SERVER_NAME = 'cloudcli-images';
export const IMAGE_GENERATION_TOOL_ID = `mcp__${IMAGE_GENERATION_MCP_SERVER_NAME}__generate_image`;

const TOOL_DESCRIPTION = [
  'Generate an image with OpenAI gpt-image and show it to the user in this chat.',
  'Use it whenever the user asks to draw, generate, render or design a picture: illustrations,',
  'icons, logos, banners, mockups, diagrams-as-art, photos.',
  'To edit or vary an existing image (a previous result or a user attachment), pass its path in',
  'input_images and describe the change in prompt.',
  'Write a detailed prompt: subject, style, composition, colors, lighting, and any exact text to render.',
  'The image is displayed in the chat automatically, so do not repeat it in your reply.',
].join(' ');

/** Alt text for the chat markdown: short, single-line, without brackets that would end it. */
function buildAltText(prompt: string): string {
  const flattened = prompt.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length > 80 ? `${flattened.slice(0, 79)}…` : flattened;
}

/**
 * Tool result for the model. The chat card renders the markdown image line itself, so the
 * text tells the model the user already sees the picture and where the file lives.
 */
export function buildImageToolResultText(image: GeneratedImage, prompt: string): string {
  const resolution = image.size ? `, ${image.size}` : '';
  return [
    `Image generated (${image.model}${resolution}) and already displayed to the user in the chat.`,
    `Saved to: ${image.filePath}`,
    `![${buildAltText(prompt)}](${image.url})`,
    'To refine it, call generate_image again with this path in input_images.',
    'To use it in the project, copy the file there.',
  ].join('\n');
}

/**
 * Builds the server for one run, or null when no gateway is configured (or the feature is
 * switched off), so runs without image support never see the tool.
 */
export async function createImageGenerationMcpServer({ cwd }: { cwd?: string }) {
  if (!(await resolveImageGateway())) {
    return null;
  }

  return createSdkMcpServer({
    name: IMAGE_GENERATION_MCP_SERVER_NAME,
    version: '1.0.0',
    // Tool search would otherwise hide the tool until the model looks it up by name.
    alwaysLoad: true,
    timeout: IMAGE_REQUEST_TIMEOUT_MS + 30_000,
    tools: [
      tool(
        'generate_image',
        TOOL_DESCRIPTION,
        {
          prompt: z.string().min(1).describe('Detailed description of the image to create, or of the change to make to input_images.'),
          size: z.enum(IMAGE_SIZES).optional().describe('Aspect: square 1024x1024, landscape 1536x1024, portrait 1024x1536. Default: auto.'),
          quality: z.enum(IMAGE_QUALITIES).optional().describe('low is fastest; high takes longest. Default: auto.'),
          background: z.enum(IMAGE_BACKGROUNDS).optional().describe('transparent for icons/logos/stickers. Default: auto.'),
          input_images: z.array(z.string().min(1)).max(MAX_INPUT_IMAGES).optional()
            .describe('Absolute or project-relative paths of images to edit or use as references (PNG/JPEG/WebP).'),
        },
        async (args) => {
          try {
            const image = await generateImage({
              prompt: args.prompt,
              size: args.size,
              quality: args.quality,
              background: args.background,
              inputImages: args.input_images,
              cwd,
            });
            return { content: [{ type: 'text', text: buildImageToolResultText(image, args.prompt) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text', text: `Image generation failed: ${message}` }], isError: true };
          }
        },
      ),
    ],
  });
}
