import { GameRole } from "@werewolf/database";
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

    return assignments;
  }

  private async initializeAbilities(playerId: string, role: GameRole) {
    const abilities = GAME_CONFIG.roleAbilities[role];
    if (!abilities) return;

    // Create ability entries based on role
    if (role === GameRole.WITCH) {
      await this.prisma.ability.createMany({
        data: [
          { playerId, abilityType: "heal", usesLeft: 1, maxUses: 1 },
          { playerId, abilityType: "poison", usesLeft: 1, maxUses: 1 },
        ],
      });
    } else if (role === GameRole.POISONER) {
      await this.prisma.ability.create({
        data: { playerId, abilityType: "poison", usesLeft: 2, maxUses: 2 },
      });
    }
    // Add more role-specific abilities...
  }

  private getRoleDistribution(playerCount: number) {
    return (
      GAME_CONFIG.roleDistribution[playerCount] ||
      this.calculateDynamicDistribution(playerCount)
    );
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}
