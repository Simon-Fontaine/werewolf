import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { GameService } from "./game.service.js";

interface QueuedPlayer {
  userId: string;
  skill: number;
  joinedAt: number;
}

export class MatchmakingService {
  private readonly QUEUE_KEY = "matchmaking:queue";
  private readonly MATCH_SIZE = 8; // Optimal game size
  private readonly SKILL_TOLERANCE = 200; // Skill rating difference tolerance

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
    private gameService: GameService,
  ) {
    // Start matchmaking loop
    this.startMatchmakingLoop();
  }

  async joinQueue(userId: string) {
    // Get user's skill rating (based on win rate)
    const stats = await this.prisma.userStats.findUnique({
      where: { userId },
    });

    const skill = this.calculateSkillRating(stats);

    const player: QueuedPlayer = {
      userId,
      skill,
      joinedAt: Date.now(),
    };

    // Add to queue
    await this.redis.zadd(this.QUEUE_KEY, skill, JSON.stringify(player));

    // Try to make a match immediately
    await this.tryCreateMatch();

    return { queued: true, estimatedWait: this.estimateWaitTime() };
  }

  async leaveQueue(userId: string) {
    const members = await this.redis.zrange(this.QUEUE_KEY, 0, -1);

    for (const member of members) {
      const player = JSON.parse(member) as QueuedPlayer;
      if (player.userId === userId) {
        await this.redis.zrem(this.QUEUE_KEY, member);
        return { removed: true };
      }
    }

    return { removed: false };
  }

  private async tryCreateMatch() {
    const members = await this.redis.zrange(this.QUEUE_KEY, 0, -1);

    if (members.length < this.MATCH_SIZE) return;

    const players = members.map((m) => JSON.parse(m) as QueuedPlayer);

    // Sort by skill
    players.sort((a, b) => a.skill - b.skill);

    // Try to find a group of players with similar skill
    for (let i = 0; i <= players.length - this.MATCH_SIZE; i++) {
      const group = players.slice(i, i + this.MATCH_SIZE);
      const skillDiff = group[group.length - 1].skill - group[0].skill;

      if (skillDiff <= this.SKILL_TOLERANCE) {
        // Found a match!
        await this.createGameFromMatch(group);

        // Remove matched players from queue
        for (const player of group) {
          await this.redis.zrem(this.QUEUE_KEY, JSON.stringify(player));
        }

        return;
      }
    }

    // If no perfect match, check if anyone has been waiting too long
    const now = Date.now();
    const maxWaitTime = 120000; // 2 minutes

    const waitingPlayers = players.filter(
      (p) => now - p.joinedAt > maxWaitTime,
    );

    if (waitingPlayers.length >= this.MATCH_SIZE) {
      // Create a game with players who have been waiting
      const group = waitingPlayers.slice(0, this.MATCH_SIZE);
      await this.createGameFromMatch(group);

      for (const player of group) {
        await this.redis.zrem(this.QUEUE_KEY, JSON.stringify(player));
      }
    }
  }

  private async createGameFromMatch(players: QueuedPlayer[]) {
    // Select a random host
    const hostIndex = Math.floor(Math.random() * players.length);
    const hostId = players[hostIndex].userId;

    // Create the game
    const game = await this.gameService.createGame(hostId, {
      name: "Ranked Match",
      minPlayers: this.MATCH_SIZE,
      maxPlayers: this.MATCH_SIZE,
      isPrivate: false,
    });

    // Add all other players
    for (const player of players) {
      if (player.userId !== hostId) {
        await this.gameService.joinGame(game.id, player.userId);
      }
    }

    // Auto-start the game
    setTimeout(async () => {
      await this.gameService.startGame(game.id, hostId);
    }, 10000); // 10 second countdown

    // Notify players
    for (const player of players) {
      await this.redis.publish(
        `user:${player.userId}:matched`,
        JSON.stringify({
          gameId: game.id,
          gameCode: game.code,
        }),
      );
    }
  }

  private calculateSkillRating(
    stats: { gamesPlayed: number; gamesWon: number } | null,
  ): number {
    if (!stats || stats.gamesPlayed === 0) return 1000; // Default rating

    const winRate = stats.gamesWon / stats.gamesPlayed;
    const experienceFactor = Math.min(stats.gamesPlayed / 100, 1); // Cap at 100 games

    // Base rating: 500-1500 based on win rate
    // Experience bonus: 0-500 based on games played
    return Math.round(500 + winRate * 1000 + experienceFactor * 500);
  }

  private async estimateWaitTime(): Promise<number> {
    const queueSize = await this.redis.zcard(this.QUEUE_KEY);

    // Rough estimate: 30 seconds per match needed
    const matchesNeeded = Math.ceil(queueSize / this.MATCH_SIZE);
    return matchesNeeded * 30;
  }

  private startMatchmakingLoop() {
    setInterval(async () => {
      await this.tryCreateMatch();
    }, 5000); // Check every 5 seconds
  }
}
