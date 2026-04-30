require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const cors = require("cors");
const {
  Pairing,
  Device,
  ResumeToken,
  HostAuditEvent,
  connectDb,
  isDbConnected,
} = require("./db");
const { createRuntimeStore } = require("./runtimeStore");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const DEVICE_ONLINE_TTL_MS = 20000;
const DEVICE_SWEEP_INTERVAL_MS = 5000;
const RESUME_ROTATION_TTL_MS = Number(
  process.env.RESUME_ROTATION_TTL_MS || 15 * 60 * 1000,
);
const RESUME_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RESUME_RATE_LIMIT_MAX_ATTEMPTS = 12;
const RESUME_RATE_LIMIT_COOLDOWN_MS = 120 * 1000;
const RESUME_RATE_LIMIT_SWEEP_MS = 60 * 1000;
const HOST_AUDIT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const HOST_AUDIT_RATE_LIMIT_MAX_ATTEMPTS = 120;
const HOST_AUDIT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
let runtimeStore = null;
const roomHandshakeState = new Map();
const resumePreflightRateState = new Map();
const hostAuditRateState = new Map();

app.use(cors());
app.use(express.json());

connectDb();

const getStore = () => {
  if (!runtimeStore) {
    throw new Error("Runtime store is not initialized");
  }
  return runtimeStore;
};

const markDeviceOnline = async (deviceId, displayName = "") => {
  if (!deviceId || !isDbConnected()) return;
  await Device.updateOne(
    { deviceId: String(deviceId) },
    {
      $set: {
        displayName: displayName || "",
        isOnline: true,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true },
  );
};

const markDeviceOffline = async (deviceId) => {
  if (!deviceId || !isDbConnected()) return;
  await Device.updateOne(
    { deviceId: String(deviceId) },
    {
      $set: {
        isOnline: false,
        lastSeenAt: new Date(),
      },
    },
  );
};

setInterval(async () => {
  if (!isDbConnected()) return;
  const cutoff = new Date(Date.now() - DEVICE_ONLINE_TTL_MS);
  await Device.updateMany(
    { isOnline: true, lastSeenAt: { $lt: cutoff } },
    { $set: { isOnline: false } },
  );
}, DEVICE_SWEEP_INTERVAL_MS).unref();

setInterval(() => {
  const nowMs = Date.now();
  for (const [key, state] of resumePreflightRateState.entries()) {
    const inCooldown = state.cooldownUntil > nowMs;
    const windowActive =
      nowMs - state.windowStartedAt < RESUME_RATE_LIMIT_WINDOW_MS;
    if (!inCooldown && !windowActive) {
      resumePreflightRateState.delete(key);
    }
  }
}, RESUME_RATE_LIMIT_SWEEP_MS).unref();

setInterval(() => {
  const nowMs = Date.now();
  for (const [key, state] of hostAuditRateState.entries()) {
    const inCooldown = state.cooldownUntil > nowMs;
    const windowActive =
      nowMs - state.windowStartedAt < HOST_AUDIT_RATE_LIMIT_WINDOW_MS;
    if (!inCooldown && !windowActive) {
      hostAuditRateState.delete(key);
    }
  }
}, RESUME_RATE_LIMIT_SWEEP_MS).unref();

const requireDb = (res) => {
  if (isDbConnected()) return true;
  res
    .status(503)
    .json({ message: "Database unavailable. Service is temporarily locked." });
  return false;
};

const text = (value) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";

const fail = (res, status, message, reasonCode, requestId, extra = {}) =>
  res.status(status).json({
    ok: false,
    message,
    reasonCode,
    ...(requestId ? { requestId } : {}),
    ...extra,
  });

const getClientIp = (req) => {
  const forwarded = text(req.headers["x-forwarded-for"]);
  if (forwarded) return forwarded.split(",")[0].trim();
  return text(req.ip || req.socket?.remoteAddress || "unknown");
};

const ensureRequestId = (req, res) => {
  const incoming = text(req.headers["x-request-id"]);
  const requestId = incoming || crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  return requestId;
};

const logResumeEvent = ({
  event,
  requestId,
  reasonCode,
  httpStatus,
  tokenId,
  deviceId,
  roomId,
  role,
  latencyMs,
  extra,
}) => {
  console.log(
    JSON.stringify({
      event,
      requestId,
      reasonCode,
      httpStatus,
      tokenId: tokenId || "",
      deviceId: deviceId || "",
      roomId: roomId || "",
      role: role || "",
      latencyMs,
      ...(extra || {}),
    }),
  );
};

const getResumeRateLimitState = (key, nowMs) => {
  const existing = resumePreflightRateState.get(key);
  if (!existing) {
    const fresh = { windowStartedAt: nowMs, attempts: 0, cooldownUntil: 0 };
    resumePreflightRateState.set(key, fresh);
    return fresh;
  }
  if (existing.cooldownUntil > 0 && nowMs >= existing.cooldownUntil) {
    existing.cooldownUntil = 0;
    existing.windowStartedAt = nowMs;
    existing.attempts = 0;
    return existing;
  }
  if (nowMs - existing.windowStartedAt >= RESUME_RATE_LIMIT_WINDOW_MS) {
    existing.windowStartedAt = nowMs;
    existing.attempts = 0;
  }
  return existing;
};

const consumeResumeRateLimit = (rateKey, nowMs) => {
  const state = getResumeRateLimitState(rateKey, nowMs);
  if (state.cooldownUntil > nowMs) {
    return {
      limited: true,
      retryAfterSec: Math.max(
        1,
        Math.ceil((state.cooldownUntil - nowMs) / 1000),
      ),
    };
  }

  state.attempts += 1;
  if (state.attempts > RESUME_RATE_LIMIT_MAX_ATTEMPTS) {
    state.cooldownUntil = nowMs + RESUME_RATE_LIMIT_COOLDOWN_MS;
    return {
      limited: true,
      retryAfterSec: Math.max(
        1,
        Math.ceil((state.cooldownUntil - nowMs) / 1000),
      ),
    };
  }
  return { limited: false, retryAfterSec: 0 };
};

const isTransactionUnsupportedError = (error) => {
  const msg = text(error?.message).toLowerCase();
  return (
    msg.includes("replica set") ||
    msg.includes("transaction numbers are only allowed") ||
    msg.includes("transactions are not supported")
  );
};

const clamp = (value, maxLen) => text(value).slice(0, maxLen);

const HOST_AUDIT_ALLOWED_EVENTS = new Set([
  "request_received",
  "request_auto_approved",
  "request_risk_confirmation_required",
  "request_approved",
  "request_rejected",
  "request_respond_failed",
]);

const consumeGenericRateLimit = (
  storeMap,
  rateKey,
  nowMs,
  windowMs,
  maxAttempts,
  cooldownMs,
) => {
  const existing = storeMap.get(rateKey) || {
    windowStartedAt: nowMs,
    attempts: 0,
    cooldownUntil: 0,
  };
  if (existing.cooldownUntil > 0 && nowMs >= existing.cooldownUntil) {
    existing.cooldownUntil = 0;
    existing.windowStartedAt = nowMs;
    existing.attempts = 0;
  }
  if (nowMs - existing.windowStartedAt >= windowMs) {
    existing.windowStartedAt = nowMs;
    existing.attempts = 0;
  }
  if (existing.cooldownUntil > nowMs) {
    storeMap.set(rateKey, existing);
    return {
      limited: true,
      retryAfterSec: Math.max(
        1,
        Math.ceil((existing.cooldownUntil - nowMs) / 1000),
      ),
    };
  }

  existing.attempts += 1;
  if (existing.attempts > maxAttempts) {
    existing.cooldownUntil = nowMs + cooldownMs;
    storeMap.set(rateKey, existing);
    return {
      limited: true,
      retryAfterSec: Math.max(
        1,
        Math.ceil((existing.cooldownUntil - nowMs) / 1000),
      ),
    };
  }

  storeMap.set(rateKey, existing);
  return { limited: false, retryAfterSec: 0 };
};

const isTokenConsumed = (tokenDoc) => {
  if (!tokenDoc) return false;
  if (tokenDoc.isConsumed === true) return true;
  if (tokenDoc.consumedAt) return true;
  return text(tokenDoc.status).toLowerCase() === "consumed";
};

const isTokenRevoked = (tokenDoc) => {
  if (!tokenDoc) return false;
  if (tokenDoc.isRevoked === true) return true;
  if (tokenDoc.revokedAt) return true;
  return text(tokenDoc.status).toLowerCase() === "revoked";
};

app.get("/status", (req, res) => {
  Promise.resolve(getStore().countActiveRooms())
    .then((rooms) => {
      res.json({
        status: isDbConnected() ? "OK" : "DEGRADED",
        rooms,
        dbConnected: isDbConnected(),
      });
    })
    .catch(() => {
      res.json({
        status: isDbConnected() ? "OK" : "DEGRADED",
        rooms: 0,
        dbConnected: isDbConnected(),
      });
    });
});

app.post("/sessions", (req, res) => {
  if (!requireDb(res)) return;
  const { hostId } = req.body;
  getStore()
    .setActiveRoom(hostId)
    .then(() => {
      res.json({ message: "Session started", hostId });
    })
    .catch(() => {
      res.status(500).json({ message: "Could not start session" });
    });
});

app.post("/sessions/resume/preflight", async (req, res) => {
  const startedAt = Date.now();
  const requestId = ensureRequestId(req, res);
  const tokenId = text(req.body?.tokenId);
  const role = text(req.body?.role).toLowerCase();
  const roomId = text(req.body?.roomId);
  const deviceId = text(req.body?.deviceId);
  const targetHostDeviceId = text(req.body?.targetHostDeviceId);
  const ip = getClientIp(req);

  const reject = (status, message, reasonCode, extra = {}) => {
    const retryAfterSec = Number(extra.retryAfterSec || 0);
    if (reasonCode === "RATE_LIMITED" && retryAfterSec > 0) {
      res.setHeader("Retry-After", String(retryAfterSec));
    }
    logResumeEvent({
      event:
        reasonCode === "RATE_LIMITED"
          ? "resume_preflight_rate_limited"
          : "resume_preflight_rejected",
      requestId,
      reasonCode,
      httpStatus: status,
      tokenId,
      deviceId,
      roomId,
      role,
      latencyMs: Date.now() - startedAt,
      extra: retryAfterSec > 0 ? { retryAfterSec } : undefined,
    });
    return fail(res, status, message, reasonCode, requestId, extra);
  };

  if (!isDbConnected()) {
    return reject(
      503,
      "Resume service is temporarily unavailable.",
      "UPSTREAM_UNAVAILABLE",
    );
  }

  const safeDeviceId = text(deviceId);
  const rateKey = safeDeviceId ? `${ip}|${safeDeviceId}` : `${ip}|anonymous`;
  const rateCheck = consumeResumeRateLimit(rateKey, Date.now());
  if (rateCheck.limited) {
    return reject(429, "Too many preflight attempts. Please retry later.", "RATE_LIMITED", {
      retryAfterSec: rateCheck.retryAfterSec,
    });
  }

  if (!tokenId || !role || !roomId || !deviceId) {
    return reject(
      400,
      "tokenId, role, roomId and deviceId are required.",
      "INVALID_REQUEST",
    );
  }
  if (role !== "host" && role !== "client") {
    return reject(400, "role must be either host or client.", "INVALID_REQUEST");
  }
  if (role === "client" && !targetHostDeviceId) {
    return reject(
      400,
      "targetHostDeviceId is required for client preflight.",
      "INVALID_REQUEST",
    );
  }

  let tokenDoc = null;
  try {
    tokenDoc = await ResumeToken.findOne({ tokenId }).lean();
  } catch (_error) {
    return reject(
      503,
      "Resume token lookup is temporarily unavailable.",
      "UPSTREAM_UNAVAILABLE",
    );
  }

  if (!tokenDoc) {
    return reject(404, "Resume token was not found.", "TOKEN_NOT_FOUND");
  }

  if (isTokenRevoked(tokenDoc)) {
    return reject(401, "Resume token is invalid.", "TOKEN_INVALID");
  }

  if (isTokenConsumed(tokenDoc)) {
    return reject(409, "Resume token has already been used.", "TOKEN_CONSUMED");
  }

  const expiresAt = tokenDoc.expiresAt ? new Date(tokenDoc.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    return reject(410, "Resume token expired.", "TOKEN_EXPIRED");
  }

  const tokenRole = text(tokenDoc.role).toLowerCase();
  const tokenRoomId = text(tokenDoc.roomId);
  const tokenDeviceId = text(tokenDoc.deviceId);
  const tokenTargetHostDeviceId = text(tokenDoc.targetHostDeviceId);

  if (
    tokenRole !== role ||
    tokenRoomId !== roomId ||
    tokenDeviceId !== deviceId ||
    (role === "client" && tokenTargetHostDeviceId !== targetHostDeviceId)
  ) {
    return reject(
      403,
      "Resume token does not match requested session binding.",
      "TOKEN_BINDING_MISMATCH",
    );
  }

  if (role === "client") {
    try {
      const store = getStore();
      const hostInfo = await store.getOnlineHost(targetHostDeviceId);
      const hostSocketAlive = Boolean(
        hostInfo?.socketId && io.sockets.sockets.get(hostInfo.socketId),
      );
      if (!hostSocketAlive) {
        const hostDoc = await Device.findOne({ deviceId: targetHostDeviceId })
          .select("isOnline")
          .lean();
        const hostOnline = Boolean(hostInfo) || Boolean(hostDoc?.isOnline);
        if (!hostOnline) {
          return reject(423, "Target host is not ready for resume.", "HOST_NOT_READY");
        }
      }
    } catch (_error) {
      return reject(503, "Resume preflight could not verify host availability.", "UPSTREAM_UNAVAILABLE");
    }
  }

  const now = new Date();
  const nextTokenId = crypto.randomUUID();
  const nextExpiresAt = new Date(
    Date.now() + Math.max(30_000, RESUME_ROTATION_TTL_MS),
  );
  const consumeQuery = {
    tokenId,
    isConsumed: { $ne: true },
    consumedAt: null,
    isRevoked: { $ne: true },
    revokedAt: null,
    status: { $nin: ["consumed", "revoked"] },
    expiresAt: { $gt: now },
  };
  const consumeUpdate = {
    $set: {
      isConsumed: true,
      consumedAt: now,
      status: "consumed",
      updatedAt: now,
    },
  };

  const session = await mongoose.startSession();
  let usedFallbackMode = false;
  try {
    try {
      let consumeResult = null;
      await session.withTransaction(async () => {
        consumeResult = await ResumeToken.updateOne(consumeQuery, consumeUpdate, {
          session,
        });

        if (consumeResult?.modifiedCount !== 1) {
          const conflictError = new Error("TOKEN_CONSUMED");
          conflictError.reasonCode = "TOKEN_CONSUMED";
          throw conflictError;
        }

        await ResumeToken.create(
          [
            {
              tokenId: nextTokenId,
              role,
              roomId,
              deviceId,
              targetHostDeviceId: role === "client" ? targetHostDeviceId : "",
              expiresAt: nextExpiresAt,
              isConsumed: false,
              isRevoked: false,
              status: "active",
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) {
        throw error;
      }
      usedFallbackMode = true;
      console.warn(
        `[resume-preflight] requestId=${requestId} using non-transaction fallback mode`,
      );
      await ResumeToken.create({
        tokenId: nextTokenId,
        role,
        roomId,
        deviceId,
        targetHostDeviceId: role === "client" ? targetHostDeviceId : "",
        expiresAt: nextExpiresAt,
        isConsumed: false,
        isRevoked: false,
        status: "pending_rotation",
      });

      const consumeFallbackResult = await ResumeToken.updateOne(
        consumeQuery,
        consumeUpdate,
      );
      if (consumeFallbackResult?.modifiedCount !== 1) {
        await ResumeToken.deleteOne({ tokenId: nextTokenId }).catch(() => {});
        return reject(409, "Resume token has already been used.", "TOKEN_CONSUMED");
      }

      const activateResult = await ResumeToken.updateOne(
        { tokenId: nextTokenId, status: "pending_rotation" },
        { $set: { status: "active", updatedAt: new Date() } },
      );
      if (activateResult?.modifiedCount !== 1) {
        await ResumeToken.deleteOne({ tokenId: nextTokenId }).catch(() => {});
        await ResumeToken.updateOne(
          { tokenId, consumedAt: now },
          {
            $set: {
              isConsumed: false,
              consumedAt: null,
              status: text(tokenDoc.status) || "active",
              updatedAt: new Date(),
            },
          },
        ).catch(() => {});
        return reject(
          503,
          "Resume token rotation failed. Please retry.",
          "TOKEN_ROTATION_FAILED",
        );
      }
    }
  } catch (error) {
    const reasonCode = text(error?.reasonCode || error?.message).toUpperCase();
    if (reasonCode === "TOKEN_CONSUMED") {
      return reject(409, "Resume token has already been used.", "TOKEN_CONSUMED");
    }
    if (reasonCode === "TOKEN_ROTATION_FAILED") {
      logResumeEvent({
        event: "resume_preflight_rotation_failed",
        requestId,
        reasonCode: "TOKEN_ROTATION_FAILED",
        httpStatus: 503,
        tokenId,
        deviceId,
        roomId,
        role,
        latencyMs: Date.now() - startedAt,
      });
      return reject(503, "Resume token rotation failed. Please retry.", "TOKEN_ROTATION_FAILED");
    }
    logResumeEvent({
      event: "resume_preflight_error",
      requestId,
      reasonCode: "UPSTREAM_UNAVAILABLE",
      httpStatus: 503,
      tokenId,
      deviceId,
      roomId,
      role,
      latencyMs: Date.now() - startedAt,
      extra: { errorMessage: text(error?.message) },
    });
    return reject(503, "Resume token preflight is temporarily unavailable.", "UPSTREAM_UNAVAILABLE");
  } finally {
    await session.endSession().catch(() => {});
  }

  logResumeEvent({
    event: "resume_preflight_ok",
    requestId,
    reasonCode: "OK",
    httpStatus: 200,
    tokenId,
    deviceId,
    roomId,
    role,
    latencyMs: Date.now() - startedAt,
    extra: { usedFallbackMode },
  });
  return res.status(200).json({
    ok: true,
    message: "ok",
    reasonCode: "OK",
    consumeCurrentToken: true,
    nextTokenId,
    nextExpiresAt: nextExpiresAt.getTime(),
    requestId,
  });
});

app.post("/audit/host-connection-events", async (req, res) => {
  const startedAt = Date.now();
  const requestId = ensureRequestId(req, res);
  const ip = getClientIp(req);
  const payload = req.body || {};
  const safeRoomId = clamp(payload.roomId, 128);
  const safeEvent = clamp(payload.event, 96);
  const safeClientDeviceId = clamp(payload.clientDeviceId, 128);

  const reject = (status, message, reasonCode, extra = {}) => {
    const retryAfterSec = Number(extra.retryAfterSec || 0);
    if (reasonCode === "RATE_LIMITED" && retryAfterSec > 0) {
      res.setHeader("Retry-After", String(retryAfterSec));
    }
    console.log(
      JSON.stringify({
        event:
          reasonCode === "RATE_LIMITED"
            ? "host_audit_event_rate_limited"
            : "host_audit_event_rejected",
        requestId,
        httpStatus: status,
        reasonCode,
        eventName: safeEvent,
        roomId: safeRoomId,
        clientDeviceId: safeClientDeviceId,
        latencyMs: Date.now() - startedAt,
      }),
    );
    return fail(res, status, message, reasonCode, requestId, extra);
  };

  if (!isDbConnected()) {
    return reject(
      503,
      "Audit service unavailable.",
      "UPSTREAM_UNAVAILABLE",
    );
  }

  const rateKey = `${ip}|${safeRoomId || "unknown-room"}`;
  const rateCheck = consumeGenericRateLimit(
    hostAuditRateState,
    rateKey,
    Date.now(),
    HOST_AUDIT_RATE_LIMIT_WINDOW_MS,
    HOST_AUDIT_RATE_LIMIT_MAX_ATTEMPTS,
    HOST_AUDIT_RATE_LIMIT_COOLDOWN_MS,
  );
  if (rateCheck.limited) {
    return reject(429, "Too many audit events.", "RATE_LIMITED", {
      retryAfterSec: rateCheck.retryAfterSec,
    });
  }

  if (!safeEvent || !safeRoomId || !payload.at) {
    return reject(400, "Invalid payload", "INVALID_REQUEST");
  }
  if (!HOST_AUDIT_ALLOWED_EVENTS.has(safeEvent)) {
    return reject(400, "Invalid payload", "INVALID_REQUEST");
  }

  const parsedAt = new Date(payload.at);
  const eventAt = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt;
  const riskReasons = Array.isArray(payload.riskReasons)
    ? payload.riskReasons.map((item) => clamp(item, 256)).filter(Boolean)
    : [];

  const userAgent = clamp(req.headers["user-agent"], 512);
  const doc = {
    externalId: clamp(payload.id, 128),
    event: safeEvent,
    requestId: clamp(payload.requestId, 128),
    policyMode: clamp(payload.policyMode, 64),
    clientDeviceId: safeClientDeviceId,
    clientDisplayName: clamp(payload.clientDisplayName, 256),
    clientSocketId: clamp(payload.clientSocketId, 128),
    reason: clamp(payload.reason, 512),
    riskReasons,
    approved:
      typeof payload.approved === "boolean" ? payload.approved : null,
    roomId: safeRoomId,
    at: eventAt,
    receivedAt: new Date(),
    ip: clamp(ip, 96),
    userAgent,
    raw: payload,
  };

  try {
    await HostAuditEvent.create(doc);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "host_audit_event_error",
        requestId,
        httpStatus: 503,
        reasonCode: "UPSTREAM_UNAVAILABLE",
        eventName: safeEvent,
        roomId: safeRoomId,
        clientDeviceId: safeClientDeviceId,
        latencyMs: Date.now() - startedAt,
        errorMessage: clamp(error?.message, 256),
      }),
    );
    return fail(
      res,
      503,
      "Audit service unavailable.",
      "UPSTREAM_UNAVAILABLE",
      requestId,
    );
  }

  console.log(
    JSON.stringify({
      event: "host_audit_event_ingested",
      requestId,
      httpStatus: 200,
      reasonCode: "OK",
      eventName: safeEvent,
      roomId: safeRoomId,
      clientDeviceId: safeClientDeviceId,
      latencyMs: Date.now() - startedAt,
    }),
  );
  return res.status(200).json({ ok: true, requestId });
});

app.get("/pairings/:deviceId", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const items = await Pairing.find({ ownerDeviceId: req.params.deviceId })
      .sort({ lastConnectedAt: -1 })
      .limit(20)
      .lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: "Unable to fetch pairings" });
  }
});

app.post("/pairings/save", async (req, res) => {
  if (!requireDb(res)) return;
  const { ownerDeviceId, ownerLabel, peerDeviceId, peerLabel, roomId } =
    req.body || {};
  if (!ownerDeviceId || !peerDeviceId || !roomId) {
    return res
      .status(400)
      .json({ message: "ownerDeviceId, peerDeviceId and roomId are required" });
  }

  try {
    const now = new Date();
    await Pairing.updateOne(
      { ownerDeviceId, peerDeviceId },
      {
        $set: {
          ownerLabel: ownerLabel || "",
          peerLabel: peerLabel || "",
          lastRoomId: roomId,
          lastConnectedAt: now,
        },
      },
      { upsert: true },
    );

    await Pairing.updateOne(
      { ownerDeviceId: peerDeviceId, peerDeviceId: ownerDeviceId },
      {
        $set: {
          ownerLabel: peerLabel || "",
          peerLabel: ownerLabel || "",
          lastRoomId: roomId,
          lastConnectedAt: now,
        },
      },
      { upsert: true },
    );

    res.json({ message: "Pairing saved" });
  } catch (error) {
    res.status(500).json({ message: "Unable to save pairing" });
  }
});

app.post("/devices/register", async (req, res) => {
  if (!requireDb(res)) return;
  const { deviceId, displayName, isOnline } = req.body || {};
  if (!deviceId) {
    return res.status(400).json({ message: "deviceId is required" });
  }

  try {
    const now = new Date();
    await Device.updateOne(
      { deviceId: String(deviceId) },
      {
        $set: {
          displayName: displayName || "",
          isOnline: Boolean(isOnline),
          lastSeenAt: now,
        },
      },
      { upsert: true },
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Could not register device" });
  }
});

app.post("/devices/change-id", async (req, res) => {
  if (!requireDb(res)) return;
  const { oldDeviceId, newDeviceId, displayName } = req.body || {};
  const oldId = String(oldDeviceId || "").trim();
  const newId = String(newDeviceId || "").trim();

  if (!oldId || !newId) {
    return res
      .status(400)
      .json({ ok: false, message: "oldDeviceId and newDeviceId are required" });
  }
  if (oldId === newId) {
    return res.json({ ok: true, message: "Device ID is unchanged" });
  }

  try {
    const newExists = await Device.exists({ deviceId: newId });
    if (newExists) {
      return res
        .status(409)
        .json({ ok: false, message: "New device ID already exists" });
    }

    const updateResult = await Device.updateOne(
      { deviceId: oldId },
      {
        $set: {
          deviceId: newId,
          displayName: displayName || "",
          lastSeenAt: new Date(),
        },
      },
    );

    if (updateResult.matchedCount === 0) {
      return res
        .status(404)
        .json({ ok: false, message: "Old device ID was not found" });
    }

    await Pairing.updateMany(
      { ownerDeviceId: oldId },
      { $set: { ownerDeviceId: newId, ownerLabel: displayName || "" } },
    );
    await Pairing.updateMany(
      { peerDeviceId: oldId },
      { $set: { peerDeviceId: newId, peerLabel: displayName || "" } },
    );

    await getStore().renameHostDevice(oldId, newId, displayName || "");
    await getStore().updatePendingHostDevice(oldId, newId);

    return res.json({ ok: true, message: "Device ID updated" });
  } catch (error) {
    return res
      .status(500)
      .json({ ok: false, message: "Could not update device ID" });
  }
});

app.get("/devices/:deviceId/status", async (req, res) => {
  if (!requireDb(res)) return;
  const deviceId = String(req.params.deviceId || "").trim();
  if (!deviceId) {
    return res.status(400).json({ ok: false, message: "deviceId is required" });
  }

  try {
    const doc = await Device.findOne({ deviceId })
      .select("deviceId isOnline displayName lastSeenAt")
      .lean();
    if (!doc) {
      return res.json({
        ok: true,
        exists: false,
        isOnline: false,
        reason: "not_found",
      });
    }
    return res.json({
      ok: true,
      exists: true,
      isOnline: Boolean(doc.isOnline),
      reason: doc.isOnline ? "online" : "offline",
      displayName: doc.displayName || "",
      lastSeenAt: doc.lastSeenAt || null,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ ok: false, message: "Could not check device status" });
  }
});

// ✅ Room existence check
io.on("connection", (socket) => {
  console.log("🔌 Connected:", socket.id);

  const emitHandshakeError = (
    targetSocketId,
    message,
    code = "handshake_error",
  ) => {
    io.to(targetSocketId).emit("handshake-error", {
      code,
      message,
    });
  };

  const attemptStartHandshake = (roomId, trigger = "unknown") => {
    if (!roomId) return;
    const state = roomHandshakeState.get(roomId);
    if (!state?.hostSocketId || !state.isHostReady) return;

    const roomMembers = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const hostAlive = Boolean(io.sockets.sockets.get(state.hostSocketId));
    if (!hostAlive) {
      roomHandshakeState.delete(roomId);
      return;
    }

    const readyClientSocketId = roomMembers.find(
      (memberId) =>
        memberId !== state.hostSocketId && state.readyClients.has(memberId),
    );
    if (!readyClientSocketId) return;

    state.readyClients.delete(readyClientSocketId);
    io.to(state.hostSocketId).emit("start-handshake", {
      roomId,
      peerSocketId: readyClientSocketId,
      role: "host",
      initiatedBy: trigger,
    });
    io.to(readyClientSocketId).emit("start-handshake", {
      roomId,
      peerSocketId: state.hostSocketId,
      role: "client",
      initiatedBy: trigger,
    });
    console.log("[handshake] started", {
      roomId,
      hostSocketId: state.hostSocketId,
      clientSocketId: readyClientSocketId,
      trigger,
    });
  };

  const ensureDbForSocket = (callback) => {
    if (isDbConnected()) return true;
    socket.emit("service-unavailable", {
      message: "Database unavailable. Remote service is locked.",
    });
    callback?.({
      ok: false,
      message: "Database unavailable. Service is locked.",
    });
    return false;
  };

  socket.on("register-host", async (payload, callback) => {
    if (!ensureDbForSocket(callback)) return;
    const deviceId = payload?.deviceId;
    if (!deviceId) {
      callback?.({ ok: false, message: "deviceId is required" });
      return;
    }

    const displayName = payload?.displayName || "Host Device";
    const store = getStore();
    const prev = (await store.getOnlineHost(deviceId)) || null;
    await store.setOnlineHost(deviceId, {
      roomId: prev?.roomId || "",
      displayName,
      socketId: socket.id,
    });
    socket.data.hostDeviceId = deviceId;

    try {
      await markDeviceOnline(deviceId, displayName);
    } catch (error) {
      callback?.({ ok: false, message: "Could not update device registry" });
      return;
    }

    callback?.({ ok: true });
  });

  socket.on("check-room", (roomId, callback) => {
    if (!ensureDbForSocket(() => callback(false))) return;
    const store = getStore();
    console.log("join room :", roomId);
    store
      .hasActiveRoom(roomId)
      .then((exists) => callback(Boolean(exists)))
      .catch(() => callback(false));
  });

  socket.on("join-room", async (payload, callback) => {
    if (!ensureDbForSocket()) return;
    const store = getStore();
    const isLegacy = typeof payload === "string";
    const roomId = isLegacy ? payload : payload.roomId;
    if (!roomId) {
      callback?.({ ok: false, message: "roomId is required." });
      socket.emit("join-error", { message: "roomId is required." });
      return;
    }

    if (!isLegacy && payload.role === "client") {
      const allowedRoomId = await store.getApprovedJoin(socket.id);
      if (allowedRoomId !== roomId) {
        socket.emit("join-denied", {
          message: "Host approval is required before joining this room.",
        });
        callback?.({
          ok: false,
          message: "Host approval is required before joining this room.",
        });
        return;
      }
      await store.deleteApprovedJoin(socket.id);
    }

    console.log("join-room :", roomId);
    socket.join(roomId);
    await store.setActiveRoom(roomId);

    if (!isLegacy && payload.role === "host" && payload.deviceId) {
      await store.setOnlineHost(payload.deviceId, {
        roomId,
        displayName: payload.displayName || "Host Device",
        socketId: socket.id,
      });
      socket.data.hostDeviceId = payload.deviceId;
      socket.data.hostRoomId = roomId;
      await store.setRoomHost(roomId, payload.deviceId);
      markDeviceOnline(
        payload.deviceId,
        payload.displayName || "Host Device",
      ).catch(() => {});

      const existingState = roomHandshakeState.get(roomId);
      roomHandshakeState.set(roomId, {
        hostSocketId: socket.id,
        isHostReady: false,
        readyClients: existingState?.readyClients || new Set(),
      });
    }

    if (!isLegacy && payload.role === "client") {
      const state = roomHandshakeState.get(roomId);
      if (state) {
        state.readyClients.add(socket.id);
      }
    }

    socket.data.joinedRoomId = roomId;
    socket.data.joinedRole = isLegacy ? "legacy" : payload.role || "unknown";

    const roomPeers = Array.from(
      io.sockets.adapter.rooms.get(roomId) || [],
    ).filter((peerId) => peerId !== socket.id);
    if (roomPeers.length > 0) {
      socket.emit("peer-joined", roomPeers[0]);
    }
    socket.to(roomId).emit("peer-joined", socket.id);
    callback?.({
      ok: true,
      roomId,
      role: socket.data.joinedRole,
      peers: roomPeers.length,
    });
    console.log("[join-room] success", {
      roomId,
      socketId: socket.id,
      role: socket.data.joinedRole,
      peers: roomPeers.length,
    });
  });

  socket.on("host-handshake-ready", ({ roomId }, callback) => {
    const safeRoomId = String(roomId || "").trim();
    if (!safeRoomId) {
      callback?.({ ok: false, message: "roomId is required." });
      return;
    }
    const state = roomHandshakeState.get(safeRoomId);
    if (!state || state.hostSocketId !== socket.id) {
      callback?.({
        ok: false,
        message: "Host handshake state is not available for this room.",
      });
      emitHandshakeError(
        socket.id,
        "Host handshake state is not available for this room.",
        "host_state_missing",
      );
      return;
    }
    state.isHostReady = true;
    callback?.({ ok: true, roomId: safeRoomId });
    attemptStartHandshake(safeRoomId, "host_ready");
  });

  socket.on("client-handshake-ready", ({ roomId }, callback) => {
    const safeRoomId = String(roomId || "").trim();
    if (!safeRoomId) {
      callback?.({ ok: false, message: "roomId is required." });
      return;
    }
    const state = roomHandshakeState.get(safeRoomId);
    if (!state) {
      const pendingState = {
        hostSocketId: "",
        isHostReady: false,
        readyClients: new Set([socket.id]),
      };
      roomHandshakeState.set(safeRoomId, pendingState);
      callback?.({
        ok: true,
        roomId: safeRoomId,
        pendingHost: true,
        message: "Waiting for host to join room before handshake starts.",
      });
      return;
    }
    state.readyClients.add(socket.id);
    callback?.({ ok: true, roomId: safeRoomId });
    attemptStartHandshake(safeRoomId, "client_ready");
  });

  socket.on("request-connection", async (payload, callback) => {
    if (!ensureDbForSocket(callback)) return;
    const store = getStore();
    const {
      roomId: incomingRoomId,
      targetHostDeviceId,
      clientDeviceId,
      clientDisplayName,
    } = payload || {};
    const normalizedTargetHostDeviceId =
      typeof targetHostDeviceId === "string" ? targetHostDeviceId.trim() : "";
    console.log("[request-connection] incoming", {
      requesterSocketId: socket.id,
      targetHostDeviceId: normalizedTargetHostDeviceId || null,
      incomingRoomId: incomingRoomId || null,
    });

    let deviceRecord = null;
    if (normalizedTargetHostDeviceId) {
      try {
        deviceRecord = await Device.findOne({
          deviceId: normalizedTargetHostDeviceId,
        })
          .select("deviceId displayName isOnline lastSeenAt")
          .lean();
      } catch (error) {
        callback?.({
          ok: false,
          message: "Could not verify address in database.",
        });
        return;
      }

      if (!deviceRecord) {
        console.log("[request-connection] db-check", {
          targetHostDeviceId: normalizedTargetHostDeviceId,
          exists: false,
          isOnline: null,
          socketAlive: null,
          decision: "not_found",
        });
        callback?.({ ok: false, message: "Address not found in system." });
        return;
      }
      if (!deviceRecord.isOnline) {
        console.log("[request-connection] db-check", {
          targetHostDeviceId: normalizedTargetHostDeviceId,
          exists: true,
          isOnline: false,
          socketAlive: null,
          decision: "offline_by_db",
        });
        callback?.({ ok: false, message: "Address is currently offline." });
        return;
      }
      console.log("[request-connection] db-check", {
        targetHostDeviceId: normalizedTargetHostDeviceId,
        exists: true,
        isOnline: true,
        socketAlive: null,
        decision: "continue",
      });
    }

    let hostInfo = null;
    let hostDeviceId = normalizedTargetHostDeviceId || "";
    if (hostDeviceId) {
      hostInfo = await store.getOnlineHost(hostDeviceId);
    } else {
      const mappedHostDeviceId = incomingRoomId
        ? await store.getRoomHost(incomingRoomId)
        : "";
      if (mappedHostDeviceId) {
        hostDeviceId = mappedHostDeviceId;
        hostInfo = await store.getOnlineHost(mappedHostDeviceId);
      }
    }

    if (!hostInfo) {
      console.log("[request-connection] memory-check", {
        targetHostDeviceId: normalizedTargetHostDeviceId || null,
        exists: Boolean(deviceRecord),
        isOnline: Boolean(deviceRecord?.isOnline),
        socketAlive: false,
        decision: "offline_no_hostInfo",
      });
      callback?.({
        ok: false,
        message: normalizedTargetHostDeviceId
          ? "Address is currently offline."
          : "Host is offline or unavailable",
      });
      return;
    }

    const hostSocketAlive = Boolean(
      hostInfo.socketId && io.sockets.sockets.get(hostInfo.socketId),
    );
    if (!hostSocketAlive) {
      if (hostDeviceId) {
        await store.deleteOnlineHost(hostDeviceId);
        markDeviceOffline(hostDeviceId).catch(() => {});
      }
      console.log("[request-connection] socket-check", {
        targetHostDeviceId:
          hostDeviceId || normalizedTargetHostDeviceId || null,
        exists: Boolean(deviceRecord),
        isOnline: Boolean(deviceRecord?.isOnline),
        socketAlive: false,
        decision: "offline_stale_socket",
      });
      callback?.({ ok: false, message: "Address is currently offline." });
      return;
    }

    const roomId =
      hostInfo.roomId ||
      incomingRoomId ||
      crypto.randomUUID().replace(/-/g, "");

    await store.setPendingRequest(socket.id, {
      roomId,
      hostDeviceId,
      hostSocketId: hostInfo.socketId,
      clientDeviceId: clientDeviceId || "",
      clientDisplayName: clientDisplayName || "Unknown Client",
      requestedAt: Date.now(),
    });

    io.to(hostInfo.socketId).emit("incoming-connection-request", {
      clientSocketId: socket.id,
      roomId,
      hostDeviceId,
      clientDeviceId: clientDeviceId || "",
      clientDisplayName: clientDisplayName || "Unknown Client",
    });

    callback?.({
      ok: true,
      message: "Connection request sent. Waiting for host approval.",
    });
    console.log("[request-connection] accepted", {
      requesterSocketId: socket.id,
      hostSocketId: hostInfo.socketId,
      targetHostDeviceId: hostDeviceId || normalizedTargetHostDeviceId || null,
      roomId: roomId || null,
      exists: Boolean(deviceRecord),
      isOnline: Boolean(deviceRecord?.isOnline),
      socketAlive: true,
      decision: "request_sent",
    });
  });

  socket.on(
    "respond-connection-request",
    ({ clientSocketId, approved }, callback) => {
      if (!ensureDbForSocket()) return;
      if (!clientSocketId) return;
      const store = getStore();
      store
        .getPendingRequest(clientSocketId)
        .then(async (request) => {
          if (!request) {
            callback?.({
              ok: false,
              message: "Pending request was not found.",
            });
            return;
          }
          if (request.hostSocketId !== socket.id) {
            callback?.({
              ok: false,
              message: "Request no longer belongs to this host socket.",
            });
            return;
          }
          await store.deletePendingRequest(clientSocketId);

          if (approved) {
            const roomId =
              request.roomId || crypto.randomUUID().replace(/-/g, "");
            await store.setApprovedJoin(clientSocketId, roomId);
            await store.setApprovedJoin(socket.id, roomId);

            const hostEntry =
              (await store.getOnlineHost(request.hostDeviceId)) || {};
            await store.setOnlineHost(request.hostDeviceId, {
              roomId,
              displayName: hostEntry.displayName || "Host Device",
              socketId: request.hostSocketId,
            });
            await store.setRoomHost(roomId, request.hostDeviceId);

            io.to(socket.id).emit("host-connection-approved", {
              roomId,
              clientSocketId,
              clientDeviceId: request.clientDeviceId,
            });
            io.to(clientSocketId).emit("connection-approved", {
              roomId,
              hostDeviceId: request.hostDeviceId,
            });
            callback?.({
              ok: true,
              approved: true,
              roomId,
              hostDeviceId: request.hostDeviceId,
            });
            return;
          }

          io.to(clientSocketId).emit("connection-rejected", {
            message: "Host rejected the connection request.",
          });
          callback?.({ ok: true, approved: false });
        })
        .catch(() => {
          callback?.({
            ok: false,
            message: "Could not respond to connection request.",
          });
        });
    },
  );

  socket.on("get-room-host-meta", (roomId, callback) => {
    if (!ensureDbForSocket(callback)) return;
    const store = getStore();
    store
      .getRoomHost(roomId)
      .then(async (hostDeviceId) => {
        const info = hostDeviceId
          ? await store.getOnlineHost(hostDeviceId)
          : null;
        if (!hostDeviceId || !info) {
          callback({ exists: false });
          return;
        }
        callback({
          exists: true,
          hostDeviceId,
          hostDisplayName: info.displayName,
          roomId: info.roomId,
        });
      })
      .catch(() => callback({ exists: false }));
  });

  socket.on("check-device-online", (deviceId, callback) => {
    if (!ensureDbForSocket(callback)) return;
    const store = getStore();
    store
      .getOnlineHost(deviceId)
      .then((info) => {
        if (!info) {
          Device.findOne({ deviceId: String(deviceId || "").trim() })
            .select("isOnline")
            .lean()
            .then((doc) => {
              if (!doc) {
                callback({ exists: false, reason: "not_found" });
                return;
              }
              callback({
                exists: false,
                reason: doc.isOnline ? "stale_online" : "offline",
              });
            })
            .catch(() => {
              callback({ exists: false, reason: "unknown" });
            });
          return;
        }
        callback({
          exists: true,
          roomId: info.roomId,
          displayName: info.displayName,
        });
      })
      .catch(() => callback({ exists: false, reason: "unknown" }));
  });

  socket.on("host-heartbeat", (payload = {}) => {
    if (!ensureDbForSocket()) return;
    const deviceId = payload?.deviceId || socket.data.hostDeviceId;
    if (!deviceId) return;
    const displayName = payload?.displayName || "";
    markDeviceOnline(deviceId, displayName).catch(() => {});
  });

  socket.on("signal", ({ to, from, data }) => {
    io.to(to).emit("signal", { from, data });
  });

  socket.on("mouse-move", (data) => {
    socket.to(data.roomId).emit("mouse-move", data);
  });

  socket.on("mouse-click", (data) => {
    socket.to(data.roomId).emit("mouse-click", data);
  });

  socket.on("mouse-down", (data) => {
    socket.to(data.roomId).emit("mouse-down", data);
  });

  socket.on("mouse-up", (data) => {
    socket.to(data.roomId).emit("mouse-up", data);
  });

  socket.on("mouse-scroll", (data) => {
    socket.to(data.roomId).emit("mouse-scroll", data);
  });

  socket.on("client-network-quality", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) return;
    socket.to(roomId).emit("client-network-quality", {
      level: String(data.level || "good"),
      rttMs: Number(data.rttMs || 0),
      roomId,
    });
  });

  socket.on("key-down", (data) => {
    socket.to(data.roomId).emit("key-down", data);
  });

  socket.on("key-up", (data) => {
    socket.to(data.roomId).emit("key-up", data);
  });

  socket.on("leave-session", ({ roomId, message } = {}) => {
    const safeRoomId = String(roomId || socket.data.joinedRoomId || "").trim();
    if (!safeRoomId) return;

    socket.to(safeRoomId).emit("session-ended", {
      message: String(message || "The other participant ended the session."),
    });
    socket.leave(safeRoomId);

    if (socket.data.joinedRoomId === safeRoomId) {
      socket.data.joinedRoomId = "";
    }

    const state = roomHandshakeState.get(safeRoomId);
    if (state) {
      if (state.hostSocketId === socket.id) {
        roomHandshakeState.delete(safeRoomId);
      } else {
        state.readyClients.delete(socket.id);
      }
    }
  });

  socket.on("disconnect", () => {
    const disconnectedRoomId = String(socket.data.joinedRoomId || "").trim();
    if (disconnectedRoomId) {
      socket.to(disconnectedRoomId).emit("session-ended", {
        message: "The other participant disconnected.",
      });
    }
    const store = getStore();
    Promise.resolve()
      .then(async () => {
        for (const [roomId, state] of roomHandshakeState.entries()) {
          if (state.hostSocketId === socket.id) {
            roomHandshakeState.delete(roomId);
            continue;
          }
          state.readyClients.delete(socket.id);
        }

        await store.deletePendingRequest(socket.id);
        await store.deleteApprovedJoin(socket.id);

        if (!socket.data.hostDeviceId) return;
        const hostInfo = await store.getOnlineHost(socket.data.hostDeviceId);
        const isLatestHostSocket = hostInfo?.socketId === socket.id;
        if (!isLatestHostSocket) return;

        markDeviceOffline(socket.data.hostDeviceId).catch(() => {});

        if (hostInfo?.roomId) {
          await store.deleteRoomHost(hostInfo.roomId);
        }
        await store.deleteOnlineHost(socket.data.hostDeviceId);
        if (socket.data.hostRoomId) {
          await store.deleteRoomHost(socket.data.hostRoomId);
          await store.deleteActiveRoom(socket.data.hostRoomId);
        }

        const pendingItems = await store.listPendingRequestsByHostSocket(
          socket.id,
        );
        for (const { clientSocketId } of pendingItems) {
          io.to(clientSocketId).emit("connection-rejected", {
            message: "Host went offline.",
          });
          await store.deletePendingRequest(clientSocketId);
        }
      })
      .finally(() => {
        console.log("❌ Disconnected:", socket.id);
      });
  });
});

const PORT = process.env.PORT || 3010;

const bootstrap = async () => {
  runtimeStore = await createRuntimeStore();
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
};

bootstrap().catch((error) => {
  console.error("Failed to bootstrap server:", error.message);
  process.exit(1);
});

const shutdown = async () => {
  if (runtimeStore) {
    await runtimeStore.close().catch(() => {});
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
