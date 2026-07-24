// Хэширование паролей: формат PHC argon2id, соль уникальна, проверка верна,
// совместимость с хэшами, созданными нативной реализацией argon2.
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";

describe("hashPassword", () => {
  it("возвращает PHC-строку argon2id с параметрами OWASP", async () => {
    const hash = await hashPassword("Bilim2026!");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("одинаковые пароли дают разные хэши (случайная соль)", async () => {
    const [a, b] = await Promise.all([hashPassword("qwerty123"), hashPassword("qwerty123")]);
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("принимает верный пароль и отклоняет неверный", async () => {
    const hash = await hashPassword("Купа1рос!");
    expect(await verifyPassword(hash, "Купа1рос!")).toBe(true);
    expect(await verifyPassword(hash, "купа1рос!")).toBe(false);
  });

  it("проверяет хэш, созданный нативным argon2 (совместимость при миграции)", async () => {
    // Реальный хэш пароля "Bilim2026!", созданный пакетом argon2 (node) до
    // перехода на WASM: параметры в другом порядке (m,p,t). Уже выданные
    // пароли обязаны продолжать работать.
    const native =
      "$argon2id$v=19$m=19456,p=1,t=2$8PALF23oS1rF31EWh1a9Ig$JGXNSPoriB5JCa9eK6K3wEgN5wFjjwCHpKwu0f7Mi7A";
    expect(await verifyPassword(native, "Bilim2026!")).toBe(true);
    expect(await verifyPassword(native, "Bilim2026?")).toBe(false);
  });

  it("повреждённый хэш не роняет проверку", async () => {
    expect(await verifyPassword("не-хэш", "Bilim2026!")).toBe(false);
    expect(await verifyPassword("", "Bilim2026!")).toBe(false);
  });
});
