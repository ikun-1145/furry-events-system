#!/usr/bin/env bash
set -euo pipefail
set +x
# Defense in depth; workflow_dispatch has no override input.
[[ "${FCC_SYNC_ENABLED:-}" == true ]] || { echo 'Sync frozen'; exit 0; }
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Unapproved ref; sync frozen'; exit 0; }
: "${SUPABASE_FUNCTION_URL:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${FUNCTION_SECRET:?}"
[[ "$SUPABASE_FUNCTION_URL" == 'https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/fetch-furry-events' ]] || { echo 'Unexpected sync endpoint; refusing request'; exit 1; }
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
trigger=scheduled
[[ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]] || trigger=manual
# No curl automatic retries. Ambiguous timeouts require operator reconciliation.
status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 120 --retry 0 --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  --header "x-function-secret: $FUNCTION_SECRET" --header "x-sync-trigger: $trigger" \
  --data '{"allow_empty":false}' "$SUPABASE_FUNCTION_URL")
[[ "$status" == 200 ]] || { echo 'Sync failed; inspect controlled server telemetry'; exit 1; }
# Print neither the arbitrary response body nor credentials.
jq -e '.success == true and .source == "fcc" and .deactivated == 0 and .errors == []' "$response_file" >/dev/null
echo 'FCC sync completed with zero deactivations'
