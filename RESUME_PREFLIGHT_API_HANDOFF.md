# Resume Preflight API Handoff (Sprint 4.2.x)

This document defines what the API server must implement so it is fully compatible with the current client/gateway behavior.

## Context

- Client calls: `POST /api/sessions/resume/preflight` (local gateway in desktop app)
- Gateway forwards to upstream API: `POST /sessions/resume/preflight`
- Gateway now supports:
  - one-time token consume + token rotation fields
  - rate-limit handling (`RATE_LIMITED`)
  - request tracing (`x-request-id`, `requestId`)
  - telemetry/event logs

To complete end-to-end behavior, upstream API must support the contract below.

---

## 1) Endpoint Contract

### Request

`POST /sessions/resume/preflight`

Headers:
- `Content-Type: application/json`
- `x-request-id` (optional but recommended; if missing, API should generate one)

Body:

```json
{
  "tokenId": "string",
  "role": "host|client",
  "roomId": "string",
  "deviceId": "string",
  "targetHostDeviceId": "string (required when role=client)"
}
```

Validation rules:
- `tokenId`, `role`, `roomId`, `deviceId` are required
- `role` must be `host` or `client`
- `targetHostDeviceId` required when `role=client`

---

## 2) Success Response (One-time + Rotation)

When preflight passes:

```json
{
  "ok": true,
  "message": "ok",
  "reasonCode": "OK",
  "consumeCurrentToken": true,
  "nextTokenId": "string",
  "nextExpiresAt": 1760000000000,
  "requestId": "uuid-or-correlation-id"
}
```

Also return header:
- `X-Request-Id: <same requestId>`

Notes:
- `consumeCurrentToken` should normally be `true`
- `nextTokenId` and `nextExpiresAt` are required for rotation flow

---

## 3) Error Contract

Error response shape:

```json
{
  "ok": false,
  "message": "human-readable error",
  "reasonCode": "SOME_REASON_CODE",
  "requestId": "uuid-or-correlation-id"
}
```

Recommended status + reasonCode mapping:
- `400` -> `INVALID_REQUEST`
- `401` -> `TOKEN_INVALID`
- `403` -> `TOKEN_BINDING_MISMATCH`
- `404` -> `TOKEN_NOT_FOUND`
- `409` -> `TOKEN_CONSUMED`
- `410` -> `TOKEN_EXPIRED`
- `423` -> `HOST_NOT_READY`
- `429` -> `RATE_LIMITED` (+ `Retry-After` header)
- `503` -> `UPSTREAM_UNAVAILABLE` or `TOKEN_ROTATION_FAILED`

---

## 4) Mandatory Request Tracing

Implement request correlation:

1. Read incoming `x-request-id`
2. If absent, generate a new request ID
3. Put request ID in:
   - response header `X-Request-Id`
   - response body field `requestId`
   - all structured logs for this request

This is required because client/gateway now shows `requestId` in diagnostics.

---

## 5) Mandatory Rate Limiting (API Side)

Even though gateway has rate limiting, API must enforce defense-in-depth.

Suggested policy:
- key: `ip + deviceId` (or `ip + tokenId`)
- window: 60s
- max attempts: 12
- cooldown: 120s

On limit:
- status `429`
- `reasonCode: RATE_LIMITED`
- include `Retry-After` header

---

## 6) Mandatory One-time Token Atomicity

On successful preflight:
1. Atomically consume current token
2. Create rotated token
3. Return rotated metadata in response

Use Mongo transaction when available. If transaction is not supported in current deployment, implement a safe fallback path and clearly log fallback mode.

Important: avoid partial success (consumed old token but failed to create new token).

---

## 7) Structured Telemetry Events

Emit structured logs/events with fields:
- `event`
- `requestId`
- `reasonCode`
- `httpStatus`
- `tokenId`
- `deviceId`
- `roomId`
- `role`
- `latencyMs`

Suggested events:
- `resume_preflight_ok`
- `resume_preflight_rejected`
- `resume_preflight_rate_limited`
- `resume_preflight_error`
- `resume_preflight_rotation_failed`

---

## 8) Optional but Recommended

- Add cleanup job for old resume tokens:
  - expired + consumed/revoked tokens
- Add indexes for frequent filters:
  - `tokenId` unique
  - `expiresAt`
  - `deviceId`
  - `roomId`
- Add metric counters for each `reasonCode`

---

## 9) Acceptance Checklist

- [ ] API returns `requestId` in both response header and body
- [ ] API supports one-time token consume + rotation fields
- [ ] API returns `RATE_LIMITED` with `429` and `Retry-After`
- [ ] API logs structured events with `requestId`
- [ ] API never leaves token in half-rotated state
- [ ] Gateway diagnostics can trace a failed request by `requestId`

