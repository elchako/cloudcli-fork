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

import { IMAGE_PROFILES } from './image-generation.config.js';

export const IMAGE_GENERATION_MCP_SERVER_NAME = 'cloudcli-images';
export const IMAGE_GENERATION_TOOL_ID = `mcp__${IMAGE_GENERATION_MCP_SERVER_NAME}__generate_image`;

// GOLDJAXE fork (реестр §13.3): режим выбирает задачу; конкретные модель/качество — настройки аккаунта.
const TOOL_DESCRIPTION = [
  'Сгенерируй или отредактируй изображение через настроенный API и покажи его в чате.',
  'Используй для иллюстраций, иконок, логотипов, баннеров, макетов и фотографий.',
  'Опиши в prompt предмет, стиль, композицию, цвет, освещение и точные надписи.',
  'Для правки или продолжения предыдущей картинки передай путь в input_images и опиши изменение.',
  'Если пользователь просит набросок или проверку идеи, выбери profile=draft; для явно финальной версии — final.',
  'Без указания режима оставь profile пустым: сервер использует режим по умолчанию пользователя.',
  'Не сравнивай несколько моделей, не повышай режим и не повторяй генерацию после ошибки без просьбы пользователя.',
  'Конкретные модели и свойства Flare/Sunburst не угадывай: их настраивает пользователь.',
  'Картинка показывается автоматически — не дублируй её в ответе.',
].join(' ');

function buildAltText(prompt: string): string {
  const flattened = prompt.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length > 80 ? `${flattened.slice(0, 79)}…` : flattened;
}

/** Транскрипт хранит настройки результата; UI отделяет их от инструкций для агента. */
export function buildImageToolResultText(image: GeneratedImage, prompt: string): string {
  const resolution = image.size ? `, ${image.size}` : '';
  return [
    `Image generated (${image.model}${resolution}) and already displayed to the user in the chat.`,
    ...(image.profile ? [`Image settings: ${JSON.stringify({
      model: image.model, reportedModel: image.reportedModel, profile: image.profile,
      quality: image.quality, elapsedMs: image.elapsedMs,
    })}`] : []),
    `Saved to: ${image.filePath}`,
    `![${buildAltText(prompt)}](${image.url})`,
    'To refine it, call generate_image again with this path in input_images.',
    'To use it in the project, copy the file there.',
  ].join('\n');
}

/** userId только из авторизации рана: модель не может выбрать чужие настройки. */
export async function createImageGenerationMcpServer({ cwd, userId }: { cwd?: string; userId?: number }) {
  if (!(await resolveImageGateway())) return null;

  return createSdkMcpServer({
    name: IMAGE_GENERATION_MCP_SERVER_NAME,
    version: '1.1.0',
    alwaysLoad: true,
    timeout: IMAGE_REQUEST_TIMEOUT_MS + 30_000,
    tools: [
      tool(
        'generate_image',
        TOOL_DESCRIPTION,
        {
          prompt: z.string().min(1).describe('Описание желаемого изображения или правки input_images.'),
          profile: z.enum(IMAGE_PROFILES).optional().describe('draft — набросок; standard — обычный; final — явно запрошенный финал. Не задано — режим пользователя по умолчанию.'),
          size: z.enum(IMAGE_SIZES).optional().describe('Формат: квадрат 1024x1024, горизонталь 1536x1024, вертикаль 1024x1536; по умолчанию auto.'),
          quality: z.enum(IMAGE_QUALITIES).optional().describe('Переопределяй только по явной просьбе о качестве. Иначе не задавай: качество берётся из профиля пользователя.'),
          background: z.enum(IMAGE_BACKGROUNDS).optional().describe('transparent — прозрачный фон, opaque — непрозрачный; по умолчанию auto.'),
          input_images: z.array(z.string().min(1)).max(MAX_INPUT_IMAGES).optional()
            .describe('PNG/JPEG/WebP для правки: абсолютные пути или пути относительно проекта.'),
        },
        async (args) => {
          try {
            const image = await generateImage({
              prompt: args.prompt, profile: args.profile, size: args.size, quality: args.quality,
              background: args.background, inputImages: args.input_images, cwd, userId,
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
