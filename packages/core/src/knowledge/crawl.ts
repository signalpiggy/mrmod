import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";
import { eq, notInArray } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { embed } from "../ai.js";
import type { Settings } from "../config.js";
import type { DB } from "../db/client.js";
import { kbChunks, kbPages } from "../db/schema.js";

const UA = "mrmod-kb-crawler/0.1 (+discord moderation bot)";
const MAX_PAGES = 3000;

/** Freshdesk help-centre paths we follow; everything else (login, tickets, search) is ignored. */
export function isCrawlable(u: URL, allowedHosts: string[]): boolean {
  if (!allowedHosts.includes(u.hostname)) return false;
  return /^\/support\/solutions(\/|$)/.test(u.pathname) || /^\/[a-z-]+\/support\/solutions(\/|$)/.test(u.pathname);
}

export function isArticle(u: URL): boolean {
  return /\/support\/solutions\/articles\/\d+/.test(u.pathname);
}

export function normalizeUrl(href: string, base: string): URL | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, "");
    return u;
  } catch {
    return null;
  }
}

export function extractArticle(html: string, url: string): { title: string; text: string; links: string[] } {
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll("a[href]")].map((a) => (a as unknown as { getAttribute(n: string): string }).getAttribute("href"));
  const titleEl = document.querySelector("h1, h2.heading, .article-title");
  let title = titleEl?.textContent?.trim() || document.title || url;
  let text = "";
  const body = document.querySelector(".article-body, #article-body, article");
  if (body?.textContent?.trim()) {
    text = body.textContent;
  } else {
    const parsed = new Readability(document as unknown as Document).parse();
    text = parsed?.textContent ?? "";
    if (parsed?.title) title = parsed.title;
  }
  text = text.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return { title, text, links };
}

export function chunkText(title: string, text: string, maxChars = 1800): string[] {
  const paras = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `${title}\n\n${c}`);
}

export interface CrawlReport {
  visited: number;
  articles: number;
  updated: number;
  removed: number;
  errors: string[];
}

export async function crawlKnowledgeBase(db: DB, settings: Settings, log: (m: string) => void = () => {}): Promise<CrawlReport> {
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const s of settings.kbStartUrls) {
    const u = normalizeUrl(s, s);
    if (u) {
      queue.push(u.toString());
      seen.add(u.toString());
    }
  }
  const articleUrls: string[] = [];
  const report: CrawlReport = { visited: 0, articles: 0, updated: 0, removed: 0, errors: [] };

  while (queue.length && report.visited < MAX_PAGES) {
    const url = queue.shift()!;
    report.visited++;
    let html: string;
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
      if (!res.ok) {
        report.errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      report.errors.push(`${url}: ${String(err)}`);
      continue;
    }
    const page = extractArticle(html, url);
    for (const href of page.links) {
      const u = normalizeUrl(href, url);
      if (!u || !isCrawlable(u, settings.kbAllowedHosts)) continue;
      const key = u.toString();
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(key);
      }
    }
    const parsed = new URL(url);
    if (isArticle(parsed) && page.text.length > 40) {
      report.articles++;
      articleUrls.push(url);
      try {
        if (await upsertPage(db, settings, url, page.title, page.text)) report.updated++;
      } catch (err) {
        report.errors.push(`${url}: embed/store failed: ${String(err)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 250)); // be polite
  }

  // Only prune if the crawl clearly worked, so a site outage doesn't wipe the knowledge base.
  if (articleUrls.length >= 5) {
    const gone = await db.delete(kbPages).where(notInArray(kbPages.url, articleUrls)).returning({ url: kbPages.url });
    report.removed = gone.length;
  }
  log(`kb crawl: visited ${report.visited}, articles ${report.articles}, updated ${report.updated}, removed ${report.removed}, errors ${report.errors.length}`);
  return report;
}

async function upsertPage(db: DB, settings: Settings, url: string, title: string, text: string): Promise<boolean> {
  const hash = createHash("sha256").update(title + "\n" + text).digest("hex");
  const existing = await db.select({ h: kbPages.contentHash }).from(kbPages).where(eq(kbPages.url, url)).limit(1);
  if (existing[0]?.h === hash) return false;
  const chunks = chunkText(title, text);
  const vectors = await embed(chunks, settings);
  await db.transaction(async (tx) => {
    await tx
      .insert(kbPages)
      .values({ url, title, contentHash: hash, chunkCount: chunks.length, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: kbPages.url, set: { title, contentHash: hash, chunkCount: chunks.length, fetchedAt: new Date() } });
    await tx.delete(kbChunks).where(eq(kbChunks.url, url));
    if (chunks.length) {
      await tx.insert(kbChunks).values(chunks.map((content, i) => ({ url, title, ordinal: i, content, embedding: vectors[i]! })));
    }
  });
  return true;
}
