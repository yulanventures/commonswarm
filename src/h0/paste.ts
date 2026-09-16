import { H0_PREAUTH_VERBS } from "./verbs.js";

export interface H0AgentPasteInput {
  joinCredential: string;
  documentUrl: string;
}

const JOIN_CREDENTIAL_RE = /^swm_join_[A-Za-z0-9_-]{43}$/;

function preauthVerb(): string {
  if (H0_PREAUTH_VERBS.length !== 1) {
    throw new Error("The H0 agent paste requires exactly one pre-auth verb");
  }
  return H0_PREAUTH_VERBS[0]!;
}

/** Build the complete message that a human pastes into a fresh agent session. */
export function h0AgentPaste(input: H0AgentPasteInput): string {
  if (!JOIN_CREDENTIAL_RE.test(input.joinCredential)) {
    throw new Error("joinCredential must be swm_join_ followed by 43 base64url characters");
  }

  let document: URL;
  try {
    document = new URL(input.documentUrl);
  } catch {
    throw new Error("documentUrl must be an absolute HTTP(S) URL");
  }
  /*
   * HTTPS ONLY, with plain HTTP allowed solely for a loopback host (local `npm run db:start` serves
   * 127.0.0.1:54321). The first version accepted any `http:` URL. That matters more than it looks:
   * the agent reads the register endpoint from the document it fetched, so a plaintext document
   * leads it to POST the join credential in cleartext — the one value this whole design keeps off
   * every public channel. A URL a human pastes is not a place to let that slide.
   */
  const loopback = document.hostname === "localhost" ||
    document.hostname === "127.0.0.1" ||
    document.hostname === "[::1]";
  if (document.protocol !== "https:" && !(document.protocol === "http:" && loopback)) {
    throw new Error("documentUrl must be HTTPS (plain HTTP is allowed only for a loopback host)");
  }
  if (input.documentUrl.includes("?") || document.search !== "") {
    throw new Error("documentUrl must not contain a query string");
  }
  if (input.documentUrl.includes("#") || document.hash !== "") {
    throw new Error("documentUrl must not contain a fragment");
  }

  let decodedDocumentUrl: string;
  try {
    decodedDocumentUrl = decodeURIComponent(input.documentUrl);
  } catch {
    decodedDocumentUrl = input.documentUrl;
  }
  /*
   * The SECRET BODY as well as the whole credential. The `swm_join_` prefix is public and carries
   * no entropy; the 43 characters after it are the secret. A URL holding only those 43 characters
   * leaks the credential just as completely, and the first version checked only the prefixed form.
   */
  const secretBody = input.joinCredential.slice("swm_join_".length);
  const carriesSecret = (value: string) =>
    value.includes(input.joinCredential) || value.includes(secretBody);
  if (
    carriesSecret(input.documentUrl) ||
    carriesSecret(document.href) ||
    carriesSecret(decodedDocumentUrl)
  ) {
    throw new Error("documentUrl must not contain the join credential");
  }

  const verb = preauthVerb();
  return [
    "Fetch the agent document at the URL below.",
    `The single-purpose join credential is ${input.joinCredential}; use it only to ${verb}.`,
    input.documentUrl,
  ].join("\n");
}
