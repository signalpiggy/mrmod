import {
  insertDecision,
  runPipeline,
  setModlogMessage,
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
