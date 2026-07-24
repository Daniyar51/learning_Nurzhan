// Argon2id через WebAssembly (hash-wasm): нет нативного бинарника, поэтому
// одинаково работает в Docker, на serverless-платформах и в тестах.
// Формат хэша — стандартный PHC (`$argon2id$v=19$m=...`), совместим с
// хэшами, созданными нативной реализацией.
import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

// Параметры OWASP: память 19 MiB, t=2, p=1.
const OPTS = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    ...OPTS,
    outputType: "encoded",
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}
