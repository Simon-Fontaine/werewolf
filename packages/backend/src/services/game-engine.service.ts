import {
  GamePhase,
  GameState,
  PlayerState,
  GameRole,
  ActionType,
  Team,
  ActionResult as GameActionResult,
} from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { ActionResult } from "../types/game.types.js";
import { GAME_CONFIG } from "../config/game.config.js";

export class GameEngineService {
  private phaseTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  async scheduleGameStart(gameId: string) {
    // Notify players game will start in 10 seconds
    await this.publishGameEvent(gameId, "game_starting", { countdown: 10 });

    setTimeout(async () => {
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        include: { players: true },
      });

      if (
        game &&
        game.state === GameState.WAITING &&
        game.players.length >= game.minPlayers
      ) {
        // Auto-start the game
        await this.transitionToPhase(gameId, GamePhase.ROLE_ASSIGNMENT);
      }
    }, 10000);
  }

  async transitionToPhase(gameId: string, nextPhase: GamePhase) {
    // Clear existing timer
    this.clearPhaseTimer(gameId);

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) throw new Error("Game not found");

    // Process end of current phase
    await this.processPhaseEnd(gameId, game.phase);

    // Check win conditions before transitioning
    const winner = await this.checkWinConditions(gameId);
    if (winner) {
      await this.endGame(gameId, winner);
      return;
    }

    // Determine phase duration
    const duration = this.getPhaseDuration(game, nextPhase);
    const phaseEndsAt = duration
      ? new Date(Date.now() + duration * 1000)
      : null;

    // Update game state
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        phase: nextPhase,
        state: this.getStateForPhase(nextPhase),
        phaseStartedAt: new Date(),
        phaseEndsAt,
        dayNumber:
          nextPhase === GamePhase.NIGHT_PHASE
            ? game.dayNumber + 1
            : game.dayNumber,
      },
    });

    // Execute phase-specific logic
    await this.executePhaseTransition(gameId, nextPhase);

    // Schedule next phase if applicable
    if (duration && nextPhase !== GamePhase.GAME_END) {
      this.schedulePhaseEnd(gameId, nextPhase, duration);
    }

    // Emit phase change event
    await this.publishGameEvent(gameId, "phase_change", {
      phase: nextPhase,
      duration,
      endsAt: phaseEndsAt,
      dayNumber:
        nextPhase === GamePhase.NIGHT_PHASE
          ? game.dayNumber + 1
          : game.dayNumber,
    });
  }

  private async processPhaseEnd(gameId: string, currentPhase: GamePhase) {
    switch (currentPhase) {
      case GamePhase.NIGHT_PHASE:
        await this.processNightActions(gameId);
        break;
      case GamePhase.DAY_VOTING:
        // Voting results are processed by VotingService
        break;
    }
  }

  private async executePhaseTransition(gameId: string, phase: GamePhase) {
    switch (phase) {
      case GamePhase.ROLE_ASSIGNMENT:
        await this.startRoleAssignment(gameId);
        break;
      case GamePhase.NIGHT_PHASE:
        await this.startNightPhase(gameId);
        break;
      case GamePhase.DAY_DISCUSSION:
        await this.startDayPhase(gameId);
        break;
      case GamePhase.DAY_VOTING:
        await this.startVotingPhase(gameId);
        break;
      case GamePhase.GAME_END:
        // Game end is handled by endGame method
        break;
    }
  }

  private async startRoleAssignment(gameId: string) {
    // Role assignment is handled by RoleService
    // This phase is just for revealing roles to players
    setTimeout(async () => {
      await this.transitionToPhase(gameId, GamePhase.NIGHT_PHASE);
    }, 5000); // 5 seconds to view role
  }

  private async startNightPhase(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Reset night actions
    await this.prisma.gameAction.deleteMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber: game.dayNumber,
      },
    });

    // Enable night abilities for special roles
    const players = await this.prisma.player.findMany({
      where: { gameId, state: PlayerState.ALIVE },
    });

    // Notify players with night abilities
    for (const player of players) {
      if (this.hasNightAbility(player.role)) {
        await this.publishPlayerEvent(
          gameId,
          player.id,
          "night_ability_available",
          {
            role: player.role,
            abilities: this.getNightAbilities(player.role),
          },
        );
      }
    }

    // Special: If it's the first night, Cupid and Heir act
    if (game.dayNumber === 1) {
      const specialFirstNightRoles = [
        GameRole.CUPID,
        GameRole.HEIR,
      ] as GameRole[];
      const firstNightPlayers = players.filter((p) =>
        specialFirstNightRoles.includes(p.role),
      );

      for (const player of firstNightPlayers) {
        await this.publishPlayerEvent(gameId, player.id, "first_night_action", {
          role: player.role,
        });
      }
    }
  }

  private async startDayPhase(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    const gameWithEvents = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { events: { where: { dayNumber: game.dayNumber } } },
    });

    if (!gameWithEvents) return;

    // Announce night results
    const nightEvents = gameWithEvents.events.filter(
      (e) => e.eventType === "night_death",
    );

    for (const event of nightEvents) {
      const data = event.data as any;
      await this.publishGameEvent(gameId, "player_died", {
        playerId: data.playerId,
        playerName: data.playerName,
        deathCause: data.cause,
      });
    }

    // Check for Talkative Seer investigations
    const talkativeSeerAction = await this.prisma.gameAction.findFirst({
      where: {
        gameId,
        actionType: ActionType.SEER_INVESTIGATE,
        dayNumber: game.dayNumber,
        performer: {
          role: GameRole.TALKATIVE_SEER,
        },
      },
      include: {
        performer: { include: { user: true } },
        target: { include: { user: true } },
      },
    });

    if (talkativeSeerAction && talkativeSeerAction.target) {
      await this.publishGameEvent(gameId, "talkative_seer_result", {
        seerName: talkativeSeerAction.performer.user.displayName,
        targetName: talkativeSeerAction.target.user.displayName,
        targetRole: talkativeSeerAction.target.role,
      });
    }

    // Enable day chat
    await this.publishGameEvent(gameId, "chat_enabled", {
      channel: "all",
    });
  }

  private async startVotingPhase(gameId: string) {
    // Clear any existing votes
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    await this.prisma.gameAction.deleteMany({
      where: {
        gameId,
        actionType: ActionType.DAY_VOTE,
        dayNumber: game.dayNumber,
      },
    });

    // Notify players voting has started
    await this.publishGameEvent(gameId, "voting_started", {
      timeLimit: game.voteDuration,
    });
  }

  private async processNightActions(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Get all night actions for this phase
    const actions = await this.prisma.gameAction.findMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber: game.dayNumber,
      },
      include: {
        performer: true,
        target: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Process in priority order
    const prioritizedActions = this.prioritizeActions(actions);
    const results: ActionResult[] = [];

    // Track protections and other effects
    const protectedPlayers = new Set<string>();
    const deaths = new Map<string, string>(); // playerId -> cause

    for (const action of prioritizedActions) {
      const result = await this.processAction(action, {
        protectedPlayers,
        deaths,
        game,
      });
      results.push(result);
    }

    // Apply deaths
    for (const [playerId, cause] of deaths) {
      if (!protectedPlayers.has(playerId)) {
        await this.killPlayer(gameId, playerId, cause);
      } else {
        // Player was saved
        await this.publishGameEvent(gameId, "player_saved", {
          message: "Someone was attacked but saved!",
        });
      }
    }
  }

  private async processAction(
    action: any,
    context: {
      protectedPlayers: Set<string>;
      deaths: Map<string, string>;
      game: any;
    },
  ): Promise<ActionResult> {
    const result: ActionResult = {
      action: action.actionType,
      success: false,
      targetId: action.targetId,
    };

    switch (action.actionType) {
      case ActionType.WEREWOLF_VOTE: {
        // Werewolf votes are tallied at end
        const werewolfVotes = await this.prisma.gameAction.findMany({
          where: {
            gameId: action.gameId,
            actionType: ActionType.WEREWOLF_VOTE,
            dayNumber: context.game.dayNumber,
            phase: GamePhase.NIGHT_PHASE,
          },
        });

        // Count votes
        const voteCount = new Map<string, number>();
        werewolfVotes.forEach((vote) => {
          if (vote.targetId) {
            voteCount.set(
              vote.targetId,
              (voteCount.get(vote.targetId) || 0) + 1,
            );
          }
        });

        // Find target with most votes
        let maxVotes = 0;
        let target: string | null = null;
        voteCount.forEach((votes, playerId) => {
          if (votes > maxVotes) {
            maxVotes = votes;
            target = playerId;
          }
        });

        if (target) {
          context.deaths.set(target, "werewolf_attack");
          result.success = true;
        }
        break;
      }

      case ActionType.GUARD_PROTECT: {
        if (action.targetId) {
          context.protectedPlayers.add(action.targetId);
          result.success = true;
        }
        break;
      }

      case ActionType.WITCH_HEAL: {
        // Find who werewolves targeted
        const werewolfTarget = Array.from(context.deaths.entries()).find(
          ([_, cause]) => cause === "werewolf_attack",
        );

        if (werewolfTarget && action.targetId === werewolfTarget[0]) {
          context.protectedPlayers.add(action.targetId);
          result.success = true;
        }
        break;
      }

      case ActionType.WITCH_POISON: {
        if (action.targetId) {
          context.deaths.set(action.targetId, "witch_poison");
          result.success = true;
        }
        break;
      }

      case ActionType.SEER_INVESTIGATE: {
        if (action.targetId) {
          const target = await this.prisma.player.findUnique({
            where: { id: action.targetId },
          });

          if (target) {
            // Store investigation result
            await this.prisma.gameAction.update({
              where: { id: action.id },
              data: {
                result: GameActionResult.SUCCESS,
                resultData: {
                  role: target.role,
                  team: this.getTeamForRole(target.role),
                },
              },
            });

            // Notify seer of result
            await this.publishPlayerEvent(
              action.gameId,
              action.performerId,
              "investigation_result",
              {
                targetId: action.targetId,
                role: target.role,
                team: this.getTeamForRole(target.role),
              },
            );

            result.success = true;
          }
        }
        break;
      }

      case ActionType.WHITE_WOLF_DEVOUR: {
        if (action.targetId) {
          context.deaths.set(action.targetId, "white_wolf_devour");
          result.success = true;
        }
        break;
      }

      case ActionType.BLACK_WOLF_CONVERT: {
        if (action.targetId) {
          // Instead of killing, convert to werewolf
          const werewolfKill = Array.from(context.deaths.entries()).find(
            ([playerId, cause]) =>
              playerId === action.targetId && cause === "werewolf_attack",
          );

          if (werewolfKill) {
            // Remove from deaths
            context.deaths.delete(action.targetId);

            // Convert player
            await this.prisma.player.update({
              where: { id: action.targetId },
              data: { role: GameRole.WEREWOLF },
            });

            await this.publishPlayerEvent(
              action.gameId,
              action.targetId,
              "role_changed",
              { newRole: GameRole.WEREWOLF },
            );

            result.success = true;
          }
        }
        break;
      }
    }

    return result;
  }

  private async killPlayer(gameId: string, playerId: string, cause: string) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { user: true },
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
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    await this.prisma.gameEvent.create({
      data: {
        gameId,
        eventType: "night_death",
        dayNumber: game!.dayNumber,
        data: {
          playerId,
          playerName: player.user.displayName,
          cause,
          role: player.role,
        },
      },
    });

    // Handle death triggers
    await this.handleDeathTriggers(gameId, player);
  }

  private async handleDeathTriggers(gameId: string, deadPlayer: any) {
    // Hunter revenge shot
    if (deadPlayer.role === GameRole.HUNTER) {
      await this.publishPlayerEvent(gameId, deadPlayer.id, "hunter_revenge", {
        message: "You can take one player with you!",
      });
      // Hunter will choose target through a special action
    }

    // Cupid lovers
    if (deadPlayer.linkedTo) {
      const lover = await this.prisma.player.findUnique({
        where: { id: deadPlayer.linkedTo },
      });

      if (lover && lover.state === PlayerState.ALIVE) {
        await this.killPlayer(gameId, lover.id, "grief");
      }
    }

    // Check if player was linked by Cupid
    const linkedLover = await this.prisma.player.findFirst({
      where: {
        gameId,
        linkedTo: deadPlayer.id,
        state: PlayerState.ALIVE,
      },
    });

    if (linkedLover) {
      await this.killPlayer(gameId, linkedLover.id, "grief");
    }
  }

  private async checkWinConditions(gameId: string): Promise<Team | null> {
    const alivePlayers = await this.prisma.player.findMany({
      where: {
        gameId,
        state: PlayerState.ALIVE,
      },
    });

    if (alivePlayers.length === 0) {
      return null; // Draw
    }

    const werewolves = alivePlayers.filter((p) =>
      (
        [
          GameRole.WEREWOLF,
          GameRole.BLACK_WOLF,
          GameRole.WOLF_RIDING_HOOD,
        ] as GameRole[]
      ).includes(p.role),
    );
    const villagers = alivePlayers.filter(
      (p) => this.getTeamForRole(p.role) === Team.VILLAGERS,
    );
    const soloPlayers = alivePlayers.filter(
      (p) => this.getTeamForRole(p.role) === Team.SOLO,
    );

    // Check White Wolf win (sole survivor)
    if (
      alivePlayers.length === 1 &&
      alivePlayers[0].role === GameRole.WHITE_WOLF
    ) {
      return Team.SOLO;
    }

    // Check Werewolf win (equal or more than villagers)
    if (werewolves.length >= villagers.length && soloPlayers.length === 0) {
      return Team.WEREWOLVES;
    }

    // Check Villager win (no werewolves or hostile solo)
    if (
      werewolves.length === 0 &&
      !soloPlayers.some((p) => p.role === GameRole.WHITE_WOLF)
    ) {
      return Team.VILLAGERS;
    }

    return null;
  }

  private async endGame(gameId: string, winningTeam: Team) {
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        state: GameState.ENDED,
        phase: GamePhase.GAME_END,
        endedAt: new Date(),
        winningTeam,
      },
    });

    // Clear phase timer
    this.clearPhaseTimer(gameId);

    // Update player statistics
    const players = await this.prisma.player.findMany({
      where: { gameId },
      include: { user: true },
    });

    for (const player of players) {
      const won = this.getTeamForRole(player.role) === winningTeam;
      await this.updatePlayerStats(player.userId, player.role, won);
    }

    // Emit game end event
    await this.publishGameEvent(gameId, "game_ended", {
      winningTeam,
      players: players.map((p) => ({
        id: p.id,
        displayName: p.user.displayName,
        role: p.role,
        team: this.getTeamForRole(p.role),
        survived: p.state === PlayerState.ALIVE,
      })),
    });
  }

  private async updatePlayerStats(
    userId: string,
    role: GameRole,
    won: boolean,
  ) {
    const team = this.getTeamForRole(role);

    await this.prisma.userStats.upsert({
      where: { userId },
      create: {
        userId,
        gamesPlayed: 1,
        gamesWon: won ? 1 : 0,
        gamesAsWerewolf: team === Team.WEREWOLVES ? 1 : 0,
        gamesAsVillager: team === Team.VILLAGERS ? 1 : 0,
        gamesAsSolo: team === Team.SOLO ? 1 : 0,
        werewolfWins: team === Team.WEREWOLVES && won ? 1 : 0,
        villagerWins: team === Team.VILLAGERS && won ? 1 : 0,
        soloWins: team === Team.SOLO && won ? 1 : 0,
      },
      update: {
        gamesPlayed: { increment: 1 },
        gamesWon: won ? { increment: 1 } : undefined,
        gamesAsWerewolf:
          team === Team.WEREWOLVES ? { increment: 1 } : undefined,
        gamesAsVillager: team === Team.VILLAGERS ? { increment: 1 } : undefined,
        gamesAsSolo: team === Team.SOLO ? { increment: 1 } : undefined,
        werewolfWins:
          team === Team.WEREWOLVES && won ? { increment: 1 } : undefined,
        villagerWins:
          team === Team.VILLAGERS && won ? { increment: 1 } : undefined,
        soloWins: team === Team.SOLO && won ? { increment: 1 } : undefined,
      },
    });
  }

  private schedulePhaseEnd(gameId: string, phase: GamePhase, duration: number) {
    const timer = setTimeout(async () => {
      try {
        const nextPhase = this.getNextPhase(phase);
        await this.transitionToPhase(gameId, nextPhase);
      } catch (error) {
        console.error(`Failed to transition phase for game ${gameId}:`, error);
      }
    }, duration * 1000);

    this.phaseTimers.set(gameId, timer);
  }

  private clearPhaseTimer(gameId: string) {
    const timer = this.phaseTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.phaseTimers.delete(gameId);
    }
  }

  private getPhaseDuration(game: any, phase: GamePhase): number {
    switch (phase) {
      case GamePhase.ROLE_ASSIGNMENT:
        return 5; // 5 seconds to view role
      case GamePhase.NIGHT_PHASE:
        return game.nightDuration;
      case GamePhase.DAY_DISCUSSION:
        return game.dayDuration;
      case GamePhase.DAY_VOTING:
        return game.voteDuration;
      default:
        return 0;
    }
  }

  private getStateForPhase(phase: GamePhase): GameState {
    switch (phase) {
      case GamePhase.LOBBY:
        return GameState.WAITING;
      case GamePhase.ROLE_ASSIGNMENT:
        return GameState.STARTING;
      case GamePhase.NIGHT_PHASE:
        return GameState.NIGHT;
      case GamePhase.DAY_DISCUSSION:
        return GameState.DAY;
      case GamePhase.DAY_VOTING:
        return GameState.VOTING;
      case GamePhase.GAME_END:
        return GameState.ENDED;
    }
  }

  private getNextPhase(currentPhase: GamePhase): GamePhase {
    switch (currentPhase) {
      case GamePhase.ROLE_ASSIGNMENT:
        return GamePhase.NIGHT_PHASE;
      case GamePhase.NIGHT_PHASE:
        return GamePhase.DAY_DISCUSSION;
      case GamePhase.DAY_DISCUSSION:
        return GamePhase.DAY_VOTING;
      case GamePhase.DAY_VOTING:
        return GamePhase.NIGHT_PHASE;
      default:
        return GamePhase.GAME_END;
    }
  }

  private hasNightAbility(role: GameRole): boolean {
    const nightRoles = [
      GameRole.WEREWOLF,
      GameRole.BLACK_WOLF,
      GameRole.WHITE_WOLF,
      GameRole.SEER,
      GameRole.TALKATIVE_SEER,
      GameRole.WITCH,
      GameRole.POISONER,
      GameRole.GUARD,
      GameRole.CUPID, // First night only
      GameRole.HEIR, // First night only
    ] as GameRole[];
    return nightRoles.includes(role);
  }

  private getNightAbilities(role: GameRole): string[] {
    const abilities: Record<GameRole, string[]> = {
      [GameRole.WEREWOLF]: ["werewolf_vote"],
      [GameRole.BLACK_WOLF]: ["werewolf_vote", "black_wolf_convert"],
      [GameRole.WHITE_WOLF]: ["werewolf_vote", "white_wolf_devour"],
      [GameRole.SEER]: ["seer_investigate"],
      [GameRole.TALKATIVE_SEER]: ["seer_investigate"],
      [GameRole.WITCH]: ["witch_heal", "witch_poison"],
      [GameRole.POISONER]: ["witch_poison"],
      [GameRole.GUARD]: ["guard_protect"],
      [GameRole.CUPID]: ["cupid_link"],
      [GameRole.HEIR]: ["heir_choose"],
    } as any;

    return abilities[role] || [];
  }

  private prioritizeActions(actions: any[]): any[] {
    // Action priority order for resolution
    const priority: ActionType[] = [
      ActionType.GUARD_PROTECT,
      ActionType.CUPID_LINK,
      ActionType.HEIR_CHOOSE,
      ActionType.WEREWOLF_VOTE,
      ActionType.WHITE_WOLF_DEVOUR,
      ActionType.BLACK_WOLF_CONVERT,
      ActionType.WITCH_HEAL,
      ActionType.WITCH_POISON,
      ActionType.SEER_INVESTIGATE,
    ];

    return actions.sort((a, b) => {
      const aPriority = priority.indexOf(a.actionType);
      const bPriority = priority.indexOf(b.actionType);
      return aPriority - bPriority;
    });
  }

  private getTeamForRole(role: GameRole): Team {
    const werewolfRoles = [
      GameRole.WEREWOLF,
      GameRole.BLACK_WOLF,
      GameRole.WOLF_RIDING_HOOD,
    ] as GameRole[];
    const soloRoles = [GameRole.WHITE_WOLF, GameRole.MERCENARY] as GameRole[];

    if (werewolfRoles.includes(role)) return Team.WEREWOLVES;
    if (soloRoles.includes(role)) return Team.SOLO;
    return Team.VILLAGERS;
  }

  private async getCurrentDay(gameId: string): Promise<number> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { dayNumber: true },
    });
    return game?.dayNumber || 1;
  }

  private async publishGameEvent(gameId: string, event: string, data: any) {
    await this.redis.publish(`game:${gameId}:${event}`, JSON.stringify(data));
  }

  private async publishPlayerEvent(
    gameId: string,
    playerId: string,
    event: string,
    data: any,
  ) {
    await this.redis.publish(
      `game:${gameId}:player:${playerId}:${event}`,
      JSON.stringify(data),
    );
  }
}
