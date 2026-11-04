/** file_put for the hosted MCP: reserve, upload and commit one version inside the function.
 *
 * The reservation's signed upload path and token are consumed here and never returned. Command
 * ids derive from (workspace, seat, request_id) and the reserved ids also bind the content
 * digest, so a retry replays the ledger and a retry with changed content is refused at reserve
 * as command_id_conflict. Commit measures the stored object, so an upload that did not land
 * cannot commit. */
import type { CommandResult, HostedCommandInput } from "../command/contract.d.ts";
import type { HostedSeatCapability } from "../_shared/hosted-seat-auth.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { contentTypeForName } from "../../../src/protocol/file-types.ts";
import {
  FileContentUnavailable,
  decodeBase64,
  isTextContentType,
  putIds,
  putObjectBytes,
  sha256Hex,
} from "./file-content.ts";
import { HostedToolFailure } from "./tool-errors.ts";

export interface FilePutDeps {
  handleHostedCommand: (input: HostedCommandInput, capability: HostedSeatCapability) => Promise<CommandResult>;
  baseUrl: string | null;
  fetchImpl?: typeof fetch;
}

export async function executeFilePut(
  args: Record<string, unknown>,
  binding: { workspaceId: string; handle: string },
  capability: HostedSeatCapability,
  deps: FilePutDeps,
): Promise<Record<string, unknown>> {
  const name = String(args.name);
  const contentType = contentTypeForName(name);
  if (contentType === null) throw new HostedToolFailure("invalid_request");
  if (args.content !== undefined && !isTextContentType(contentType)) throw new HostedToolFailure("file_text_type_required");
  const bytes = args.content !== undefined
    ? new TextEncoder().encode(String(args.content))
    : decodeBase64(String(args.content_base64));
  if (!deps.baseUrl) throw new HostedToolFailure("file_content_unavailable");
  const sha256 = await sha256Hex(bytes);
  const ids = await putIds(binding.workspaceId, binding.handle, String(args.request_id), sha256);
  const envelope = (commandId: string, command: Record<string, unknown>) => ({
    command_id: commandId,
    client_version: "0.1.80",
    workspace_id: binding.workspaceId,
    stream: { kind: "workspace" },
    command,
  }) as unknown as HostedCommandInput;
  const created = await deps.handleHostedCommand(envelope(ids.create_command_id, {
    kind: "file_version_create",
    file_id: ids.file_id,
    version_id: ids.version_id,
    name,
    declared_size_bytes: bytes.byteLength,
    content_type: contentType,
  }), capability);
  if (created.status !== 200) throw new HostedToolFailure(created.body.error, created.body.resets_at);
  const fileId = String(created.body.file_id);
  try {
    // A replayed reservation may already hold the bytes; commit decides either way.
    await putObjectBytes(deps.baseUrl, String(created.body.upload_path), bytes, contentType, deps.fetchImpl);
  } catch (error) {
    if (!(error instanceof FileContentUnavailable)) throw error;
    throw new HostedToolFailure("file_content_unavailable");
  }
  const committed = await deps.handleHostedCommand(envelope(ids.commit_command_id, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: ids.version_id,
    sha256,
  }), capability);
  if (committed.status !== 200) throw new HostedToolFailure(committed.body.error, committed.body.resets_at);
  return {
    file_id: committed.body.file_id,
    version_n: committed.body.version_n,
    name: committed.body.name,
    size_bytes: committed.body.size_bytes,
    content_type: contentType,
  };
}
