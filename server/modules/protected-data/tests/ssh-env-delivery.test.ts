import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, link, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { deliverSshEnv } from '../ssh-env-delivery.js';
import { SSH_ENV_COMMAND } from '../ssh-env-writer.js';

const fields = [['CHANGE_ME', 'демо " $ \\ `'], ['NEW_NAME', 'тест']];
const nonce = '0'.repeat(64);
const original = '# прочее\r\nCHANGE_ME=old\r\nKEEP=ok';
const expected = '# прочее\r\nCHANGE_ME="демо \\" \\$ \\\\ \\`"\r\nKEEP=ok\r\nNEW_NAME="тест"\r\n';

// /tmp небезопасен как предок целевого EnvironmentFile. Только новый приватный
// каталог; не используем чужие known_hosts, конфиги, сокеты или ключи.
async function fixture(t: TestContext) {
  const run = `/run/user/${process.geteuid!()}`;
  const base = await access(run).then(() => run, () => userInfo().homedir);
  const dir = await mkdtemp(join(base, 'ssh-env-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.env');
  await writeFile(path, original, { mode: 0o600 });
  await chmod(path, 0o640);
  return { dir, path };
}

function writer(path: string, entries: unknown = fields) {
  const child = spawnSync('/bin/sh', ['-c', SSH_ENV_COMMAND], {
    input: JSON.stringify([nonce, path, entries]), cwd: '/', env: {}, timeout: 3500, encoding: 'utf8',
  });
  assert.ifError(child.error);
  return [child.status, child.stdout, child.stderr];
}

test('удалённая команда заменяет полный набор одним rename с прежними UID, GID, режимом и CRLF', async t => {
  const { dir, path } = await fixture(t);
  const old = await open(path, 'r');
  try {
    assert.deepEqual(writer(path), [0, nonce + '\n', '']);
    assert.equal(await old.readFile('utf8'), original);
    assert.equal(await readFile(path, 'utf8'), expected);
    const a = await old.stat(); const b = await stat(path);
    assert.notEqual(a.ino, b.ino);
    assert.deepEqual([b.uid, b.gid, b.mode], [a.uid, a.gid, a.mode]);
    assert.deepEqual(await readdir(dir), ['sample.env']);
  } finally { await old.close(); }
});

test('весь набор отклоняется без вывода, временных файлов и частичных изменений', async t => {
  const { path, dir } = await fixture(t);
  const inode = (await stat(path)).ino;
  for (const text of ['A=1\nB=2\nB=3\n', 'A=ok\nB="multi\nC=2\n', 'A=ok\\\nB=2', 'A=1\r\nB=2\n', 'export A=1\n', 'A=1\0', '# comment\\\nB=2', 'B=﻿bad', 'C=\u{1FFFF}']) {
    await writeFile(path, text);
    assert.deepEqual(writer(path), [1, '', '']);
    assert.equal(await readFile(path, 'utf8'), text);
  }
  await writeFile(path, original);
  for (const entries of [[], [['A', 'new'], ['A', 'other']], [['A', 'new'], ['BAD-NAME', 'x']],
    [['A', 'new'], ['B', 'bad\nline']], [['A', 'я'.repeat(2049)]]]) {
    assert.deepEqual(writer(path, entries), [1, '', '']);
  }
  assert.equal((await stat(path)).ino, inode);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['sample.env']);
});

test('отказ для ссылок, небезопасных предков, имён и прав файла', async t => {
  const { path, dir } = await fixture(t);
  const bad = async (p: string) => assert.deepEqual(writer(p), [1, '', '']);
  await symlink(path, join(dir, 'linked.env'));
  await symlink(dir, join(dir, 'alias'));
  await bad(join(dir, 'linked.env')); await bad(join(dir, 'alias', 'sample.env'));
  await bad(dir + '/../' + dir.split('/').at(-1) + '/sample.env');
  await bad(join(dir, 'missing.env'));
  const other = join(dir, 'not-env'); await writeFile(other, original, { mode: 0o600 }); await bad(other);
  await link(path, join(dir, 'hard.env')); await bad(path); await rm(join(dir, 'hard.env'));
  await chmod(path, 0o644); await bad(path); await chmod(path, 0o600);
  await mkdir(join(dir, 'child'), { mode: 0o700 }); const nested = join(dir, 'child', '.env.stage');
  await writeFile(nested, original, { mode: 0o600 });
  await chmod(dir, 0o770); await bad(nested); await chmod(dir, 0o700);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(writer(nested), [0, nonce + '\n', '']);
});

test('унаследованный или действующий именованный ACL не расширяет доступ к секрету', async t => {
  const { dir, path } = await fixture(t);
  const uid = process.geteuid!() === 65534 ? 65533 : 65534;
  const acl = (...args: string[]) => spawnSync('/usr/bin/setfacl', args, { env: {}, stdio: 'ignore' }).status;
  if (acl('-m', `d:u:${uid}:r`, dir) !== 0) { t.skip('Нет поддержки POSIX ACL'); return; }
  const ino = (await stat(path)).ino;
  assert.deepEqual(writer(path), [1, '', '']); // У нового файла был бы дополнительный читатель.
  assert.equal(acl('-k', dir), 0); assert.equal(acl('-m', `u:${uid}:r`, path), 0);
  assert.deepEqual(writer(path), [1, '', '']); // Не заменяем чужую схему разграничения прав.
  assert.equal((await stat(path)).ino, ino); assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['sample.env']);
});

const denied = { name: 'Error', message: 'Доставка по SSH не подтверждена' };
test('отказ до подключения для опций вместо адреса и уже отозванного вызова', async () => {
  const dest = { host: '127.0.0.1', path: '/etc/example/service.env' };
  for (const changes of [{ host: '-V' }, { host: 'user@host' }, { user: '-V' }, { port: 0 }, { port: 65536 }, { path: '/not/an/env-file' }]) {
    await assert.rejects(deliverSshEnv({ ...dest, ...changes }, new Map([['SAMPLE', 'test']]), new AbortController().signal), denied);
  }
  await assert.rejects(deliverSshEnv(dest, new Map(), AbortSignal.abort('не возвращать причину')), denied);
});

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

async function waitFor(check: () => Promise<unknown>, proc: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    assert.ok(proc.pid && proc.exitCode === null && proc.signalCode === null, 'Временный процесс не запустился');
    try { await check(); return; } catch { await delay(25); }
  }
  throw new Error('Временный процесс не готов');
}

async function stop(proc: ChildProcess | undefined) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = once(proc, 'close'); proc.kill('SIGKILL'); await closed;
}

test('настоящий OpenSSH на loopback: меняется целевой файл, чужой ключ и пустой успех не принимаются', { timeout: 25_000 }, async t => {
  const binaries = ['/usr/sbin/sshd', '/usr/bin/keychain', '/usr/bin/ssh', '/usr/bin/ssh-keygen', '/usr/bin/ssh-agent', '/usr/bin/ssh-add'];
  if (!(await Promise.all(binaries.map(p => access(p).then(() => true, () => false)))).every(Boolean)) {
    t.skip('Требуются системные OpenSSH и keychain'); return;
  }
  const { dir, path } = await fixture(t);
  const env = { PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/sh' };
  const sockDir = await mkdtemp(join(tmpdir(), 'ssh-env-sock-'));
  t.after(() => rm(sockDir, { recursive: true, force: true }));
  const sock = join(sockDir, 'a');
  const sys = (exe: string, args: string[], extra = {}) => {
    const child = spawnSync(exe, args, { cwd: dir, env: { ...env, ...extra }, stdio: 'ignore', timeout: 3000 });
    assert.ifError(child.error); assert.equal(child.status, 0, exe);
  };
  const key = join(dir, 'client'); const hostKey = join(dir, 'host');
  for (const file of [key, hostKey]) sys('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
  await mkdir(join(dir, '.keychain'), { mode: 0o700 }); await mkdir(join(dir, '.ssh'), { mode: 0o700 });
  const port = await freePort(); const authorized = join(dir, 'authorized');
  const clientPub = await readFile(key + '.pub', 'utf8'); const hostPub = await readFile(hostKey + '.pub', 'utf8');
  await writeFile(authorized, 'restrict ' + clientPub, { mode: 0o600 });
  const config = join(dir, 'sshd_config');
  await writeFile(config, [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `AuthorizedKeysFile ${authorized}`,
    `PidFile ${dir}/sshd.pid`, 'AuthenticationMethods publickey', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'DisableForwarding yes', 'PermitTTY no', 'PermitUserRC no', `SetEnv HOME=${dir}`].join('\n') + '\n');
  const sshDir = join(dir, '.ssh'); const known = join(sshDir, 'known_hosts');
  await writeFile(join(sshDir, 'config'), 'Host *\n  ProxyCommand /bin/false\n');
  const client = new Map(fields.map(([k, v]) => [k, v]));
  const dest = { host: '127.0.0.1', port, user: userInfo().username, path };
  const deliver = (signal = new AbortController().signal) => deliverSshEnv(dest, client, signal);
  const prevHome = process.env.HOME;
  const agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', sock], { cwd: '/', env, stdio: 'ignore' });
  let daemon: ChildProcess | undefined;
  try {
    await waitFor(() => access(sock), agent);
    await writeFile(join(dir, '.keychain', hostname() + '-sh'), `SSH_AUTH_SOCK=${sock}; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=${agent.pid}; export SSH_AGENT_PID;\n`, { mode: 0o600 });
    sys('/usr/bin/ssh-add', [key], { SSH_AUTH_SOCK: sock });
    process.env.HOME = dir;
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { cwd: '/', env, stdio: 'ignore' });
    await waitFor(async () => { const c = createConnection(port, '127.0.0.1'); try { await once(c, 'connect'); } finally { c.destroy(); } }, daemon);
    await assert.rejects(deliver(), denied); // Неизвестный ключ не добавлен автоматически.
    assert.equal(await readFile(path, 'utf8'), original);
    await writeFile(known, `[127.0.0.1]:${port} ${clientPub}`); await assert.rejects(deliver(), denied);
    assert.equal(await readFile(path, 'utf8'), original);
    await writeFile(known, `[127.0.0.1]:${port} ${hostPub}`);
    await deliver(); assert.equal(await readFile(path, 'utf8'), expected);
    const ino = (await stat(path)).ino;
    await writeFile(authorized, 'restrict,command="/bin/true" ' + clientPub);
    await assert.rejects(deliver(), denied); // Код 0 без свежей квитанции не означает запись.
    // Наблюдатель не читает stdin и не исполняет полученный текст. SSH_ORIGINAL_COMMAND
    // в реальном sshd содержит ровно константу, без пути, имён и значений набора.
    const observer = join(dir, 'observe'); const observed = join(dir, 'command');
    await writeFile(observer, `#!/bin/sh\nprintf '%s' "$SSH_ORIGINAL_COMMAND" > '${observed}'\n`, { mode: 0o700 });
    await writeFile(authorized, `restrict,command="${observer}" ` + clientPub);
    await assert.rejects(deliver(), denied);
    assert.ok((await readFile(observed, 'utf8')) === SSH_ENV_COMMAND);
    assert.equal((await stat(path)).ino, ino);
    assert.equal(await readFile(path, 'utf8'), expected);

    // Смотрим только собственный дочерний ssh в застрявшем подключении.
    const findSsh = async () => {
      const children = await readFile(`/proc/self/task/${process.pid}/children`, 'utf8');
      for (const pid of children.trim().split(/\s+/)) {
        const proc = `/proc/${pid}`;
        if (await readlink(`${proc}/exe`).catch(() => '') !== '/usr/bin/ssh') continue;
        for (const file of ['cmdline', 'environ']) {
          const data = await readFile(`${proc}/${file}`, 'utf8');
          assert.ok([path, ...fields.flat()].every(s => !data.includes(s)), 'Набор и путь не должны попасть в argv/env');
        }
        return proc;
      }
      throw new Error('Ожидался дочерний ssh');
    };
    // Открытый TCP без SSH-баннера. После отказа нет ни соединения, ни PID.
    const stall = createServer(); stall.listen(0, '127.0.0.1'); await once(stall, 'listening');
    try {
      dest.port = (stall.address() as AddressInfo).port;
      const connected = once(stall, 'connection'); const cancel = new AbortController();
      const result = assert.rejects(deliver(cancel.signal), denied);
      const [socket] = await connected; socket.resume(); const closed = once(socket, 'close');
      const firstPid = await findSsh();
      cancel.abort('не выводить'); await result; await closed; await assert.rejects(access(firstPid), { code: 'ENOENT' });
      const connectedAgain = once(stall, 'connection'); const timedOut = assert.rejects(deliver(), denied);
      const [second] = await connectedAgain; second.resume(); const closedAgain = once(second, 'close');
      const secondPid = await findSsh();
      await timedOut; await closedAgain; await assert.rejects(access(secondPid), { code: 'ENOENT' });
    } finally { stall.close(); }
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    await stop(daemon); await stop(agent);
  }
});
