import { humanInvitationClient as transport } from './human-invitation-transport.js';
import { withClientBuild } from './client-build.js';
import { CLIENT_PROTOCOL_VERSION } from './config.js';
export * from './human-invitation-transport.js';
/** CLI commands report the same build as every other CLI transport. Browser
 * callers use the shared transport with their own browser envelope. */
export function humanInvitationClient(options: Omit<Parameters<typeof transport>[0], 'commandEnvelope'>) {
  return transport({ ...options, commandEnvelope: (commandId, command) =>
    withClientBuild({ command_id: commandId, client_version: CLIENT_PROTOCOL_VERSION, command }) });
}
