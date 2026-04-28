const { createClient } = require("redis");

const KEY_PREFIX = "remotrix:runtime";
const key = {
  onlineHost: (deviceId) => `${KEY_PREFIX}:onlineHost:${deviceId}`,
  roomHost: (roomId) => `${KEY_PREFIX}:roomHost:${roomId}`,
  pending: (clientSocketId) => `${KEY_PREFIX}:pending:${clientSocketId}`,
  approvedJoin: (socketId) => `${KEY_PREFIX}:approvedJoin:${socketId}`,
  activeRoom: (roomId) => `${KEY_PREFIX}:activeRoom:${roomId}`,
};

const safeParse = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

const scanKeys = async (client, pattern) => {
  const keys = [];
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = reply.cursor;
    keys.push(...reply.keys);
  } while (cursor !== "0");
  return keys;
};

const createMemoryFallback = () => {
  const onlineHosts = new Map();
  const roomHosts = new Map();
  const pending = new Map();
  const approvedJoin = new Map();
  const activeRooms = new Set();
  return { onlineHosts, roomHosts, pending, approvedJoin, activeRooms };
};

const createRuntimeStore = async () => {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const safeRedisTarget = (() => {
    try {
      const parsed = new URL(redisUrl);
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "6379"}`;
    } catch (_error) {
      return "redis://<hidden>";
    }
  })();
  const client = createClient({ url: redisUrl });
  let isRedisReady = false;
  const fallback = createMemoryFallback();

  try {
    client.on("error", () => {});
    await client.connect();
    isRedisReady = true;
    console.log(`[runtime-store] Redis connected: ${safeRedisTarget}`);
  } catch (error) {
    console.warn(
      `[runtime-store] Redis unavailable (${safeRedisTarget}), using in-memory fallback: ${error.message}`,
    );
  }

  const store = {
    usingRedis: isRedisReady,
    async setOnlineHost(deviceId, value) {
      if (isRedisReady) {
        await client.set(key.onlineHost(deviceId), JSON.stringify(value));
        return;
      }
      fallback.onlineHosts.set(deviceId, value);
    },
    async getOnlineHost(deviceId) {
      if (isRedisReady) {
        const raw = await client.get(key.onlineHost(deviceId));
        return safeParse(raw);
      }
      return fallback.onlineHosts.get(deviceId) || null;
    },
    async deleteOnlineHost(deviceId) {
      if (isRedisReady) {
        await client.del(key.onlineHost(deviceId));
        return;
      }
      fallback.onlineHosts.delete(deviceId);
    },
    async setRoomHost(roomId, deviceId) {
      if (isRedisReady) {
        await client.set(key.roomHost(roomId), deviceId || "");
        return;
      }
      fallback.roomHosts.set(roomId, deviceId || "");
    },
    async getRoomHost(roomId) {
      if (isRedisReady) {
        return (await client.get(key.roomHost(roomId))) || "";
      }
      return fallback.roomHosts.get(roomId) || "";
    },
    async deleteRoomHost(roomId) {
      if (isRedisReady) {
        await client.del(key.roomHost(roomId));
        return;
      }
      fallback.roomHosts.delete(roomId);
    },
    async setPendingRequest(clientSocketId, value, ttlSec = 120) {
      if (isRedisReady) {
        await client.set(key.pending(clientSocketId), JSON.stringify(value), {
          EX: ttlSec,
        });
        return;
      }
      fallback.pending.set(clientSocketId, value);
    },
    async getPendingRequest(clientSocketId) {
      if (isRedisReady) {
        const raw = await client.get(key.pending(clientSocketId));
        return safeParse(raw);
      }
      return fallback.pending.get(clientSocketId) || null;
    },
    async deletePendingRequest(clientSocketId) {
      if (isRedisReady) {
        await client.del(key.pending(clientSocketId));
        return;
      }
      fallback.pending.delete(clientSocketId);
    },
    async listPendingRequestsByHostSocket(hostSocketId) {
      if (isRedisReady) {
        const keys = await scanKeys(client, `${KEY_PREFIX}:pending:*`);
        const result = [];
        for (const fullKey of keys) {
          const request = safeParse(await client.get(fullKey));
          if (!request || request.hostSocketId !== hostSocketId) continue;
          const clientSocketId = fullKey.split(":").pop();
          result.push({ clientSocketId, request });
        }
        return result;
      }
      return Array.from(fallback.pending.entries())
        .filter(([, request]) => request.hostSocketId === hostSocketId)
        .map(([clientSocketId, request]) => ({ clientSocketId, request }));
    },
    async updatePendingHostDevice(oldDeviceId, newDeviceId) {
      if (isRedisReady) {
        const keys = await scanKeys(client, `${KEY_PREFIX}:pending:*`);
        for (const fullKey of keys) {
          const request = safeParse(await client.get(fullKey));
          if (!request || request.hostDeviceId !== oldDeviceId) continue;
          request.hostDeviceId = newDeviceId;
          await client.set(fullKey, JSON.stringify(request), { EX: 120 });
        }
        return;
      }
      for (const [clientSocketId, request] of fallback.pending.entries()) {
        if (request.hostDeviceId !== oldDeviceId) continue;
        fallback.pending.set(clientSocketId, { ...request, hostDeviceId: newDeviceId });
      }
    },
    async setApprovedJoin(socketId, roomId, ttlSec = 180) {
      if (isRedisReady) {
        await client.set(key.approvedJoin(socketId), roomId || "", { EX: ttlSec });
        return;
      }
      fallback.approvedJoin.set(socketId, roomId || "");
    },
    async getApprovedJoin(socketId) {
      if (isRedisReady) {
        return (await client.get(key.approvedJoin(socketId))) || "";
      }
      return fallback.approvedJoin.get(socketId) || "";
    },
    async deleteApprovedJoin(socketId) {
      if (isRedisReady) {
        await client.del(key.approvedJoin(socketId));
        return;
      }
      fallback.approvedJoin.delete(socketId);
    },
    async setActiveRoom(roomId) {
      if (isRedisReady) {
        await client.set(key.activeRoom(roomId), "1");
        return;
      }
      fallback.activeRooms.add(roomId);
    },
    async hasActiveRoom(roomId) {
      if (isRedisReady) {
        return Boolean(await client.get(key.activeRoom(roomId)));
      }
      return fallback.activeRooms.has(roomId);
    },
    async deleteActiveRoom(roomId) {
      if (isRedisReady) {
        await client.del(key.activeRoom(roomId));
        return;
      }
      fallback.activeRooms.delete(roomId);
    },
    async countActiveRooms() {
      if (isRedisReady) {
        const keys = await scanKeys(client, `${KEY_PREFIX}:activeRoom:*`);
        return keys.length;
      }
      return fallback.activeRooms.size;
    },
    async renameHostDevice(oldId, newId, displayName = "") {
      const hostInfo = await this.getOnlineHost(oldId);
      if (!hostInfo) return;
      await this.deleteOnlineHost(oldId);
      await this.setOnlineHost(newId, {
        ...hostInfo,
        displayName: displayName || hostInfo.displayName || "Host Device",
      });
      if (hostInfo.roomId) {
        await this.setRoomHost(hostInfo.roomId, newId);
      }
    },
    async close() {
      if (isRedisReady) {
        await client.quit();
      }
    },
  };

  return store;
};

module.exports = {
  createRuntimeStore,
};

