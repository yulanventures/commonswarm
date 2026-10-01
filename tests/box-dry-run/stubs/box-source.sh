# Loaded by the remote BASH_ENV, including its nested bash shells. Sourcing stays
# in the caller's shell; only the file's box paths are projected, never its values
# evaluated by a separate process. Keep the original fixture bytes unchanged.
source() {
  local box_dry_run_source_copy box_dry_run_source_status
  box_dry_run_source_copy=$(/usr/bin/python3 "$BOX_DRY_RUN_USERLAND" source-file "$1") || return $?
  shift
  builtin source "$box_dry_run_source_copy" "$@"
  box_dry_run_source_status=$?
  /bin/rm -f "$box_dry_run_source_copy"
  return "$box_dry_run_source_status"
}
function . { source "$@"; }
