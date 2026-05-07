import "dotenv/config";
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import {
  isOriginAllowed,
  parseAllowedOrigins,
  requestErrorHandler,
  securityHeaders,
} from "./lib/httpSecurity";
import {
  TabularWorkerPool,
  readWorkerPoolConfig,
} from "./lib/tabularJobs";
import { createServerSupabase } from "./lib/supabase";

const app = express();
const PORT = process.env.PORT ?? 3001;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? "2mb";

const allowedOrigins = parseAllowedOrigins();
app.disable("x-powered-by");
app.use(securityHeaders());
app.use(
  cors({
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, allowedOrigins)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(requestErrorHandler());

// bug-007 — In-process worker pool for tabular generate jobs. Started
// after listen() so the HTTP server is ready when the first item gets
// claimed; on SIGTERM/SIGINT we stop accepting new claims and let the
// in-flight items run their lease out (the next worker that comes up
// after restart will reclaim them via the SKIP LOCKED query).
const tabularPool = new TabularWorkerPool({
  ...readWorkerPoolConfig(),
  dbFactory: () => createServerSupabase(),
});

const server = app.listen(PORT, () => {
  console.log(`Olava backend running on port ${PORT}`);
  tabularPool.start();
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] graceful shutdown — stopping worker pool…`);
  await tabularPool.stop();
  server.close(() => process.exit(0));
  // Hard-exit timeout so a hung connection doesn't block deploy. Items
  // mid-flight get reclaimed by the next worker after lease expiry.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
