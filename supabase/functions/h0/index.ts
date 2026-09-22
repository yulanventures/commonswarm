import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
} from "./core.ts";
import {
  H0ClientAbort,
  h0VerbFailure,
  h0RetryableDatabaseFailure,
  handleH0AckRequest,
  handleH0PollRequest,
} from "./poll-ack.ts";
import { h0VerbPath } from "./parse.ts";
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
import { H0_SEAT_TOKEN_TTL_MS } from "../_shared/protocol.js";
/* The wire rule is the ENFORCEMENT's own constants, passed in because core.ts must stay a leaf. A
 * test pins by AST that exactly these imported identifiers are what is passed. */
const agentDocument = buildH0AgentDocument(
  H0_VERBS,
  h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS),
  {
    recipientKinds: SIGNAL_RECIPIENT_KINDS,
    recipientMax: SIGNAL_RECIPIENT_MAX,
    ackOutcomes: DELIVERY_ACK_OUTCOMES,
    ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
  },
);

Deno.serve((request) => {
  try {
    const verb = h0VerbPath(new URL(request.url).pathname);
    if (verb === "poll") {
      return handleH0PollRequest(request).catch((error: unknown) => {
        if (error instanceof H0ClientAbort) return new Response(null, { status: 204 });
        const retryable = h0RetryableDatabaseFailure(error);
        if (retryable !== null) return retryable;
        console.error("h0 poll failed");
        return h0VerbFailure();
      });
    }
    if (verb === "ack") {
      return handleH0AckRequest(request).catch((error: unknown) => {
        const retryable = h0RetryableDatabaseFailure(error);
        if (retryable !== null) return retryable;
        console.error("h0 ack failed");
        return h0VerbFailure();
      });
    }
    return handleH0Request(request, agentDocument);
  } catch {
    console.error("h0 request failed");
    return internalErrorResponse();
  }
});
