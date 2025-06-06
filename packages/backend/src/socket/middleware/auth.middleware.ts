import { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void,
) {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error("No token provided"));
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string };
    socket.data.userId = decoded.userId;

    next();
  } catch (error) {
    next(new Error("Invalid token"));
  }
}
