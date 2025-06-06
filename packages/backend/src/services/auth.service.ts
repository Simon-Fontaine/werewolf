import { hash, verify } from "argon2";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccountType, UserStatus } from "@werewolf/database";
import type { PrismaClientType } from "../lib/prisma.js";
import { generateRandomString } from "../utils/random.js";

export const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(100),
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export class AuthService {
  constructor(
    private prisma: PrismaClientType,
    private app: FastifyInstance,
  ) {}

  async register(data: z.infer<typeof registerSchema>) {
    // Check if username or email already exists
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existing) {
      throw new Error("Username or email already exists");
    }

    // Hash password
    const passwordHash = await hash(data.password);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        username: data.username,
        email: data.email,
        passwordHash,
        accountType: AccountType.REGISTERED,
        status: UserStatus.ACTIVE,
        displayName: data.username,
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

    if (!user || !user.passwordHash) {
      throw new Error("Invalid credentials");
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new Error("Account is not active");
    }

    // Verify password
    const valid = await verify(user.passwordHash, data.password);
    if (!valid) {
      throw new Error("Invalid credentials");
    }

    // Update last active
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastActive: new Date() },
    });

    // Generate tokens
    const tokens = await this.generateTokens(user.id);

    const { passwordHash, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, ...tokens };
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

    // Store refresh token in database
    await this.prisma.refreshToken.create({
      data: {
        userId,
        token: refreshToken,
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
      const storedToken = await this.prisma.refreshToken.findUnique({
        where: { token: refreshToken },
      });

      if (!storedToken || storedToken.revokedAt) {
        throw new Error("Invalid refresh token");
      }

      // Revoke old token
      await this.prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      // Generate new tokens
      return this.generateTokens(payload.userId);
    } catch (error) {
      throw new Error("Invalid refresh token");
    }
  }
}
