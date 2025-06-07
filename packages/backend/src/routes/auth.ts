import {
  AuthService,
  registerSchema,
  loginSchema,
} from "../services/auth.service.js";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const registerAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const authService = new AuthService(app.prisma, app);

  // Register with rate limiting
  app.post(
    "/register",
    {
      preHandler: app.rateLimit({
        max: 5,
        timeWindow: "15 minutes",
      }),
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
          path: "/",
        });

        return {
          user: result.user,
          accessToken: result.accessToken,
        };
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("already exists")) {
            return reply.code(409).send({ error: error.message });
          }
        }
        throw error;
      }
    },
  );

  // Login with rate limiting and progressive delay
  app.post(
    "/login",
    {
      preHandler: app.rateLimit({
        max: 10,
        timeWindow: "15 minutes",
      }),
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
          path: "/",
        });

        return {
          user: result.user,
          accessToken: result.accessToken,
        };
      } catch (_error) {
        // Add delay to prevent timing attacks
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return reply.code(401).send({ error: "Invalid credentials" });
      }
    },
  );

  // Guest login with rate limiting
  app.post(
    "/guest",
    {
      preHandler: app.rateLimit({
        max: 20,
        timeWindow: "1 hour",
      }),
    },
    async (request, reply) => {
      try {
        const result = await authService.createGuestUser();

        reply.setCookie("refreshToken", result.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days for guests
          path: "/",
        });

        return {
          user: result.user,
          accessToken: result.accessToken,
        };
      } catch (error) {
        throw error;
      }
    },
  );

  // Refresh tokens with rate limiting
  app.post(
    "/refresh",
    {
      preHandler: app.rateLimit({
        max: 30,
        timeWindow: "15 minutes",
      }),
    },
    async (request, reply) => {
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
          path: "/",
        });

        return {
          accessToken: result.accessToken,
        };
      } catch (_error) {
        reply.clearCookie("refreshToken");
        return reply.code(401).send({ error: "Invalid refresh token" });
      }
    },
  );

  // Logout
  app.post("/logout", async (request, reply) => {
    const refreshToken = request.cookies.refreshToken;

    if (refreshToken) {
      try {
        await authService.revokeRefreshToken(refreshToken);
      } catch (error) {
        // Log but don't fail logout
        app.log.error(error);
      }
    }

    reply.clearCookie("refreshToken");
    return { success: true };
  });
};
