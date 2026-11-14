import assert from 'node:assert/strict';
import test from 'node:test';

import { appendFilesInputTag, appendImagesInputTag, normalizeAttachmentDescriptors, parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';

const reference = {
  path: '/synthetic/assets/upload.png', name: 'upload.png', mimeType: 'image/png', size: 42,
  mail_source_object_id: '8262d1ef-f092-4476-b5aa-a00a41f66c31', mail_sha256: 'a'.repeat(64),
};

test('additive upload ID/SHA сохраняются через нормализацию дескрипторов для prompt', () => {
  assert.deepEqual(normalizeAttachmentDescriptors([reference]), [reference]);
  assert.deepEqual(normalizeAttachmentDescriptors(normalizeAttachmentDescriptors([reference])), [reference]);
});

test('неполная/невалидная пара ID/hash и попытка внедрения prompt отбрасываются', () => {
  for (const patch of [
    { mail_source_object_id: '../../path' }, { mail_source_object_id: 'uuid\n1. injected' },
    { mail_sha256: undefined }, { mail_sha256: 'not-a-hash' }, { mail_source_object_id: undefined },
  ]) {
    const [normalized] = normalizeAttachmentDescriptors([{ ...reference, ...patch }]);
    assert.equal(normalized.mail_source_object_id, undefined);
    assert.equal(normalized.mail_sha256, undefined);
  }
});

test('file ref виден модели, но не ломает путь/имя и не всплывает JSON в истории', () => {
  const prompt = appendFilesInputTag('Прикрепи документ', [{ ...reference, path: '/synthetic/assets/doc.pdf', name: 'doc.pdf' }]);
  assert.ok(prompt.includes(reference.mail_source_object_id));
  assert.ok(prompt.includes(reference.mail_sha256));
  assert.ok(prompt.includes('не разрешение'));
  assert.deepEqual(parseFilesInputTag(prompt), {
    text: 'Прикрепи документ', filePaths: ['/synthetic/assets/doc.pdf'], attachments: [{ path: '/synthetic/assets/doc.pdf', name: 'doc.pdf' }],
  });
});

test('Claude native image ref передаётся в одном files_input без дублирования file attachment', () => {
  const prompt = appendFilesInputTag('Прикрепи картинку', [], normalizeAttachmentDescriptors([reference]));
  assert.ok(prompt.includes('"attachment_kind":"image"'));
  assert.ok(prompt.includes(reference.mail_source_object_id));
  assert.deepEqual(parseFilesInputTag(prompt), { text: 'Прикрепи картинку', filePaths: [], attachments: [] });
});

test('смешанные image/file refs остаются в одном блоке и сохраняют doc history', () => {
  const prompt = appendFilesInputTag('Смешанные вложения', [{ ...reference, path: '/synthetic/assets/doc.pdf', name: 'doc.pdf' }], [reference]);
  assert.equal(prompt.split('<files_input>').length, 2);
  assert.ok(prompt.includes('"attachment_kind":"file"'));
  assert.ok(prompt.includes('"attachment_kind":"image"'));
  assert.equal(parseFilesInputTag(prompt).attachments.length, 1);
});

test('images_input сохраняет image refs для соответствующих провайдеров и прежний парсер', () => {
  const prompt = appendImagesInputTag('Изображение', [reference]);
  assert.ok(prompt.includes(reference.mail_source_object_id));
  assert.deepEqual(parseImagesInputTag(prompt), {
    text: 'Изображение', imagePaths: [reference.path], attachments: [{ path: reference.path, name: reference.name }],
  });
});

test('default off/старый дескриптор не получает выдуманный ID или технический ref', () => {
  const prompt = appendFilesInputTag('Обычное сообщение', [{ path: '/synthetic/assets/old.pdf' }]);
  assert.equal(prompt.includes('mail_source_object_id'), false);
  assert.equal(appendFilesInputTag('Без вложений', [], [{ path: '/synthetic/assets/old.png' }]), 'Без вложений');
});
