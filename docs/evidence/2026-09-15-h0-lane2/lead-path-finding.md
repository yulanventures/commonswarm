# Lane 2 risk I found myself: the path matcher may 404 in production while every test passes

`supabase/functions/h0/core.ts`:

    const AGENT_DOCUMENT_PATH = /^\/functions\/v1\/h0\/agent-doc\/[^/]+$/;
    ... AGENT_DOCUMENT_PATH.test(new URL(request.url).pathname)

Measured: NO existing edge function in this repo matches on a path at all. `grep -rn "functions/v1"
supabase/functions/` returns NOTHING, and the four live functions are single-endpoint POST handlers
that never inspect `pathname`. So there is no precedent here for what a DEPLOYED function actually
receives.

That matters because the two environments differ: `supabase functions serve` routes locally and a
deployed function sits behind the API gateway. If the deployed `pathname` lacks the
`/functions/v1/h0` prefix, this regex never matches, the function answers 404 to every request, and
EVERY TEST STILL PASSES — the tests construct the Request themselves, so they assert the matcher
against the shape the author assumed rather than the shape production sends.

This is the "a negative result must reach the path it claims to test" rule pointed at a positive:
the tests cannot distinguish a correct matcher from an incorrect one, because they supply the input
the matcher expects.

REMEDY, in order of preference:
  1. Match the SUFFIX (`/agent-doc/<locator>` at the end of the path) so both shapes work. A
     tolerant matcher cannot be wrong in one environment and right in the other.
  2. If a strict prefix is wanted, it must be VERIFIED against a deployed function, and
     `cloud-swarm-dev` IS production — resolve the ref against the live page before touching it.

Until one of those happens this is NOT ESTABLISHED and must be said so in the lane, not assumed.
Flagged to the grok arm as its axis 4 so the finding is independent of me.
