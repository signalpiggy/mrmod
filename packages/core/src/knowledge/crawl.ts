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

/** Freshdesk paths, optionally behind a locale prefix like /en/ or /pt-BR/ (but not /chains/support on nu.fi). */
const FRESHDESK_ANY = /^\/([a-z]{2}(-[a-z]{2,4})?\/)?support(\/|$)/i;
const FRESHDESK = /^\/([a-z]{2}(-[a-z]{2,4})?\/)?support\/solutions(\/|$)/i;
const FRESHDESK_ARTICLE = /\/support\/solutions\/articles\/\d+/;
const SKIP_PATH = /^\/(_next|cdn-cgi|api|static|assets)\//;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|css|js|mjs|json|xml|txt|mp4|webm|woff2?)$/i;

/**
 * Pages we follow on the allowed hosts. Freshdesk help-centre paths (/support/...) are limited to the
 * solutions section (no login, tickets or search); any other site (e.g. nu.fi) is followed everywhere
 * except build assets and files.
 */
export function isCrawlable(u: URL, allowedHosts: string[]): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (!allowedHosts.includes(u.hostname)) return false;
  if (SKIP_PATH.test(u.pathname) || SKIP_EXT.test(u.pathname)) return false;
  if (FRESHDESK_ANY.test(u.pathname)) return FRESHDESK.test(u.pathname);
  return true;
}

/** Pages whose text goes into the knowledge base: Freshdesk articles, and every normal page elsewhere. */
export function isArticle(u: URL): boolean {
  if (FRESHDESK_ARTICLE.test(u.pathname)) return true;
  return !FRESHDESK_ANY.test(u.pathname);
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

const BLOCK_TAGS = "p,h1,h2,h3,h4,h5,h6,li,tr,dt,dd,div,section,article,br,blockquote,pre";

export function extractArticle(html: string, url: string): { title: string; text: string; links: string[] } {
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll("a[href]")].map((a) => (a as unknown as { getAttribute(n: string): string }).getAttribute("href"));
  const titleEl = document.querySelector("h1, h2.heading, .article-title");
  const title = titleEl?.textContent?.trim().replace(/\s+/g, " ") || document.title?.trim() || url;
  // Freshdesk article body, else the page's main content without site chrome.
  let body = document.querySelector(".article-body, #article-body");
  if (!body) {
    for (const el of [...document.querySelectorAll("script, style, noscript, template, svg, nav, header, footer, form, iframe")]) el.remove();
    body = document.querySelector("main, article, [role=main]") ?? document.body;
  }
  let text = "";
  if (body) {
    // textContent glues adjacent blocks and table cells together ("BitcoinEthereum"), so add breaks first.
    for (const el of [...body.querySelectorAll("td, th")]) el.appendChild(document.createTextNode(" | "));
    for (const el of [...body.querySelectorAll(BLOCK_TAGS)]) el.appendChild(document.createTextNode("\n"));
    text = body.textContent ?? "";
  }
  text = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\| ?\n/g, "\n")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
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
    if (isArticle(parsed) && page.text.length > 120) {
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
