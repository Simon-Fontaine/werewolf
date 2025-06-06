import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const registerGameRoutes: FastifyPluginAsyncZod = async (app) => {
  // List games
  app.get("/", async (request, reply) => {
    const games = await app.prisma.game.findMany({
      where: {
        state: {
          in: ["WAITING", "STARTING"],
        },
      },
      include: {
        _count: {
          select: { players: true },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    return games;
  });
};
