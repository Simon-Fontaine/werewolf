// packages/backend/src/services/event-bus.service.ts
import { EventEmitter } from "events";

export class EventBusService extends EventEmitter {
  emitPlayerDeath(gameId: string, playerId: string, cause: string) {
    this.emit("player:death", { gameId, playerId, cause });
  }

  emitVoteCompleted(gameId: string, eliminatedPlayerId: string | null) {
    this.emit("vote:completed", { gameId, eliminatedPlayerId });
  }

  emitPhaseChange(gameId: string, phase: string) {
    this.emit("phase:change", { gameId, phase });
  }
}
