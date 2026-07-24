// Геймификация (§10): идемпотентное начисление, уровни, серия дней, бейджи,
// пересчёт рейтинга челленджа с детерминированным tie-break.

import { prisma } from "./db";
import { enqueue } from "./jobs";

export const LEVELS = [0, 100, 250, 500, 1000, 2000, 4000, 8000] as const;

export function levelForPoints(total: number): number {
  let lvl = 1;
  for (let i = 0; i < LEVELS.length; i++) if (total >= LEVELS[i]) lvl = i + 1;
  return lvl;
}

/** Начисление с защитой от повтора (unique idempotencyKey). Возвращает false, если уже было. */
export async function awardPoints(params: {
  orgId: string;
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  comment?: string;
  createdById?: string;
}): Promise<boolean> {
  try {
    await prisma.pointTransaction.create({
      data: {
        organizationId: params.orgId,
        userId: params.userId,
        amount: params.amount,
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
        refType: params.refType ?? "",
        refId: params.refId ?? "",
        comment: params.comment ?? "",
        createdById: params.createdById ?? null,
      },
    });
    await maybeAwardBadges(params.orgId, params.userId);
    return true;
  } catch (e) {
    if (typeof e === "object" && e && "code" in e && (e as { code: string }).code === "P2002") return false;
    throw e;
  }
}

export async function pointsTotal(userId: string): Promise<number> {
  const agg = await prisma.pointTransaction.aggregate({ where: { userId }, _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}

/** Серия дней с активностью (по транзакциям баллов), TZ Asia/Almaty. */
export async function streakDays(userId: string): Promise<number> {
  const rows = await prisma.pointTransaction.findMany({
    where: { userId },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const days = new Set(
    rows.map((r) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(r.createdAt))
  );
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(d);
  let streak = 0;
  const cursor = new Date();
  if (!days.has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1); // сегодня активности может ещё не быть
  while (days.has(fmt(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ——— Бейджи ———

const BADGE_RULES: { slug: string; check: (ctx: { total: number; passedTests: number; streak: number }) => boolean }[] = [
  { slug: "first-steps", check: (c) => c.passedTests >= 1 },
  { slug: "points-100", check: (c) => c.total >= 100 },
  { slug: "points-500", check: (c) => c.total >= 500 },
  { slug: "streak-7", check: (c) => c.streak >= 7 },
];

export async function maybeAwardBadges(orgId: string, userId: string): Promise<void> {
  const [total, passedTests, streak] = await Promise.all([
    pointsTotal(userId),
    prisma.testAttempt.count({ where: { userId, passed: true } }),
    streakDays(userId),
  ]);
  const ctx = { total, passedTests, streak };
  for (const rule of BADGE_RULES) {
    if (!rule.check(ctx)) continue;
    const badge = await prisma.badge.findUnique({
      where: { organizationId_slug: { organizationId: orgId, slug: rule.slug } },
    });
    if (!badge) continue;
    await prisma.userBadge
      .create({ data: { userId, badgeId: badge.id } })
      .catch(() => {}); // уже выдан
  }
}

// ——— Рейтинг челленджа ———

/**
 * Пересчёт totalPoints/rank. Tie-break (детерминированный, задокументирован):
 * 1) больше баллов; 2) раньше завершил все активности (finishedAt);
 * 3) раньше присоединился (joinedAt).
 */
export async function recomputeChallengeLeaderboard(challengeId: string): Promise<void> {
  const enrollments = await prisma.challengeEnrollment.findMany({
    where: { challengeId },
    include: { user: { select: { id: true } } },
  });
  const activities = await prisma.challengeActivity.findMany({ where: { challengeId } });
  const testIds = activities.map((a) => a.testId);
  const weights = new Map(activities.map((a) => [a.testId, a.pointsWeight]));

  for (const en of enrollments) {
    const attempts = await prisma.testAttempt.findMany({
      where: { userId: en.userId, challengeId, testId: { in: testIds }, status: "GRADED" },
      select: { testId: true, totalScore: true, maxScore: true, submittedAt: true },
    });
    // лучший результат по каждому тесту
    const best = new Map<string, { pct: number; submittedAt: Date | null }>();
    for (const at of attempts) {
      const pct = at.maxScore > 0 ? ((at.totalScore ?? 0) / at.maxScore) * 100 : 0;
      const cur = best.get(at.testId);
      if (!cur || pct > cur.pct) best.set(at.testId, { pct, submittedAt: at.submittedAt });
    }
    let points = 0;
    let lastFinish: Date | null = null;
    for (const [testId, b] of best) {
      points += b.pct * (weights.get(testId) ?? 1);
      if (b.submittedAt && (!lastFinish || b.submittedAt > lastFinish)) lastFinish = b.submittedAt;
    }
    const finishedAll = best.size === testIds.length && testIds.length > 0;
    await prisma.challengeEnrollment.update({
      where: { id: en.id },
      data: {
        totalPoints: Math.round(points * 100) / 100,
        finishedAt: finishedAll ? lastFinish : null,
      },
    });
  }

  const ranked = await prisma.challengeEnrollment.findMany({
    where: { challengeId },
    orderBy: [{ totalPoints: "desc" }, { finishedAt: { sort: "asc", nulls: "last" } }, { joinedAt: "asc" }],
  });
  for (let i = 0; i < ranked.length; i++) {
    await prisma.challengeEnrollment.update({ where: { id: ranked[i].id }, data: { rank: i + 1 } });
  }
}

/**
 * На обычном сервере пересчёт уходит в фоновую очередь (D-002).
 * На serverless-платформах процесс может быть остановлен сразу после ответа,
 * поэтому там пересчёт выполняется в запросе — иначе рейтинг молча отстаёт.
 * Ночной cron (/api/cron/leaderboard) страхует оба режима.
 */
const INLINE_JOBS = !!process.env.VERCEL || process.env.JOBS_INLINE === "1";

export async function enqueueLeaderboardRecompute(challengeId: string): Promise<void> {
  if (INLINE_JOBS) {
    await recomputeChallengeLeaderboard(challengeId);
    return;
  }
  enqueue(`leaderboard:${challengeId}`, () => recomputeChallengeLeaderboard(challengeId));
}
