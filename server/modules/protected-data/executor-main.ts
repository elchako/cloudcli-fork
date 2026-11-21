import { startProtectedDataExecutor } from './executor.js';

// GOLDJAXE fork (реестр §27): независимая точка входа, без запуска из CloudCLI.
async function main(): Promise<void> {
  let stopping = false;
  let close: (() => Promise<void>) | undefined;
  const stop = () => {
    stopping = true;
    void close?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  ({ close } = await startProtectedDataExecutor(process.env.CLOUDCLI_PROTECTED_DATA_EXECUTOR_CONFIG));
  if (stopping) await close();
}

void main().catch(() => {
  console.error('Не удалось запустить исполнитель защищённых данных.');
  process.exitCode = 1;
});
