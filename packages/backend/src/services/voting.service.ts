import {
  ActionType,
  GamePhase,
  PlayerState,
  Prisma,
  GameRole,
} from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { GamePubSub } from "../lib/pubsub.js";

export class VotingService {
  private pubsub: GamePubSub | null = null;

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  setPubSub(pubsub: GamePubSub) {
    this.pubsub = pubsub;
  }

  async castVote(gameId: string, voterId: string, targetId: string | null) {
    // Use transaction to prevent race conditions
    return await this.prisma.$transaction(
      async (tx) => {
        // Lock the game row to prevent concurrent modifications
        const game = await tx.game.update({
          where: { id: gameId },
          data: {}, // Touch to lock
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
        await tx.gameAction.upsert({
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

        const voteCount = await tx.gameAction.count({
          where: {
            gameId,
            actionType: ActionType.DAY_VOTE,
            dayNumber: game.dayNumber,
            phase: GamePhase.DAY_VOTING,
          },
        });

        if (voteCount === livingPlayers.length) {
          // Everyone voted, schedule immediate phase end
          await this.redis.zadd(
            "phase_timers",
            Date.now(),
            JSON.stringify({ gameId, trigger: "all_voted" }),
          );
        }

        // Emit vote update
        await this.emitVoteUpdate(gameId);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  async getVotes(gameId: string, dayNumber: number) {
    return this.prisma.gameAction.findMany({
      where: {
        gameId,
        actionType: ActionType.DAY_VOTE,
        dayNumber,
        phase: GamePhase.DAY_VOTING,
      },
      include: {
        performer: {
          include: {
            user: {
              select: { displayName: true },
            },
          },
        },
        target: {
          include: {
            user: {
              select: { displayName: true },
            },
          },
        },
      },
    });
  }

  async processVoteResults(gameId: string) {
    // Use transaction for atomic vote processing
    await this.prisma.$transaction(async (tx) => {
      const game = await tx.game.findUnique({
        where: { id: gameId },
        include: { players: true },
      });

      if (!game) return;

      const votes = await this.getVotes(gameId, game.dayNumber);
      const voteCount = this.countVotes(votes);

      // Apply Mayor (successful Dictator) double votes
      const mayorVotes = await this.applyMayorVotes(tx, gameId, voteCount);

      // Find player(s) with most votes
      const maxVotes = Math.max(...Object.values(mayorVotes));
      const targets = Object.entries(mayorVotes)
        .filter(([_, count]) => count === maxVotes)
        .map(([playerId, _]) => playerId);

      // Handle tie or no elimination
      let eliminatedPlayerId: string | null = null;

      if (targets.length === 1 && maxVotes > 0) {
        eliminatedPlayerId = targets[0];
      } else if (targets.length > 1) {
        // Tie-breaking logic
        eliminatedPlayerId = await this.breakTie(gameId, targets);
      }

      if (eliminatedPlayerId) {
        // Check for special protections
        const isProtected = await this.checkVoteProtection(
          tx,
          eliminatedPlayerId,
        );

        if (!isProtected) {
          await this.eliminatePlayer(gameId, eliminatedPlayerId, "voted_out");

          // Check Mercenary win condition
          const gameEngineService = new (
            await import("./game-engine.service.js")
          ).GameEngineService(this.prisma, this.redis, null as any);
          await gameEngineService.checkMercenaryWinCondition(
            gameId,
            eliminatedPlayerId,
          );
        } else {
          await this.publishGameEvent(gameId, "vote_protection", {
            message: "The vote target was protected and survives!",
          });
        }
      }

      // Record vote results
      await tx.gameEvent.create({
        data: {
          gameId,
          eventType: "vote_results",
          dayNumber: game.dayNumber,
          data: {
            voteCount: mayorVotes,
            eliminated: eliminatedPlayerId,
            tie: targets.length > 1,
          },
        },
      });

      // Transition Mercenary if Day 1 ended without their target dying
      if (game.dayNumber === 1) {
        const gameEngineService = new (
          await import("./game-engine.service.js")
        ).GameEngineService(this.prisma, this.redis, null as any);
        await gameEngineService.transitionMercenaryToVillager(gameId);
      }
    });

    // Check for game end conditions
    await this.checkGameEndConditions(gameId);
  }

  private async applyMayorVotes(
    tx: any,
    gameId: string,
    baseVotes: Record<string, number>,
  ): Promise<Record<string, number>> {
    const result = { ...baseVotes };

    // Find players with Mayor ability (successful Dictators)
    const mayorPlayers = await tx.player.findMany({
      where: {
        gameId,
        state: PlayerState.ALIVE,
        abilities: {
          some: {
            abilityType: "mayor_vote",
            usesLeft: { gt: 0 },
          },
        },
      },
    });

    for (const mayor of mayorPlayers as any[]) {
      const mayorVote = await tx.gameAction.findFirst({
        where: {
          gameId,
          performerId: mayor.id,
          actionType: ActionType.DAY_VOTE,
          targetId: { not: null },
        },
      });

      if (mayorVote && mayorVote.targetId) {
        // Double the mayor's vote
        result[mayorVote.targetId] = (result[mayorVote.targetId] || 0) + 1;
      }
    }

    return result;
  }

  private async checkVoteProtection(
    tx: any,
    playerId: string,
  ): Promise<boolean> {
    const player = await tx.player.findUnique({
      where: { id: playerId },
      include: {
        game: {
          include: {
            players: true,
          },
        },
      },
    });

    if (!player) return false;

    // Wolf Riding Hood protection
    if (player.role === GameRole.WOLF_RIDING_HOOD) {
      const blackWolfAlive = player.game.players.some(
        (p: { role: GameRole; state: PlayerState }) =>
          p.role === GameRole.BLACK_WOLF && p.state === PlayerState.ALIVE,
      );
      return blackWolfAlive;
    }

    return false;
  }

  private countVotes(
    votes: { targetId?: string | null }[],
  ): Record<string, number> {
    const count: Record<string, number> = {};

    votes.forEach((vote) => {
      if (vote.targetId) {
        count[vote.targetId] = (count[vote.targetId] || 0) + 1;
      }
    });

    return count;
  }

  private async breakTie(
    gameId: string,
    tiedPlayerIds: string[],
  ): Promise<string | null> {
    // Check if there's a Mayor (Dictator who successfully eliminated a werewolf)
    const mayorPlayer = await this.prisma.player.findFirst({
      where: {
        gameId,
        state: PlayerState.ALIVE,
        abilities: {
          some: {
            abilityType: "mayor_vote",
            usesLeft: { gt: 0 },
          },
        },
      },
    });

    if (mayorPlayer) {
      // Mayor decides the tie
      await this.publishGameEvent(gameId, "mayor_tiebreak", {
        mayorId: mayorPlayer.id,
        tiedPlayers: tiedPlayerIds,
      });

      // In a real implementation, you'd wait for the Mayor's decision
      // For now, we'll randomly select from tied players
      return tiedPlayerIds[Math.floor(Math.random() * tiedPlayerIds.length)];
    }

    // No elimination on tie (standard rule)
    return null;
  }

  async eliminatePlayer(gameId: string, playerId: string, reason: string) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: {
        user: true,
        game: true,
      },
    });

    if (!player || player.state !== PlayerState.ALIVE) return;

    // Update player state
    await this.prisma.player.update({
      where: { id: playerId },
      data: {
        state: PlayerState.DEAD,
        diedAt: new Date(),
      },
    });

    // Record death event
    await this.prisma.gameEvent.create({
      data: {
        gameId,
        eventType: "player_died",
        dayNumber: player.game.dayNumber,
        data: {
          playerId,
          playerName: player.user.displayName,
          role: player.role,
          reason,
        },
      },
    });

    // Handle special death triggers
    await this.handleDeathTriggers(gameId, playerId);

    // Emit death event
    if (this.pubsub) {
      await this.pubsub.publishGameEvent(gameId, "player:died", {
        playerId,
        playerName: player.user.displayName,
        reason,
      });
    }
  }

  private async handleDeathTriggers(gameId: string, playerId: string) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true, user: true },
    });

    if (!player) return;

    // Hunter's revenge shot
    if (player.role === GameRole.HUNTER) {
      await this.prisma.gameEvent.create({
        data: {
          gameId,
          eventType: "hunter_triggered",
          dayNumber: player.game.dayNumber,
          data: { hunterId: playerId },
        },
      });

      if (this.pubsub) {
        await this.pubsub.publishGameEvent(gameId, "hunter:triggered", {
          hunterId: playerId,
        });
      }
    }

    // Cupid's lover link
    if (player.linkedTo) {
      const lover = await this.prisma.player.findUnique({
        where: { id: player.linkedTo },
      });

      if (lover && lover.state === PlayerState.ALIVE) {
        await this.eliminatePlayer(gameId, lover.id, "died_of_grief");
      }
    }

    // Check if someone was linked to this player
    const linkedLover = await this.prisma.player.findFirst({
      where: {
        gameId,
        linkedTo: playerId,
        state: PlayerState.ALIVE,
      },
    });

    if (linkedLover) {
      await this.eliminatePlayer(gameId, linkedLover.id, "died_of_grief");
    }

    // Call shared death trigger handler
    const gameEngineService = new (
      await import("./game-engine.service.js")
    ).GameEngineService(this.prisma, this.redis, null as any);
    await gameEngineService["handleDeathTriggers"](gameId, {
      id: player.id,
      role: player.role,
      linkedTo: player.linkedTo,
      user: { displayName: player.user?.displayName || "Unknown" },
    });
  }

  private async checkGameEndConditions(gameId: string) {
    const gameEngineService = new (
      await import("./game-engine.service.js")
    ).GameEngineService(this.prisma, this.redis, null as any);

    const winner = await gameEngineService["checkWinConditions"](gameId);
    if (winner !== null) {
      await gameEngineService["endGame"](gameId, winner);
    }
  }

  private async publishGameEvent(gameId: string, event: string, data: any) {
    if (this.pubsub) {
      await this.pubsub.publishGameEvent(gameId, event, data);
    }
  }

  async emitVoteUpdate(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    const votes = await this.getVotes(gameId, game.dayNumber);
    const voteCount = this.countVotes(votes);

    // Create a detailed vote summary
    const voteSummary = await Promise.all(
      Object.entries(voteCount).map(async ([targetId, count]) => {
        const target = await this.prisma.player.findUnique({
          where: { id: targetId },
          include: { user: true },
        });

        const voters = votes
          .filter((v) => v.targetId === targetId)
          .map((v) => ({
            id: v.performer.id,
            displayName: v.performer.user.displayName,
          }));

        return {
          targetId,
          targetName: target?.user.displayName || "Unknown",
          voteCount: count,
          voters,
        };
      }),
    );

    if (this.pubsub) {
      await this.pubsub.publishGameEvent(gameId, "vote:update", {
        voteSummary,
        totalVotes: votes.length,
        livingPlayers: await this.prisma.player.count({
          where: { gameId, state: PlayerState.ALIVE },
        }),
      });
    }
  }
}
