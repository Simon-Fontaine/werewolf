import { ActionType, GamePhase, PlayerState, Prisma } from "@werewolf/database";
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
      // Tie-breaking logic
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

    // Check for game end conditions
    await this.checkGameEndConditions(gameId);
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
      include: { game: true },
    });

    if (!player) return;

    // Hunter's revenge shot
    if (player.role === "HUNTER") {
      // In a real implementation, you'd prompt the Hunter to choose a target
      // For now, we'll mark that the Hunter needs to take their shot
      await this.prisma.gameEvent.create({
        data: {
          gameId,
          eventType: "hunter_triggered",
          dayNumber: player.game.dayNumber,
          data: { hunterId: playerId },
        },
      });
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

    // Heir inheritance
    const heirAbility = await this.prisma.ability.findFirst({
      where: {
        abilityType: "heir_target",
        metadata: {
          path: ["targetId"],
          equals: playerId,
        },
      },
      include: { player: true },
    });

    if (heirAbility && heirAbility.player.state === PlayerState.ALIVE) {
      // Heir inherits the role
      await this.prisma.player.update({
        where: { id: heirAbility.playerId },
        data: { role: player.role },
      });

      // Transfer abilities
      const targetAbilities = await this.prisma.ability.findMany({
        where: { playerId },
      });

      for (const ability of targetAbilities) {
        await this.prisma.ability.create({
          data: {
            playerId: heirAbility.playerId,
            abilityType: ability.abilityType,
            usesLeft: ability.usesLeft,
            maxUses: ability.maxUses,
            cooldownDays: ability.cooldownDays,
            lastUsedDay: ability.lastUsedDay,
          },
        });
      }
    }

    // Wolf Riding Hood protection check
    if (player.role === "BLACK_WOLF") {
      const wolfRidingHood = await this.prisma.player.findFirst({
        where: {
          gameId,
          role: "WOLF_RIDING_HOOD",
          state: PlayerState.ALIVE,
        },
      });

      if (wolfRidingHood) {
        // Wolf Riding Hood loses protection
        await this.prisma.gameEvent.create({
          data: {
            gameId,
            eventType: "protection_lost",
            dayNumber: player.game.dayNumber,
            data: {
              playerId: wolfRidingHood.id,
              protectionType: "black_wolf",
            },
          },
        });
      }
    }

    // Similar check for Hunter/Red Riding Hood relationship
    if (player.role === "HUNTER") {
      const redRidingHood = await this.prisma.player.findFirst({
        where: {
          gameId,
          role: "RED_RIDING_HOOD",
          state: PlayerState.ALIVE,
        },
      });

      if (redRidingHood) {
        await this.prisma.gameEvent.create({
          data: {
            gameId,
            eventType: "protection_lost",
            dayNumber: player.game.dayNumber,
            data: {
              playerId: redRidingHood.id,
              protectionType: "hunter",
            },
          },
        });
      }
    }
  }

  private async checkGameEndConditions(gameId: string) {
    const alivePlayers = await this.prisma.player.findMany({
      where: {
        gameId,
        state: PlayerState.ALIVE,
      },
    });

    if (alivePlayers.length === 0) {
      await this.endGame(gameId, null, "all_players_dead");
      return;
    }

    // Count teams
    const teamCounts = {
      WEREWOLVES: 0,
      VILLAGERS: 0,
      SOLO: 0,
    };

    const roleService = new (await import("./role.service.js")).RoleService(
      this.prisma,
    );

    alivePlayers.forEach((player) => {
      const team = roleService.getTeamForRole(player.role);
      teamCounts[team]++;
    });

    // Check White Wolf win condition (sole survivor)
    const whiteWolf = alivePlayers.find((p) => p.role === "WHITE_WOLF");
    if (whiteWolf && alivePlayers.length === 1) {
      await this.endGame(gameId, "SOLO", "white_wolf_victory");
      return;
    }

    // Check Werewolves win condition (equal or greater than villagers)
    if (teamCounts.WEREWOLVES >= teamCounts.VILLAGERS + teamCounts.SOLO) {
      await this.endGame(gameId, "WEREWOLVES", "werewolves_majority");
      return;
    }

    // Check Villagers win condition (no werewolves)
    if (teamCounts.WEREWOLVES === 0) {
      await this.endGame(gameId, "VILLAGERS", "werewolves_eliminated");
      return;
    }
  }

  private async endGame(
    gameId: string,
    winningTeam: string | null,
    reason: string,
  ) {
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        state: "ENDED",
        phase: "GAME_END",
        winningTeam: winningTeam as any,
        endReason: reason,
        endedAt: new Date(),
      },
    });

    if (this.pubsub) {
      await this.pubsub.publishGameEvent(gameId, "game:ended", {
        winningTeam,
        reason,
      });
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
