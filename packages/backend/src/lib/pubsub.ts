import { Redis } from "ioredis";
import { Server as SocketIOServer } from "socket.io";

export class GamePubSub {
  private publisher: Redis;
  private subscriber: Redis;

  constructor(
    redisUrl: string,
    private io: SocketIOServer,
  ) {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);

    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    this.subscriber.psubscribe("game:*");

    this.subscriber.on("pmessage", (pattern, channel, message) => {
      const parts = channel.split(":");

      if (parts[0] === "game" && parts.length >= 3) {
        const gameId = parts[1];
        const eventType = parts.slice(2).join(":");
        const data = JSON.parse(message);

        // Emit to the game room
        this.io.to(`game:${gameId}`).emit(eventType, data);
      }
    });
  }

  async publishGameEvent(gameId: string, eventType: string, data: unknown) {
    const channel = `game:${gameId}:${eventType}`;
    await this.publisher.publish(channel, JSON.stringify(data));
  }

  async subscribeToGame(gameId: string) {
    await this.subscriber.subscribe(`game:${gameId}:*`);
  }

  async unsubscribeFromGame(gameId: string) {
    await this.subscriber.unsubscribe(`game:${gameId}:*`);
  }
}
