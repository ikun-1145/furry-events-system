"""Offline backup command tests: fake utilities, no database or network."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fcc-backup.sh"


class BackupTests(unittest.TestCase):
    def test_requires_attestation_before_running_utilities(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / "calls"
            env = {"PATH": "/usr/bin:/bin", "FCC_BACKUP_PARENT": root,
                   "PGSERVICE": "fcc_prod_readonly", "CALLS": str(marker)}
            proc = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2)
            self.assertFalse(marker.exists())
            self.assertEqual(list(Path(root).iterdir()), [])

    def test_backup_is_private_validated_and_does_not_claim_restore(self):
        with tempfile.TemporaryDirectory() as root:
            binpath = Path(root) / "bin"
            binpath.mkdir()
            dump = binpath / "pg_dump"
            dump.write_text("#!/bin/bash\nprintf 'dump\\n' >> \"$CALLS\"\nfor x in \"$@\"; do case $x in --file=*) target=${x#--file=};; esac; done\nprintf fixture > \"$target\"\n")
            restore = binpath / "pg_restore"
            restore.write_text("#!/bin/bash\nprintf 'list\\n' >> \"$CALLS\"\ntest \"$1\" = --list && test -f \"$2\"\n")
            psql = binpath / "psql"
            psql.write_text("#!/bin/bash\nfor arg in \"$@\"; do case $arg in --file=*) printf 'security\\n' >> \"$CALLS\"; printf '%s\\n' '{\"table\":\"public.furry_events\",\"sync_rpc\":\"public.sync_furry_events(jsonb,timestamptz,boolean)\",\"table_owner\":\"postgres\",\"rpc_owner\":\"postgres\",\"rls_enabled\":true,\"rls_forced\":false,\"table_acl\":[{\"grantee\":\"postgres\"}],\"column_acl\":[],\"policies\":[],\"rpc_acl\":[{\"grantee\":\"postgres\"}],\"role_memberships\":[],\"roles\":[{\"name\":\"postgres\"}]}'; exit 0;; esac; done\nprintf 'metadata\\n' >> \"$CALLS\"\nprintf '%s\\n' '{\"legacy_rows\":32,\"legacy_max_id\":809,\"sequence_last_value\":841,\"sequence_is_called\":true,\"sequence_increment\":1}'\n")
            for item in (dump, restore, psql):
                item.chmod(0o700)
            parent = Path(root) / "backups"
            parent.mkdir()
            calls = Path(root) / "calls"
            env = {**os.environ, "PATH": str(binpath) + ":/usr/bin:/bin", "FCC_BACKUP_PARENT": str(parent),
                   "PGSERVICE": "fcc_prod_readonly", "FCC_FREEZE_ATTESTED": "YES", "CALLS": str(calls)}
            proc = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("Not a restore test", proc.stdout)
            self.assertEqual(calls.read_text().splitlines(), ["dump", "dump", "metadata", "security", "list", "list"])
            destination, = list(parent.iterdir())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
            for filename in ("furry-events.dump", "public-schema.dump", "watermark.json", "legacy-security.json", "SHA256SUMS"):
                self.assertEqual(stat.S_IMODE((destination / filename).stat().st_mode), 0o600)
            checked = subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=destination, capture_output=True)
            self.assertEqual(checked.returncode, 0)

    def test_failed_dump_never_reports_complete(self):
        with tempfile.TemporaryDirectory() as root:
            binpath = Path(root) / "bin"
            binpath.mkdir()
            for name, body in (("pg_dump", "exit 1"), ("pg_restore", "exit 0"), ("psql", "exit 0")):
                f = binpath / name
                f.write_text("#!/bin/bash\n" + body + "\n")
                f.chmod(0o700)
            env = {**os.environ, "PATH": str(binpath) + ":/usr/bin:/bin", "FCC_BACKUP_PARENT": root,
                   "PGSERVICE": "fcc_prod_readonly", "FCC_FREEZE_ATTESTED": "YES"}
            proc = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn("Private backup created", proc.stdout)
            self.assertIn("Backup incomplete", proc.stderr)

    def test_unsafe_sequence_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            binpath = Path(root) / "bin"
            binpath.mkdir()
            entries = {
                "pg_dump": "for x in \"$@\"; do case $x in --file=*) target=${x#--file=};; esac; done\nprintf fixture > \"$target\"",
                "pg_restore": "exit 0",
                "psql": "for arg in \"$@\"; do case $arg in --file=*) printf '%s\\n' '{\"table\":\"public.furry_events\",\"sync_rpc\":\"public.sync_furry_events(jsonb,timestamptz,boolean)\",\"table_owner\":\"postgres\",\"rpc_owner\":\"postgres\",\"rls_enabled\":true,\"rls_forced\":false,\"table_acl\":[{\"grantee\":\"postgres\"}],\"column_acl\":[],\"policies\":[],\"rpc_acl\":[{\"grantee\":\"postgres\"}],\"role_memberships\":[],\"roles\":[{\"name\":\"postgres\"}]}'; exit 0;; esac; done\nprintf '%s\\n' '{\"legacy_rows\":32,\"legacy_max_id\":809,\"sequence_last_value\":809,\"sequence_is_called\":false,\"sequence_increment\":1}'",
            }
            for name, body in entries.items():
                item = binpath / name
                item.write_text("#!/bin/bash\n" + body + "\n")
                item.chmod(0o700)
            env = {**os.environ, "PATH": str(binpath) + ":/usr/bin:/bin", "FCC_BACKUP_PARENT": root,
                   "PGSERVICE": "fcc_prod_readonly", "FCC_FREEZE_ATTESTED": "YES"}
            proc = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn("Private backup created", proc.stdout)
            self.assertIn("unsafe legacy sequence watermark", proc.stderr)

    def test_missing_security_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            binpath = Path(root) / "bin"
            binpath.mkdir()
            entries = {
                "pg_dump": "for x in \"$@\"; do case $x in --file=*) target=${x#--file=};; esac; done\nprintf fixture > \"$target\"",
                "pg_restore": "exit 0",
                "psql": "for arg in \"$@\"; do case $arg in --file=*) printf '%s\\n' '{}'; exit 0;; esac; done\nprintf '%s\\n' '{\"legacy_rows\":32,\"legacy_max_id\":809,\"sequence_last_value\":841,\"sequence_is_called\":true,\"sequence_increment\":1}'",
            }
            for name, body in entries.items():
                item = binpath / name
                item.write_text("#!/bin/bash\n" + body + "\n")
                item.chmod(0o700)
            env = {**os.environ, "PATH": str(binpath) + ":/usr/bin:/bin", "FCC_BACKUP_PARENT": root,
                   "PGSERVICE": "fcc_prod_readonly", "FCC_FREEZE_ATTESTED": "YES"}
            proc = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn("Private backup created", proc.stdout)
            self.assertIn("invalid security metadata", proc.stderr)


if __name__ == "__main__":
    unittest.main()
