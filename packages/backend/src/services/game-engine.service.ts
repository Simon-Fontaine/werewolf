import { GamePhase, PlayerState } from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { ActionResult } from "../types/game.types.js";

export class GameEngineService {
  private phaseTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
  ) {}

  async transitionToPhase(gameId: string, nextPhase: GamePhase) {
    // Clear existing timer
    this.clearPhaseTimer(gameId);

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });

    if (!game) throw new Error("Game not found");

    // Determine phase duration
    const duration = this.getPhaseDuration(game, nextPhase);
    const phaseEndsAt = new Date(Date.now() + duration * 1000);

    // Update game state
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        phase: nextPhase,
        state: this.getStateForPhase(nextPhase),
        phaseStartedAt: new Date(),
        phaseEndsAt,
        dayNumber:
          nextPhase === GamePhase.NIGHT_PHASE
            ? game.dayNumber + 1
            : game.dayNumber,
      },
    });

    // Execute phase-specific logic
    await this.executePhaseTransition(gameId, nextPhase);

    // Schedule next phase
    this.schedulePhaseEnd(gameId, nextPhase, duration);

    // Emit phase change event
    await this.emitGameEvent(gameId, "phase_change", {
      phase: nextPhase,
      duration,
      endsAt: phaseEndsAt,
    });
  }

  private async executePhaseTransition(gameId: string, phase: GamePhase) {
    switch (phase) {
      case GamePhase.NIGHT_PHASE:
        await this.startNightPhase(gameId);
        break;
      case GamePhase.DAY_DISCUSSION:
        await this.startDayPhase(gameId);
        break;
      case GamePhase.DAY_VOTING:
        await this.startVotingPhase(gameId);
        break;
      case GamePhase.GAME_END:
        await this.endGame(gameId);
        break;
    }
  }

  private async startNightPhase(gameId: string) {
    // Reset night actions
    await this.prisma.gameAction.deleteMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber: await this.getCurrentDay(gameId),
      },
    });

    // Enable night abilities for special roles
    const players = await this.prisma.player.findMany({
      where: { gameId, state: PlayerState.ALIVE },
    });

    for (const player of players) {
      if (this.hasNightAbility(player.role)) {
        await this.enableNightAction(gameId, player.id, player.role);
      }
    }
  }

  private async processNightActions(gameId: string) {
    const dayNumber = await this.getCurrentDay(gameId);

    // Get all night actions for this phase
    const actions = await this.prisma.gameAction.findMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber,
      },
      orderBy: { createdAt: "asc" },
    });

    // Process in priority order
    const prioritizedActions = this.prioritizeActions(actions);
    const results: ActionResult[] = [];

    for (const action of prioritizedActions) {
      const result = await this.processAction(action);
      results.push(result);
    }

    // Apply final results (deaths, protections, etc.)
    await this.applyNightResults(gameId, results);
  }

  private schedulePhaseEnd(gameId: string, phase: GamePhase, duration: number) {
    const timer = setTimeout(async () => {
      try {
        const nextPhase = this.getNextPhase(phase);
        await this.transitionToPhase(gameId, nextPhase);
      } catch (error) {
        console.error(`Failed to transition phase for game ${gameId}:`, error);
      }
    }, duration * 1000);

    this.phaseTimers.set(gameId, timer);
  }
}
