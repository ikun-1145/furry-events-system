#!/usr/bin/env bash
set -euo pipefail
set +x
# Defense in depth; workflow_dispatch has no override input.
[[ "${FCC_SYNC_ENABLED:-}" == true ]] || { echo 'Sync frozen'; exit 0; }
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Unapproved ref; sync frozen'; exit 0; }
: "${SUPABASE_FUNCTION_URL:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${FUNCTION_SECRET:?}"
[[ "$SUPABASE_FUNCTION_URL" == 'https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/fetch-furry-events' ]] || { echo 'Unexpected sync endpoint; refusing request'; exit 1; }
# Use the same bounded, no-retry, no-redirect client as the manual trigger.
# Secrets stay in the inherited process environment, not curl's argument list.
exec python3 scripts/fcc-manual-trigger.py
