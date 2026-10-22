import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import app, { isAllowedOrigin } from "./app";
import { logger } from "./lib/logger";
import { setupSocketHandlers } from "./lib/socketHandler";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  path: "/api/socket.io",
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["polling", "websocket"],
});

setupSocketHandlers(io);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});
