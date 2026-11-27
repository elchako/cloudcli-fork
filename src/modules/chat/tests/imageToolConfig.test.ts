import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getToolConfig, getToolErrorContent } from '@/modules/chat/tools/configs/toolConfigs';
import { i18n } from '@/modules/i18n';

/**
 * The `generate_image` result is written for the model (file path, follow-up
 * hints). The chat card must show only the picture, whatever shape the result
 * content arrives in.
 */

const TOOL_NAME = 'mcp__cloudcli-images__generate_image';
const RESULT_TEXT = [
  'Image generated (gpt-image-2.5, 1254x1254) and already displayed to the user in the chat.',
  'Saved to: /home/user/.cloudcli/assets/1-ab12cd34-generated.png',
  '![golden axe icon](/api/assets/images/1-ab12cd34-generated.png)',
  'To refine it, call generate_image again with this path in input_images.',
].join('\n');

const renderResult = (content: unknown) =>
  getToolConfig(TOOL_NAME).result?.getContentProps?.({ content })?.content;

test('the image card keeps only the markdown image from an MCP content array', () => {
  assert.equal(
    renderResult([{ type: 'text', text: RESULT_TEXT }]),
    '![golden axe icon](/api/assets/images/1-ab12cd34-generated.png)',
  );
});

test('the image card also reads content serialized as JSON text', () => {
  assert.equal(
    renderResult(JSON.stringify([{ type: 'text', text: RESULT_TEXT }])),
    '![golden axe icon](/api/assets/images/1-ab12cd34-generated.png)',
  );
});

test('карточка показывает запрошенные модель, режим, качество и время, не выдавая их за подтверждённые API', async () => {
  await i18n.changeLanguage('ru');
  const metadata = JSON.stringify({ model: 'gpt-image-2.6', profile: 'draft', quality: 'low', elapsedMs: 1250 });
  const content = renderResult(`${RESULT_TEXT}\nImage settings: ${metadata}`);
  assert.match(content, /Запрошено: gpt-image-2.6/);
  assert.match(content, /Черновик/);
  assert.match(content, /1.3 с/);
  assert.doesNotMatch(content, /Saved to|To refine|Image settings:|Модель в ответе API/);
});

test('повреждённые метаданные и Markdown от API не попадают в карточку', () => {
  const metadata = JSON.stringify({ model: '[bad](https://example.test)', profile: 'final', quality: 'high', elapsedMs: 10 });
  assert.equal(renderResult(`${RESULT_TEXT}\nImage settings: ${metadata}`), '![golden axe icon](/api/assets/images/1-ab12cd34-generated.png)');
});

test('a result without an image line falls back to its text', () => {
  assert.equal(renderResult('Image generation is not available.'), 'Image generation is not available.');
});

const OUTSIDE_ERROR = 'Image generation failed: Input image must be inside the project or ~/.cloudcli/assets: /tmp/reference.webp';

test('отказ по пути к референсу показывает подсказку на языке чата', async () => {
  const previousLanguage = i18n.language;
  const parts = [{ type: 'text', text: OUTSIDE_ERROR }];
  try {
    await i18n.changeLanguage('ru');
    for (const content of [OUTSIDE_ERROR, parts, JSON.stringify(parts)]) {
      assert.equal(
        getToolErrorContent(TOOL_NAME, { content }),
        'Референс находится вне разрешённых папок. Прикрепите его к чату или поместите в текущий проект.',
      );
    }
    await i18n.changeLanguage('en');
    assert.match(getToolErrorContent(TOOL_NAME, { content: OUTSIDE_ERROR }), /Attach it to the chat or place it in the current project/);
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

test('другие ошибки генерации и других инструментов не заменяются подсказкой', () => {
  const gatewayError = 'Image generation failed: Image gateway returned 400: Invalid input';
  assert.equal(getToolErrorContent(TOOL_NAME, { content: gatewayError }), gatewayError);
  assert.equal(getToolErrorContent('Read', { content: OUTSIDE_ERROR }), OUTSIDE_ERROR);
});

test('the image card is open by default and shows the prompt on the input row', () => {
  const config = getToolConfig(TOOL_NAME);
  assert.equal(config.result?.defaultOpen, true);
  assert.equal(config.input.getValue?.({ prompt: 'golden axe icon' }), 'golden axe icon');
});
