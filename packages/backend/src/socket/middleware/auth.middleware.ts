import { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

interface SocketData {
  userId: string;
  gameId?: string;
  playerId?: string;
}

interface ClientToServerEvents {
  "auth:refresh": (token: string) => void;
  [event: string]: (...args: any[]) => void;
}

interface ServerToClientEvents {
  "auth:refreshed": (data: { success: boolean }) => void;
  [event: string]: (...args: any[]) => void;
}

export async function authenticateSocket(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, any, SocketData>,
  next: (err?: Error) => void,
) {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error("No token provided"));
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      type: string;
    };

    if (decoded.type !== "access") {
      return next(new Error("Invalid token type"));
    }

    socket.data.userId = decoded.userId;

    // Set up token refresh handling
    socket.on("auth:refresh", async (newToken: string) => {
      try {
        const newDecoded = jwt.verify(newToken, env.JWT_SECRET) as {
          userId: string;
          type: string;
        };

        if (
          newDecoded.type === "access" &&
          newDecoded.userId === socket.data.userId
        ) {
          // Token refreshed successfully
          socket.emit("auth:refreshed", { success: true });
        } else {
          socket.emit("auth:refreshed", { success: false });
          socket.disconnect();
        }
      } catch (_error) {
        socket.emit("auth:refreshed", { success: false });
        socket.disconnect();
      }
    });

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new Error("Token expired"));
    } else {
      next(new Error("Invalid token"));
    }
  }
}
