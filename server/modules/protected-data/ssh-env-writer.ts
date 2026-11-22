import { PROTECTED_DATA_MAX_BODY_BYTES, PROTECTED_DATA_MAX_FIELDS, PROTECTED_DATA_MAX_VALUE_BYTES } from './protocol.js';

// GOLDJAXE fork (реестр §27.5): весь код известен до запроса. OpenSSH передаёт
// одну командную строку login-shell; ни одно поле назначения или набора в неё не входит.
// Изолированный Python из стандартной системы, без импортов из cwd, site и PYTHONPATH.
// Только обычные Unix-права: chmod(0640) не должен раскрыть файл через унаследованный ACL.
const PYTHON = String.raw`
import fcntl, json, os, re, secrets, signal, stat, sys

LIMIT = 65536
DIR = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
UID = os.geteuid()

def require(ok):
    if not ok:
        raise ValueError()

def expire(*_):
    raise TimeoutError()

def check_chars(text):
    require(all(n not in (0, 0xfeff) and not 0xfdd0 <= n <= 0xfdef and (n & 0xffff) < 0xfffe for n in map(ord, text)))

def parse(payload):
    require(type(payload) is list and len(payload) == 3)
    nonce, path, fields = payload
    require(re.fullmatch(r"[0-9a-f]{64}", nonce))
    require(len(path) <= 4096 and path.startswith("/"))
    parts = path[1:].split("/")
    require(all(re.fullmatch(r"[\w.-]+", p, re.ASCII) and p not in (".", "..", ".git") for p in parts))
    require(re.fullmatch(r"(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.env)", parts[-1], re.ASCII))
    require(type(fields) is list and 0 < len(fields) <= ${PROTECTED_DATA_MAX_FIELDS})
    changes = {}
    for pair in fields:
        require(type(pair) is list and len(pair) == 2)
        key, value = pair
        require(re.fullmatch(r"[A-Za-z_]\w{0,31}", key, re.ASCII) and key not in changes)
        require(type(value) is str and 0 < len(value.encode("utf-8")) <= ${PROTECTED_DATA_MAX_VALUE_BYTES})
        check_chars(value)
        require(not re.search(r"[\x00-\x1f\x7f-\x9f]", value))
        escaped = re.sub(r'["\\\x60$]', lambda m: "\\" + m[0], value)
        changes[key] = key + '="' + escaped + '"'
    return nonce, parts, changes

def update(data, changes):
    text = data.decode("utf-8")
    check_chars(text)
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(eol) if text else []
    seen = set()
    for i, line in enumerate(lines):
        require(not re.search(r"[\r\n]", line) and not line.endswith("\\"))
        if not line.strip(" \t") or line.lstrip(" \t").startswith(("#", ";")):
            continue
        m = re.fullmatch(r"[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)", line)
        require(m)
        key, body = m.groups()
        require(key not in seen)
        if body.startswith(('"', "'")):
            require(re.fullmatch(r'''(?:'[^']*'|"(?:[^"\\]|\\.)*")[ \t]*''', body))
        seen.add(key)
        if key in changes:
            lines[i] = changes[key]
    additions = [line for key, line in changes.items() if key not in seen]
    if additions:
        if lines and lines[-1] == "":
            lines.pop()
        lines.extend(additions + [""])
    result = eol.join(lines).encode("utf-8")
    require(len(result) <= LIMIT)
    return result

def identity(s):
    return s.st_dev, s.st_ino, s.st_ctime_ns, s.st_size

def replace(d, name, changes):
    fcntl.flock(d, fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = os.stat(name, dir_fd=d, follow_symlinks=False)
    mode = stat.S_IMODE(before.st_mode)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == UID)
    require(mode in (0o600, 0o640) and before.st_size <= LIMIT)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
    with os.fdopen(fd, "rb") as src:
        require(identity(os.fstat(fd)) == identity(before))
        require("system.posix_acl_access" not in os.listxattr(fd))
        data = src.read(LIMIT + 1)
        require(len(data) == before.st_size)
        result = update(data, changes)
    temp = ".cloudcli-env-" + secrets.token_hex(16) + ".tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=d)
    try:
        with os.fdopen(fd, "wb") as out:
            require("system.posix_acl_access" not in os.listxattr(fd))
            out.write(result)
            out.flush()
            if os.fstat(fd).st_gid != before.st_gid:
                os.fchown(fd, UID, before.st_gid)
            os.fchmod(fd, mode)
            os.fsync(fd)
        require(identity(os.stat(name, dir_fd=d, follow_symlinks=False)) == identity(before))
        os.replace(temp, name, src_dir_fd=d, dst_dir_fd=d)
        temp = None
        os.fsync(d)
    finally:
        if temp is not None:
            os.unlink(temp, dir_fd=d)

def main():
    for sig in (signal.SIGALRM, signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, expire)
    signal.alarm(10)
    os.umask(0o077)
    data = sys.stdin.buffer.read(${PROTECTED_DATA_MAX_BODY_BYTES} + 1)
    require(len(data) <= ${PROTECTED_DATA_MAX_BODY_BYTES})
    nonce, parts, changes = parse(json.loads(data.decode("utf-8")))
    d = os.open("/", DIR)
    try:
        for part in [None] + parts[:-1]:
            if part is not None:
                child = os.open(part, DIR, dir_fd=d)
                os.close(d)
                d = child
            s = os.fstat(d)
            require(s.st_uid in (0, UID) and not (s.st_mode & 0o022))
        replace(d, parts[-1], changes)
    finally:
        os.close(d)
    sys.stdout.buffer.write(nonce.encode("ascii") + b"\n")
    sys.stdout.buffer.flush()

try:
    main()
except Exception:
    sys.exit(1)
`;

export const SSH_ENV_COMMAND = `exec /usr/bin/python3 -I -S -c '${PYTHON.replaceAll("'", "'\\''")}'`;
