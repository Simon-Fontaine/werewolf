import {
  GamePhase,
  GameState,
  PlayerState,
  GameRole,
  ActionType,
  Team,
  ActionResult as GameActionResult,
} from "@werewolf/database";
import { PrismaClientType } from "../lib/prisma.js";
import { RedisClientType } from "../lib/redis.js";
import { ActionResult } from "../types/game.types.js";
import { RoleService } from "./role.service.js";
import { GamePubSub } from "../lib/pubsub.js";

export class GameEngineService {
  private phaseTimers: Map<string, NodeJS.Timeout> = new Map();
  private pubsub?: GamePubSub;
  private timerCheckInterval?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaClientType,
    private redis: RedisClientType,
    private roleService: RoleService,
  ) {}

  setPubSub(pubsub: GamePubSub) {
    this.pubsub = pubsub;
  }

  async initializeTimerProcessor() {
    // Process any timers that expired while server was down
    await this.processExpiredTimers();

    // Check for expired timers every second
    this.timerCheckInterval = setInterval(async () => {
      await this.processExpiredTimers();
    }, 1000);
  }

  private async processExpiredTimers() {
    const now = Date.now();
    const expiredTimers = await this.redis.zrangebyscore(
      "phase_timers",
      "-inf",
      now,
    );

    for (const timerData of expiredTimers) {
      try {
        const { gameId, phase } = JSON.parse(timerData);
        const game = await this.prisma.game.findUnique({
          where: { id: gameId },
        });

        if (game && game.phase === phase) {
          const nextPhase = this.getNextPhase(phase);
          await this.transitionToPhase(gameId, nextPhase);
        }

        await this.redis.zrem("phase_timers", timerData);
      } catch (error) {
        console.error("Error processing timer:", error);
        await this.redis.zrem("phase_timers", timerData);
      }
    }
  }

  async scheduleGameStart(gameId: string) {
    // Notify players game will start in 10 seconds
    await this.publishGameEvent(gameId, "game_starting", { countdown: 10 });

    setTimeout(async () => {
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        include: { players: true },
      });

      if (
        game &&
        game.state === GameState.WAITING &&
        game.players.length >= game.minPlayers
      ) {
        // Auto-start the game
        await this.transitionToPhase(gameId, GamePhase.ROLE_ASSIGNMENT);
      }
    }, 10000);
  }

  async transitionToPhase(gameId: string, nextPhase: GamePhase) {
    // Use transaction to prevent race conditions
    await this.prisma.$transaction(async (tx) => {
      // Clear existing timer
      await this.clearPhaseTimer(gameId);

      const game = await tx.game.findUnique({
        where: { id: gameId },
        include: { players: true },
      });

      if (!game) throw new Error("Game not found");

      // Process end of current phase
      await this.processPhaseEnd(gameId, game.phase);

      // Check win conditions before transitioning
      const winner = await this.checkWinConditions(gameId);
      if (winner) {
        await this.endGame(gameId, winner);
        return;
      }

      // Determine phase duration
      const duration = this.getPhaseDuration(game, nextPhase);
      const phaseEndsAt = duration
        ? new Date(Date.now() + duration * 1000)
        : null;

      // Update game state
      await tx.game.update({
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

      // Schedule next phase if applicable
      if (duration && nextPhase !== GamePhase.GAME_END) {
        await this.schedulePhaseEnd(gameId, nextPhase, duration);
      }

      // Emit phase change event
      await this.publishGameEvent(gameId, "phase_change", {
        phase: nextPhase,
        duration,
        endsAt: phaseEndsAt,
        dayNumber:
          nextPhase === GamePhase.NIGHT_PHASE
            ? game.dayNumber + 1
            : game.dayNumber,
      });
    });
  }

  private async processPhaseEnd(gameId: string, currentPhase: GamePhase) {
    switch (currentPhase) {
      case GamePhase.NIGHT_PHASE:
        await this.processNightActions(gameId);
        break;
      case GamePhase.DAY_VOTING:
        // Voting results are processed by VotingService
        break;
    }
  }

  private async executePhaseTransition(gameId: string, phase: GamePhase) {
    switch (phase) {
      case GamePhase.ROLE_ASSIGNMENT:
        await this.startRoleAssignment(gameId);
        break;
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
        // Game end is handled by endGame method
        break;
    }
  }

  private async startRoleAssignment(gameId: string) {
    // Role assignment is handled by RoleService
    // This phase is just for revealing roles to players
    setTimeout(async () => {
      await this.transitionToPhase(gameId, GamePhase.NIGHT_PHASE);
    }, 5000); // 5 seconds to view role
  }

  private async startNightPhase(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Reset night actions
    await this.prisma.gameAction.deleteMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber: game.dayNumber,
      },
    });

    // Handle special night mechanics
    await this.handleNightPhaseMechanics(gameId);

    // Enable night abilities for special roles
    const players = await this.prisma.player.findMany({
      where: { gameId, state: PlayerState.ALIVE },
    });

    // Notify players with night abilities
    for (const player of players) {
      if (this.hasNightAbility(player.role)) {
        await this.publishPlayerEvent(
          gameId,
          player.id,
          "night_ability_available",
          {
            role: player.role,
            abilities: this.getNightAbilities(player.role),
          },
        );
      }
    }

    // Special: If it's the first night, Cupid and Heir act
    if (game.dayNumber === 1) {
      const specialFirstNightRoles = [
        GameRole.CUPID,
        GameRole.HEIR,
      ] as GameRole[];
      const firstNightPlayers = players.filter((p) =>
        specialFirstNightRoles.includes(p.role),
      );

      for (const player of firstNightPlayers) {
        await this.publishPlayerEvent(gameId, player.id, "first_night_action", {
          role: player.role,
        });
      }
    }
  }

  private async handleNightPhaseMechanics(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Little Girl passive ability
    const littleGirl = await this.prisma.player.findFirst({
      where: {
        gameId,
        role: GameRole.LITTLE_GIRL,
        state: PlayerState.ALIVE,
      },
      include: { user: true },
    });

    if (littleGirl) {
      // 10% chance of being caught each night
      if (Math.random() < 0.1) {
        await this.killPlayer(gameId, littleGirl.id, "caught_spying");
        await this.publishGameEvent(gameId, "little_girl_caught", {
          playerName: littleGirl.user.displayName,
        });
      } else {
        // Grant access to werewolf chat
        await this.publishPlayerEvent(
          gameId,
          littleGirl.id,
          "channel_access_granted",
          {
            channel: "werewolves",
            duration: game.nightDuration,
          },
        );
      }
    }
  }

  private async startDayPhase(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    const gameWithEvents = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { events: { where: { dayNumber: game.dayNumber } } },
    });

    if (!gameWithEvents) return;

    // Announce night results
    const nightEvents = gameWithEvents.events.filter(
      (e) => e.eventType === "night_death",
    );

    for (const event of nightEvents) {
      const data = event.data as {
        playerId: string;
        playerName: string;
        cause: string;
      };
      await this.publishGameEvent(gameId, "player_died", {
        playerId: data.playerId,
        playerName: data.playerName,
        deathCause: data.cause,
      });
    }

    // Check for Talkative Seer investigations
    const talkativeSeerAction = await this.prisma.gameAction.findFirst({
      where: {
        gameId,
        actionType: ActionType.SEER_INVESTIGATE,
        dayNumber: game.dayNumber,
        performer: {
          role: GameRole.TALKATIVE_SEER,
        },
      },
      include: {
        performer: { include: { user: true } },
        target: { include: { user: true } },
      },
    });

    if (talkativeSeerAction && talkativeSeerAction.target) {
      await this.publishGameEvent(gameId, "talkative_seer_result", {
        seerName: talkativeSeerAction.performer.user.displayName,
        targetName: talkativeSeerAction.target.user.displayName,
        targetRole: talkativeSeerAction.target.role,
      });
    }

    // Enable day chat
    await this.publishGameEvent(gameId, "chat_enabled", {
      channel: "all",
    });
  }

  private async startVotingPhase(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Clear any existing votes
    await this.prisma.gameAction.deleteMany({
      where: {
        gameId,
        actionType: ActionType.DAY_VOTE,
        dayNumber: game.dayNumber,
      },
    });

    // Check for Mercenary on Day 1
    if (game.dayNumber === 1) {
      await this.handleMercenaryCheck(gameId);
    }

    // Notify players voting has started
    await this.publishGameEvent(gameId, "voting_started", {
      timeLimit: game.voteDuration,
    });
  }

  private async handleMercenaryCheck(gameId: string) {
    const mercenary = await this.prisma.player.findFirst({
      where: {
        gameId,
        role: GameRole.MERCENARY,
        state: PlayerState.ALIVE,
      },
      include: { user: true },
    });

    if (!mercenary) return;

    const targetAbility = await this.prisma.ability.findFirst({
      where: {
        playerId: mercenary.id,
        abilityType: "mercenary_target",
      },
    });

    if (targetAbility?.metadata) {
      const targetId = (targetAbility.metadata as { targetId: string })
        .targetId;
      const target = await this.prisma.player.findUnique({
        where: { id: targetId },
        include: { user: true },
      });

      if (target) {
        await this.publishPlayerEvent(
          gameId,
          mercenary.id,
          "mercenary_reminder",
          {
            targetName: target.user.displayName,
            targetId: target.id,
            dayNumber: 1,
          },
        );
      }
    }
  }

  private async processNightActions(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) return;

    // Get all night actions for this phase
    const actions = await this.prisma.gameAction.findMany({
      where: {
        gameId,
        phase: GamePhase.NIGHT_PHASE,
        dayNumber: game.dayNumber,
      },
      include: {
        performer: true,
        target: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Process in priority order
    const prioritizedActions = this.prioritizeActions(actions);
    const results: ActionResult[] = [];

    // Track protections and other effects
    const protectedPlayers = new Set<string>();
    const deaths = new Map<string, string>(); // playerId -> cause

    for (const action of prioritizedActions) {
      const result = await this.processAction(action, {
        protectedPlayers,
        deaths,
        game,
      });
      results.push(result);
    }

    // Apply deaths
    for (const [playerId, cause] of deaths) {
      // Check special protections
      const isProtected = await this.isPlayerProtected(playerId, cause);

      if (!protectedPlayers.has(playerId) && !isProtected) {
        await this.killPlayer(gameId, playerId, cause);
      } else {
        // Player was saved
        await this.publishGameEvent(gameId, "player_saved", {
          message: "Someone was attacked but saved!",
        });
      }
    }
  }

  private async processAction(
    action: {
      id: string;
      actionType: ActionType;
      targetId?: string | null;
      performerId: string;
      gameId: string;
      metadata?: unknown;
    },
    context: {
      protectedPlayers: Set<string>;
      deaths: Map<string, string>;
      game: { dayNumber: number };
    },
  ): Promise<ActionResult> {
    const result: ActionResult = {
      action: action.actionType,
      success: false,
      targetId: action.targetId || undefined,
    };

    switch (action.actionType) {
      case ActionType.WEREWOLF_VOTE: {
        // Werewolf votes are tallied at end
        const werewolfVotes = await this.prisma.gameAction.findMany({
          where: {
            gameId: action.gameId,
            actionType: ActionType.WEREWOLF_VOTE,
            dayNumber: context.game.dayNumber,
            phase: GamePhase.NIGHT_PHASE,
          },
        });

        // Count votes
        const voteCount = new Map<string, number>();
        werewolfVotes.forEach((vote) => {
          if (vote.targetId) {
            voteCount.set(
              vote.targetId,
              (voteCount.get(vote.targetId) || 0) + 1,
            );
          }
        });

        // Find target with most votes
        let maxVotes = 0;
        let target: string | null = null;
        voteCount.forEach((votes, playerId) => {
          if (votes > maxVotes) {
            maxVotes = votes;
            target = playerId;
          }
        });

        if (target) {
          context.deaths.set(target, "werewolf_attack");
          result.success = true;
        }
        break;
      }

      case ActionType.GUARD_PROTECT: {
        if (action.targetId) {
          context.protectedPlayers.add(action.targetId);
          result.success = true;
        }
        break;
      }

      case ActionType.WITCH_HEAL: {
        // Find who werewolves targeted
        const werewolfTarget = Array.from(context.deaths.entries()).find(
          ([_, cause]) => cause === "werewolf_attack",
        );

        if (werewolfTarget && action.targetId === werewolfTarget[0]) {
          context.protectedPlayers.add(action.targetId);
          result.success = true;
        }
        break;
      }

      case ActionType.WITCH_POISON: {
        if (action.targetId) {
          context.deaths.set(action.targetId, "witch_poison");
          result.success = true;
        }
        break;
      }

      case ActionType.SEER_INVESTIGATE: {
        if (action.targetId) {
          const target = await this.prisma.player.findUnique({
            where: { id: action.targetId },
          });

          if (target) {
            // Store investigation result
            await this.prisma.gameAction.update({
              where: { id: action.id },
              data: {
                result: GameActionResult.SUCCESS,
                resultData: {
                  role: target.role,
                  team: this.getTeamForRole(target.role),
                },
              },
            });

            // Notify seer of result
            await this.publishPlayerEvent(
              action.gameId,
              action.performerId,
              "investigation_result",
              {
                targetId: action.targetId,
                role: target.role,
                team: this.getTeamForRole(target.role),
              },
            );

            result.success = true;
          }
        }
        break;
      }

      case ActionType.WHITE_WOLF_DEVOUR: {
        if (action.targetId) {
          context.deaths.set(action.targetId, "white_wolf_devour");
          result.success = true;
        }
        break;
      }

      case ActionType.BLACK_WOLF_CONVERT: {
        if (action.targetId) {
          // Instead of killing, convert to werewolf
          const werewolfKill = Array.from(context.deaths.entries()).find(
            ([playerId, cause]) =>
              playerId === action.targetId && cause === "werewolf_attack",
          );

          if (werewolfKill) {
            // Remove from deaths
            context.deaths.delete(action.targetId);

            // Convert player
            await this.prisma.player.update({
              where: { id: action.targetId },
              data: { role: GameRole.WEREWOLF },
            });

            await this.publishPlayerEvent(
              action.gameId,
              action.targetId,
              "role_changed",
              { newRole: GameRole.WEREWOLF },
            );

            result.success = true;
          }
        }
        break;
      }

      case ActionType.CUPID_LINK: {
        if (action.metadata) {
          const { player1Id, player2Id } = action.metadata as {
            player1Id: string;
            player2Id: string;
          };

          // Link the players
          await this.prisma.player.update({
            where: { id: player1Id },
            data: { linkedTo: player2Id },
          });

          await this.prisma.player.update({
            where: { id: player2Id },
            data: { linkedTo: player1Id },
          });

          // Notify the lovers
          await this.publishPlayerEvent(
            action.gameId,
            player1Id,
            "became_lover",
            { partnerId: player2Id },
          );

          await this.publishPlayerEvent(
            action.gameId,
            player2Id,
            "became_lover",
            { partnerId: player1Id },
          );

          result.success = true;
        }
        break;
      }

      case ActionType.HEIR_CHOOSE: {
        if (action.targetId) {
          // Store the heir relationship
          await this.prisma.ability.upsert({
            where: {
              playerId_abilityType: {
                playerId: action.performerId,
                abilityType: "heir_target",
              },
            },
            create: {
              playerId: action.performerId,
              abilityType: "heir_target",
              usesLeft: 1,
              maxUses: 1,
              metadata: { targetId: action.targetId },
            },
            update: {
              metadata: { targetId: action.targetId },
            },
          });

          result.success = true;
        }
        break;
      }
    }

    return result;
  }

  private async isPlayerProtected(
    playerId: string,
    deathCause: string,
  ): Promise<boolean> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: {
        game: {
          include: {
            players: true,
          },
        },
      },
    });

    if (!player) return false;

    // Red Riding Hood protection
    if (
      player.role === GameRole.RED_RIDING_HOOD &&
      deathCause === "werewolf_attack"
    ) {
      const hunterAlive = player.game.players.some(
        (p) => p.role === GameRole.HUNTER && p.state === PlayerState.ALIVE,
      );
      return hunterAlive;
    }

    // Blue Riding Hood protection
    if (
      player.role === GameRole.BLUE_RIDING_HOOD &&
      deathCause === "werewolf_attack"
    ) {
      const villagersAlive = player.game.players.some(
        (p) => p.role === GameRole.VILLAGER && p.state === PlayerState.ALIVE,
      );
      return villagersAlive;
    }

    // Wolf Riding Hood protection
    if (
      player.role === GameRole.WOLF_RIDING_HOOD &&
      deathCause === "voted_out"
    ) {
      const blackWolfAlive = player.game.players.some(
        (p) => p.role === GameRole.BLACK_WOLF && p.state === PlayerState.ALIVE,
      );
      return blackWolfAlive;
    }

    return false;
  }

  private async killPlayer(gameId: string, playerId: string, cause: string) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { user: true },
    });

    if (!player || player.state !== PlayerState.ALIVE) return;

    // Update player state
    await this.prisma.player.update({
      where: { id: playerId },
      data: {
        state: PlayerState.DEAD,
        diedAt: new Date(),
      },
    });

    // Record death event
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    await this.prisma.gameEvent.create({
      data: {
        gameId,
        eventType: "night_death",
        dayNumber: game!.dayNumber,
        data: {
          playerId,
          playerName: player.user.displayName,
          cause,
          role: player.role,
        },
      },
    });

    // Handle death triggers
    await this.handleDeathTriggers(gameId, {
      id: player.id,
      role: player.role,
      linkedTo: player.linkedTo,
      user: { displayName: player.user.displayName || "Unknown" },
    });
  }

  private async handleDeathTriggers(
    gameId: string,
    deadPlayer: {
      id: string;
      role: GameRole;
      linkedTo?: string | null;
      user: { displayName: string };
    },
  ) {
    // Hunter revenge shot
    if (deadPlayer.role === GameRole.HUNTER) {
      await this.publishPlayerEvent(gameId, deadPlayer.id, "hunter_revenge", {
        message: "You can take one player with you!",
      });
      // Hunter will choose target through a special action
    }

    // Cupid lovers
    if (deadPlayer.linkedTo) {
      const lover = await this.prisma.player.findUnique({
        where: { id: deadPlayer.linkedTo },
      });

      if (lover && lover.state === PlayerState.ALIVE) {
        await this.killPlayer(gameId, lover.id, "grief");
      }
    }

    // Check if player was linked by Cupid
    const linkedLover = await this.prisma.player.findFirst({
      where: {
        gameId,
        linkedTo: deadPlayer.id,
        state: PlayerState.ALIVE,
      },
    });

    if (linkedLover) {
      await this.killPlayer(gameId, linkedLover.id, "grief");
    }

    // Handle Heir inheritance
    const heirAbility = await this.prisma.ability.findFirst({
      where: {
        abilityType: "heir_target",
        metadata: {
          path: ["targetId"],
          equals: deadPlayer.id,
        },
      },
      include: { player: true },
    });

    if (heirAbility && heirAbility.player.state === PlayerState.ALIVE) {
      // Heir inherits the role
      await this.prisma.player.update({
        where: { id: heirAbility.playerId },
        data: { role: deadPlayer.role },
      });

      // Initialize fresh abilities for the new role
      await this.roleService.initializeAbilities(
        heirAbility.playerId,
        deadPlayer.role,
      );

      await this.publishPlayerEvent(
        gameId,
        heirAbility.playerId,
        "role_inherited",
        {
          newRole: deadPlayer.role,
          fromPlayer: deadPlayer.user.displayName,
        },
      );
    }

    // Handle Plunderer (first death)
    const deathCount = await this.prisma.player.count({
      where: {
        gameId,
        state: PlayerState.DEAD,
      },
    });

    if (deathCount === 1) {
      const plunderer = await this.prisma.player.findFirst({
        where: {
          gameId,
          role: GameRole.PLUNDERER,
          state: PlayerState.ALIVE,
        },
      });

      if (plunderer) {
        // Plunderer inherits the role
        await this.prisma.player.update({
          where: { id: plunderer.id },
          data: { role: deadPlayer.role },
        });

        // Initialize fresh abilities for the new role
        await this.roleService.initializeAbilities(
          plunderer.id,
          deadPlayer.role,
        );

        await this.publishPlayerEvent(gameId, plunderer.id, "role_stolen", {
          newRole: deadPlayer.role,
          fromPlayer: deadPlayer.user.displayName,
        });
      }
    }

    // Check protection losses
    await this.checkProtectionLosses(gameId, deadPlayer);
  }

  private async checkProtectionLosses(
    gameId: string,
    deadPlayer: { role: GameRole },
  ) {
    // Wolf Riding Hood loses protection if Black Wolf dies
    if (deadPlayer.role === GameRole.BLACK_WOLF) {
      const wolfRidingHood = await this.prisma.player.findFirst({
        where: {
          gameId,
          role: GameRole.WOLF_RIDING_HOOD,
          state: PlayerState.ALIVE,
        },
      });

      if (wolfRidingHood) {
        await this.publishPlayerEvent(
          gameId,
          wolfRidingHood.id,
          "protection_lost",
          {
            protectionType: "vote_immunity",
          },
        );
      }
    }

    // Red Riding Hood loses protection if Hunter dies
    if (deadPlayer.role === GameRole.HUNTER) {
      const redRidingHood = await this.prisma.player.findFirst({
        where: {
          gameId,
          role: GameRole.RED_RIDING_HOOD,
          state: PlayerState.ALIVE,
        },
      });

      if (redRidingHood) {
        await this.publishPlayerEvent(
          gameId,
          redRidingHood.id,
          "protection_lost",
          {
            protectionType: "werewolf_immunity",
          },
        );
      }
    }
  }

  async checkMercenaryWinCondition(gameId: string, votedOutPlayerId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game || game.dayNumber !== 1) return;

    const mercenary = await this.prisma.player.findFirst({
      where: {
        gameId,
        role: GameRole.MERCENARY,
        state: PlayerState.ALIVE,
      },
      include: { user: true },
    });

    if (!mercenary) return;

    const targetAbility = await this.prisma.ability.findFirst({
      where: {
        playerId: mercenary.id,
        abilityType: "mercenary_target",
      },
    });

    if (!targetAbility || !targetAbility.metadata) return;

    const targetId = (targetAbility.metadata as { targetId: string }).targetId;

    if (targetId === votedOutPlayerId) {
      // Mercenary wins!
      await this.endGame(gameId, Team.SOLO);

      await this.publishGameEvent(gameId, "mercenary_victory", {
        mercenaryName: mercenary.user.displayName,
        message: "The Mercenary successfully eliminated their target!",
      });
    }
  }

  async transitionMercenaryToVillager(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game || game.dayNumber !== 1) return;

    const mercenary = await this.prisma.player.findFirst({
      where: {
        gameId,
        role: GameRole.MERCENARY,
        state: PlayerState.ALIVE,
      },
    });

    if (!mercenary) return;

    // Convert to villager
    await this.prisma.player.update({
      where: { id: mercenary.id },
      data: { role: GameRole.VILLAGER },
    });

    await this.publishPlayerEvent(gameId, mercenary.id, "mercenary_failed", {
      newRole: GameRole.VILLAGER,
      message: "You failed to eliminate your target. You are now a Villager.",
    });
  }

  private async checkWinConditions(gameId: string): Promise<Team | null> {
    const alivePlayers = await this.prisma.player.findMany({
      where: {
        gameId,
        state: PlayerState.ALIVE,
      },
    });

    if (alivePlayers.length === 0) {
      return null; // Draw
    }

    // Check Cupid lovers win condition
    const lovers = alivePlayers.filter((p) => p.linkedTo !== null);
    if (lovers.length === 2 && alivePlayers.length === 2) {
      // Only the two lovers remain - they win
      return Team.VILLAGERS; // Lovers win counts as villager victory
    }

    const werewolves = alivePlayers.filter((p) =>
      (
        [
          GameRole.WEREWOLF,
          GameRole.BLACK_WOLF,
          GameRole.WOLF_RIDING_HOOD,
        ] as GameRole[]
      ).includes(p.role),
    );
    const villagers = alivePlayers.filter(
      (p) => this.getTeamForRole(p.role) === Team.VILLAGERS,
    );
    const soloPlayers = alivePlayers.filter(
      (p) => this.getTeamForRole(p.role) === Team.SOLO,
    );

    // Check White Wolf win (sole survivor)
    if (
      alivePlayers.length === 1 &&
      alivePlayers[0].role === GameRole.WHITE_WOLF
    ) {
      return Team.SOLO;
    }

    // Check Werewolf win (equal or more than villagers)
    if (werewolves.length >= villagers.length && soloPlayers.length === 0) {
      return Team.WEREWOLVES;
    }

    // Check Villager win (no werewolves or hostile solo)
    if (
      werewolves.length === 0 &&
      !soloPlayers.some((p) => p.role === GameRole.WHITE_WOLF)
    ) {
      return Team.VILLAGERS;
    }

    return null;
  }

  private async endGame(gameId: string, winningTeam: Team) {
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        state: GameState.ENDED,
        phase: GamePhase.GAME_END,
        endedAt: new Date(),
        winningTeam,
      },
    });

    // Clear phase timer
    await this.clearPhaseTimer(gameId);

    // Update player statistics
    const players = await this.prisma.player.findMany({
      where: { gameId },
      include: { user: true },
    });

    for (const player of players) {
      const won = this.getTeamForRole(player.role) === winningTeam;
      await this.updatePlayerStats(player.userId, player.role, won);
    }

    // Emit game end event
    await this.publishGameEvent(gameId, "game_ended", {
      winningTeam,
      players: players.map((p) => ({
        id: p.id,
        displayName: p.user.displayName,
        role: p.role,
        team: this.getTeamForRole(p.role),
        survived: p.state === PlayerState.ALIVE,
      })),
    });
  }

  private async updatePlayerStats(
    userId: string,
    role: GameRole,
    won: boolean,
  ) {
    const team = this.getTeamForRole(role);

    await this.prisma.userStats.upsert({
      where: { userId },
      create: {
        userId,
        gamesPlayed: 1,
        gamesWon: won ? 1 : 0,
        gamesAsWerewolf: team === Team.WEREWOLVES ? 1 : 0,
        gamesAsVillager: team === Team.VILLAGERS ? 1 : 0,
        gamesAsSolo: team === Team.SOLO ? 1 : 0,
        werewolfWins: team === Team.WEREWOLVES && won ? 1 : 0,
        villagerWins: team === Team.VILLAGERS && won ? 1 : 0,
        soloWins: team === Team.SOLO && won ? 1 : 0,
      },
      update: {
        gamesPlayed: { increment: 1 },
        gamesWon: won ? { increment: 1 } : undefined,
        gamesAsWerewolf:
          team === Team.WEREWOLVES ? { increment: 1 } : undefined,
        gamesAsVillager: team === Team.VILLAGERS ? { increment: 1 } : undefined,
        gamesAsSolo: team === Team.SOLO ? { increment: 1 } : undefined,
        werewolfWins:
          team === Team.WEREWOLVES && won ? { increment: 1 } : undefined,
        villagerWins:
          team === Team.VILLAGERS && won ? { increment: 1 } : undefined,
        soloWins: team === Team.SOLO && won ? { increment: 1 } : undefined,
      },
    });
  }

  private async schedulePhaseEnd(
    gameId: string,
    phase: GamePhase,
    duration: number,
  ) {
    const endTime = Date.now() + duration * 1000;

    // Store in Redis
    await this.redis.zadd(
      "phase_timers",
      endTime,
      JSON.stringify({ gameId, phase, endTime }),
    );

    // Set local timer as backup
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

  private async clearPhaseTimer(gameId: string) {
    // Clear local timer
    const timer = this.phaseTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.phaseTimers.delete(gameId);
    }

    // Clear from Redis
    const timers = await this.redis.zrange("phase_timers", 0, -1);
    for (const timerData of timers) {
      const data = JSON.parse(timerData);
      if (data.gameId === gameId) {
        await this.redis.zrem("phase_timers", timerData);
      }
    }
  }

  cleanup() {
    // Clear all timers on shutdown
    if (this.timerCheckInterval) {
      clearInterval(this.timerCheckInterval);
    }

    for (const timer of this.phaseTimers.values()) {
      clearTimeout(timer);
    }
    this.phaseTimers.clear();
  }

  private getPhaseDuration(
    game: { nightDuration: number; dayDuration: number; voteDuration: number },
    phase: GamePhase,
  ): number {
    switch (phase) {
      case GamePhase.ROLE_ASSIGNMENT:
        return 5; // 5 seconds to view role
      case GamePhase.NIGHT_PHASE:
        return game.nightDuration;
      case GamePhase.DAY_DISCUSSION:
        return game.dayDuration;
      case GamePhase.DAY_VOTING:
        return game.voteDuration;
      default:
        return 0;
    }
  }

  private getStateForPhase(phase: GamePhase): GameState {
    switch (phase) {
      case GamePhase.LOBBY:
        return GameState.WAITING;
      case GamePhase.ROLE_ASSIGNMENT:
        return GameState.STARTING;
      case GamePhase.NIGHT_PHASE:
        return GameState.NIGHT;
      case GamePhase.DAY_DISCUSSION:
        return GameState.DAY;
      case GamePhase.DAY_VOTING:
        return GameState.VOTING;
      case GamePhase.GAME_END:
        return GameState.ENDED;
    }
  }

  private getNextPhase(currentPhase: GamePhase): GamePhase {
    switch (currentPhase) {
      case GamePhase.ROLE_ASSIGNMENT:
        return GamePhase.NIGHT_PHASE;
      case GamePhase.NIGHT_PHASE:
        return GamePhase.DAY_DISCUSSION;
      case GamePhase.DAY_DISCUSSION:
        return GamePhase.DAY_VOTING;
      case GamePhase.DAY_VOTING:
        return GamePhase.NIGHT_PHASE;
      default:
        return GamePhase.GAME_END;
    }
  }

  private hasNightAbility(role: GameRole): boolean {
    return this.roleService.hasNightAbility(role);
  }

  private getNightAbilities(role: GameRole): string[] {
    const abilities: Record<GameRole, string[]> = {
      [GameRole.WEREWOLF]: ["werewolf_vote"],
      [GameRole.BLACK_WOLF]: ["werewolf_vote", "black_wolf_convert"],
      [GameRole.WHITE_WOLF]: ["werewolf_vote", "white_wolf_devour"],
      [GameRole.SEER]: ["seer_investigate"],
      [GameRole.TALKATIVE_SEER]: ["seer_investigate"],
      [GameRole.WITCH]: ["witch_heal", "witch_poison"],
      [GameRole.POISONER]: ["witch_poison"],
      [GameRole.GUARD]: ["guard_protect"],
      [GameRole.CUPID]: ["cupid_link"],
      [GameRole.HEIR]: ["heir_choose"],
    } as any;

    return abilities[role] || [];
  }

  private prioritizeActions(
    actions: {
      id: string;
      actionType: ActionType;
      targetId?: string | null;
      performerId: string;
      gameId: string;
      metadata?: unknown;
    }[],
  ): {
    id: string;
    actionType: ActionType;
    targetId?: string | null;
    performerId: string;
    gameId: string;
    metadata?: unknown;
  }[] {
    // Action priority order for resolution
    const priority: ActionType[] = [
      ActionType.GUARD_PROTECT,
      ActionType.CUPID_LINK,
      ActionType.HEIR_CHOOSE,
      ActionType.WEREWOLF_VOTE,
      ActionType.WHITE_WOLF_DEVOUR,
      ActionType.BLACK_WOLF_CONVERT,
      ActionType.WITCH_HEAL,
      ActionType.WITCH_POISON,
      ActionType.SEER_INVESTIGATE,
    ];

    return actions.sort((a, b) => {
      const aPriority = priority.indexOf(a.actionType);
      const bPriority = priority.indexOf(b.actionType);
      return aPriority - bPriority;
    });
  }

  private getTeamForRole(role: GameRole): Team {
    const team = this.roleService.getTeamForRole(role);
    if (team === "WEREWOLVES") return Team.WEREWOLVES;
    if (team === "SOLO") return Team.SOLO;
    return Team.VILLAGERS;
  }

  private async publishGameEvent(gameId: string, event: string, data: unknown) {
    if (this.pubsub) {
      await this.pubsub.publishGameEvent(gameId, event, data);
    }
  }

  private async publishPlayerEvent(
    gameId: string,
    playerId: string,
    event: string,
    data: unknown,
  ) {
    await this.redis.publish(
      `game:${gameId}:player:${playerId}:${event}`,
      JSON.stringify(data),
    );
  }

  // Hunter revenge mechanic
  async processHunterRevenge(
    gameId: string,
    hunterId: string,
    targetId: string,
  ) {
    const hunter = await this.prisma.player.findUnique({
      where: { id: hunterId },
      include: { game: true },
    });

    if (!hunter || hunter.role !== GameRole.HUNTER) {
      throw new Error("Invalid hunter");
    }

    const target = await this.prisma.player.findUnique({
      where: { id: targetId },
      include: { user: true },
    });

    if (!target || target.state !== PlayerState.ALIVE) {
      throw new Error("Invalid target");
    }

    // Record the action
    await this.prisma.gameAction.create({
      data: {
        gameId,
        performerId: hunterId,
        targetId,
        actionType: ActionType.HUNTER_SHOOT,
        dayNumber: hunter.game.dayNumber,
        phase: hunter.game.phase,
      },
    });

    // Kill the target
    await this.killPlayer(gameId, targetId, "hunter_revenge");

    await this.publishGameEvent(gameId, "hunter_revenge_completed", {
      hunterId,
      targetId,
      targetName: target.user.displayName,
    });
  }

  // Dictator coup mechanic
  async processDictatorCoup(
    gameId: string,
    dictatorId: string,
    targetId: string,
  ) {
    const dictator = await this.prisma.player.findUnique({
      where: { id: dictatorId },
      include: { game: true, user: true },
    });

    if (!dictator || dictator.role !== GameRole.DICTATOR) {
      throw new Error("Invalid dictator");
    }

    const target = await this.prisma.player.findUnique({
      where: { id: targetId },
      include: { user: true },
    });

    if (!target || target.state !== PlayerState.ALIVE) {
      throw new Error("Invalid target");
    }

    // Check if dictator has uses left
    const ability = await this.prisma.ability.findUnique({
      where: {
        playerId_abilityType: {
          playerId: dictatorId,
          abilityType: "coup",
        },
      },
    });

    if (!ability || ability.usesLeft <= 0) {
      throw new Error("No coup attempts left");
    }

    // Use the ability
    await this.prisma.ability.update({
      where: { id: ability.id },
      data: { usesLeft: 0 },
    });

    // Check if target is a werewolf
    const isWerewolf = (
      [
        GameRole.WEREWOLF,
        GameRole.BLACK_WOLF,
        GameRole.WOLF_RIDING_HOOD,
      ] as GameRole[]
    ).includes(target.role);

    if (isWerewolf) {
      // Success! Eliminate the werewolf and become Mayor
      await this.killPlayer(gameId, targetId, "dictator_coup");

      // Grant Mayor powers (double vote)
      await this.prisma.ability.create({
        data: {
          playerId: dictatorId,
          abilityType: "mayor_vote",
          usesLeft: 999, // Effectively unlimited
          maxUses: 999,
        },
      });

      await this.publishGameEvent(gameId, "dictator_success", {
        dictatorName: dictator.user.displayName,
        targetName: target.user.displayName,
        targetRole: target.role,
      });
    } else {
      // Failed! Dictator dies
      await this.killPlayer(gameId, dictatorId, "failed_coup");

      await this.publishGameEvent(gameId, "dictator_failed", {
        dictatorName: dictator.user.displayName,
        targetName: target.user.displayName,
      });
    }
  }
}
