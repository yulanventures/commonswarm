import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
} from "./core.ts";
import {
  H0_VERBS,
  h0AgentDocumentDescription,
} from "../../../src/h0/verbs.ts";
const agentDocument = buildH0AgentDocument(
  H0_VERBS,
  h0AgentDocumentDescription(),
);

Deno.serve((request) => {
  try {
    return handleH0Request(request, agentDocument);
  } catch {
    console.error("h0 request failed");
    return internalErrorResponse();
  }
});
