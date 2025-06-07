import { GamePhase, GameRole, PlayerState } from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { GamePubSub } from "../lib/pubsub.js";

interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string | null;
  content: string;
  channel: string;
  timestamp: Date;
}

export class ChatService {
  private pubsub: GamePubSub | null = null;
  private profanityList: Set<string> = new Set([
    // Add profanity words here
    // This is a basic implementation - in production, use a proper profanity filter library
  ]);

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  setPubSub(pubsub: GamePubSub) {
    this.pubsub = pubsub;
  }

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

  async getChannelHistory(
    gameId: string,
    channel: string,
    playerId: string,
    limit: number = 50,
  ) {
    // Verify player can access this channel
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player || !this.canAccessChannel(player, channel)) {
      return [];
    }

    const messages = await this.prisma.gameMessage.findMany({
      where: {
        gameId,
        channel,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        game: {
          select: {
            players: {
              where: { id: playerId },
              include: { user: true },
            },
          },
        },
      },
    });

    // Map messages to include player names
    const messagesWithNames = await Promise.all(
      messages.map(async (msg) => {
        const msgPlayer = await this.prisma.player.findUnique({
          where: { id: msg.playerId },
          include: { user: true },
        });

        return {
          id: msg.id,
          playerId: msg.playerId,
          playerName: msgPlayer?.user.displayName || "Unknown",
          content: msg.content,
          channel: msg.channel,
          timestamp: msg.createdAt,
        };
      }),
    );

    return messagesWithNames.reverse(); // Return in chronological order
  }

  private canAccessChannel(
    player: { state: PlayerState; role: GameRole; game: { phase: GamePhase } },
    channel: string,
  ): boolean {
    switch (channel) {
      case "all":
        return (
          player.state === PlayerState.ALIVE &&
          player.game.phase === GamePhase.DAY_DISCUSSION
        );

      case "werewolves":
        return (
          player.state === PlayerState.ALIVE &&
          (
            [
              GameRole.WEREWOLF,
              GameRole.BLACK_WOLF,
              GameRole.WHITE_WOLF,
            ] as GameRole[]
          ).includes(player.role) &&
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
    // Trim and limit length
    let sanitized = content.trim().substring(0, 500);

    // Basic profanity filter
    this.profanityList.forEach((word) => {
      const regex = new RegExp(`\\b${word}\\b`, "gi");
      sanitized = sanitized.replace(regex, "*".repeat(word.length));
    });

    // Remove excessive whitespace
    sanitized = sanitized.replace(/\s+/g, " ");

    // Basic XSS prevention (though this should be handled on the frontend too)
    sanitized = sanitized
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    return sanitized;
  }

  private async broadcastMessage(
    gameId: string,
    channel: string,
    message: ChatMessage,
  ) {
    if (!this.pubsub) {
      console.error("PubSub not initialized for chat service");
      return;
    }

    // Broadcast to specific channel subscribers
    await this.pubsub.publishGameEvent(gameId, `chat:${channel}`, message);

    // Also broadcast a general chat event for UI updates
    await this.pubsub.publishGameEvent(gameId, "chat:message", {
      channel,
      messageId: message.id,
    });
  }

  async getAvailableChannels(
    gameId: string,
    playerId: string,
  ): Promise<string[]> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player) return [];

    const channels: string[] = [];

    // All channel - available during day discussion
    if (
      player.state === PlayerState.ALIVE &&
      player.game.phase === GamePhase.DAY_DISCUSSION
    ) {
      channels.push("all");
    }

    // Werewolves channel - available during night for werewolves
    if (
      player.state === PlayerState.ALIVE &&
      (
        [
          GameRole.WEREWOLF,
          GameRole.BLACK_WOLF,
          GameRole.WHITE_WOLF,
        ] as GameRole[]
      ).includes(player.role) &&
      player.game.phase === GamePhase.NIGHT_PHASE
    ) {
      channels.push("werewolves");
    }

    // Dead channel - available for dead players
    if (player.state === PlayerState.DEAD) {
      channels.push("dead");
    }

    return channels;
  }

  async clearGameChat(gameId: string) {
    await this.prisma.gameMessage.deleteMany({
      where: { gameId },
    });
  }

  // System messages for game events
  async sendSystemMessage(gameId: string, channel: string, content: string) {
    const message = await this.prisma.gameMessage.create({
      data: {
        gameId,
        playerId: "system", // Special system player ID
        channel,
        content,
      },
    });

    await this.broadcastMessage(gameId, channel, {
      id: message.id,
      playerId: "system",
      playerName: "System",
      content: message.content,
      channel,
      timestamp: message.createdAt,
    });

    return message;
  }

  // Get unread message count for a player
  async getUnreadCount(gameId: string, playerId: string): Promise<number> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player) return 0;

    const lastReadKey = `chat:lastread:${gameId}:${playerId}`;
    const lastReadTime = await this.redis.get(lastReadKey);
    const since = lastReadTime ? new Date(lastReadTime) : player.joinedAt;

    const channels = await this.getAvailableChannels(gameId, playerId);

    const count = await this.prisma.gameMessage.count({
      where: {
        gameId,
        channel: { in: channels },
        createdAt: { gt: since },
        NOT: { playerId }, // Don't count own messages
      },
    });

    return count;
  }

  // Mark messages as read for a player
  async markAsRead(gameId: string, playerId: string, channel: string) {
    const lastReadKey = `chat:lastread:${gameId}:${playerId}:${channel}`;
    await this.redis.set(lastReadKey, new Date().toISOString());
  }
}
