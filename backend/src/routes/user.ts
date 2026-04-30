import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const userRouter = Router();

// GET /user/server-keys
// Reports which provider credentials are configured server-side via .env, so
// the frontend can mark a model "available" without requiring a per-user key.
// Returns booleans only — no secret material. Values still matching the
// `your-*-key` placeholders from .env.example are treated as unset.
function envKeySet(name: string): boolean {
  const v = process.env[name]?.trim();
  if (!v) return false;
  return !/^your-.*-key$/.test(v);
}
userRouter.get("/server-keys", (_req, res) => {
  res.json({
    claude: envKeySet("ANTHROPIC_API_KEY"),
    gemini: envKeySet("GEMINI_API_KEY"),
    olava: envKeySet("OLAVA_BASE_URL") && envKeySet("OLAVA_AUTH_TOKEN"),
  });
});

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
