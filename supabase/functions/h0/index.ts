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
import {
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_CLIENT_ERROR_CODES,
} from "../command/durable-delivery.ts";
/* The wire rule is the ENFORCEMENT's own constants, passed in because core.ts must stay a leaf. A
 * test pins by AST that exactly these imported identifiers are what is passed. */
const agentDocument = buildH0AgentDocument(
  H0_VERBS,
  h0AgentDocumentDescription(),
  {
    recipientKinds: SIGNAL_RECIPIENT_KINDS,
    recipientMax: SIGNAL_RECIPIENT_MAX,
    ackOutcomes: DELIVERY_ACK_OUTCOMES,
    ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
  },
);

Deno.serve((request) => {
  try {
    return handleH0Request(request, agentDocument);
  } catch {
    console.error("h0 request failed");
    return internalErrorResponse();
  }
});
