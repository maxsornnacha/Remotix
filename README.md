<p align="center"><img src="https://i.imgur.com/X7dSE68.png"></p>

## Usage

### Create an App

```
# with npx
$ npx create-nextron-app my-app --example basic-lang-javascript

# with yarn
$ yarn create nextron-app my-app --example basic-lang-javascript

# with pnpm
$ pnpm dlx create-nextron-app my-app --example basic-lang-javascript
```

### Install Dependencies

```
$ cd my-app

# using yarn or npm
$ yarn (or `npm install`)

# using pnpm
$ pnpm install --shamefully-hoist
```

### Use it

```
# development mode
$ yarn dev (or `npm run dev` or `pnpm run dev`)

# production build
$ yarn build (or `npm run build` or `pnpm run build`)
```

### Resume Preflight Upstream Contract

The desktop client calls a local gateway endpoint at `POST /api/sessions/resume/preflight`.
That gateway forwards to `RESUME_PREFLIGHT_UPSTREAM_URL` (or `NEXT_PUBLIC_API_URL + /sessions/resume/preflight`).

Expected upstream request payload:

```json
{
  "tokenId": "string",
  "role": "host|client",
  "roomId": "string",
  "deviceId": "string",
  "targetHostDeviceId": "string (required when role=client)"
}
```

Expected upstream response payload:

```json
{
  "ok": true,
  "message": "ok",
  "reasonCode": "OK"
}
```

When rejected/unavailable, return:

```json
{
  "ok": false,
  "message": "human readable reason",
  "reasonCode": "UPSTREAM_REJECTED|UPSTREAM_UNAVAILABLE|<custom_code>"
}
```

### Backend Implementation Checklist (Resume Preflight)

- Validate request body fields:
  - `tokenId` required, non-empty string
  - `role` required, must be `host` or `client`
  - `roomId` required, non-empty string
  - `deviceId` required, non-empty string
  - `targetHostDeviceId` required when `role=client`
- Verify token record exists by `tokenId`
- Verify token is not expired (`expiresAt > now`)
- Verify token is not consumed/revoked
- Verify token fields match request (`role`, `roomId`, `deviceId`, `targetHostDeviceId`)
- For `role=client`, verify target host device is still valid/online for resume policy
- Return deterministic `reasonCode` for each rejection path

Suggested status code + reason mapping:

- `200 OK` + `ok: true` + `reasonCode: OK`
- `400 Bad Request` + `ok: false` + `reasonCode: INVALID_REQUEST`
- `401 Unauthorized` + `ok: false` + `reasonCode: TOKEN_INVALID`
- `403 Forbidden` + `ok: false` + `reasonCode: TOKEN_BINDING_MISMATCH`
- `404 Not Found` + `ok: false` + `reasonCode: TOKEN_NOT_FOUND`
- `409 Conflict` + `ok: false` + `reasonCode: TOKEN_CONSUMED`
- `410 Gone` + `ok: false` + `reasonCode: TOKEN_EXPIRED`
- `423 Locked` + `ok: false` + `reasonCode: HOST_NOT_READY` (optional)
- `429 Too Many Requests` + `ok: false` + `reasonCode: RATE_LIMITED`
- `503 Service Unavailable` + `ok: false` + `reasonCode: UPSTREAM_UNAVAILABLE`

Recommended response shape for failures:

```json
{
  "ok": false,
  "message": "Resume token expired.",
  "reasonCode": "TOKEN_EXPIRED"
}
```
