import { GamePhase, GameRole, PlayerState } from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";

export class ChatService {
  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  async sendMessage(
    gameId: string,
    playerId: string,
    content: string,
    channel: string,
  ) {
    // Validate player can send to this channel
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true, user: true },
    });

    if (!player) throw new Error("Player not found");

    // Check channel permissions
    if (!this.canAccessChannel(player, channel)) {
      throw new Error("No access to this channel");
    }

    // Rate limiting check
    const rateLimitKey = `chat:ratelimit:${playerId}`;
    const messageCount = await this.redis.incr(rateLimitKey);

    if (messageCount === 1) {
      await this.redis.expire(rateLimitKey, 60); // 1 minute window
    }

    if (messageCount > 10) {
      throw new Error("Rate limit exceeded");
    }

    // Store message
    const message = await this.prisma.gameMessage.create({
      data: {
        gameId,
        playerId,
        channel,
        content: this.sanitizeMessage(content),
      },
    });

    // Broadcast to channel subscribers
    await this.broadcastMessage(gameId, channel, {
      id: message.id,
      playerId,
      playerName: player.user.displayName,
      content: message.content,
      channel,
      timestamp: message.createdAt,
    });

    return message;
  }

  private canAccessChannel(player: any, channel: string): boolean {
    switch (channel) {
      case "all":
        return (
          player.state === PlayerState.ALIVE &&
          player.game.phase === GamePhase.DAY_DISCUSSION
        );

      case "werewolves":
        return (
          player.state === PlayerState.ALIVE &&
          [
            GameRole.WEREWOLF,
            GameRole.BLACK_WOLF,
            GameRole.WHITE_WOLF,
          ].includes(player.role) &&
          player.game.phase === GamePhase.NIGHT_PHASE
        );

      case "dead":
        return player.state === PlayerState.DEAD;

      case "spectators":
        return false; // Handled separately for spectator model

      default:
        return false;
    }
  }

  private sanitizeMessage(content: string): string {
    // Basic sanitization - expand as needed
    return content.trim().substring(0, 500);
  }
}
