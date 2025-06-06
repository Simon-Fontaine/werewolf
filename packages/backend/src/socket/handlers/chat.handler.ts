import { Socket, Server } from "socket.io";
import { ChatService } from "../../services/chat.service.js";

export function registerChatHandlers(
  io: Server,
  socket: Socket,
  services: {
    chatService: ChatService;
  },
) {
  // Send message
  socket.on("chat:send", async (data: { channel: string; content: string }) => {
    try {
      const { gameId, playerId } = socket.data;

      if (!gameId || !playerId) {
        throw new Error("Not in a game");
      }

      const message = await services.chatService.sendMessage(
        gameId,
        playerId,
        data.content,
        data.channel,
      );

      socket.emit("chat:sent", { messageId: message.id });
    } catch (error) {
      socket.emit("error", {
        type: "chat_error",
        message:
          error instanceof Error ? error.message : "Failed to send message",
      });
    }
  });

  // Get chat history
  socket.on(
    "chat:history",
    async (data: { channel: string; limit?: number }) => {
      try {
        const { gameId, playerId } = socket.data;

        if (!gameId || !playerId) {
          throw new Error("Not in a game");
        }

        const messages = await services.chatService.getChannelHistory(
          gameId,
          data.channel,
          playerId,
          data.limit,
        );

        socket.emit("chat:history", { channel: data.channel, messages });
      } catch (error) {
        socket.emit("error", {
          type: "chat_error",
          message:
            error instanceof Error ? error.message : "Failed to get history",
        });
      }
    },
  );

  // Get available channels
  socket.on("chat:channels", async () => {
    try {
      const { gameId, playerId } = socket.data;

      if (!gameId || !playerId) {
        throw new Error("Not in a game");
      }

      const channels = await services.chatService.getAvailableChannels(
        gameId,
        playerId,
      );

      socket.emit("chat:channels", { channels });
    } catch (error) {
      socket.emit("error", {
        type: "chat_error",
        message:
          error instanceof Error ? error.message : "Failed to get channels",
      });
    }
  });

  // Mark messages as read
  socket.on("chat:markRead", async (data: { channel: string }) => {
    try {
      const { gameId, playerId } = socket.data;

      if (!gameId || !playerId) {
        throw new Error("Not in a game");
      }

      await services.chatService.markAsRead(gameId, playerId, data.channel);
      socket.emit("chat:marked", { channel: data.channel });
    } catch (error) {
      socket.emit("error", {
        type: "chat_error",
        message:
          error instanceof Error ? error.message : "Failed to mark as read",
      });
    }
  });

  // Get unread count
  socket.on("chat:unread", async () => {
    try {
      const { gameId, playerId } = socket.data;

      if (!gameId || !playerId) {
        throw new Error("Not in a game");
      }

      const count = await services.chatService.getUnreadCount(gameId, playerId);
      socket.emit("chat:unread", { count });
    } catch (error) {
      socket.emit("error", {
        type: "chat_error",
        message:
          error instanceof Error ? error.message : "Failed to get unread count",
      });
    }
  });
}
