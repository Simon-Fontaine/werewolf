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
    this.subscriber.on("message", (channel, message) => {
      const [prefix, gameId, eventType] = channel.split(":");

      if (prefix === "game") {
        const data = JSON.parse(message);
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
