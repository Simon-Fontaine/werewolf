import { hash, verify } from "argon2";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccountType, UserStatus } from "@werewolf/database";
import type { PrismaClientType } from "../lib/prisma.js";
import { generateRandomString } from "../utils/random.js";
import crypto from "crypto";

// Enhanced validation schemas
export const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username can only contain letters, numbers, underscores, and hyphens",
    ),
  email: z.string().email().toLowerCase(),
  password: z
    .string()
    .min(12)
    .max(100)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
      "Password must contain uppercase, lowercase, number, and special character",
    ),
});

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(100),
});

export class AuthService {
  constructor(
    private prisma: PrismaClientType,
    private app: FastifyInstance,
  ) {}

  async register(data: z.infer<typeof registerSchema>) {
    // Normalize email
    const email = data.email.toLowerCase();
    const username = data.username.trim();

    // Check if username or email already exists
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username }, { email }],
      },
    });

    if (existing) {
      if (existing.username === username) {
        throw new Error("Username already exists");
      }
      throw new Error("Email already exists");
    }

    // Hash password with strong settings
    const passwordHash = await hash(data.password, {
      memoryCost: 19456, // 19 MiB
      timeCost: 2,
      parallelism: 1,
    });

    // Create user
    const user = await this.prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        accountType: AccountType.REGISTERED,
        status: UserStatus.ACTIVE,
        displayName: username,
      },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        accountType: true,
      },
    });

    // Generate tokens
    const tokens = await this.generateTokens(user.id);

    return { user, ...tokens };
  }

  async login(data: z.infer<typeof loginSchema>) {
    // Add constant time delay to prevent timing attacks
    const startTime = Date.now();
    const minDelay = 100; // milliseconds

    try {
      // Find user
      const user = await this.prisma.user.findUnique({
        where: { username: data.username },
        select: {
          id: true,
          username: true,
          email: true,
          displayName: true,
          accountType: true,
          passwordHash: true,
          status: true,
        },
      });

      // Always verify even if user doesn't exist (constant time)
      const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$dummy$hash";
      const hashToVerify = user?.passwordHash || dummyHash;

      const valid = await verify(hashToVerify, data.password);

      if (!user || !valid) {
        throw new Error("Invalid credentials");
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw new Error("Account is not active");
      }

      // Update last active
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActive: new Date() },
      });

      // Generate tokens
      const tokens = await this.generateTokens(user.id);

      const { passwordHash: _passwordHash, ...userWithoutPassword } = user;

      // Ensure constant time
      const elapsed = Date.now() - startTime;
      if (elapsed < minDelay) {
        await new Promise((resolve) => setTimeout(resolve, minDelay - elapsed));
      }

      return { user: userWithoutPassword, ...tokens };
    } catch (error) {
      // Ensure constant time even on error
      const elapsed = Date.now() - startTime;
      if (elapsed < minDelay) {
        await new Promise((resolve) => setTimeout(resolve, minDelay - elapsed));
      }
      throw error;
    }
  }

  async createGuestUser() {
    const guestId = generateRandomString(16);

    const user = await this.prisma.user.create({
      data: {
        guestId,
        accountType: AccountType.GUEST,
        status: UserStatus.ACTIVE,
        displayName: `Guest_${generateRandomString(6)}`,
      },
      select: {
        id: true,
        guestId: true,
        displayName: true,
        accountType: true,
      },
    });

    const tokens = await this.generateTokens(user.id);
    return { user, ...tokens };
  }

  private async generateTokens(userId: string) {
    const accessToken = await this.app.jwt.sign(
      { userId, type: "access" },
      { expiresIn: "15m" },
    );

    const refreshToken = await this.app.jwt.sign(
      { userId, type: "refresh" },
      { expiresIn: "7d" },
    );

    // Store refresh token in database with secure hash
    const tokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    await this.prisma.refreshToken.create({
      data: {
        userId,
        token: tokenHash, // Store hash instead of plain token
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    return { accessToken, refreshToken };
  }

  async refreshTokens(refreshToken: string) {
    try {
      const payload = (await this.app.jwt.verify(refreshToken)) as {
        userId: string;
        type: string;
      };

      if (payload.type !== "refresh") {
        throw new Error("Invalid token type");
      }

      // Check if token exists and is not revoked
      const tokenHash = crypto
        .createHash("sha256")
        .update(refreshToken)
        .digest("hex");

      const storedToken = await this.prisma.refreshToken.findUnique({
        where: { token: tokenHash },
      });

      if (
        !storedToken ||
        storedToken.revokedAt ||
        storedToken.expiresAt < new Date()
      ) {
        throw new Error("Invalid refresh token");
      }

      // Revoke old token
      await this.prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      // Generate new tokens
      return this.generateTokens(payload.userId);
    } catch (_error) {
      throw new Error("Invalid refresh token");
    }
  }

  async revokeRefreshToken(refreshToken: string) {
    const tokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    await this.prisma.refreshToken.updateMany({
      where: { token: tokenHash },
      data: { revokedAt: new Date() },
    });
  }
}
