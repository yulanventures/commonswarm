# OpenAI domain-verification DNS TXT handoff

HezLead ruling 2: DNS TXT verification for **commonswarm.com** is ours. Intended handoff: `~/work/cswarm-submissions/DNS-TXT.md`. The submission worker reads the exact TXT record name and value from OpenAI's portal under Tom's existing SSO for the existing organization/project. OpenAI generates these per organization: never reuse another organization's challenge or invent a record. This docs-only worker has no portal authorization; the exact record is **pending portal read**, not populated or published.

The authorized submission worker replaces the placeholders below in the private handoff with the exact displayed values. Record the name as a fully qualified DNS name and preserve the exact TXT content; if the portal shows a relative name, record it as displayed too and resolve it within commonswarm.com before handing off. Use this format:

```text
domain: commonswarm.com
existing_organization: <read exact organization name/ID from portal>
existing_project: <read exact project name/ID from portal, if applicable>
record_type: TXT
record_name_as_displayed: <copy exact OpenAI portal record name>
record_name_fqdn: <exact fully qualified record name within commonswarm.com>
record_value: <copy exact OpenAI portal TXT value>
portal_verification_status: <copy actual status>
captured_at_utc: <actual capture timestamp>
cloudflare_owner: HezLead
publication_status: pending HezLead
dns_check_status: not checked
```

This public template contains no challenge value or credential. Copy only the DNS TXT challenge and status into the authorized handoff; never add session tokens, passwords, private callback URLs, government ID or business documents. Reading/copying the TXT challenge is allowed. The worker does not change DNS, create an account, make a payment or perform identity/organization verification.

HezLead adds the exact TXT name/value via the **Cloudflare API** in the commonswarm.com zone, preserving existing records. After publication, substitute the captured fully qualified record name for the placeholder and check public DNS:

```sh
dig TXT <record_name_fqdn> +short
dig @1.1.1.1 TXT <record_name_fqdn> +short
```

Compare the returned TXT content exactly with the captured portal value (DNS output may quote or split strings). Then the authorized worker reads/rechecks the OpenAI domain-verification status; a DNS answer alone is not proof of portal acceptance. Record actual timestamps and statuses. A missing/mismatched record or unverified status keeps OA-05 open and goes to HezLead.

Government ID or business-document verification remains **Tom-only**. If OpenAI requires identity/organization verification and it is incomplete, **park ChatGPT for Tom and submit Claude alone once Claude's C3 rows are met**. DNS TXT handling does not bypass that requirement. No DNS change, portal read or verification was performed in this documentation task.
