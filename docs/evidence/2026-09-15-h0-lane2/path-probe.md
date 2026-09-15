# Lane 2 path-matching probe — run by the lead on the integration worktree

Exercised `handleH0Request` directly against eleven path shapes. Every response carried
`cache-control: no-store`.

    200  /functions/v1/h0/agent-doc/abc        public shape (what a human pastes)
    200  /h0/agent-doc/abc                     gateway-stripped shape (what the function SEES)
    404  /h0/agent-doc/                        empty locator
    404  /h0/agent-doc/a/b                     nested
    404  /h0/agent-doc/x/                      trailing slash
    404  /h0/agent-doc/..                      traversal (URL normalisation collapses it first)
    200  /h0/agent-doc/%2Fetc%2Fpasswd         encoded slash — harmless, the locator is never read
    200  /h0/agent-doc/abc?x=1                 query ignored, as pathname excludes it
    404  /functions/v1/h0/agent-doc/abc/extra  extra segment
    404  /H0/agent-doc/abc                     case-sensitive
    404  //h0/agent-doc/abc                    double slash

The encoded-slash case returning 200 is NOT a finding: the locator is never extracted and never
reaches the response, so no value in that position can do anything. That is the structural property
the lane rests on, and this probe is consistent with it.

NOT ESTABLISHED: this exercises the handler in-process. It is not an HTTP request to a deployed
function, and the gateway-stripped shape is established from the supabase CLI's Kong template and
serve worker rather than from production.
