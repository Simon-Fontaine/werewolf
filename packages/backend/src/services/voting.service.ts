import { ActionType, GamePhase, PlayerState } from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";

export class VotingService {
  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  async castVote(gameId: string, voterId: string, targetId: string | null) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game || game.phase !== GamePhase.DAY_VOTING) {
      throw new Error("Invalid voting phase");
    }

    const voter = game.players.find((p) => p.id === voterId);
    if (!voter || voter.state !== PlayerState.ALIVE) {
      throw new Error("Invalid voter");
    }

    // Validate target if not abstaining
    if (targetId) {
      const target = game.players.find((p) => p.id === targetId);
      if (!target || target.state !== PlayerState.ALIVE) {
        throw new Error("Invalid target");
      }
    }

    // Record vote (upsert to allow vote changes)
    await this.prisma.gameAction.upsert({
      where: {
        gameId_performerId_actionType_dayNumber_phase: {
          gameId,
          performerId: voterId,
          actionType: ActionType.DAY_VOTE,
          dayNumber: game.dayNumber,
          phase: GamePhase.DAY_VOTING,
        },
      },
      create: {
        gameId,
        performerId: voterId,
        targetId,
        actionType: ActionType.DAY_VOTE,
        dayNumber: game.dayNumber,
        phase: GamePhase.DAY_VOTING,
      },
      update: {
        targetId,
        createdAt: new Date(), // Update timestamp
      },
    });

    // Check if all living players have voted
    const livingPlayers = game.players.filter(
      (p) => p.state === PlayerState.ALIVE,
    );
    const votes = await this.getVotes(gameId, game.dayNumber);

    if (votes.length === livingPlayers.length) {
      // Everyone voted, end phase early
      await this.processVoteResults(gameId);
    }

    // Emit vote update
    await this.emitVoteUpdate(gameId);
  }

  async processVoteResults(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) return;

    const votes = await this.getVotes(gameId, game.dayNumber);
    const voteCount = this.countVotes(votes);

    // Find player(s) with most votes
    const maxVotes = Math.max(...Object.values(voteCount));
    const targets = Object.entries(voteCount)
      .filter(([_, count]) => count === maxVotes)
      .map(([playerId, _]) => playerId);

    // Handle tie or no elimination
    let eliminatedPlayerId: string | null = null;

    if (targets.length === 1 && maxVotes > 0) {
      eliminatedPlayerId = targets[0];
    } else if (targets.length > 1) {
      // Tie-breaking logic (could be random, mayor decision, etc.)
      eliminatedPlayerId = await this.breakTie(gameId, targets);
    }

    if (eliminatedPlayerId) {
      await this.eliminatePlayer(gameId, eliminatedPlayerId, "voted_out");
    }

    // Record vote results
    await this.prisma.gameEvent.create({
      data: {
        gameId,
        eventType: "vote_results",
        dayNumber: game.dayNumber,
        data: {
          voteCount,
          eliminated: eliminatedPlayerId,
          tie: targets.length > 1,
        },
      },
    });
  }

  private countVotes(votes: any[]): Record<string, number> {
    const count: Record<string, number> = {};

    votes.forEach((vote) => {
      if (vote.targetId) {
        count[vote.targetId] = (count[vote.targetId] || 0) + 1;
      }
    });

    return count;
  }
}
