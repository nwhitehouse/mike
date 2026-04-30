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

const app = express();
const PORT = process.env.PORT ?? 3001;

// Origin allowlist:
//  - FRONTEND_URL (the production domain — Vercel custom domain or *.vercel.app)
//  - Any *.vercel.app subdomain (so Vercel preview deploys per PR also work)
//  - Localhost on the dev port (and 3000 as a fallback for npm dev defaults)
// Origin function gives us multi-origin support without rewriting on each
// new preview URL.
const allowedOrigins = new Set<string>([
  process.env.FRONTEND_URL ?? "http://localhost:9000",
  "http://localhost:9000",
  "http://localhost:3000",
]);
app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server has no Origin header — allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      // Vercel preview URLs: finch-<branch>-<hash>.vercel.app
      try {
        const host = new URL(origin).hostname;
        if (host.endsWith(".vercel.app")) return cb(null, true);
      } catch {
        /* fall through to deny */
      }
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));

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

app.listen(PORT, () => {
  console.log(`Finch backend running on port ${PORT}`);
});
