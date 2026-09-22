import { readFile, writeFile, stat } from "node:fs/promises";

// No source/admin URL is read or forwarded. Only the restricted backup password.
const envPath = process.env.COMMONSWARM_ENV_FILE || "/home/commonswarm/.env";
const output = process.env.PG_SERVICE_OUTPUT;
const passOutput = process.env.PG_PASS_OUTPUT;
if (!output || !passOutput) throw new Error("protected service output paths are required");
if (((await stat(envPath)).mode & 0o077) !== 0) throw new Error("environment file must be private");
const matches = (await readFile(envPath, "utf8")).split(/\r?\n/).filter(line => line.startsWith("BACKUP_RO_PASSWORD="));
if (matches.length !== 1) throw new Error("exactly one BACKUP_RO_PASSWORD is required");
const password = matches[0].slice("BACKUP_RO_PASSWORD=".length);
if (!password || /^["']/.test(password) || /[\r\n]/.test(password)) throw new Error("invalid backup password encoding");
const escape = value => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
await writeFile(output, `[backup]
host=db.commonswarm.internal
hostaddr=172.31.0.10
port=5432
dbname=postgres
user=backup_ro
sslmode=verify-full
sslrootcert=/etc/ssl/yulan-internal-ca.pem
connect_timeout=10
options=-c default_transaction_read_only=on -c row_security=off
`, { mode: 0o600 });
await writeFile(passOutput, `db.commonswarm.internal:5432:postgres:backup_ro:${escape(password)}\n`, { mode: 0o600 });
