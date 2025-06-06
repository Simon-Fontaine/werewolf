import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const registerUserRoutes: FastifyPluginAsyncZod = async (app) => {
  // Get current user
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.user.userId },
        select: {
          id: true,
          username: true,
          email: true,
          displayName: true,
          accountType: true,
          level: true,
          experience: true,
        },
      });

      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }

      return user;
    },
  );
};
