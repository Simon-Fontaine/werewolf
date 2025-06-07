import { GameState } from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";

// packages/backend/src/services/cleanup.service.ts
export class CleanupService {
  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {
    this.startCleanupInterval();
  }

  private startCleanupInterval() {
    setInterval(async () => {
      await this.cleanupAbandonedGames();
      await this.cleanupExpiredSessions();
    }, 300000); // 5 minutes
  }

  private async cleanupAbandonedGames() {
    const oneHourAgo = new Date(Date.now() - 3600000);

    const abandonedGames = await this.prisma.game.findMany({
      where: {
        state: GameState.WAITING,
        createdAt: { lt: oneHourAgo },
      },
    });

    for (const game of abandonedGames) {
      await this.prisma.game.update({
        where: { id: game.id },
        data: { state: GameState.CANCELLED },
      });
      await this.redis.del(`game:${game.id}`);
    }
  }

  private async cleanupExpiredSessions() {
    await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }
}
