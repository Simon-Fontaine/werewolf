import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import {
  GameState,
  GamePhase,
  GameRole,
  PlayerState,
} from "@werewolf/database";
import { GameEngineService } from "./game-engine.service.js";
import { RoleService } from "./role.service.js";
import { generateRoomCode } from "../utils/random.js";
import { CreateGameOptions } from "../types/game.types.js";

export class GameService {
  private gameEngine: GameEngineService;
  private roleService: RoleService;

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {
    this.gameEngine = new GameEngineService(prisma, redis);
    this.roleService = new RoleService(prisma);
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
    if (game.state !== GameState.WAITING)
      throw new Error("Game already started");
    if (game.players.length >= game.maxPlayers) throw new Error("Game is full");
    if (game.isPrivate && game.password !== password)
      throw new Error("Invalid password");

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
    await this.updateCachedPlayer(gameId, player);

    // Check if we can auto-start
    if (game.players.length + 1 >= game.minPlayers) {
      await this.gameEngine.scheduleGameStart(gameId);
    }

    return player;
  }

  async startGame(gameId: string, requesterId: string) {
    const game = await this.validateHostAction(gameId, requesterId);

    if (game.players.length < game.minPlayers) {
      throw new Error("Not enough players");
    }

    // Assign roles
    const roleAssignments = await this.roleService.assignRoles(
      gameId,
      game.players.length,
    );

    // Transition to night phase
    await this.gameEngine.transitionToPhase(gameId, GamePhase.NIGHT_PHASE);

    return { started: true, roleAssignments };
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

  private async cacheGameState(gameId: string, state: any) {
    await this.redis.setex(
      `game:${gameId}`,
      3600, // 1 hour TTL
      JSON.stringify(state),
    );
  }
}
