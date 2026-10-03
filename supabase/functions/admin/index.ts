// This entry shares command's verified delegated actor and account transaction.
// The router prepares /admin; production ingress and issuance activation remain
// release-owned and closed.
export { handleAdminMcpRequest as handleRequest } from '../command/index.ts';
import { handleAdminMcpRequest } from '../command/index.ts';
if (import.meta.main) Deno.serve(handleAdminMcpRequest);
