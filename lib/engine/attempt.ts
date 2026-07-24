// Жизненный цикл попытки (§8): старт (снимок раскладки: секции, случайные
// выборки из банка, перемешивание, серверный дедлайн) → автосохранение ответов
// (история изменений) → идемпотентное транзакционное завершение → ручная
// проверка → итог/баллы/диагностика.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { err } from "@/lib/http";
import { gradeAnswer } from "./grade";
import { MANUAL_TYPES, parseResponse, type LayoutItem, type QuestionTypeKey } from "./types";
import { awardPoints, enqueueLeaderboardRecompute } from "@/lib/points";
import { notify } from "@/lib/notify";

const GRACE_MS = 10_000;

// Детерминированное перемешивание (seed = attempt id) — воспроизводимо при resume.
function seededShuffle<T>(arr: T[], seed: string): T[] {
  const out = [...arr];
  let h = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) % 2 ** 31;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function assertTestAccessible(testId: string, userId: string | null) {
  const test = await prisma.test.findFirst({
    where: { id: testId, deletedAt: null },
    include: { cohortAccess: true },
  });
  if (!test || test.status !== "PUBLISHED") throw err.notFound();
  const now = new Date();
  if (test.availableFrom && now < test.availableFrom) throw err.forbidden();
  if (test.availableTo && now > test.availableTo) throw err.forbidden();
  if (test.cohortAccess.length > 0) {
    if (!userId) throw err.forbidden();
    const member = await prisma.cohortMember.findFirst({
      where: { userId, cohortId: { in: test.cohortAccess.map((c) => c.cohortId) } },
    });
    if (!member) throw err.forbidden();
  }
  if (test.accessType === "PAID") {
    if (!userId) throw err.forbidden();
    const paid = await prisma.payment.findFirst({
      where: { userId, refType: "TEST", refId: testId, status: "PAID" },
    });
    if (!paid) throw err.forbidden();
  }
  return test;
}

/** Старт попытки: проверка лимитов, снимок раскладки, серверный дедлайн. */
export async function startAttempt(params: {
  testId: string;
  userId: string;
  accessCode?: string;
  challengeId?: string;
  preview?: boolean; // админ-предпросмотр: не учитывается в аналитике
}) {
  const test = await assertTestAccessible(params.testId, params.userId);
  if (test.accessCode && test.accessCode !== (params.accessCode ?? "") && !params.preview) {
    throw err.forbidden();
  }

  // незавершённая попытка → продолжаем её (resume)
  const open = await prisma.testAttempt.findFirst({
    where: { testId: test.id, userId: params.userId, status: "IN_PROGRESS" },
  });
  if (open) return open;

  const used = await prisma.testAttempt.count({ where: { testId: test.id, userId: params.userId } });
  if (!params.preview && used >= test.attemptsAllowed) throw err.conflict("attempts_exhausted");

  const sections = await prisma.testSection.findMany({
    where: { testId: test.id },
    orderBy: { sort: "asc" },
    include: { questions: { orderBy: { sort: "asc" }, include: { question: { include: { choices: true } } } } },
  });

  const attemptId = crypto.randomUUID();
  const layout: LayoutItem[] = [];

  for (const s of sections) {
    // явные вопросы секции
    let qs = s.questions
      .filter((tq) => tq.question.status === "PUBLISHED" && !tq.question.deletedAt)
      .map((tq) => ({ q: tq.question, points: tq.pointsOverride ?? tq.question.points }));

    // случайная выборка из банка по теме
    if (s.randomFromTopicId && s.randomCount && s.randomCount > 0) {
      const pool = await prisma.question.findMany({
        where: {
          topicId: s.randomFromTopicId,
          status: "PUBLISHED",
          deletedAt: null,
          ...(s.randomDifficulty ? { difficulty: s.randomDifficulty } : {}),
          id: { notIn: qs.map((x) => x.q.id) },
        },
        include: { choices: true },
      });
      const picked = seededShuffle(pool, attemptId + s.id).slice(0, s.randomCount);
      qs = qs.concat(picked.map((q) => ({ q, points: q.points })));
    }

    if (test.shuffleQuestions) qs = seededShuffle(qs, attemptId + s.id + "q");

    for (const { q, points } of qs) {
      const item: LayoutItem = {
        questionId: q.id,
        points,
        sectionKk: s.titleKk,
        sectionRu: s.titleRu,
      };
      if (["SINGLE_CHOICE", "MULTI_CHOICE"].includes(q.type)) {
        const ids = q.choices.sort((a, b) => a.sort - b.sort).map((c) => c.id);
        item.choiceOrder = test.shuffleChoices ? seededShuffle(ids, attemptId + q.id) : ids;
      }
      if (q.type === "ORDERING" || q.type === "MATCHING") {
        const cfg = q.config as { items?: unknown[]; pairs?: unknown[] };
        const n = (q.type === "ORDERING" ? cfg.items?.length : cfg.pairs?.length) ?? 0;
        item.presentOrder = seededShuffle([...Array(n).keys()], attemptId + q.id);
        if (q.type === "MATCHING") {
          item.presentOrderRight = seededShuffle([...Array(n).keys()], attemptId + q.id + "r");
        }
      }
      layout.push(item);
    }
  }

  if (layout.length === 0) throw err.conflict("empty_test");
  const maxScore = layout.reduce((s, l) => s + l.points, 0);

  return prisma.testAttempt.create({
    data: {
      id: attemptId,
      testId: test.id,
      userId: params.userId,
      attemptNo: used + 1,
      layout: layout as unknown as object,
      deadlineAt: test.timeLimitSec ? new Date(Date.now() + test.timeLimitSec * 1000) : null,
      maxScore,
      challengeId: params.challengeId ?? null,
      meta: params.preview ? { preview: true } : {},
    },
  });
}

async function loadOwnAttempt(attemptId: string, userId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, userId },
    include: { test: true },
  });
  if (!attempt) throw err.notFound();
  return attempt;
}

/** Автосохранение ответа (+история). Отклоняется после дедлайна. */
export async function saveAnswer(params: {
  attemptId: string;
  userId: string;
  questionId: string;
  response: unknown;
  flagged?: boolean;
}) {
  const attempt = await loadOwnAttempt(params.attemptId, params.userId);
  if (attempt.status !== "IN_PROGRESS") throw err.conflict("attempt_finished");
  if (attempt.deadlineAt && Date.now() > attempt.deadlineAt.getTime() + GRACE_MS) {
    throw err.conflict("time_over");
  }
  const layout = attempt.layout as unknown as LayoutItem[];
  if (!layout.some((l) => l.questionId === params.questionId)) throw err.notFound();

  const q = await prisma.question.findUnique({ where: { id: params.questionId } });
  if (!q) throw err.notFound();
  const parsed = params.response == null ? null : parseResponse(q.type as QuestionTypeKey, params.response);

  const existing = await prisma.testAnswer.findUnique({
    where: { attemptId_questionId: { attemptId: attempt.id, questionId: params.questionId } },
  });
  const historyEntry = { at: new Date().toISOString(), response: parsed };

  if (existing) {
    const history = [...((existing.history as unknown as object[]) ?? []), historyEntry].slice(-20);
    return prisma.testAnswer.update({
      where: { id: existing.id },
      data: {
        response: (parsed ?? {}) as object,
        flagged: params.flagged ?? existing.flagged,
        history: history as object,
        savedAt: new Date(),
      },
    });
  }
  return prisma.testAnswer.create({
    data: {
      attemptId: attempt.id,
      questionId: params.questionId,
      response: (parsed ?? {}) as object,
      flagged: params.flagged ?? false,
      history: [historyEntry] as unknown as object,
    },
  });
}

/** Аналитическое событие (переключение вкладки и т.п.). */
export async function trackAttemptEvent(attemptId: string, userId: string, event: string) {
  const attempt = await loadOwnAttempt(attemptId, userId);
  const meta = (attempt.meta as Record<string, number>) ?? {};
  meta[event] = (meta[event] ?? 0) + 1;
  await prisma.testAttempt.update({ where: { id: attempt.id }, data: { meta } });
}

/**
 * Завершение попытки: транзакционно и идемпотентно (статусный guard).
 * Объективные типы оцениваются автоматически; ESSAY/FILE_UPLOAD → очередь
 * ручной проверки. Начисление баллов челленджа — с idempotency-ключом.
 */
export async function finalizeAttempt(attemptId: string, userId: string) {
  const attempt = await loadOwnAttempt(attemptId, userId);

  // Идемпотентность: переводим IN_PROGRESS→SUBMITTED атомарно; второй вызов не пройдёт
  const claimed = await prisma.testAttempt.updateMany({
    where: { id: attempt.id, status: "IN_PROGRESS" },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  if (claimed.count === 0) {
    return prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }

  const layout = attempt.layout as unknown as LayoutItem[];
  const answers = await prisma.testAnswer.findMany({ where: { attemptId: attempt.id } });
  const answerByQ = new Map(answers.map((a) => [a.questionId, a]));
  const questions = await prisma.question.findMany({
    where: { id: { in: layout.map((l) => l.questionId) } },
    include: { choices: true },
  });
  const qById = new Map(questions.map((q) => [q.id, q]));

  let autoScore = 0;
  let manualCount = 0;

  await prisma.$transaction(async (tx) => {
    for (const item of layout) {
      const q = qById.get(item.questionId);
      if (!q) continue;
      const ans = answerByQ.get(item.questionId);
      const isManual = MANUAL_TYPES.includes(q.type as QuestionTypeKey);
      const hasResponse = !!ans && Object.keys((ans.response as object) ?? {}).length > 0;

      if (isManual) {
        if (hasResponse) {
          manualCount++;
          await tx.manualReview.upsert({
            where: { answerId: ans!.id },
            update: {},
            create: { answerId: ans!.id },
          });
        }
        continue;
      }
      const { score } = gradeAnswer(
        { type: q.type as QuestionTypeKey, points: item.points, config: q.config, choices: q.choices },
        hasResponse ? (ans!.response as object) : null
      );
      autoScore += score;
      if (ans) await tx.testAnswer.update({ where: { id: ans.id }, data: { autoScore: score } });
    }

    const isPreview = !!(attempt.meta as { preview?: boolean })?.preview;
    const done = manualCount === 0;
    const totalScore = done ? autoScore : null;
    const passed = done ? (attempt.maxScore > 0 ? (autoScore / attempt.maxScore) * 100 >= attempt.test.passPct : false) : null;

    await tx.testAttempt.update({
      where: { id: attempt.id },
      data: {
        autoScore,
        status: done ? "GRADED" : "SUBMITTED",
        totalScore,
        passed,
        ...(isPreview ? { meta: { ...(attempt.meta as object), preview: true } } : {}),
      },
    });
  });

  const fresh = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id }, include: { test: true } });
  const isPreview = !!(fresh.meta as { preview?: boolean })?.preview;

  if (!isPreview && fresh.status === "GRADED") {
    await onAttemptGraded(fresh.id);
  }
  return fresh;
}

/** Пост-обработка полностью оценённой попытки: баллы, челлендж, уведомление. */
export async function onAttemptGraded(attemptId: string) {
  const at = await prisma.testAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { test: true, user: { include: { memberships: true } } },
  });
  if ((at.meta as { preview?: boolean })?.preview) return;
  const orgId = at.user.memberships[0]?.organizationId ?? at.test.organizationId;
  const pct = at.maxScore > 0 ? ((at.totalScore ?? 0) / at.maxScore) * 100 : 0;

  // базовые баллы за пройденный тест (лучшая попытка учитывается идемпотентным ключом на тест)
  if (at.passed) {
    await awardPoints({
      orgId,
      userId: at.userId,
      amount: Math.round(pct),
      reason: "test_passed",
      refType: "TEST",
      refId: at.testId,
      idempotencyKey: `test:${at.testId}:user:${at.userId}`,
    });
  }
  if (at.challengeId) {
    await enqueueLeaderboardRecompute(at.challengeId);
  }
  await notify(at.userId, "attempt_graded", {
    testId: at.testId,
    attemptId: at.id,
    scorePct: Math.round(pct),
    passed: at.passed,
  });
}

/** Итог ручной проверки одного ответа. Когда всё проверено — финализируем попытку. */
export async function completeManualReview(params: {
  reviewId: string;
  reviewerId: string;
  score: number;
  comment: string;
}) {
  const review = await prisma.manualReview.findUnique({
    where: { id: params.reviewId },
    include: { answer: { include: { attempt: true } } },
  });
  if (!review) throw err.notFound();
  const attempt = review.answer.attempt;
  const layout = attempt.layout as unknown as LayoutItem[];
  const item = layout.find((l) => l.questionId === review.answer.questionId);
  const max = item?.points ?? 0;
  const score = Math.max(0, Math.min(params.score, max));

  await prisma.$transaction([
    prisma.manualReview.update({
      where: { id: review.id },
      data: { status: "DONE", reviewerId: params.reviewerId, score, comment: params.comment, reviewedAt: new Date() },
    }),
    prisma.testAnswer.update({
      where: { id: review.answerId },
      data: { manualScore: score, gradedById: params.reviewerId, comment: params.comment },
    }),
  ]);

  const pendingLeft = await prisma.manualReview.count({
    where: { status: "PENDING", answer: { attemptId: attempt.id } },
  });
  if (pendingLeft === 0 && attempt.status === "SUBMITTED") {
    const answers = await prisma.testAnswer.findMany({ where: { attemptId: attempt.id } });
    const manualScore = answers.reduce((s, a) => s + (a.manualScore ?? 0), 0);
    const totalScore = attempt.autoScore + manualScore;
    const passed = attempt.maxScore > 0 ? (totalScore / attempt.maxScore) * 100 >= (await prisma.test.findUniqueOrThrow({ where: { id: attempt.testId } })).passPct : false;
    await prisma.testAttempt.update({
      where: { id: attempt.id },
      data: { manualScore, totalScore, passed, status: "GRADED" },
    });
    await onAttemptGraded(attempt.id);
  }
}

/** Диагностический разбор по темам/целям (§9). */
export async function diagnosticsForAttempt(attemptId: string) {
  const attempt = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const layout = attempt.layout as unknown as LayoutItem[];
  const answers = await prisma.testAnswer.findMany({ where: { attemptId } });
  const answerByQ = new Map(answers.map((a) => [a.questionId, a]));
  const questions = await prisma.question.findMany({
    where: { id: { in: layout.map((l) => l.questionId) } },
    include: { topic: true, objective: true },
  });
  const qById = new Map(questions.map((q) => [q.id, q]));

  const byTopic = new Map<string, { nameKk: string; nameRu: string; score: number; max: number }>();
  const byObjective = new Map<string, { nameKk: string; nameRu: string; score: number; max: number }>();

  for (const item of layout) {
    const q = qById.get(item.questionId);
    if (!q) continue;
    const a = answerByQ.get(item.questionId);
    const score = (a?.manualScore ?? 0) + (a?.autoScore ?? 0);
    if (q.topic) {
      const cur = byTopic.get(q.topic.id) ?? { nameKk: q.topic.nameKk, nameRu: q.topic.nameRu, score: 0, max: 0 };
      cur.score += score;
      cur.max += item.points;
      byTopic.set(q.topic.id, cur);
    }
    if (q.objective) {
      const cur = byObjective.get(q.objective.id) ?? { nameKk: q.objective.nameKk, nameRu: q.objective.nameRu, score: 0, max: 0 };
      cur.score += score;
      cur.max += item.points;
      byObjective.set(q.objective.id, cur);
    }
  }

  const topics = [...byTopic.entries()].map(([id, v]) => ({
    id,
    ...v,
    pct: v.max > 0 ? Math.round((v.score / v.max) * 100) : 0,
  }));
  return {
    topics,
    objectives: [...byObjective.entries()].map(([id, v]) => ({
      id,
      ...v,
      pct: v.max > 0 ? Math.round((v.score / v.max) * 100) : 0,
    })),
    strengths: topics.filter((t) => t.pct >= 70),
    weaknesses: topics.filter((t) => t.pct < 50),
  };
}
