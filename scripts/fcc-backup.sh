#!/usr/bin/env bash
# Future maintenance-window command only. This script is not an authorization.
# The operator must independently establish that *all* old writers are frozen
# and drained and that PGSERVICE selects the intended read-only production DB.
set -euo pipefail
set +x
umask 077

if [[ ${FCC_FREEZE_ATTESTED:-} != YES || ${PGSERVICE:-} != fcc_prod_readonly ]]; then
  echo 'Stopped: verified freeze attestation and fcc_prod_readonly service required.' >&2
  exit 2
fi
if [[ ${FCC_BACKUP_PARENT:-} != /* || ! -d ${FCC_BACKUP_PARENT:-} || ! -w ${FCC_BACKUP_PARENT:-} ]]; then
  echo 'Stopped: FCC_BACKUP_PARENT must be an existing writable absolute directory.' >&2
  exit 2
fi
for command in pg_dump pg_restore psql python3 sha256sum mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Stopped: missing required backup utility: $command" >&2
    exit 2
  fi
done

destination=$(mktemp -d "$FCC_BACKUP_PARENT/fcc-backup.XXXXXXXX")
chmod 700 "$destination"
trap 'echo "Backup incomplete. Preserve and inspect the private directory: $destination" >&2' ERR

# Force read-only sessions without exposing connection credentials in arguments.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on"
pg_dump --format=custom --table=public.furry_events --file="$destination/furry-events.dump"
pg_dump --format=custom --schema-only --schema=public --file="$destination/public-schema.dump"
# pg_dump schema-only does not capture the current value of the shared sequence.
# Store counts and sequence state without event content or connection details.
# This read is valid only after independently verifying all writers are drained.
psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --command="select json_build_object('legacy_rows',(select count(*) from public.furry_events),'legacy_max_id',(select max(id) from public.furry_events),'sequence_last_value',s.last_value,'sequence_is_called',s.is_called,'sequence_increment',(select increment_by from pg_catalog.pg_sequences where schemaname='public' and sequencename='furry_events_id_seq')) from public.furry_events_id_seq s" \
  > "$destination/watermark.json"
test -s "$destination/watermark.json"
# Capture security metadata without role passwords or per-role settings. A separate
# pre-fence capture is required to restore the *original* privileges after revoke.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --file="$script_dir/../sql/review/fcc_legacy_security_snapshot.sql" > "$destination/legacy-security.json"
test -s "$destination/legacy-security.json"
# A reused sequence must produce IDs greater than every old ID. Do not reset it.
python3 - "$destination/watermark.json" "$destination/legacy-security.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as file:
        data = json.load(file)
    rows, maximum = data["legacy_rows"], data["legacy_max_id"]
    last, called, step = data["sequence_last_value"], data["sequence_is_called"], data["sequence_increment"]
    if type(rows) is not int or rows < 0 or type(last) is not int or type(called) is not bool or type(step) is not int or step <= 0:
        raise ValueError
    if (rows == 0) != (maximum is None) or (maximum is not None and (type(maximum) is not int or last + (step if called else 0) <= maximum)):
        raise ValueError
    with open(sys.argv[2], encoding="utf-8") as file:
        security = json.load(file)
    if (security.get("table") != "public.furry_events" or security.get("sync_rpc") != "public.sync_furry_events(jsonb,timestamptz,boolean)"
            or not isinstance(security.get("table_owner"), str) or not isinstance(security.get("rpc_owner"), str)
            or type(security.get("rls_enabled")) is not bool or type(security.get("rls_forced")) is not bool
            or any(not isinstance(security.get(key), list) for key in ("table_acl", "column_acl", "policies", "rpc_acl", "role_memberships", "roles"))
            or not security["table_acl"] or not security["rpc_acl"] or not security["roles"]):
        raise ValueError
except (OSError, ValueError, TypeError, KeyError):
    print("Stopped: invalid security metadata or unsafe legacy sequence watermark.", file=sys.stderr)
    sys.exit(1)
PY
pg_restore --list "$destination/furry-events.dump" >/dev/null
pg_restore --list "$destination/public-schema.dump" >/dev/null
(cd "$destination" && sha256sum furry-events.dump public-schema.dump watermark.json legacy-security.json > SHA256SUMS && sha256sum --check --status SHA256SUMS)
chmod 600 "$destination/furry-events.dump" "$destination/public-schema.dump" "$destination/watermark.json" "$destination/legacy-security.json" "$destination/SHA256SUMS"
trap - ERR
printf 'Private backup created: %s\n' "$destination"
echo 'Not a restore test: separately verify project identity, roles, grants and isolated restore before migration.'
