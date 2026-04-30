# Host Audit API Handoff (Sprint 4.3.4)

This document is for the backend/API agent to implement host-side audit persistence used by the current client.

## Why This Is Needed

Client host page now records local audit events and sends them (best-effort) to:

- `POST /audit/host-connection-events`

Without API support, audit history only exists in local UI diagnostics and cannot be queried across sessions/devices.

---

## 1) Endpoint To Implement

### `POST /audit/host-connection-events`

Headers:
- `Content-Type: application/json`
- `x-request-id` (optional but recommended)

Request body shape (from current client):

```json
{
  "id": "1740000000000-ab12cd",
  "event": "request_received|request_auto_approved|request_risk_confirmation_required|request_approved|request_rejected|request_respond_failed",
  "requestId": "optional-correlation-id",
  "policyMode": "always_ask|ask_new_only|auto_approve_trusted",
  "clientDeviceId": "string",
  "clientDisplayName": "string",
  "clientSocketId": "string",
  "reason": "string",
  "riskReasons": ["string"],
  "approved": true,
  "roomId": "string",
  "at": "2026-05-01T00:00:00.000Z"
}
```

Minimum required fields:
- `event`
- `roomId`
- `at`

Everything else may be optional/empty but should be sanitized.

---

## 2) Response Contract

Success:

```json
{
  "ok": true
}
```

Validation error:

```json
{
  "ok": false,
  "message": "Invalid payload",
  "reasonCode": "INVALID_REQUEST"
}
```

Rate-limited:

```json
{
  "ok": false,
  "message": "Too many audit events.",
  "reasonCode": "RATE_LIMITED"
}
```

Also set:
- status `429`
- `Retry-After` header

Server/internal error:

```json
{
  "ok": false,
  "message": "Audit service unavailable.",
  "reasonCode": "UPSTREAM_UNAVAILABLE"
}
```

---

## 3) Persistence Model

Create collection/model: `HostAuditEvent`

Suggested fields:
- `event` (string, indexed)
- `requestId` (string, indexed)
- `policyMode` (string)
- `clientDeviceId` (string, indexed)
- `clientDisplayName` (string)
- `clientSocketId` (string)
- `reason` (string)
- `riskReasons` (array of strings)
- `approved` (boolean)
- `roomId` (string, indexed)
- `at` (date, indexed) // event time from client
- `receivedAt` (date, indexed) // server ingest time
- `ip` (string)
- `userAgent` (string)
- `raw` (optional object for debugging)

Recommended indexes:
- `{ roomId: 1, at: -1 }`
- `{ requestId: 1 }`
- `{ clientDeviceId: 1, at: -1 }`
- `{ event: 1, at: -1 }`

Optional TTL/index strategy:
- Keep 30-90 days using TTL on `receivedAt` if long-term retention is not required.

---

## 4) Validation + Sanitization Rules

- Trim all strings
- Clamp string lengths (e.g., 256/512 max depending on field)
- `event` must be one of known values; unknown -> allow as `custom` or reject with `INVALID_REQUEST`
- `riskReasons` must be array of strings; coerce invalid to `[]`
- Parse `at` as ISO date, fallback to `new Date()` if invalid
- Ignore client-provided `id` as primary key (store as optional external id only)

---

## 5) API-Side Rate Limiting

Implement defense-in-depth rate limit even though client sends best-effort:

Suggested:
- key: `ip` or `ip + roomId`
- window: 60s
- max attempts: 120
- cooldown: 60s

On limit:
- return `429`
- `reasonCode: RATE_LIMITED`
- include `Retry-After`

---

## 6) Request Tracing

Use existing tracing pattern:

1. Read incoming `x-request-id`
2. If missing, generate one
3. Return `X-Request-Id` header
4. Include `requestId` in structured server logs

---

## 7) Observability Events

Emit structured logs for:
- `host_audit_event_ingested`
- `host_audit_event_rejected`
- `host_audit_event_rate_limited`
- `host_audit_event_error`

Log fields:
- `requestId`
- `httpStatus`
- `reasonCode`
- `event`
- `roomId`
- `clientDeviceId`
- `latencyMs`

---

## 8) Acceptance Checklist

- [ ] `POST /audit/host-connection-events` implemented
- [ ] Payload validated and sanitized
- [ ] Events persisted to DB
- [ ] `429 RATE_LIMITED` supported
- [ ] `X-Request-Id` returned
- [ ] Structured logs emitted
- [ ] Query by `roomId` + time works efficiently

---

## 9) Optional Next Endpoint (Useful)

For later UI history page:

- `GET /audit/host-connection-events?roomId=<id>&limit=50&cursor=<timestamp>`

Returns recent events for forensic/incident review.

