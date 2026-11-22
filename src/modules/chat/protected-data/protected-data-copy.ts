import { useTranslation } from 'react-i18next';

import type { ProtectedDataIssue } from '@/modules/chat/protected-data/protected-data-client';

const ruPlural = new Intl.PluralRules('ru');

const en = {
  title: 'Protected data',
  destination: 'Destination',
  chooseDestination: 'Choose a destination',
  chatDestination: 'Say where to send the fields in your message. Confirm the destination before delivery.',
  projectEnv: 'Values will be saved in the current project’s .env file, not on the VPS.',
  required: 'Required fields',
  name: 'Name',
  value: 'Value',
  add: 'Add field',
  removeField: 'Remove field',
  close: 'Close',
  attach: 'Attach to message',
  edit: 'Edit protected data',
  remove: 'Remove protected data',
  count: (count: number) => `${count} ${count === 1 ? 'field' : 'fields'}`,
  errors: {
    invalidCount: 'Add between 1 and 12 fields',
    invalidName: 'Use 1–32 Latin letters, digits or underscores. Start with a letter or underscore',
    duplicateName: 'Use a different name for each field',
    emptyValue: 'Enter a value for this field',
    valueTooLarge: 'Keep each value within 4096 bytes',
    missingRequired: 'Fill in all required fields',
    tooLarge: 'The attachment is too large. Shorten the values',
  } satisfies Record<ProtectedDataIssue['code'], string>,
};

const ru: typeof en = {
  title: 'Защищённые данные',
  destination: 'Назначение',
  chooseDestination: 'Выберите назначение',
  chatDestination: 'Напишите в чате, куда доставить поля. Перед доставкой подтвердите назначение.',
  projectEnv: 'Значения сохранятся в .env текущего проекта, не на VPS.',
  required: 'Обязательные поля',
  name: 'Название',
  value: 'Значение',
  add: 'Добавить поле',
  removeField: 'Удалить поле',
  close: 'Закрыть',
  attach: 'Прикрепить к сообщению',
  edit: 'Изменить защищённые данные',
  remove: 'Удалить защищённые данные',
  count: (count) => {
    const form = ruPlural.select(count);
    return `${count} ${form === 'one' ? 'поле' : form === 'few' ? 'поля' : 'полей'}`;
  },
  errors: {
    invalidCount: 'Добавьте от 1 до 12 полей',
    invalidName: 'Введите 1–32 латинские буквы, цифры или «_». Начните с буквы или «_»',
    duplicateName: 'Названия полей не должны повторяться',
    emptyValue: 'Введите значение этого поля',
    valueTooLarge: 'Значение не должно превышать 4096 байт',
    missingRequired: 'Заполните все обязательные поля',
    tooLarge: 'Вложение слишком большое. Сократите значения',
  },
};

// GOLDJAXE fork (реестр §27): подписи этого компонента не зависят от общих словарей.
export function useProtectedDataCopy() {
  const { i18n } = useTranslation('chat');
  return /^ru(?:[-_]|$)/i.test(i18n.resolvedLanguage || i18n.language || '') ? ru : en;
}
