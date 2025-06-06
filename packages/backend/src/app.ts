import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { Server as SocketIOServer } from "socket.io";
import { createServer } from "http";
import { env } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import { createPrismaClient } from "./lib/prisma.js";
import { createRedisClient } from "./lib/redis.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerUserRoutes } from "./routes/users.js";
import { setupSocketHandlers } from "./socket/index.js";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

export async function createApp(): Promise<{
  app: FastifyInstance;
  io: SocketIOServer;
}> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    },
  });

  // Database clients
  const prisma = createPrismaClient();
  const redis = createRedisClient();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Decorate fastify instance
  app.decorate("prisma", prisma);
  app.decorate("redis", redis);

  // Register plugins
  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: "token",
      signed: false,
    },
  });

  await app.register(authPlugin);

  // Routes
  await app.register(registerAuthRoutes, { prefix: "/api/auth" });
  await app.register(registerGameRoutes, { prefix: "/api/games" });
  await app.register(registerUserRoutes, { prefix: "/api/users" });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Create HTTP server and Socket.IO
  const httpServer = createServer(app.server);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.FRONTEND_URL,
      credentials: true,
    },
  });

  // Setup socket handlers
  setupSocketHandlers(io, prisma, redis);

  return { app, io };
}
