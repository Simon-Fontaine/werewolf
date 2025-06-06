import { GameRole, Prisma } from "@werewolf/database";
import { GAME_CONFIG } from "../config/game.config.js";
import { PrismaClientType } from "../lib/prisma.js";

export class RoleService {
  constructor(private prisma: PrismaClientType) {}

  async assignRoles(gameId: string, playerCount: number) {
    const distribution = this.getRoleDistribution(playerCount);
    const players = await this.prisma.player.findMany({
      where: { gameId },
      orderBy: { position: "asc" },
    });

    // Build role pool
    const rolePool: GameRole[] = [];

    // Add werewolves
    for (let i = 0; i < distribution.werewolves; i++) {
      rolePool.push(GameRole.WEREWOLF);
    }

    // Add special roles
    Object.entries(distribution).forEach(([role, count]) => {
      if (role !== "werewolves" && role !== "villagers" && count > 0) {
        const gameRole = this.mapToGameRole(role);
        if (gameRole) rolePool.push(gameRole);
      }
    });

    // Fill remaining with villagers
    while (rolePool.length < playerCount) {
      rolePool.push(GameRole.VILLAGER);
    }

    // Shuffle roles
    const shuffledRoles = this.shuffleArray(rolePool);

    // Assign roles to players
    const assignments = await Promise.all(
      players.map(async (player, index) => {
        const role = shuffledRoles[index];

        await this.prisma.player.update({
          where: { id: player.id },
          data: { role },
        });

        // Initialize abilities for special roles
        await this.initializeAbilities(player.id, role);

        return { playerId: player.id, role };
      }),
    );

    // Handle special role relationships
    await this.handleSpecialRoleRelationships(gameId, assignments);

    return assignments;
  }

  private async initializeAbilities(playerId: string, role: GameRole) {
    const abilities =
      GAME_CONFIG.roleAbilities[role as keyof typeof GAME_CONFIG.roleAbilities];
    if (!abilities) return;

    const abilityData: Prisma.AbilityCreateManyInput[] = [];

    switch (role) {
      case GameRole.WITCH:
        abilityData.push(
          { playerId, abilityType: "heal", usesLeft: 1, maxUses: 1 },
          { playerId, abilityType: "poison", usesLeft: 1, maxUses: 1 },
        );
        break;

      case GameRole.POISONER:
        abilityData.push({
          playerId,
          abilityType: "poison",
          usesLeft: 2,
          maxUses: 2,
        });
        break;

      case GameRole.BLACK_WOLF:
        abilityData.push({
          playerId,
          abilityType: "convert",
          usesLeft: 1,
          maxUses: 1,
        });
        break;

      case GameRole.WHITE_WOLF:
        abilityData.push({
          playerId,
          abilityType: "devour",
          usesLeft: 1,
          maxUses: 1,
          cooldownDays: 2,
        });
        break;

      case GameRole.DICTATOR:
        abilityData.push({
          playerId,
          abilityType: "coup",
          usesLeft: 1,
          maxUses: 1,
        });
        break;

      case GameRole.GUARD:
        abilityData.push({
          playerId,
          abilityType: "protect",
          usesLeft: 1,
          maxUses: 1,
          cooldownDays: 0, // Resets each night
        });
        break;

      case GameRole.SEER:
      case GameRole.TALKATIVE_SEER:
        abilityData.push({
          playerId,
          abilityType: "investigate",
          usesLeft: 1,
          maxUses: 1,
          cooldownDays: 0,
        });
        break;

      case GameRole.CUPID:
        abilityData.push({
          playerId,
          abilityType: "link",
          usesLeft: 1,
          maxUses: 1,
        });
        break;

      case GameRole.HEIR:
        abilityData.push({
          playerId,
          abilityType: "choose_heir",
          usesLeft: 1,
          maxUses: 1,
        });
        break;
    }

    if (abilityData.length > 0) {
      await this.prisma.ability.createMany({ data: abilityData });
    }
  }

  private async handleSpecialRoleRelationships(
    gameId: string,
    assignments: { playerId: string; role: GameRole }[],
  ) {
    // Handle Mercenary target assignment
    const mercenary = assignments.find((a) => a.role === GameRole.MERCENARY);
    if (mercenary) {
      const potentialTargets = assignments.filter(
        (a) =>
          a.playerId !== mercenary.playerId && a.role !== GameRole.MERCENARY,
      );

      if (potentialTargets.length > 0) {
        const target =
          potentialTargets[Math.floor(Math.random() * potentialTargets.length)];

        await this.prisma.ability.create({
          data: {
            playerId: mercenary.playerId,
            abilityType: "mercenary_target",
            usesLeft: 1,
            maxUses: 1,
            metadata: { targetId: target.playerId },
          },
        });
      }
    }
  }

  private getRoleDistribution(playerCount: number) {
    return (
      GAME_CONFIG.roleDistribution[
        playerCount as keyof typeof GAME_CONFIG.roleDistribution
      ] || this.calculateDynamicDistribution(playerCount)
    );
  }

  private calculateDynamicDistribution(playerCount: number) {
    // For player counts not in the config, calculate a balanced distribution
    const distribution: any = { villagers: 0 };

    // Base werewolf count: ~25% of players
    distribution.werewolves = Math.max(1, Math.floor(playerCount * 0.25));

    // Always have at least one seer for games with 5+ players
    if (playerCount >= 5) {
      distribution.seer = 1;
    }

    // Add special roles based on player count
    if (playerCount >= 7) {
      distribution.witch = 1;
    }
    if (playerCount >= 9) {
      distribution.hunter = 1;
    }
    if (playerCount >= 11) {
      distribution.guard = 1;
    }
    if (playerCount >= 13) {
      distribution.cupid = 1;
    }

    // Fill the rest with villagers
    const specialRolesCount = Object.values(distribution).reduce(
      (sum: number, count: any) => sum + (count as number),
      0,
    );
    distribution.villagers = playerCount - specialRolesCount;

    return distribution;
  }

  private mapToGameRole(roleName: string): GameRole | null {
    const roleMap: Record<string, GameRole> = {
      werewolf: GameRole.WEREWOLF,
      werewolves: GameRole.WEREWOLF,
      seer: GameRole.SEER,
      witch: GameRole.WITCH,
      hunter: GameRole.HUNTER,
      guard: GameRole.GUARD,
      cupid: GameRole.CUPID,
      dictator: GameRole.DICTATOR,
      poisoner: GameRole.POISONER,
      little_girl: GameRole.LITTLE_GIRL,
      talkative_seer: GameRole.TALKATIVE_SEER,
      black_wolf: GameRole.BLACK_WOLF,
      white_wolf: GameRole.WHITE_WOLF,
      wolf_riding_hood: GameRole.WOLF_RIDING_HOOD,
      red_riding_hood: GameRole.RED_RIDING_HOOD,
      blue_riding_hood: GameRole.BLUE_RIDING_HOOD,
      heir: GameRole.HEIR,
      plunderer: GameRole.PLUNDERER,
      mercenary: GameRole.MERCENARY,
    };

    return roleMap[roleName.toLowerCase()] || null;
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Helper method to get role team affiliation
  getTeamForRole(role: GameRole): "WEREWOLVES" | "VILLAGERS" | "SOLO" {
    switch (role) {
      case GameRole.WEREWOLF:
      case GameRole.BLACK_WOLF:
      case GameRole.WOLF_RIDING_HOOD:
        return "WEREWOLVES";

      case GameRole.WHITE_WOLF:
      case GameRole.MERCENARY:
        return "SOLO";

      default:
        return "VILLAGERS";
    }
  }

  // Check if a role has night abilities
  hasNightAbility(role: GameRole): boolean {
    const nightRoles = [
      GameRole.WEREWOLF,
      GameRole.BLACK_WOLF,
      GameRole.WHITE_WOLF,
      GameRole.SEER,
      GameRole.TALKATIVE_SEER,
      GameRole.WITCH,
      GameRole.POISONER,
      GameRole.GUARD,
      GameRole.CUPID, // First night only
      GameRole.HEIR, // First night only
    ] as GameRole[];

    return nightRoles.includes(role);
  }

  // Get action priority for processing night actions
  getActionPriority(role: GameRole): number {
    // Lower number = higher priority (processed first)
    const priorities: Partial<Record<GameRole, number>> = {
      [GameRole.GUARD]: 1, // Protection must be applied first
      [GameRole.CUPID]: 2, // Linking on first night
      [GameRole.HEIR]: 2, // Choosing heir on first night
      [GameRole.WEREWOLF]: 3,
      [GameRole.BLACK_WOLF]: 3,
      [GameRole.WHITE_WOLF]: 4, // After regular werewolves
      [GameRole.WITCH]: 5, // Can heal after werewolf attack
      [GameRole.POISONER]: 5,
      [GameRole.SEER]: 6,
      [GameRole.TALKATIVE_SEER]: 6,
      // Other roles...
    };

    return priorities[role] || 99;
  }
}
