import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClientType;
    redis: RedisClientType;
  }
}
