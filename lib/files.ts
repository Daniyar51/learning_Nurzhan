// FileStorage (§ D-003): подписанные URL (HMAC со сроком действия) + два
// драйвера хранения байтов, выбираемых через env FILE_STORAGE:
//   disk (по умолчанию) — файл в UPLOADS_DIR; для локальной разработки и Docker;
//   db                  — байты в колонке FileAsset.data; для платформ с
//                         файловой системой только для чтения (Vercel и т.п.).
// S3/MinIO подключается третьим драйвером без изменений вызывающего кода:
// наружу отдаётся всегда /api/files/[id], а не путь в хранилище.

import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db";
import { err } from "./http";

const SECRET = () => process.env.APP_SECRET ?? "dev-secret-change-me";
const DIR = () => path.join(process.cwd(), process.env.UPLOADS_DIR ?? "uploads");
const DRIVER = () => (process.env.FILE_STORAGE === "db" ? "db" : "disk");

export const ALLOWED_MIME: Record<string, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  doc: ["application/pdf"],
  audio: ["audio/mpeg", "audio/ogg", "audio/wav"],
  video: ["video/mp4", "video/webm"],
  archiveless: [], // произвольные типы запрещены
};
export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export function mimeAllowed(mime: string): boolean {
  return Object.values(ALLOWED_MIME).some((list) => list.includes(mime));
}

export async function saveFile(params: {
  ownerId: string | null;
  name: string;
  mime: string;
  bytes: Buffer;
  visibility?: "PUBLIC" | "PRIVATE";
}) {
  if (!mimeAllowed(params.mime)) throw err.badRequest("file_type_not_allowed");
  if (params.bytes.length > MAX_FILE_SIZE) throw err.badRequest("file_too_large");
  const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
  if (DRIVER() === "disk") {
    const full = path.join(DIR(), key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, params.bytes);
  }
  return prisma.fileAsset.create({
    data: {
      ownerId: params.ownerId,
      key,
      name: params.name.slice(0, 200),
      mime: params.mime,
      size: params.bytes.length,
      visibility: params.visibility ?? "PRIVATE",
      // Prisma ждёт Uint8Array<ArrayBuffer>; Buffer от Node типизирован шире
      data: DRIVER() === "db" ? new Uint8Array(params.bytes) : null,
    },
  });
}

export async function readFileBytes(key: string): Promise<Buffer> {
  if (DRIVER() === "db") {
    const row = await prisma.fileAsset.findUnique({ where: { key }, select: { data: true } });
    if (!row?.data) throw err.notFound();
    return Buffer.from(row.data);
  }
  return readFile(path.join(DIR(), key));
}

export async function deleteFileBytes(key: string): Promise<void> {
  if (DRIVER() === "db") {
    await prisma.fileAsset.updateMany({ where: { key }, data: { data: null } });
    return;
  }
  await unlink(path.join(DIR(), key)).catch(() => {});
}

export function signFileUrl(fileId: string, ttlSec = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", SECRET()).update(`${fileId}.${exp}`).digest("hex").slice(0, 32);
  return `/api/files/${fileId}?exp=${exp}&sig=${sig}`;
}

export function verifyFileSig(fileId: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expect = createHmac("sha256", SECRET()).update(`${fileId}.${exp}`).digest("hex").slice(0, 32);
  return expect === sig;
}
