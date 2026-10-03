import { ADMIN_GATE_URL, parseAdminGate } from "./admin-delegations-contract.js";

/** Public AS-owned read, independent of account recovery and human credentials. */
export async function readAdminIssuanceGate(fetcher: typeof fetch = fetch): Promise<ReturnType<typeof parseAdminGate>> {
  try {
    const response = await fetcher(ADMIN_GATE_URL, {
      method: "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { state: "unavailable" };
    return parseAdminGate(await response.json());
  } catch { return { state: "unavailable" }; }
}
