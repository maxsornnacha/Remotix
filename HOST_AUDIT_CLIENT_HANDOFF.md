# Host Audit Client Handoff (Ingest Key Compatibility)

This note describes required client updates when API enables `HOST_AUDIT_INGEST_KEY`.

## Problem

API now rejects audit ingest requests unless header is present:

- `x-audit-ingest-key: <value>`

Current host client sends audit events without this header, so requests return `401 UNAUTHORIZED` when server key is enabled.

---

## Required Client Change

File:
- `renderer/pages/host/[roomId].jsx`

Location:
- inside `appendHostAuditEvent(...)` where audit event is sent:
  - currently: `api.post(HOST_AUDIT_ENDPOINT, entry)`

Update to send header:

```js
const HOST_AUDIT_INGEST_KEY =
  (typeof process.env.NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY === 'string'
    ? process.env.NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY.trim()
    : '')

// ...
api.post(HOST_AUDIT_ENDPOINT, entry, {
  headers: HOST_AUDIT_INGEST_KEY
    ? { 'x-audit-ingest-key': HOST_AUDIT_INGEST_KEY }
    : undefined,
}).catch(() => {
  // keep best-effort behavior
})
```

---

## Environment Setup

Client env (`renderer/.env`):

```env
# Optional: required only if API enforces ingest key
NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY=replace-with-client-audit-key
```

API env:

```env
HOST_AUDIT_INGEST_KEY=replace-with-client-audit-key
```

Values must match.

---

## Security Note

`NEXT_PUBLIC_*` values are exposed to client bundles.  
Do not use a high-privilege secret here.

Use a dedicated low-scope ingest key only for host audit events, and rotate regularly.

---

## Operational Recommendation

- If you cannot distribute client key safely yet:
  - leave `HOST_AUDIT_INGEST_KEY` unset on API for now
  - rely on rate limits + validation + request tracing
- When key distribution is ready:
  - enable API key enforcement
  - deploy client env with matching `NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY`

---

## Acceptance Checklist

- [ ] Client sends `x-audit-ingest-key` when key is configured
- [ ] API accepts request (no 401)
- [ ] Audit events still send best-effort (no UI break on API failure)
- [ ] Local diagnostics trail continues to work regardless of API status

