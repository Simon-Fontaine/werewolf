import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const sendFriendRequestSchema = z.object({
  username: z.string(),
});

export const registerFriendRoutes: FastifyPluginAsyncZod = async (app) => {
  // Get friend list
  app.get(
    "/",
    {
      preHandler: app.authenticate,
    },
    async (request, _reply) => {
      const friends = await app.prisma.friend.findMany({
        where: {
          OR: [
            { requesterId: request.user.userId, accepted: true },
            { receiverId: request.user.userId, accepted: true },
          ],
        },
        include: {
          requester: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              lastActive: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              lastActive: true,
            },
          },
        },
      });

      return friends.map((f) => {
        const friend =
          f.requesterId === request.user.userId ? f.receiver : f.requester;

        const isOnline =
          new Date().getTime() - friend.lastActive.getTime() < 300000; // 5 minutes

        return {
          id: friend.id,
          username: friend.username,
          displayName: friend.displayName,
          avatarUrl: friend.avatarUrl,
          isOnline,
          lastActive: friend.lastActive,
        };
      });
    },
  );

  // Get pending friend requests
  app.get(
    "/requests",
    {
      preHandler: app.authenticate,
    },
    async (request, _reply) => {
      const requests = await app.prisma.friend.findMany({
        where: {
          receiverId: request.user.userId,
          accepted: false,
        },
        include: {
          requester: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      });

      return requests.map((r) => ({
        id: r.id,
        user: {
          id: r.requester.id,
          username: r.requester.username,
          displayName: r.requester.displayName,
          avatarUrl: r.requester.avatarUrl,
        },
        createdAt: r.createdAt,
      }));
    },
  );

  // Send friend request
  app.post(
    "/request",
    {
      preHandler: app.authenticate,
      schema: {
        body: sendFriendRequestSchema,
      },
    },
    async (request, reply) => {
      const targetUser = await app.prisma.user.findUnique({
        where: { username: request.body.username },
      });

      if (!targetUser) {
        return reply.code(404).send({ error: "User not found" });
      }

      if (targetUser.id === request.user.userId) {
        return reply.code(400).send({ error: "Cannot add yourself as friend" });
      }

      // Check if already friends or request exists
      const existing = await app.prisma.friend.findFirst({
        where: {
          OR: [
            { requesterId: request.user.userId, receiverId: targetUser.id },
            { requesterId: targetUser.id, receiverId: request.user.userId },
          ],
        },
      });

      if (existing) {
        return reply.code(400).send({
          error: existing.accepted
            ? "Already friends"
            : "Friend request already exists",
        });
      }

      const friendRequest = await app.prisma.friend.create({
        data: {
          requesterId: request.user.userId,
          receiverId: targetUser.id,
        },
      });

      return { id: friendRequest.id, sent: true };
    },
  );

  // Accept friend request
  app.post(
    "/accept/:requestId",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { requestId } = request.params as { requestId: string };

      const friendRequest = await app.prisma.friend.findUnique({
        where: { id: requestId },
      });

      if (!friendRequest || friendRequest.receiverId !== request.user.userId) {
        return reply.code(404).send({ error: "Friend request not found" });
      }

      await app.prisma.friend.update({
        where: { id: requestId },
        data: { accepted: true },
      });

      return { accepted: true };
    },
  );

  // Decline/remove friend
  app.delete(
    "/:friendId",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { friendId } = request.params as { friendId: string };

      const friendship = await app.prisma.friend.findFirst({
        where: {
          id: friendId,
          OR: [
            { requesterId: request.user.userId },
            { receiverId: request.user.userId },
          ],
        },
      });

      if (!friendship) {
        return reply.code(404).send({ error: "Friend not found" });
      }

      await app.prisma.friend.delete({
        where: { id: friendId },
      });

      return { removed: true };
    },
  );
};
