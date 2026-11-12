import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, sql as dsql } from "drizzle-orm";
import type { DB } from "./db/client.js";
import { runtime, secrets } from "./db/schema.js";

export const SECRET_KEYS = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "OPENAI_API_KEY"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export type SecretValues = Partial<Record<SecretKey, string>>;

function keyBytes(): Buffer {
  const k = process.env.SECRETS_KEY;
  if (!k || k.length < 32) throw new Error("SECRETS_KEY (32+ chars) must be set in the VPS .env");
  return createHash("sha256").update(k).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, body] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !body) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

export async function setSecret(db: DB, key: SecretKey, value: string, actor: string) {
  const v = value.trim();
  const row = { ciphertext: encrypt(v), hint: v.slice(-4), updatedAt: new Date(), updatedBy: actor };
  await db.insert(secrets).values({ key, ...row }).onConflictDoUpdate({ target: secrets.key, set: row });
  await db.execute(dsql`NOTIFY mrmod_secrets`);
}

export async function loadSecrets(db: DB): Promise<SecretValues> {
  const rows = await db.select().from(secrets);
  const out: SecretValues = {};
  for (const r of rows) if ((SECRET_KEYS as readonly string[]).includes(r.key)) out[r.key as SecretKey] = decrypt(r.ciphertext);
  return out;
}

/** Which secrets are set, with their last 4 characters; never the values. */
export async function secretStatus(db: DB): Promise<Record<SecretKey, { set: boolean; hint?: string; updatedAt?: Date }>> {
  const rows = await db.select({ key: secrets.key, hint: secrets.hint, updatedAt: secrets.updatedAt }).from(secrets);
  const out = {} as Record<SecretKey, { set: boolean; hint?: string; updatedAt?: Date }>;
  for (const k of SECRET_KEYS) {
    const r = rows.find((x) => x.key === k);
    out[k] = r ? { set: true, hint: r.hint, updatedAt: r.updatedAt } : { set: false };
  }
  return out;
}

export async function getRuntime<T>(db: DB, key: string): Promise<{ value: T; updatedAt: Date } | null> {
  const rows = await db.select().from(runtime).where(eq(runtime.key, key)).limit(1);
  return rows[0] ? { value: rows[0].value as T, updatedAt: rows[0].updatedAt } : null;
}

export async function setRuntime(db: DB, key: string, value: unknown) {
  await db
    .insert(runtime)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: runtime.key, set: { value, updatedAt: new Date() } });
}

export async function deleteRuntime(db: DB, key: string) {
  await db.delete(runtime).where(eq(runtime.key, key));
}
