import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookie from "cookie";
import { jwtVerify } from "jose";
import dotenv from "dotenv";
import {
  findNextAvailableOrderForDispatch,
  startOrderDispatchEngine,
} from "./dispatch";
import { RealtimeEvents } from "./events";
import { SocketPayload } from "./payloads";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const PORT = process.env.PORT || 3010;

function getJwtSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CRITICAL: JWT_SECRET environment variable is required in production.");
    }
    return new TextEncoder().encode("lagchow-dev-only-jwt-secret-do-not-use-in-prod");
  }
  return new TextEncoder().encode(secret);
}

// Configure Socket.io with CORS allowing frontends (Admin, Vendor, Customer, Rider)
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Authentication Middleware for Socket Connections
io.use(async (socket, next) => {
  let token = socket.handshake.auth?.token;

  if (!token && socket.request.headers.cookie) {
    try {
      const cookies = cookie.parse(socket.request.headers.cookie);
      token = cookies.__session;
    } catch {}
  }

  if (token) {
    try {
      const { payload } = await jwtVerify(token, getJwtSecretKey());
      socket.data.user = payload;
    } catch (err) {
      console.warn(`[WS] Invalid JWT token on socket ${socket.id}`);
    }
  }
  next();
});

io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id} (User: ${socket.data.user?.email || "anonymous"})`);

  socket.on("join_room", (room: string) => {
    socket.join(room);
    console.log(`📌 Socket ${socket.id} joined room: ${room}`);
  });

  socket.on("leave_room", (room: string) => {
    socket.leave(room);
    console.log(`📌 Socket ${socket.id} left room: ${room}`);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// REST Endpoint for Next.js API routes to trigger Socket Broadcasts & Dispatch
app.post("/emit", (req, res) => {
  const expectedSecret = process.env.INTERNAL_WS_SECRET;
  if (expectedSecret) {
    const providedSecret = req.headers["x-internal-secret"];
    if (providedSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized internal emit request" });
    }
  }

  const { event, room, data } = req.body as {
    event: keyof typeof RealtimeEvents | string;
    room?: string;
    data: SocketPayload | any;
  };

  if (!event || !data) {
    return res.status(400).json({ error: "Missing event or data payload" });
  }

  console.log(`📢 Broadcasting Event [${event}] ${room ? `to room [${room}]` : "globally"}`);

  if (room) {
    io.to(room).emit(event, data);
  } else {
    io.emit(event, data);
  }

  // Trigger dispatch candidate evaluation when an order is created or reaches accepted/preparing/ready state
  if (
    event === "ORDER_CREATED" ||
    (event === "ORDER_STATUS_CHANGED" &&
      ["accepted", "preparing", "ready"].includes(data?.data?.status))
  ) {
    void findNextAvailableOrderForDispatch(io);
  }

  return res.status(200).json({ success: true, event });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "lagchow-realtime-server",
    timestamp: new Date().toISOString(),
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 LagChow Realtime & Background Server running on port ${PORT}`);
  startOrderDispatchEngine(io);
});

export { io, httpServer, app };
