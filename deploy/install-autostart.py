#!/usr/bin/env python3
"""Install/remove only CommaPlay's background hook, preserving the boot script."""
# Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

BEGIN = '# BEGIN CommaPlay autostart'
END = '# END CommaPlay autostart'
HOOK = f'''{BEGIN}
if [ -x /data/commaplay/deploy/start.sh ]; then
    ( sudo -n timeout 210 /data/commaplay/deploy/start.sh ) >/dev/null 2>&1 &
fi
{END}
'''
ANCHOR = 'exec ./launch_openpilot.sh'


def updated(source, remove=False):
    if BEGIN in source or END in source:
        if source.count(BEGIN) != 1 or source.count(END) != 1:
            raise ValueError('ambiguous existing CommaPlay hook')
        start = source.index(BEGIN)
        end = source.index(END, start) + len(END)
        if source[end:end + 1] == '\n':
            end += 1
        if source[start:end] != HOOK:
            raise ValueError('existing CommaPlay hook was modified; review manually')
        source = source[:start] + source[end:]
    if remove:
        return source
    lines = source.splitlines(keepends=True)
    positions = [i for i, line in enumerate(lines) if line.strip() == ANCHOR]
    if len(positions) != 1:
        raise ValueError('expected exactly one openpilot launch anchor')
    lines.insert(positions[0], HOOK)
    return ''.join(lines)


def install(path, remove=False):
    if path.is_symlink() or not path.is_file():
        raise ValueError('boot script must be a regular file')
    original = path.read_bytes()
    result = updated(original.decode(), remove).encode()
    if result == original:
        return False
    backup = path.with_name(path.name + '.commaplay-backup')
    if not backup.exists():
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as file:
            file.write(original)
            file.flush()
            os.fsync(file.fileno())
    info = path.stat()
    fd, temporary = tempfile.mkstemp(prefix='.commaplay-boot-', dir=path.parent)
    staged = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(result)
            file.flush()
            os.fsync(file.fileno())
        subprocess.run(['bash', '-n', str(staged)], check=True)
        os.chown(staged, info.st_uid, info.st_gid)
        os.chmod(staged, info.st_mode & 0o7777)
        if path.read_bytes() != original:
            raise ValueError('boot script changed during installation')
        os.replace(staged, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        staged.unlink(missing_ok=True)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('run with sudo')
    changed = install(Path('/data/continue.sh'), args.remove)
    print('CommaPlay autostart ' + ('removed' if args.remove else 'installed') +
          ('; boot script updated' if changed else '; already configured'))
