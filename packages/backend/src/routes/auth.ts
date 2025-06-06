import {
  AuthService,
  registerSchema,
  loginSchema,
} from "../services/auth.service.js";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const registerAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const authService = new AuthService(app.prisma, app);

  // Register
  app.post(
    "/register",
    {
      schema: {
        body: registerSchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.register(request.body);

        reply.setCookie("refreshToken", result.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        return {
          user: result.user,
          accessToken: result.accessToken,
        };
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // Login
  app.post(
    "/login",
    {
      schema: {
        body: loginSchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.login(request.body);

        reply.setCookie("refreshToken", result.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        return {
          user: result.user,
          accessToken: result.accessToken,
        };
      } catch (error) {
        return reply.code(401).send({
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // Guest login
  app.post("/guest", async (request, reply) => {
    try {
      const result = await authService.createGuestUser();

      reply.setCookie("refreshToken", result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days for guests
      });

      return {
        user: result.user,
        accessToken: result.accessToken,
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Refresh tokens
  app.post("/refresh", async (request, reply) => {
    const refreshToken = request.cookies.refreshToken;

    if (!refreshToken) {
      return reply.code(401).send({ error: "No refresh token provided" });
    }

    try {
      const result = await authService.refreshTokens(refreshToken);

      reply.setCookie("refreshToken", result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return {
        accessToken: result.accessToken,
      };
    } catch (error) {
      return reply.code(401).send({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Logout
  app.post("/logout", async (request, reply) => {
    reply.clearCookie("refreshToken");
    return { success: true };
  });
};
