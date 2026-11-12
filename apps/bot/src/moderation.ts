import {
  appendExecuted,
  audit,
  getDecision,
  answerQuestion,
  formatAnswer,
  insertDecision,
  knownSpecialCase,
  looksLikeQuestion,
  runPipeline,
  setModlogMessage,
  setSuggestedAnswer,
  specialReply,
  type BotCommand,
  type Decision,
  type MessageInput,
} from "@mrmod/core";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { log } from "./log.js";
import type { BotState } from "./state.js";

const COLORS = { enforce: 0xd9480f, shadow: 0x7048e8, allowed: 0x868e96, sample: 0x2f9e44 } as const;

export async function toInput(message: Message<true>): Promise<MessageInput> {
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  let recent: string[] = [];
  try {
    const prev = await message.channel.messages.fetch({ limit: 20, before: message.id });
    recent = [...prev.values()]
      .filter((m) => m.author.id === message.author.id && m.content)
      .slice(0, 3)
      .reverse()
      .map((m) => m.content);
  } catch {
    /* missing Read Message History in this channel */
  }
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    channelName: "name" in message.channel ? message.channel.name : null,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    authorIsBot: message.author.bot || message.webhookId !== null || message.system,
    content: message.content,
    accountCreatedAt: message.author.createdAt,
    memberJoinedAt: member?.joinedAt ?? null,
    memberRoleIds: member ? [...member.roles.cache.keys()] : [],
    mentionCount: message.mentions.users.size + message.mentions.roles.size,
    mentionsEveryone: message.mentions.everyone,
    recentAuthorMessages: recent,
  };
}

export async function handleMessage(state: BotState, message: Message<true>) {
  if (message.author.bot || message.webhookId) return;
  const input = await toInput(message);
  const decision = await runPipeline(input, {
    settings: state.settings,
    rules: state.rules,
    duplicates: state.duplicates,
    verdicts: state.verdicts,
    log: (m, e) => log.warn(m, e),
  });
  if (!decision || !decision.record) return;

  const executed: string[] = [];
  let execError: string | null = null;
  if (decision.match?.mode === "enforce") {
    try {
      await enforce(message, decision, executed);
    } catch (err) {
      execError = `enforce: ${String(err)}`;
      log.error("enforcement failed", err);
    }
  }

  const id = await insertDecision(state.db, decision, executed, execError);
  if (id === null) return; // already processed (e.g. reconnect replay)

  if (decision.match || decision.sampled) {
    await postModlog(message.client, state, id, decision, executed).catch((err) => log.error("modlog post failed", err));
  }
  if (decision.match?.action.alert && decision.match.mode === "enforce") {
    await postAlert(message.client, state, id, decision, executed).catch((err) => log.error("alert post failed", err));
  }
  const plan = replyPlan(state, message, decision);
  if (plan?.kind === "special") await suggestSpecial(state, id, decision, plan.caseName);
  else if (plan?.kind === "answer") await suggestAnswer(state, id, decision);
}

/**
 * Shadow replies, drafted for review in the hub and never posted: an admin special case wins,
 * then the ignore list (greetings, small talk), then help questions answered from the knowledge base.
 */
function replyPlan(state: BotState, message: Message<true>, d: Decision): { kind: "special"; caseName: string } | { kind: "answer" } | null {
  const s = state.settings;
  if (!s.suggestAnswers || d.match) return null;
  if (message.client.user && message.mentions.users.has(message.client.user.id)) return null; // answered for real
  const v = d.verdict;
  if (v && v.verdict !== "ok") return null;
  const caseName = knownSpecialCase(s.specialCases, v?.special_case);
  if (caseName) {
    log.info(`suggest #${d.input.messageId}: special case "${caseName}"`);
    return { kind: "special", caseName };
  }
  if (v?.ignore) {
    log.info(`suggest #${d.input.messageId}: ignored (matches ignore list)`);
    return null;
  }
  const yes = Boolean(v?.is_question) || looksLikeQuestion(d.input.content);
  log.info(`suggest #${d.input.messageId}: ${yes ? "drafting" : "not a question"} (judge is_question=${String(v?.is_question)})`);
  return yes ? { kind: "answer" } : null;
}

async function suggestSpecial(state: BotState, id: number, d: Decision, caseName: string) {
  try {
    const r = await specialReply(state.settings, d.input.content, caseName);
    log.info(`special case "${caseName}" for decision ${id}: ${r.action} (${r.latencyMs}ms)`);
    await setSuggestedAnswer(state.db, id, {
      kind: "special",
      specialCase: caseName,
      ignored: r.action === "ignore",
      answerable: true,
      text: r.action === "reply" ? formatAnswer({ answerable: true, text: r.text, sources: [] }, state.settings) : "",
      sources: [],
      model: r.model,
      latencyMs: r.latencyMs,
    });
  } catch (err) {
    log.warn("special-case reply failed", err);
    await setSuggestedAnswer(state.db, id, { kind: "special", specialCase: caseName, answerable: false, text: "", sources: [], error: String(err).slice(0, 300) }).catch(() => {});
  }
}

async function suggestAnswer(state: BotState, id: number, d: Decision) {
  try {
    const a = await answerQuestion(state.db, state.settings, d.input.content, { userId: d.input.authorId, channelId: d.input.channelId }, { log: false });
    log.info(`suggested answer for decision ${id}: ${a.answerable ? "answered" : "not in help centre"} (${a.sources.length} links, ${a.latencyMs}ms)`);
    await setSuggestedAnswer(state.db, id, {
      kind: "answer",
      answerable: a.answerable,
      text: formatAnswer(a, state.settings),
      sources: a.sources,
      model: a.model,
      latencyMs: a.latencyMs,
    });
  } catch (err) {
    log.warn("suggested answer failed", err);
    await setSuggestedAnswer(state.db, id, { answerable: false, text: "", sources: [], error: String(err).slice(0, 300) }).catch(() => {});
  }
}

async function enforce(message: Message<true>, d: Decision, executed: string[]) {
  const a = d.match!.action;
  if (a.delete && message.deletable) {
    await message.delete();
    executed.push("delete");
  }
  if (a.ban) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (member && !member.bannable) {
      executed.push("ban skipped (member above bot role)");
    } else {
      await message.guild.members.ban(message.author.id, {
        reason: `mrmod: ${d.match!.rule.name} (decision on message ${message.id})`,
        deleteMessageSeconds: 3600,
      });
      executed.push("ban");
      return; // a ban supersedes any timeout
    }
  }
  if (a.timeoutMinutes > 0) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id));
    if (member.moderatable) {
      await member.timeout(a.timeoutMinutes * 60_000, `mrmod: ${d.match!.rule.name}`);
      executed.push(`timeout ${a.timeoutMinutes}m`);
    } else {
      executed.push("timeout skipped (member above bot role)");
    }
  }
}

function describe(d: Decision): string {
  const v = d.verdict;
  if (!v) return d.match ? "Signals only" : "No verdict";
  return `**${v.verdict}** (${Math.round(v.confidence * 100)}%${v.source === "heuristic" ? ", pattern fallback" : ""})${v.rule_broken ? ` · ${v.rule_broken}` : ""}\n${v.reason}`;
}

function actionText(d: Decision, executed: string[]): string {
  if (!d.match) return d.sampled ? "Allowed (random sample for review)" : "Allowed";
  const a = d.match.action;
  const planned = [a.delete && "delete", a.timeoutMinutes && `timeout ${a.timeoutMinutes}m`, a.alert && "alert admins", a.ban && "ban", a.recommendBan && "recommend ban"]
    .filter(Boolean)
    .join(", ") || "log only";
  if (d.match.mode === "shadow") return `Would: ${planned}`;
  return `Did: ${executed.join(", ") || "nothing"} (planned: ${planned})`;
}

function buildEmbed(id: number, d: Decision, executed: string[]) {
  const mode = d.match ? (d.match.mode === "enforce" ? "enforce" : "shadow") : d.sampled ? "sample" : "allowed";
  const link = `https://discord.com/channels/${d.input.guildId}/${d.input.channelId}/${d.input.messageId}`;
  const s = d.signals;
  return new EmbedBuilder()
    .setColor(COLORS[mode])
    .setTitle(`#${id} · ${d.match ? d.match.rule.name : d.sampled ? "Sampled message" : "No rule matched"} · ${mode.toUpperCase()}`)
    .setDescription(`> ${d.input.content.slice(0, 900).replace(/\n/g, "\n> ")}`)
    .addFields(
      { name: "Author", value: `<@${d.input.authorId}> · ${d.input.authorTag}`, inline: true },
      { name: "Channel", value: `<#${d.input.channelId}> · [jump](${link})`, inline: true },
      { name: "Verdict", value: describe(d).slice(0, 1000) },
      { name: "Action", value: actionText(d, executed) },
      {
        name: "Signals",
        value:
          `risk ${d.riskScore} · account ${Math.round(s.accountAgeDays)}d · joined ${s.memberAgeDays === null ? "?" : Math.round(s.memberAgeDays) + "d"} · links ${s.linkCount}` +
          (s.domains.length ? ` (${s.domains.slice(0, 4).join(", ")})` : "") +
          (s.supportScam.matched ? ` · support-scam: ${s.supportScam.patterns.join("/")}` : "") +
          (s.duplicateChannels > 1 ? ` · same text in ${s.duplicateChannels} channels` : "") +
          (s.injectionAttempt ? " · prompt-injection attempt" : "") +
          (d.moderation?.flagged ? ` · moderation: ${Object.keys(d.moderation.scores).slice(0, 3).join(", ")}` : ""),
      },
    )
    .setTimestamp(new Date());
}

async function sendable(client: Client, channelId: string | null): Promise<TextBasedChannel | null> {
  if (!channelId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  return ch && ch.isTextBased() && "send" in ch ? ch : null;
}

async function postModlog(client: Client, state: BotState, id: number, d: Decision, executed: string[]) {
  const ch = await sendable(client, state.settings.modlogChannelId);
  if (!ch || !("send" in ch)) return;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lbl:correct:${id}`).setLabel(d.match ? "Correct" : "Fine to allow").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lbl:wrong:${id}`).setLabel(d.match ? "Wrong" : "Should have acted").setStyle(ButtonStyle.Danger),
  );
  const sent = await ch.send({ embeds: [buildEmbed(id, d, executed)], components: [row], allowedMentions: { parse: [] } });
  await setModlogMessage(state.db, id, sent.id);
}

async function postAlert(client: Client, state: BotState, id: number, d: Decision, executed: string[]) {
  const ch = await sendable(client, state.settings.alertChannelId ?? state.settings.modlogChannelId);
  if (!ch || !("send" in ch)) return;
  const buttons = [
    new ButtonBuilder().setCustomId(`act:timeout:${d.input.authorId}:${id}`).setLabel("Timeout 24h").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`act:dismiss:${id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
  ];
  if (!executed.includes("delete")) {
    buttons.unshift(
      new ButtonBuilder().setCustomId(`act:delete:${d.input.channelId}:${d.input.messageId}:${id}`).setLabel("Delete message").setStyle(ButtonStyle.Primary),
    );
  }
  if (d.match?.action.recommendBan && !executed.includes("ban")) {
    buttons.unshift(new ButtonBuilder().setCustomId(`act:ban:${d.input.authorId}:${id}`).setLabel("Ban").setStyle(ButtonStyle.Danger));
  }
  const role = state.settings.alertRoleId;
  await ch.send({
    content: role ? `<@&${role}> moderation alert` : "Moderation alert",
    embeds: [buildEmbed(id, d, executed)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
    allowedMentions: { roles: role ? [role] : [] },
  });
}

/** Permission each alert button needs. */
export const BUTTON_PERMS = {
  ban: PermissionFlagsBits.BanMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  delete: PermissionFlagsBits.ManageMessages,
  dismiss: PermissionFlagsBits.ManageMessages,
  label: PermissionFlagsBits.ManageMessages,
} as const;

/** Runs a ban an admin confirmed in the hub. The decision row (not the payload) says who and where. */
export async function runHubCommand(state: BotState, client: Client, guildId: string, cmd: BotCommand) {
  const d = await getDecision(state.db, cmd.decisionId);
  if (!d || d.guildId !== guildId) return log.warn(`hub ban: decision ${cmd.decisionId} not found for this server`);
  let result: string;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(d.authorId).catch(() => null);
    if (member && !member.bannable) {
      result = "ban failed from hub (member is above the bot's role)";
    } else {
      await guild.members.ban(d.authorId, {
        reason: `mrmod: banned from hub by ${cmd.actor} (message log #${d.id})`,
        deleteMessageSeconds: cmd.deleteMessageHours * 3600,
      });
      result = `ban (from hub by ${cmd.actor})`;
    }
  } catch (err) {
    result = `ban failed from hub: ${String(err).slice(0, 200)}`;
  }
  log.info(`hub ban of ${d.authorId}: ${result}`);
  await appendExecuted(state.db, d.id, result).catch((e) => log.error("hub ban: record failed", e));
  await audit(state.db, "bot", "bot", "member.ban", d.authorId, { decisionId: d.id, by: cmd.actor, result }).catch(() => {});
  const ch = await sendable(client, state.settings.modlogChannelId);
  if (ch && "send" in ch) {
    await ch
      .send({ content: `🔨 ${result.startsWith("ban (") ? "Banned" : "Couldn't ban"} <@${d.authorId}> (${d.authorTag ?? d.authorId}) from the hub, message log #${d.id}${result.startsWith("ban (") ? "" : `: ${result}`}`, allowedMentions: { parse: [] } })
      .catch(() => {});
  }
}
