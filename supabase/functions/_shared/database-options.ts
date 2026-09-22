export interface DatabaseTlsOptions {
  ssl: {
    ca: string;
    rejectUnauthorized: true;
  };
}

/** Add the private CA only when the worker receives one. */
export function withDatabaseTls<T extends Record<string, unknown>>(
  options: T,
  encodedCa: string | undefined,
): T | (T & DatabaseTlsOptions) {
  if (encodedCa === undefined || encodedCa.length === 0) return options;

  let ca: string;
  try {
    ca = atob(encodedCa);
  } catch {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must be valid base64");
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must decode to a PEM certificate");
  }
  return {
    ...options,
    ssl: { ca, rejectUnauthorized: true },
  };
}
