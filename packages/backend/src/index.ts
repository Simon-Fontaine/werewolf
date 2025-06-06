import { createApp } from "./app.js";
import { env } from "./config/env.js";

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
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
