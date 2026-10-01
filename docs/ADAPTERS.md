# Ecosystem adapters

AccessLease works on its own. An adapter lets another tool (a readiness checker, a dashboard) **consume lease status events**. Adapters are optional, **disabled by default**, and no sibling product is a runtime dependency: the reference consumer in `src/adapters/` is a small standalone module you can copy.

What flows through an adapter: lease state changes and a pointer to evidence. What never flows: credentials, secrets, connection strings, tokens, or free-text fields.

## The event envelope (version 1)

```json
{
  "schema_version": 1,
  "event_id": "evt-0001",
  "source": "accesslease",
  "resource_id": "<lease id>",
  "event_type": "lease.revocation_unconfirmed",
  "occurred_at": "2026-01-01T01:00:06.000Z",
  "revision": 5,
  "evidence_ref": "lease:<lease id>@5",
  "correlation_id": "optional-caller-supplied-id"
}
```

| Field | Meaning |
| --- | --- |
| `schema_version` | Envelope version. Consumers reject a **major** version they do not understand. |
| `event_id` | Unique per event. Delivery is at least once, so consumers de-duplicate on it. |
| `source` | Producer name (`accesslease`). |
| `resource_id` | The lease the event is about. |
| `event_type` | `lease.requested`, `lease.approved`, `lease.issuing`, `lease.active`, `lease.issue_unknown`, `lease.revoking`, `lease.revoked_verified`, `lease.revocation_unconfirmed`. |
| `occurred_at` | UTC time the state change was recorded. |
| `revision` | The lease version after the change. It orders events for one lease. |
| `evidence_ref` | Where the evidence for this change lives (for example `lease:<id>@<revision>`). A pointer, never the evidence itself. |
| `correlation_id` | Optional, set by whoever started the flow. |

The producer side lives in the backend: events are written in the same transaction as the state change (transactional outbox) and are served by `GET /api/v1/events?after=<cursor>&limit=<n>` (see `docs/contracts/api.md`).

## Consumer rules (what the reference consumer enforces)

1. **Version gate first.** An event whose `schema_version` major is not `1` is rejected as `unsupported_version`, even if the rest of the document looks different. Nothing is stored for a rejected event.
2. **Strict shape.** Unknown fields are rejected: a stray field is where a raw credential would hide. Timestamps must be ISO 8601 with a UTC offset; `revision` is a non-negative integer.
3. **No credentials.** Any string value that looks like a credential (password or token assignments, bearer tokens, URLs with embedded user and password, private key blocks) rejects the whole event as `credential_in_event`. The error message never echoes the value.
4. **De-duplicate on `event_id`.** A repeated id is reported as `duplicate`. The dedupe horizon is bounded (default 50,000 ids); an event older than the horizon is re-checked by revision and found `stale`.
5. **Revision ordering.** An event is applied to a resource only if its `revision` is strictly newer than the revision already applied. An older or equal revision is kept in the history as `stale` and does **not** change the resource view.
6. **Never infer current state from an old event.** The consumer only reports "the last event I applied for this resource" (`lastEvent`). It does not claim that is the live state of the lease. To act on a lease, read the lease from the API.
7. **Ordering and version metadata are preserved** for every applied and stale event (revision, `occurred_at`, `schema_version`, applied or not, reason).

An unresolved lease stays visible: `lease.issue_unknown` and `lease.revocation_unconfirmed` are warnings, and a later `lease.revoked_verified` event only replaces them when its revision is newer.

## Enabling it

Off unless you set the switch. All settings are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACCESSLEASE_ADAPTER_ENABLED` | off | `1` turns the consumer on. Without it `events --consume` refuses to run (exit 2). |
| `ACCESSLEASE_ADAPTER_STATE_FILE` | none (memory only) | JSON file holding the dedupe set, applied revisions and pull cursor. Written atomically with mode 0600. A corrupt file stops the consumer instead of starting empty. |
| `ACCESSLEASE_ADAPTER_BASE_URL` | none | For `--remote`: base URL of the AccessLease API, for example `http://localhost:8791`. |
| `ACCESSLEASE_ADAPTER_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Exact host names the consumer may contact. |
| `ACCESSLEASE_ADAPTER_ALLOW_PRIVATE` | off | Allow allow-listed names that resolve to private (RFC 1918) addresses. Link-local (cloud metadata) and unspecified addresses are never allowed. |
| `ACCESSLEASE_ADAPTER_SESSION_COOKIE` | none | Cookie header value for an authenticated viewer session, if the remote API requires it. Never logged. |

### Command line

```bash
# Print events from the local database as JSON lines (the next cursor goes to stderr). Works without the adapter.
node dist/src/cli.js events --after 0 --limit 100

# Feed the reference consumer from the local database
ACCESSLEASE_ADAPTER_ENABLED=1 ACCESSLEASE_ADAPTER_STATE_FILE=./adapter-state.json \
  node dist/src/cli.js events --consume

# Pull over HTTP from a running AccessLease (allow-listed host, redirects refused)
ACCESSLEASE_ADAPTER_ENABLED=1 ACCESSLEASE_ADAPTER_BASE_URL=http://localhost:8791 \
  node dist/src/cli.js events --consume --remote
```

`events --consume` prints one summary line (applied, duplicate, stale, rejected) and one stderr line per rejected event. Exit codes: `0` all events handled; `2` any event rejected or the adapter is disabled; `3` the remote source is unreachable. The cursor is stored only after a whole page was processed, so a crash re-delivers the page and de-duplication absorbs it.

### Outbound safety

The consumer's check (`src/adapters/endpoint.ts`) deliberately mirrors the backend's egress rule (`src/lib/egress.ts`) instead of importing it, so the consumer stays a standalone, copyable module. The two implementations must be kept in sync: change one, change the other.

The remote pull checks the endpoint **before every request**: `http` or `https` only, no credentials in the URL, host on the allowlist, and every address the name resolves to must be acceptable. IPv6 addresses that merely carry an IPv4 address (IPv4-mapped, IPv4-compatible and NAT64, in any notation) are judged by the IPv4 they carry. The connection is **pinned** to the address that passed the check, so a DNS answer that changes afterwards cannot redirect the request. Redirects are refused (they could leave the allowlist). The response size is capped (5 MiB) and the request has a timeout. The core product makes no outbound calls at all; this path exists only when you enable the adapter and use `--remote`.

## Using it from your own code

```ts
import { EventConsumer, FileStore, httpEventSource, pollOnce } from "./src/adapters/index.js";

const consumer = new EventConsumer({ enabled: true, store: new FileStore("./adapter-state.json") });
const source = httpEventSource({
  baseUrl: "http://localhost:8791",
  policy: { allowedHosts: ["localhost"] },
});
const summary = await pollOnce(consumer, source); // { pulled, accepted, duplicates, stale, rejected, cursor }
const last = consumer.lastEvent("<lease id>");    // last applied event, not live state
```

## Tests

`tests/unit/surface/adapters.test.ts` covers: version gate (including a future v2 with a different shape), strict shape, credential rejection, dedupe, late and equal-revision events, bounded history, persistence and corruption, endpoint allowlist (DNS results, link-local, private addresses), redirects, size limits and the disabled default. `contract-drift.test.ts` checks that every event type the backend emits passes the envelope.
