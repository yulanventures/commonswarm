- PRODUCTION — `site/public/llms.txt:47-51,70-73`: The published `/llms.txt` sends agents to the deleted Vercel host. An agent follows the API, skill, or install link and does not reach CommonSwarm. The claim sweep missed `site/public/**`.

- PRODUCTION — `site/README.md:176-182`: This README runs commands from `site/`, but the new deploy command is relative to the repo root. A reader follows the earlier workflow, runs it from `site/`, and gets `deploy/site/deploy.sh: no such file or directory`. CLAIMS.md marks this item fixed.

- PRODUCTION — `supabase/functions/command/cors.ts:1-5` and `supabase/functions/capability/index.ts:184-220`: Default CORS still trusts `https://coswarm-site.vercel.app`. With the related environment value empty or absent, the edge worker allows the deleted host. The lane found these references but left them unchanged.

Build passed. The 27 focused invite and capability tests passed. I contacted no production service.

VERDICT: FAIL — published instructions and edge defaults still trust the deleted Vercel host, and the replacement site deploy command fails from its documented context.
