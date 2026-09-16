import { H0_PREAUTH_VERBS } from "./verbs.js";

export interface H0AgentPasteInput {
  joinCredential: string;
  documentUrl: string;
}

const JOIN_CREDENTIAL_PREFIX = "swm_join_";
const JOIN_CREDENTIAL_RE = /^swm_join_[A-Za-z0-9_-]{43}$/;

/*
 * THE THREAT MODEL THIS GUARD SERVES, stated so nobody reads more into it. The document URL is built
 * by our own app from a random locator that is independent of the credential. An attacker who could
 * choose `documentUrl` would already control the entire paste, so this is not a defence against a
 * hostile caller. It is a defence against a CODING MISTAKE that puts secret material into the one
 * value that link previewers, scanners, proxies and CDN logs all see — for example, a future lane
 * using the credential, or part of it, as the locator.
 *
 * Within that model it refuses any 12 CONTIGUOUS characters of the 43-character secret body
 * (about 72 bits), in any letter case, after repeated percent-decoding, anywhere in the URL. That
 * covers the whole credential, the body without its public prefix, a truncated body, a secret split
 * into pieces AS LONG AS one piece keeps 12 contiguous characters, a case-folded hostname, and
 * single or double percent-encoding.
 *
 * WHAT IT MISSES, stated because an arm caught an earlier version of this comment overclaiming:
 * a piece shorter than 12 characters, so a secret chopped into short chunks passes; the public
 * `swm_join_` prefix, which carries no entropy and is not checked at all; and any transformed
 * secret (hashed, reversed, hex). A window short enough to catch short chunks would start refusing
 * ordinary URLs, so the line is drawn at 12 on purpose.
 */
const SECRET_WINDOW = 12;

function preauthVerb(): string {
  if (H0_PREAUTH_VERBS.length !== 1) {
    throw new Error("The H0 agent paste requires exactly one pre-auth verb");
  }
  return H0_PREAUTH_VERBS[0]!;
}

/** Decode until stable, so nested encoding cannot hide a value. A malformed escape is REFUSED. */
const MAX_DECODE_ROUNDS = 4;
function fullyDecoded(value: string): string {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      /* The first version fell back to the undecoded string here, which let a malformed escape
       * anywhere in the URL switch the decoded check off entirely. Our app never builds such a
       * URL, so one arriving here is a bug, and a bug near a secret is refused. */
      throw new Error("documentUrl has a malformed percent-escape");
    }
    if (next === current) return current;
    current = next;
  }
  /* The first version fell through and returned a value that was STILL encoded after the last
   * round, so five nested encodings hid a secret silently. An arm found it. Our app never builds a
   * URL like that, so it is refused. */
  throw new Error("documentUrl has excessively nested percent-encoding");
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
    throw new Error("documentUrl must be an absolute HTTPS URL");
  }

  /*
   * HTTPS ONLY, with plain HTTP allowed solely for a loopback host (local `npm run db:start` serves
   * 127.0.0.1:54321). The agent reads the register endpoint from the document it fetched, so a
   * plaintext document leads it to POST the join credential in cleartext. This refuses a plaintext
   * document URL; it cannot stop a server from redirecting an HTTPS request to HTTP, and it does
   * not claim to.
   */
  const loopback = document.hostname === "localhost" ||
    document.hostname === "127.0.0.1" ||
    document.hostname === "[::1]";
  if (document.protocol !== "https:" && !(document.protocol === "http:" && loopback)) {
    throw new Error("documentUrl must be HTTPS (plain HTTP is allowed only for a loopback host)");
  }
  /* `https://commonswarm.com@attacker.example/doc` shows one host to a human and fetches another.
   * Our URLs never carry userinfo, so any is refused. */
  /* Both halves: `https://:pass@host/` has an empty username and a password. */
  if (document.username !== "" || document.password !== "") {
    throw new Error("documentUrl must not contain userinfo");
  }
  /* The raw `includes` is not redundant: `https://host/doc?` parses to an EMPTY search. */
  if (input.documentUrl.includes("?") || document.search !== "") {
    throw new Error("documentUrl must not contain a query string");
  }
  if (input.documentUrl.includes("#") || document.hash !== "") {
    throw new Error("documentUrl must not contain a fragment");
  }

  const secretBody = input.joinCredential.slice(JOIN_CREDENTIAL_PREFIX.length).toLowerCase();
  /* `document.href` is not redundant with the raw input: the URL parser strips ASCII tab, CR and
   * LF, so a secret split by those characters is contiguous ONLY in the parsed form. */
  const haystack = [input.documentUrl, document.href, fullyDecoded(input.documentUrl),
    fullyDecoded(document.href)].join("\n").toLowerCase();
  for (let start = 0; start + SECRET_WINDOW <= secretBody.length; start++) {
    if (haystack.includes(secretBody.slice(start, start + SECRET_WINDOW))) {
      throw new Error(
        `documentUrl must not contain ${SECRET_WINDOW} or more consecutive characters of the join credential`,
      );
    }
  }

  /*
   * EACH VALUE STANDS ON ITS OWN LINE, DIRECTLY UNDER THE SENTENCE THAT NAMES IT. An earlier version
   * ended a sentence with the credential —
   * `...credential is swm_join_…; use it only to …` — and a model extracting the token from prose can
   * easily take the adjoining semicolon with it, which the register endpoint's exact shape check then
   * refuses. The first sentence also says the document needs no credential, because a model handed a
   * secret next to a URL may otherwise send it when fetching the URL. And the URL now follows the
   * fetch sentence rather than sitting under a line ending "credential:", which invited an agent to
   * read the wrong value as the credential.
   *
   * The URL returned is the parsed, canonical form that was actually validated, not the raw input.
   */
  const verb = preauthVerb();
  /*
   * ONLY THE LINE BEFORE THE CREDENTIAL ENDS IN "credential:". The previous wording ended the fetch
   * line that way too, so an agent taking "the line after `credential:`" would pick the URL first.
   * And the register sentence points at the document for the call's fields: "sending only this
   * credential" could be read as "the body is this one field", while register also requires
   * `attemptId` and `name`.
   */
  return [
    "First fetch this agent document; reading it requires no login or key:",
    document.href,
    `Then call ${verb} once as that document describes, using this single-purpose join credential:`,
    input.joinCredential,
  ].join("\n");
}
