import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
} from "./core.ts";
import {
  H0_VERBS,
  h0AgentDocumentDescription,
} from "../../../src/h0/verbs.ts";
import {
  SIGNAL_RECIPIENT_KINDS,
  SIGNAL_RECIPIENT_MAX,
} from "../_shared/channels.ts";
/* The recipient rule is the ENFORCEMENT's own constants, passed in because core.ts must stay a
 * leaf. A test pins by AST that these two identifiers, from this module, are what is passed. */
const agentDocument = buildH0AgentDocument(
  H0_VERBS,
  h0AgentDocumentDescription(),
  { kinds: SIGNAL_RECIPIENT_KINDS, max: SIGNAL_RECIPIENT_MAX },
);

Deno.serve((request) => {
  try {
    return handleH0Request(request, agentDocument);
  } catch {
    console.error("h0 request failed");
    return internalErrorResponse();
  }
});
