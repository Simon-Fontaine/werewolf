import { Server as SocketIOServer } from "socket.io";
import type { PrismaClientType } from "../lib/prisma.js";
import type { RedisClientType } from "../lib/redis.js";

export function setupSocketHandlers(
  io: SocketIOServer,
  prisma: PrismaClientType,
  redis: RedisClientType,
) {
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });
}
