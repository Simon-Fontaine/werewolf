import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { GameService } from "../services/game.service.js";

const createGameSchema = z.object({
  name: z.string().min(1).max(50),
  minPlayers: z.number().min(5).max(15).optional(),
  maxPlayers: z.number().min(5).max(15).optional(),
  isPrivate: z.boolean().optional(),
  password: z.string().optional(),
  nightDuration: z.number().min(30).max(180).optional(),
  dayDuration: z.number().min(60).max(300).optional(),
  voteDuration: z.number().min(30).max(120).optional(),
});

const joinGameSchema = z.object({
  password: z.string().optional(),
});

export const registerGameRoutes: FastifyPluginAsyncZod = async (app) => {
  const gameService = new GameService(app.prisma, app.redis);

  // List public games
  app.get("/", async (request, reply) => {
    const games = await app.prisma.game.findMany({
      where: {
        state: {
          in: ["WAITING", "STARTING"],
        },
        isPrivate: false,
      },
      include: {
        host: {
          select: { displayName: true },
        },
        _count: {
          select: { players: true },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    return games.map((game) => ({
      id: game.id,
      code: game.code,
      name: game.name,
      hostName: game.host.displayName,
      playerCount: game._count.players,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      state: game.state,
      createdAt: game.createdAt,
    }));
  });

  // Create a new game
  app.post(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        body: createGameSchema,
      },
    },
    async (request, reply) => {
      try {
        const game = await gameService.createGame(
          request.user.userId,
          request.body,
        );

        return {
          id: game.id,
          code: game.code,
          name: game.name,
        };
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error ? error.message : "Failed to create game",
        });
      }
    },
  );

  // Get game by ID
  app.get(
    "/:gameId",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { gameId } = request.params as { gameId: string };

      try {
        const gameState = await gameService.getGameState(
          gameId,
          request.user.userId,
        );
        return gameState;
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "Game not found",
        });
      }
    },
  );

  // Find game by code
  app.get(
    "/code/:code",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };

      const game = await gameService.findGameByCode(code);

      if (!game) {
        return reply.code(404).send({ error: "Game not found" });
      }

      return {
        id: game.id,
        code: game.code,
        name: game.name,
        playerCount: game._count.players,
        maxPlayers: game.maxPlayers,
        isPrivate: game.isPrivate,
        state: game.state,
      };
    },
  );

  // Join a game
  app.post(
    "/:gameId/join",
    {
      preHandler: app.authenticate,
      schema: {
        body: joinGameSchema,
      },
    },
    async (request, reply) => {
      const { gameId } = request.params as { gameId: string };

      try {
        const player = await gameService.joinGame(
          gameId,
          request.user.userId,
          request.body.password,
        );

        return {
          playerId: player.id,
          position: player.position,
        };
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Failed to join game",
        });
      }
    },
  );

  // Leave a game
  app.post(
    "/:gameId/leave",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { gameId } = request.params as { gameId: string };

      try {
        await gameService.leaveGame(gameId, request.user.userId);
        return { success: true };
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error ? error.message : "Failed to leave game",
        });
      }
    },
  );

  // Start a game (host only)
  app.post(
    "/:gameId/start",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { gameId } = request.params as { gameId: string };

      try {
        const result = await gameService.startGame(gameId, request.user.userId);
        return result;
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error ? error.message : "Failed to start game",
        });
      }
    },
  );

  // Get game history for a user
  app.get(
    "/history/me",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const games = await app.prisma.game.findMany({
        where: {
          players: {
            some: {
              userId: request.user.userId,
            },
          },
          state: "ENDED",
        },
        include: {
          players: {
            where: {
              userId: request.user.userId,
            },
          },
          _count: {
            select: { players: true },
          },
        },
        orderBy: {
          endedAt: "desc",
        },
        take: 20,
      });

      return games.map((game) => ({
        id: game.id,
        name: game.name,
        playedAt: game.endedAt,
        playerCount: game._count.players,
        role: game.players[0].role,
        survived: game.players[0].state === "ALIVE",
        won:
          game.winningTeam ===
          gameService.roleService.getTeamForRole(game.players[0].role),
        winningTeam: game.winningTeam,
      }));
    },
  );

  // Get active games for a user
  app.get(
    "/active/me",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const games = await app.prisma.game.findMany({
        where: {
          players: {
            some: {
              userId: request.user.userId,
            },
          },
          state: {
            notIn: ["ENDED", "CANCELLED"],
          },
        },
        include: {
          host: {
            select: { displayName: true },
          },
          _count: {
            select: { players: true },
          },
        },
      });

      return games.map((game) => ({
        id: game.id,
        code: game.code,
        name: game.name,
        hostName: game.host.displayName,
        playerCount: game._count.players,
        state: game.state,
        phase: game.phase,
      }));
    },
  );
};
