#!/usr/bin/env bash
# Same shape as restore-cron-jobs.sh and verify-counts.sh: the comparator runs under if !.
set -euo pipefail
source "${LIB:?}"
if ! compare_cron_job_listings "${EXPECTED:?}" "${ACTUAL:?}"; then
  exit 1
fi
