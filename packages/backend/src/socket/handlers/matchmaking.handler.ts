import { Socket, Server } from "socket.io";
import { MatchmakingService } from "../../services/matchmaking.service.js";

export function registerMatchmakingHandlers(
  io: Server,
  socket: Socket,
  services: {
    matchmakingService: MatchmakingService;
  },
) {
  // Join matchmaking queue
  socket.on("matchmaking:join", async () => {
    try {
      const result = await services.matchmakingService.joinQueue(
        socket.data.userId,
      );
      socket.emit("matchmaking:joined", result);
    } catch (error) {
      socket.emit("error", {
        type: "matchmaking_error",
        message:
          error instanceof Error ? error.message : "Failed to join queue",
      });
    }
  });

  // Leave matchmaking queue
  socket.on("matchmaking:leave", async () => {
    try {
      const result = await services.matchmakingService.leaveQueue(
        socket.data.userId,
      );
      socket.emit("matchmaking:left", result);
    } catch (error) {
      socket.emit("error", {
        type: "matchmaking_error",
        message:
          error instanceof Error ? error.message : "Failed to leave queue",
      });
    }
  });

  // Subscribe to match found events
  socket.on("matchmaking:subscribe", () => {
    socket.join(`matchmaking:${socket.data.userId}`);
  });
}
