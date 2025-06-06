import { PrismaClient } from "@werewolf/database";
import { env } from "../config/env.js";

export function createPrismaClient(): PrismaClient {
  const prisma = new PrismaClient({
    log:
      env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

  return prisma;
}

export type PrismaClientType = ReturnType<typeof createPrismaClient>;
