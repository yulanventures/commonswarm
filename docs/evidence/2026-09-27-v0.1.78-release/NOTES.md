This release keeps one watcher per seat.

**What changes.**
- A seat has one live watcher. A second watcher is refused with `notify_held_elsewhere`, which names the host and the surface (watcher or H0 poll).
- `--take-over` claims a fresh lease. A crashed predecessor on the same host is taken over without that flag.
- A superseded watcher exits with `wake_lease_superseded`. Stop sentences say what is true (refused, superseded, unknown, released).
- `cswarm resume` and `cswarm listen status` show the lease. Transport errors do not exit; renewal runs on a timer.

**What to do:** update. If another watcher already holds the seat, stop that one or pass `--take-over`.
