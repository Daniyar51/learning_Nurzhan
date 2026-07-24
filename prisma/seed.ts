// Seed: организация, роли+права, seed-аккаунты (§4), настройки бренда,
// демо-контент (§19 — добавляется функцией seedDemoContent ниже).
// Запуск: pnpm db:seed (идемпотентен).
import "dotenv/config";
import { prisma } from "../lib/db";
import { hashPassword } from "../lib/auth/passwords";
import { PERMISSIONS, ROLE_PERMISSIONS, type RoleKey } from "../lib/rbac";
import { seedDemoContent } from "./seed-demo";

// Пароль разработки (см. README). Для публичного стенда его нужно заменить:
// SEED_PASSWORD=... pnpm db:seed — тогда документированный пароль наружу не попадёт.
const DEV_PASSWORD = process.env.SEED_PASSWORD || "Bilim2026!";

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Seed демо-аккаунтов запрещён в production. Прерывание.");
    process.exit(1);
  }
  // Наполнение публичного стенда допустимо, но только со своим паролем:
  // иначе на общедоступном сайте окажется пароль из README.
  const remote = !/localhost|127\.0\.0\.1|@db[:/]/.test(process.env.DATABASE_URL ?? "");
  if (remote && !process.env.SEED_PASSWORD) {
    console.error(
      "БД не локальная, а SEED_PASSWORD не задан.\n" +
        "Задайте свой пароль, чтобы демо-аккаунты не получили пароль из README:\n" +
        '  SEED_PASSWORD="ВашСложныйПароль" pnpm db:seed'
    );
    process.exit(1);
  }

  // — организация —
  const org = await prisma.organization.upsert({
    where: { slug: "default" },
    update: {},
    create: { slug: "default", name: "BilimHub" },
  });

  // — права и роли —
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { description }, create: { key, description } });
  }
  const roleIds: Record<RoleKey, string> = {} as never;
  for (const name of Object.keys(ROLE_PERMISSIONS) as RoleKey[]) {
    const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
    roleIds[name] = role.id;
    for (const perm of ROLE_PERMISSIONS[name]) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionKey: { roleId: role.id, permissionKey: perm } },
        update: {},
        create: { roleId: role.id, permissionKey: perm },
      });
    }
  }

  // — настройки сайта (бренд/лендинг) —
  await prisma.siteSettings.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      brandName: "BilimHub",
      primaryColor: "#6d28d9",
      accentColor: "#f59e0b",
      contacts: { phone: "+7 700 000 00 00", email: "info@bilimhub.local", address: { kk: "Алматы қ.", ru: "г. Алматы" } },
      landing: {},
    },
  });

  // — seed-аккаунты —
  const pass = await hashPassword(DEV_PASSWORD);

  async function upsertUser(params: {
    email?: string;
    phone?: string;
    roles: RoleKey[];
    firstName: string;
    lastName: string;
    withPassword?: boolean;
  }) {
    const { email, phone, roles, firstName, lastName, withPassword = true } = params;
    const where = email ? { email } : { phone: phone! };
    let user = await prisma.user.findUnique({ where: where as { email: string } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          phone,
          passwordHash: withPassword ? pass : null,
          profile: { create: { firstName, lastName } },
        },
      });
    }
    for (const r of roles) {
      await prisma.membership.upsert({
        where: { userId_organizationId_roleId: { userId: user.id, organizationId: org.id, roleId: roleIds[r] } },
        update: {},
        create: { userId: user.id, organizationId: org.id, roleId: roleIds[r] },
      });
    }
    return user;
  }

  const admin = await upsertUser({
    email: "admin@bilimhub.local",
    roles: ["SUPER_ADMIN", "ADMIN"],
    firstName: "Айгүл",
    lastName: "Админова",
  });
  const teacher = await upsertUser({
    email: "teacher@bilimhub.local",
    roles: ["TEACHER"],
    firstName: "Бекзат",
    lastName: "Оқытушыев",
  });
  const student = await upsertUser({
    email: "student@bilimhub.local",
    phone: "+77000000001",
    roles: ["STUDENT"],
    firstName: "Дәурен",
    lastName: "Оқушыұлы",
  });
  const parent = await upsertUser({
    email: "parent@bilimhub.local",
    roles: ["PARENT"],
    firstName: "Гүлнар",
    lastName: "Атааналиева",
  });

  await prisma.studentParent.upsert({
    where: { studentUserId_parentUserId: { studentUserId: student.id, parentUserId: parent.id } },
    update: {},
    create: { studentUserId: student.id, parentUserId: parent.id },
  });

  console.log("✓ Ядро: организация, роли, права, аккаунты");

  await seedDemoContent(prisma, { orgId: org.id, adminId: admin.id, teacherId: teacher.id, studentId: student.id });

  console.log("✓ Seed завершён");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
