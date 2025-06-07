import { Socket, Server } from "socket.io";
import { GameService } from "../../services/game.service.js";
import { VotingService } from "../../services/voting.service.js";
import { GameEngineService } from "../../services/game-engine.service.js";

export function registerGameHandlers(
  io: Server,
  socket: Socket,
  services: {
    gameService: GameService;
    votingService: VotingService;
    gameEngineService: GameEngineService;
  },
) {
  // Join game room
  socket.on("game:join", async (data: { gameId: string }) => {
    try {
      const userId = socket.data.userId;
      const player = await services.gameService.joinGame(data.gameId, userId);

      // Join Socket.IO room
      socket.join(`game:${data.gameId}`);
      socket.data.gameId = data.gameId;
      socket.data.playerId = player.id;

      // Notify others
      socket.to(`game:${data.gameId}`).emit("player:joined", {
        player: {
          id: player.id,
          displayName:
            (player as { user?: { displayName?: string } }).user?.displayName ||
            "Unknown",
          position: player.position,
        },
      });

      // Send current game state to joining player
      const gameState = await services.gameService.getGameState(data.gameId);
      socket.emit("game:state", gameState);
    } catch (error) {
      socket.emit("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Start game (host only)
  socket.on("game:start", async () => {
    try {
      const { gameId, userId } = socket.data;
      await services.gameService.startGame(gameId, userId);
    } catch (error) {
      socket.emit("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Cast vote
  socket.on("vote:cast", async (data: { targetId: string | null }) => {
    try {
      const { gameId, playerId } = socket.data;
      await services.votingService.castVote(gameId, playerId, data.targetId);
    } catch (error) {
      socket.emit("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Night action
  socket.on(
    "action:night",
    async (data: { action: string; targetId?: string }) => {
      try {
        const { gameId, playerId } = socket.data;
        await services.gameService.performNightAction(
          gameId,
          playerId,
          data.action,
          data.targetId,
        );
      } catch (error) {
        socket.emit("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // Special first night actions
  socket.on(
    "cupid:link",
    async (data: { player1Id: string; player2Id: string }) => {
      try {
        const { gameId, playerId } = socket.data;
        await services.gameService.performNightAction(
          gameId,
          playerId,
          "cupid_link",
          undefined,
          { player1Id: data.player1Id, player2Id: data.player2Id },
        );
      } catch (error) {
        socket.emit("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // Witch actions with potion type
  socket.on(
    "witch:potion",
    async (data: { potionType: "heal" | "poison"; targetId?: string }) => {
      try {
        const { gameId, playerId } = socket.data;
        const action =
          data.potionType === "heal" ? "witch_heal" : "witch_poison";
        await services.gameService.performNightAction(
          gameId,
          playerId,
          action,
          data.targetId,
        );
      } catch (error) {
        socket.emit("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // Hunter revenge shot (when hunter dies)
  socket.on("hunter:revenge", async (data: { targetId: string }) => {
    try {
      const { gameId, playerId } = socket.data;
      await services.gameService.performNightAction(
        gameId,
        playerId,
        "HUNTER_SHOOT",
        data.targetId,
      );
    } catch (error) {
      socket.emit("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Dictator coup attempt
  socket.on("dictator:coup", async (data: { targetId: string }) => {
    try {
      const { gameId, playerId } = socket.data;
      await services.gameService.performNightAction(
        gameId,
        playerId,
        "DICTATOR_COUP",
        data.targetId,
      );
    } catch (error) {
      socket.emit("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Handle disconnection
  socket.on("disconnect", async () => {
    if (socket.data.gameId && socket.data.playerId) {
      await services.gameService.handlePlayerDisconnect(
        socket.data.gameId,
        socket.data.playerId,
      );
    }
  });
}
