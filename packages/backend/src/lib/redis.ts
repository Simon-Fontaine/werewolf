import { Redis } from "ioredis";
import { env } from "../config/env.js";

export function createRedisClient() {
  const redis = new Redis(env.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 50, 2000),
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err);
  });

  redis.on("connect", () => {
    console.log("Redis connected");
  });

  return redis;
}

export type RedisClientType = ReturnType<typeof createRedisClient>;
