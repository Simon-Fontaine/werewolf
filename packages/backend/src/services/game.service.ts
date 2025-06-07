import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import {
  GameState,
  GamePhase,
  GameRole,
  PlayerState,
  ActionType,
} from "@werewolf/database";
import { GameEngineService } from "./game-engine.service.js";
import { RoleService } from "./role.service.js";
import { generateRoomCode } from "../utils/random.js";
import {
  CreateGameOptions,
  GameStateData,
  PlayerInfo,
} from "../types/game.types.js";

export class GameService {
  private gameEngine: GameEngineService;
  private roleService: RoleService;

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {
    this.roleService = new RoleService(prisma);
    this.gameEngine = new GameEngineService(prisma, redis, this.roleService);
  }

  async createGame(hostId: string, options: CreateGameOptions) {
    const code = await this.generateUniqueCode();

    const game = await this.prisma.game.create({
      data: {
        code,
        name: options.name,
        hostId,
        minPlayers: options.minPlayers ?? 5,
        maxPlayers: options.maxPlayers ?? 15,
        isPrivate: options.isPrivate ?? false,
        password: options.password,
        nightDuration: options.nightDuration ?? 90,
        dayDuration: options.dayDuration ?? 180,
        voteDuration: options.voteDuration ?? 60,
      },
      include: {
        host: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    // Host automatically joins the game
    await this.joinGame(game.id, hostId);

    // Cache game in Redis for fast access
    await this.cacheGameState(game.id, {
      id: game.id,
      code: game.code,
      state: game.state,
      phase: game.phase,
      players: [],
    });

    return game;
  }

  async joinGame(gameId: string, userId: string, password?: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) throw new Error("Game not found");
    if (game.state !== GameState.WAITING) {
      throw new Error("Game already started");
    }
    if (game.players.length >= game.maxPlayers) throw new Error("Game is full");
    if (game.isPrivate && game.password !== password) {
      throw new Error("Invalid password");
    }

    // Check if player already in game
    const existingPlayer = game.players.find((p) => p.userId === userId);
    if (existingPlayer) return existingPlayer;

    // Assign position
    const position = this.getNextAvailablePosition(game.players);

    const player = await this.prisma.player.create({
      data: {
        gameId,
        userId,
        position,
      },
      include: {
        user: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    // Update cached game state
    await this.updateCachedPlayer(gameId, {
      id: player.id,
      userId: player.userId,
      position: player.position,
      user: {
        displayName: player.user.displayName || undefined,
        avatarUrl: player.user.avatarUrl || undefined,
      },
    });

    // Check if we can auto-start
    if (game.players.length + 1 >= game.minPlayers && game.hostId !== userId) {
      // Notify host that game can start
      await this.publishGameEvent(gameId, "can_start", {
        playerCount: game.players.length + 1,
        minPlayers: game.minPlayers,
      });
    }

    return player;
  }

  async leaveGame(gameId: string, userId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) throw new Error("Game not found");

    const player = game.players.find((p) => p.userId === userId);
    if (!player) throw new Error("Player not in game");

    // If game hasn't started, remove player
    if (game.state === GameState.WAITING) {
      await this.prisma.player.delete({
        where: { id: player.id },
      });

      // If host left, assign new host or cancel game
      if (game.hostId === userId) {
        const remainingPlayers = game.players.filter(
          (p) => p.userId !== userId,
        );
        if (remainingPlayers.length > 0) {
          // Assign new host
          await this.prisma.game.update({
            where: { id: gameId },
            data: { hostId: remainingPlayers[0].userId },
          });
        } else {
          // Cancel empty game
          await this.cancelGame(gameId);
        }
      }
    } else {
      // Mark as disconnected during active game
      await this.prisma.player.update({
        where: { id: player.id },
        data: {
          state: PlayerState.DISCONNECTED,
          leftAt: new Date(),
        },
      });
    }

    await this.removeCachedPlayer(gameId, player.id);
  }

  async startGame(gameId: string, requesterId: string) {
    const game = await this.validateHostAction(gameId, requesterId);

    if (game.players.length < game.minPlayers) {
      throw new Error("Not enough players");
    }

    // Update game state
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        state: GameState.STARTING,
        startedAt: new Date(),
      },
    });

    // Assign roles
    const roleAssignments = await this.roleService.assignRoles(
      gameId,
      game.players.length,
    );

    // Transition to first night phase
    await this.gameEngine.transitionToPhase(gameId, GamePhase.NIGHT_PHASE);

    // Notify players of their roles
    for (const assignment of roleAssignments) {
      await this.publishPlayerEvent(
        gameId,
        assignment.playerId,
        "role_assigned",
        {
          role: assignment.role,
        },
      );
    }

    return { started: true, roleCount: roleAssignments.length };
  }

  async getGameState(
    gameId: string,
    requesterId?: string,
  ): Promise<GameStateData> {
    // Try cache first
    const cached = await this.getCachedGameState(gameId);
    if (cached && !requesterId) return cached;

    // Fetch from database
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        host: {
          select: { id: true, displayName: true },
        },
      },
    });

    if (!game) throw new Error("Game not found");

    const requesterPlayer = requesterId
      ? game.players.find((p) => p.userId === requesterId)
      : null;

    // Build player info
    const players: PlayerInfo[] = game.players.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName || "Unknown",
      avatarUrl: p.user.avatarUrl || undefined,
      position: p.position,
      isAlive: p.state === PlayerState.ALIVE,
      isHost: p.userId === game.hostId,
      // Only show role to the player themselves or if revealed
      role: requesterPlayer?.id === p.id || p.isRevealed ? p.role : undefined,
    }));

    const aliveCount = players.filter((p) => p.isAlive).length;
    const deadPlayers = players.filter((p) => !p.isAlive);

    const gameState: GameStateData = {
      id: game.id,
      code: game.code,
      name: game.name,
      state: game.state,
      phase: game.phase,
      dayNumber: game.dayNumber,
      players,
      phaseEndsAt: game.phaseEndsAt || undefined,
      isHost: requesterId === game.hostId,
      myRole: requesterPlayer?.role,
      aliveCount,
      deadPlayers,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      canStart:
        game.state === GameState.WAITING &&
        game.players.length >= game.minPlayers &&
        requesterId === game.hostId,
    };

    // Cache the state
    await this.cacheGameState(gameId, gameState);

    return gameState;
  }

  async findGameByCode(code: string) {
    return this.prisma.game.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        _count: {
          select: { players: true },
        },
      },
    });
  }

  async performNightAction(
    gameId: string,
    playerId: string,
    action: string,
    targetId?: string,
    metadata?: any,
  ) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: true,
      },
    });

    if (!game || game.phase !== GamePhase.NIGHT_PHASE) {
      throw new Error("Invalid phase for night action");
    }

    const player = game.players.find((p) => p.id === playerId);
    if (!player || player.state !== PlayerState.ALIVE) {
      throw new Error("Invalid player");
    }

    // Validate action based on role
    const actionType = this.mapActionToType(action, player.role);
    if (!actionType) {
      throw new Error("Invalid action for role");
    }

    // Check if player has ability uses left
    if (this.requiresAbilityUse(actionType)) {
      const ability = await this.prisma.ability.findUnique({
        where: {
          playerId_abilityType: {
            playerId,
            abilityType: action,
          },
        },
      });

      if (!ability || ability.usesLeft <= 0) {
        throw new Error("No uses left for this ability");
      }

      // Check cooldown for abilities like White Wolf devour
      if (ability.cooldownDays > 0 && ability.lastUsedDay) {
        const daysSinceUse = game.dayNumber - ability.lastUsedDay;
        if (daysSinceUse < ability.cooldownDays) {
          throw new Error(
            `Ability on cooldown for ${ability.cooldownDays - daysSinceUse} more days`,
          );
        }
      }
    }

    // Validate target
    if (targetId && this.requiresTarget(actionType)) {
      const target = game.players.find((p) => p.id === targetId);
      if (!target || target.state !== PlayerState.ALIVE) {
        throw new Error("Invalid target");
      }

      // Special validations
      if (actionType === ActionType.GUARD_PROTECT) {
        if (targetId === playerId) {
          throw new Error("Cannot protect yourself");
        }
        // Check if trying to protect same player twice in a row
        const lastProtection = await this.prisma.gameAction.findFirst({
          where: {
            gameId,
            performerId: playerId,
            actionType: ActionType.GUARD_PROTECT,
            dayNumber: game.dayNumber - 1,
          },
          orderBy: { createdAt: "desc" },
        });
        if (lastProtection && lastProtection.targetId === targetId) {
          throw new Error("Cannot protect the same player twice in a row");
        }
      }
    }

    // Record the action
    await this.prisma.gameAction.upsert({
      where: {
        gameId_performerId_actionType_dayNumber_phase: {
          gameId,
          performerId: playerId,
          actionType,
          dayNumber: game.dayNumber,
          phase: game.phase,
        },
      },
      create: {
        gameId,
        performerId: playerId,
        targetId,
        actionType,
        dayNumber: game.dayNumber,
        phase: game.phase,
        metadata, // Add metadata here
      },
      update: {
        targetId,
        metadata, // And here
        createdAt: new Date(),
      },
    });

    // Update ability uses if needed
    if (this.requiresAbilityUse(actionType)) {
      await this.prisma.ability.update({
        where: {
          playerId_abilityType: {
            playerId,
            abilityType: action,
          },
        },
        data: {
          usesLeft: { decrement: 1 },
          lastUsedDay: game.dayNumber,
        },
      });
    }

    // Notify player action was recorded
    await this.publishPlayerEvent(gameId, playerId, "action_recorded", {
      action,
      targetId,
    });
  }

  async handlePlayerDisconnect(gameId: string, playerId: string) {
    await this.prisma.player.update({
      where: { id: playerId },
      data: {
        state: PlayerState.DISCONNECTED,
        leftAt: new Date(),
      },
    });

    // Start reconnection timer (60 seconds)
    setTimeout(async () => {
      const player = await this.prisma.player.findUnique({
        where: { id: playerId },
      });

      if (player && player.state === PlayerState.DISCONNECTED) {
        // Player didn't reconnect, handle based on game state
        const game = await this.prisma.game.findUnique({
          where: { id: gameId },
        });

        if (game && game.state === GameState.WAITING) {
          // Remove from lobby
          await this.leaveGame(gameId, player.userId);
        }
      }
    }, 60000); // 60 seconds
  }

  async handlePlayerReconnect(gameId: string, userId: string) {
    const player = await this.prisma.player.findFirst({
      where: {
        gameId,
        userId,
        state: PlayerState.DISCONNECTED,
      },
    });

    if (player) {
      // Restore player state
      const wasAlive = player.diedAt === null;
      await this.prisma.player.update({
        where: { id: player.id },
        data: {
          state: wasAlive ? PlayerState.ALIVE : PlayerState.DEAD,
          leftAt: null,
        },
      });

      return player;
    }

    return null;
  }

  private async generateUniqueCode(): Promise<string> {
    let attempts = 0;
    while (attempts < 10) {
      const code = generateRoomCode();
      const existing = await this.prisma.game.findUnique({ where: { code } });
      if (!existing) return code;
      attempts++;
    }
    throw new Error("Could not generate unique room code");
  }

  private getNextAvailablePosition(players: { position: number }[]): number {
    const positions = players.map((p) => p.position).sort((a, b) => a - b);
    for (let i = 1; i <= 15; i++) {
      if (!positions.includes(i)) return i;
    }
    throw new Error("No positions available");
  }

  private async validateHostAction(gameId: string, userId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) throw new Error("Game not found");
    if (game.hostId !== userId) {
      throw new Error("Only host can perform this action");
    }

    return game;
  }

  private async cancelGame(gameId: string) {
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        state: GameState.CANCELLED,
        endedAt: new Date(),
      },
    });

    await this.redis.del(`game:${gameId}`);
  }

  private mapActionToType(action: string, _role: GameRole): ActionType | null {
    const actionMap: Record<string, ActionType> = {
      werewolf_vote: ActionType.WEREWOLF_VOTE,
      seer_investigate: ActionType.SEER_INVESTIGATE,
      witch_heal: ActionType.WITCH_HEAL,
      witch_poison: ActionType.WITCH_POISON,
      guard_protect: ActionType.GUARD_PROTECT,
      hunter_shoot: ActionType.HUNTER_SHOOT,
      dictator_coup: ActionType.DICTATOR_COUP,
      cupid_link: ActionType.CUPID_LINK,
      heir_choose: ActionType.HEIR_CHOOSE,
      white_wolf_devour: ActionType.WHITE_WOLF_DEVOUR,
      black_wolf_convert: ActionType.BLACK_WOLF_CONVERT,
    };

    return actionMap[action] || null;
  }

  private requiresAbilityUse(actionType: ActionType): boolean {
    return (
      [
        ActionType.WITCH_HEAL,
        ActionType.WITCH_POISON,
        ActionType.DICTATOR_COUP,
        ActionType.BLACK_WOLF_CONVERT,
        ActionType.WHITE_WOLF_DEVOUR,
      ] as ActionType[]
    ).includes(actionType);
  }

  private requiresTarget(actionType: ActionType): boolean {
    return actionType !== ActionType.HUNTER_SHOOT; // Hunter chooses target when dying
  }

  private async cacheGameState(gameId: string, state: unknown) {
    await this.redis.setex(
      `game:${gameId}`,
      3600, // 1 hour TTL
      JSON.stringify(state),
    );
  }

  private async getCachedGameState(
    gameId: string,
  ): Promise<GameStateData | null> {
    const cached = await this.redis.get(`game:${gameId}`);
    return cached ? JSON.parse(cached) : null;
  }

  private async updateCachedPlayer(
    gameId: string,
    player: {
      id: string;
      userId: string;
      position: number;
      user: { displayName?: string; avatarUrl?: string };
    },
  ) {
    const state = await this.getCachedGameState(gameId);
    if (state) {
      const playerInfo: PlayerInfo = {
        id: player.id,
        userId: player.userId,
        displayName: player.user.displayName || "Unknown",
        avatarUrl: player.user.avatarUrl,
        position: player.position,
        isAlive: true,
        isHost: false,
      };

      state.players.push(playerInfo);
      await this.cacheGameState(gameId, state);
    }
  }

  private async removeCachedPlayer(gameId: string, playerId: string) {
    const state = await this.getCachedGameState(gameId);
    if (state) {
      state.players = state.players.filter((p) => p.id !== playerId);
      await this.cacheGameState(gameId, state);
    }
  }

  private async publishGameEvent(gameId: string, event: string, data: unknown) {
    await this.redis.publish(`game:${gameId}:${event}`, JSON.stringify(data));
  }

  private async publishPlayerEvent(
    gameId: string,
    playerId: string,
    event: string,
    data: unknown,
  ) {
    await this.redis.publish(
      `game:${gameId}:player:${playerId}:${event}`,
      JSON.stringify(data),
    );
  }
}
