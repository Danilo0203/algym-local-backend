#!/usr/bin/env python3
"""Extract data, without executing SQL, from an operator's private pg_dump file.

Keep the original dump: it remains the archive of device commands, Supabase
internal data, and any columns that the local runtime does not use.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ESCAPE = re.compile(r"\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)")
CONTROL = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}


def decode_copy(value):
    if value == r"\N":
        return None
    def replace(match):
        token = match[1]
        if token[0] in "01234567":
            return chr(int(token, 8))
        if token[0] == "x" and len(token) > 1:
            return chr(int(token[1:], 16))
        return CONTROL.get(token, token)
    return ESCAPE.sub(replace, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pg-restore", required=True)
    parser.add_argument("--captured-at", required=True, help="UTC ISO timestamp of the source snapshot")
    parser.add_argument("--archive-clock-commands", action="store_true", required=True,
                        help="Explicitly keep device commands only in the original dump")
    args = parser.parse_args()
    if datetime.fromisoformat(args.captured_at.replace("Z", "+00:00")).tzinfo is None:
        raise ValueError("The snapshot timestamp must include its timezone")
    if args.dump.is_symlink() or not args.dump.is_file() or args.output.exists():
        raise ValueError("Invalid input or existing output")
    os.umask(0o077)
    hasher = hashlib.sha256()
    with args.dump.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    digest = hasher.hexdigest()
    # --file=- emits COPY text. It never restores into a database.
    process = subprocess.Popen([args.pg_restore, "--data-only", "--file=-", "--schema=public", "--schema=auth", str(args.dump)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf8")
    tables, current, archived, counting = [], None, 0, False
    try:
        for line in process.stdout:
            line = line.rstrip("\n")
            if line.startswith("COPY "):
                match = re.fullmatch(r"COPY (public|auth)\.([a-z_]+) \(([^)]+)\) FROM stdin;", line)
                if not match:
                    raise ValueError("Unsupported COPY header; inspect the source schema")
                schema, name, columns = match.groups()
                current = {"schema": schema, "name": name, "columns": [x.strip(' "') for x in columns.split(",")], "rows": []}
                counting = schema == "public" and name == "device_commands"
                if schema == "public" or name in ("users", "identities"):
                    tables.append(current)
                else:
                    current = None
                if counting:
                    current = None
            elif line == r"\.":
                current, counting = None, False
            elif counting:
                archived += 1
            elif current is not None:
                values = [decode_copy(x) for x in line.split("\t")]
                if len(values) != len(current["columns"]):
                    raise ValueError("Invalid COPY row")
                current["rows"].append(values)
        if process.wait() != 0:
            raise ValueError("pg_restore could not read the complete dump")
        result = {"kind": "AlGym.Hostinger.ReadOnlySnapshot", "capturedAt": args.captured_at,
                  "dumpSha256": digest, "tables": tables, "archivedDeviceCommands": archived}
        with args.output.open("x", encoding="utf8") as output:
            json.dump(result, output, separators=(",", ":"))
        print(json.dumps({"tables": {t["schema"]+"."+t["name"]: len(t["rows"]) for t in tables},
                          "archivedDeviceCommands": archived, "dumpSha256": digest}))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()


if __name__ == "__main__":
    main()
