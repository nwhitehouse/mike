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

app.listen(PORT, () => {
  console.log(`Olava backend running on port ${PORT}`);
});
