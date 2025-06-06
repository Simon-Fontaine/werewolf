import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const registerStatsRoutes: FastifyPluginAsyncZod = async (app) => {
  // Get user statistics
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const stats = await app.prisma.userStats.findUnique({
        where: { userId: request.user.userId },
      });

      if (!stats) {
        // Return default stats if none exist
        return {
          gamesPlayed: 0,
          gamesWon: 0,
          winRate: 0,
          favoriteRole: null,
          roleStats: {
            werewolf: { played: 0, won: 0 },
            villager: { played: 0, won: 0 },
            solo: { played: 0, won: 0 },
          },
        };
      }

      const winRate =
        stats.gamesPlayed > 0 ? (stats.gamesWon / stats.gamesPlayed) * 100 : 0;

      // Determine favorite role
      const roles = [
        { type: "werewolf", played: stats.gamesAsWerewolf },
        { type: "villager", played: stats.gamesAsVillager },
        { type: "solo", played: stats.gamesAsSolo },
      ];

      const favoriteRole = roles.reduce((prev, curr) =>
        curr.played > prev.played ? curr : prev,
      ).type;

      return {
        gamesPlayed: stats.gamesPlayed,
        gamesWon: stats.gamesWon,
        winRate: Math.round(winRate),
        favoriteRole,
        roleStats: {
          werewolf: {
            played: stats.gamesAsWerewolf,
            won: stats.werewolfWins,
            winRate:
              stats.gamesAsWerewolf > 0
                ? Math.round((stats.werewolfWins / stats.gamesAsWerewolf) * 100)
                : 0,
          },
          villager: {
            played: stats.gamesAsVillager,
            won: stats.villagerWins,
            winRate:
              stats.gamesAsVillager > 0
                ? Math.round((stats.villagerWins / stats.gamesAsVillager) * 100)
                : 0,
          },
          solo: {
            played: stats.gamesAsSolo,
            won: stats.soloWins,
            winRate:
              stats.gamesAsSolo > 0
                ? Math.round((stats.soloWins / stats.gamesAsSolo) * 100)
                : 0,
          },
        },
      };
    },
  );

  // Get global leaderboard
  app.get("/leaderboard", async (request, reply) => {
    const topPlayers = await app.prisma.userStats.findMany({
      where: {
        gamesPlayed: { gte: 10 }, // Minimum 10 games
      },
      include: {
        user: {
          select: {
            displayName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ gamesWon: "desc" }, { gamesPlayed: "desc" }],
      take: 50,
    });

    return topPlayers.map((stat, index) => ({
      rank: index + 1,
      displayName: stat.user.displayName,
      avatarUrl: stat.user.avatarUrl,
      gamesPlayed: stat.gamesPlayed,
      gamesWon: stat.gamesWon,
      winRate: Math.round((stat.gamesWon / stat.gamesPlayed) * 100),
    }));
  });

  // Get role-specific leaderboard
  app.get("/leaderboard/:role", async (request, reply) => {
    const { role } = request.params as { role: string };

    if (!["werewolf", "villager", "solo"].includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }

    const orderBy: any = {};
    const where: any = {};

    switch (role) {
      case "werewolf":
        orderBy.werewolfWins = "desc";
        where.gamesAsWerewolf = { gte: 5 };
        break;
      case "villager":
        orderBy.villagerWins = "desc";
        where.gamesAsVillager = { gte: 5 };
        break;
      case "solo":
        orderBy.soloWins = "desc";
        where.gamesAsSolo = { gte: 3 };
        break;
    }

    const topPlayers = await app.prisma.userStats.findMany({
      where,
      include: {
        user: {
          select: {
            displayName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy,
      take: 50,
    });

    return topPlayers.map((stat, index) => {
      let played, won;
      switch (role) {
        case "werewolf":
          played = stat.gamesAsWerewolf;
          won = stat.werewolfWins;
          break;
        case "villager":
          played = stat.gamesAsVillager;
          won = stat.villagerWins;
          break;
        case "solo":
          played = stat.gamesAsSolo;
          won = stat.soloWins;
          break;
        default:
          played = 0;
          won = 0;
      }

      return {
        rank: index + 1,
        displayName: stat.user.displayName,
        avatarUrl: stat.user.avatarUrl,
        gamesPlayed: played,
        gamesWon: won,
        winRate: played > 0 ? Math.round((won / played) * 100) : 0,
      };
    });
  });
};
