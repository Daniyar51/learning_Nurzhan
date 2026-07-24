// Страховочный пересчёт рейтингов активных челленджей (Vercel Cron, раз в сутки).
// Основной пересчёт идёт в момент оценки попытки; этот маршрут закрывает случаи,
// когда фоновая задача не доработала (перезапуск инстанса, обрыв соединения).
import { prisma } from "@/lib/db";
import { handler, ok, err } from "@/lib/http";
import { recomputeChallengeLeaderboard } from "@/lib/points";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handler(async (req: Request) => {
  // Vercel Cron присылает Authorization: Bearer $CRON_SECRET.
  // Без заданного секрета маршрут закрыт полностью — публично дёргать нельзя.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) throw err.forbidden();

  const now = new Date();
  const active = await prisma.challenge.findMany({
    where: {
      deletedAt: null,
      status: "PUBLISHED",
      startAt: { lte: now },
      endAt: { gte: new Date(now.getTime() - 24 * 3600_000) }, // +сутки после финиша
    },
    select: { id: true },
  });

  let ok_ = 0;
  for (const c of active) {
    try {
      await recomputeChallengeLeaderboard(c.id);
      ok_++;
    } catch (e) {
      console.error("[cron:leaderboard]", c.id, e);
    }
  }
  return ok({ challenges: active.length, recomputed: ok_ });
});
