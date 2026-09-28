#!/usr/bin/env bash
set -euo pipefail

# Node --test prints this file's test results at column 0. A pattern that selects
# no tests can instead emit a column-0 file wrapper, and "# tests" counts that
# wrapper, so it cannot be used as the executed-test count.
awk -v repeat_file="$REPEAT_FILE" '
  function is_file_wrapper(description) {
    if (description == repeat_file) {
      return 1
    }

    return repeat_file !~ /^\// &&
      length(description) > length(repeat_file) &&
      substr(description, length(description) - length(repeat_file) + 1) == repeat_file &&
      substr(description, length(description) - length(repeat_file), 1) == "/"
  }

  /^1\.\.0([[:space:]]*#.*)?$/ {
    saw_empty_top_level_plan = 1
    next
  }

  /^(ok|not ok) [0-9]+ - / {
    description = $0
    sub(/^(ok|not ok) [0-9]+ - /, "", description)
    if (description ~ /# (SKIP|TODO)([[:space:]]|$)/ || is_file_wrapper(description)) {
      next
    }
    executed_subtests += 1
  }

  END {
    if (saw_empty_top_level_plan) {
      print 0
    } else {
      print executed_subtests + 0
    }
  }
'
