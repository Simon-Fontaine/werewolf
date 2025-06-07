import { createApp } from "./app.js";
import { env } from "./config/env.js";

let shutdownInProgress = false;

async function start() {
  try {
    const { app, io } = await createApp();

    // Start the server
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });

    // Attach Socket.IO to the same port
    io.attach(app.server);

    console.log(`🚀 Server running at http://localhost:${env.PORT}`);
    console.log(`🔌 Socket.IO ready`);

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;

      console.log(`\n${signal} received, starting graceful shutdown...`);

      try {
        // Stop accepting new connections
        await app.close();

        // Close Socket.IO
        io.close();

        // Save all active game states
        const activeGames = await app.prisma.game.findMany({
          where: {
            state: {
              notIn: ["ENDED", "CANCELLED"],
            },
          },
        });

        console.log(`Saving ${activeGames.length} active games...`);

        for (const game of activeGames) {
          await app.redis.set(
            `game:state:backup:${game.id}`,
            JSON.stringify(game),
            "EX",
            86400, // 24 hours
          );
        }

        // Cleanup services
        const gameEngineService = (app as any).gameEngineService;
        if (gameEngineService?.cleanup) {
          gameEngineService.cleanup();
        }

        // Close database connections
        await app.prisma.$disconnect();
        await app.redis.quit();

        console.log("✅ Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        console.error("❌ Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Unhandled rejection handler
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
      // Don't exit - log and continue
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
