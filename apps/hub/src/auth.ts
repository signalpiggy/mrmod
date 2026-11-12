import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { deleteRuntime, getRuntime, setRuntime, type DB } from "@mrmod/core";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Admin {
  hash: string;
  salt: string;
  /** Bumped on password change; sessions carry it so old ones stop working. */
  version: number;
}

export async function getAdmin(db: DB): Promise<Admin | null> {
  return (await getRuntime<Admin>(db, "hub_admin"))?.value ?? null;
}

export async function setPassword(db: DB, password: string): Promise<Admin> {
  const prev = await getAdmin(db);
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  const admin: Admin = { hash: hash.toString("base64"), salt: salt.toString("base64"), version: (prev?.version ?? 0) + 1 };
  await setRuntime(db, "hub_admin", admin);
  await deleteRuntime(db, "hub_setup_code");
  return admin;
}

export async function checkPassword(admin: Admin, password: string): Promise<boolean> {
  const hash = await scrypt(password, Buffer.from(admin.salt, "base64"), 64);
  return timingSafeEqual(hash, Buffer.from(admin.hash, "base64"));
}

/** One-time code printed in the hub's logs until an admin password exists. */
export async function ensureSetupCode(db: DB): Promise<string | null> {
  if (await getAdmin(db)) return null;
  const existing = await getRuntime<{ code: string }>(db, "hub_setup_code");
  if (existing) return existing.value.code;
  const code = randomBytes(9).toString("base64url");
  await setRuntime(db, "hub_setup_code", { code });
  return code;
}

export async function checkSetupCode(db: DB, code: string): Promise<boolean> {
  const existing = await getRuntime<{ code: string }>(db, "hub_setup_code");
  if (!existing) return false;
  const a = Buffer.from(existing.value.code);
  const b = Buffer.from(code.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

const attempts = new Map<string, number[]>();
/** 10 attempts per 15 minutes per IP for login and setup. */
export function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10_000) attempts.clear();
  return list.length > 10;
}

export function validPassword(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  return null;
}
