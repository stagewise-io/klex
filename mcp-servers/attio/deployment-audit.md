# KLEX-41 deployment audit

## Repository access result (2026-09-18)

The Klex implementation and tests were reviewed locally. Inspection of
`stagewise-io/infra` and `stagewise-io/gitops` is **blocked**, not complete.
`gh repo view` failed to connect to `api.github.com`; cloning each repository
failed with `Could not resolve host: github.com`. Neither repository is present
in the available local repository directory. Credential validity cannot be
established while GitHub is unreachable.

No infra or gitops files were changed, and neither repository is classified as
needing no change. Their actual deployment, secret, routing and worker conventions
must be inspected before proposing manifests or infrastructure resources.

## Requirements established from the implementation

| Area | Existing contract | Remaining decision or implementation |
| --- | --- | --- |
| Runtime | Private TypeScript library using Node crypto and the MCP SDK; no listener, container or worker entrypoint | Select an existing hosting convention after inspecting infra/gitops; implement and validate a host before adding deployment wiring |
| MCP route | `POST /connections/{connectionId}/mcp` | Mount the handler behind verified Klex authentication, ownership checks, ingress limits and timeouts; no hostname has been selected |
| Management and callback | Trusted service methods; fixed configured HTTPS callback URI | Implement separately authorized customer management, browser-session/CSRF binding and callback HTTP routes; no callback path is prescribed by the package |
| Configuration | Host injects `ConnectionStore`, `KeyWrapper`, `Authenticator` and `redirectUri` | Define host configuration and its deployment mapping; there are no implemented environment-variable or secret-binding names to provision |
| Database | Atomic generation CAS, strongly consistent reads, single-use OAuth attempts | Implement a durable adapter, forward-only migrations, expiry cleanup and restore tests before allocating or wiring a production database |
| KMS and secrets | Envelope encryption via injected key wrapping; customer app secrets and tokens enter the encrypted store | Select an existing KMS convention, implement wrapping, least-privilege identity and rotation/recovery; do not provision one shared Attio app secret for customer-created apps |
| Egress | HTTPS requests to `app.attio.com` and `api.attio.com` | Confirm the host's egress policy permits these destinations |
| Worker or queue | No webhook, queue consumer or background worker entrypoint exists | No worker wiring is justified by this implementation; determine expired-attempt cleanup within the durable adapter/host design |
| Operations | Sanitized errors and bounded requests; development adapters are ephemeral | Add host audit/rate-limit infrastructure and dedicated-workspace live acceptance before production |

Do not deploy `MemoryConnectionStore` or `LocalKeyWrapper` as production adapters.
Do not create speculative DNS, routes, databases, keys, worker bindings or secret
names to make this library appear deployable. Exact repository file changes remain
undetermined until infra/gitops access and the production host design are available.
