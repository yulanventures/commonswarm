# Storage backend decision

Use the Storage API S3 backend with Cloudflare R2 bucket `commonswarm-files`.

Evidence for this choice:

- File bytes stay outside the one Hetzner host. A disk or container loss does not remove the object copy.
- PostgreSQL still owns `storage.buckets` and `storage.objects`; the Storage API keeps the same signed upload and download endpoints used by CommonSwarm.
- The box keeps the ruled 4 GB memory budget and does not need disk capacity or filesystem backup work for user objects.
- The existing R2 credential and bucket are already available. No new provider is required.
- `migrate/copy-storage.sh` copies every `swarm-files` object through the source and target Storage APIs, then downloads the target object and compares SHA-256 and byte count. It is idempotent because target uploads use upsert.

The database dump includes the `storage` schema and bucket metadata. It does not contain object bytes. Run the object copy after restore and before Caddy switches.

Ruling 9084e3e1 makes the copy forward only. The scripts refuse the hosted project as a destination. Rollback is available only before the box accepts writes. After that decision point, fix forward on the box.
