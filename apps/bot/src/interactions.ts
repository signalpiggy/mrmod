import {
  answerQuestion,
  audit,
  saveSetting,
  crawlKnowledgeBase,
  getDecision,
  getDecisionByMessage,
  insertDecision,
  labelDecision,
  runPipeline,
  statsSince,
} from "@mrmod/core";
import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { log } from "./log.js";
import { BUTTON_PERMS, toInput } from "./moderation.js";
import type { BotState } from "./state.js";

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask a question about NuFi; answered from the NuFi help centre")
    .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("modbot")
    .setDescription("Moderation bot status and admin tools")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("status").setDescription("Mode, rules and today's numbers"))
    .addSubcommand((s) => s.setName("recrawl").setDescription("Re-read the support.nu.fi help centre now"))
    .addSubcommand((s) =>
      s
        .setName("channels")
        .setDescription("Set the mod-log and alert channels and the role to ping")
        .addChannelOption((o) => o.setName("modlog").setDescription("Where every decision is logged").setRequired(true))
        .addChannelOption((o) => o.setName("alerts").setDescription("Where admins are pinged (defaults to modlog)"))
        .addRoleOption((o) => o.setName("ping_role").setDescription("Role pinged for alerts")),
    ),
  new ContextMenuCommandBuilder()
    .setName("Report to mod bot")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
].map((c) => c.toJSON());

const ephemeral = MessageFlags.Ephemeral;
let lastAsk = new Map<string, number[]>();

function rateLimited(userId: string, perMinute = 5): boolean {
  const now = Date.now();
  const hits = (lastAsk.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (lastAsk.size > 10_000) lastAsk = new Map();
  if (hits.length >= perMinute) return true;
  hits.push(now);
  lastAsk.set(userId, hits);
  return false;
}

export async function handleInteraction(state: BotState, i: Interaction) {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === "ask") return await ask(state, i);
      if (i.commandName === "modbot") return await modbot(state, i);
    }
    if (i.isMessageContextMenuCommand() && i.commandName === "Report to mod bot") return await report(state, i);
    if (i.isButton()) return await button(state, i);
  } catch (err) {
    log.error("interaction failed", err);
    if (i.isRepliable()) {
      const payload = { content: "Something went wrong; it has been logged.", flags: ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
      else await i.reply(payload).catch(() => {});
    }
  }
}

export function formatAnswer(a: { answerable: boolean; text: string; sources: { url: string; title: string }[] }): string {
  let out = a.text.slice(0, 1700);
  if (a.sources.length) out += "\n\n" + a.sources.map((s, n) => `[${n + 1}] [${s.title}](<${s.url}>)`).join("\n");
  out += "\n-# Answered from the NuFi help centre. NuFi staff will never DM you first or ask for your recovery phrase.";
  return out;
}

async function ask(state: BotState, i: ChatInputCommandInteraction) {
  if (rateLimited(i.user.id)) return i.reply({ content: "You're asking quickly; try again in a minute.", flags: ephemeral });
  const q = i.options.getString("question", true);
  await i.deferReply();
  const a = await answerQuestion(state.db, state.settings, q, { userId: i.user.id, channelId: i.channelId });
  await i.editReply({ content: formatAnswer(a), allowedMentions: { parse: [] } });
}

export async function answerMention(state: BotState, message: Message<true>) {
  const s = state.settings;
  if (s.qaChannelIds.length && !s.qaChannelIds.includes(message.channelId)) return;
  if (rateLimited(message.author.id)) return;
  const q = message.content.replace(/<@!?\d+>/g, "").trim();
  if (q.length < 3) return;
  await message.channel.sendTyping().catch(() => {});
  const a = await answerQuestion(state.db, s, q, { userId: message.author.id, channelId: message.channelId });
  await message.reply({ content: formatAnswer(a), allowedMentions: { parse: [], repliedUser: true } });
}

async function modbot(state: BotState, i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  if (sub === "status") {
    const since = new Date(Date.now() - 86_400_000);
    const st = await statsSince(state.db, since);
    const enforced = state.rules.filter((r) => r.mode === "enforce").map((r) => r.id);
    const embed = new EmbedBuilder()
      .setTitle("Mod bot status")
      .addFields(
        { name: "Global mode", value: state.settings.globalMode, inline: true },
        { name: "Judge model", value: state.settings.judgeModel, inline: true },
        { name: "Rules in enforce", value: state.settings.globalMode === "shadow" ? "none (global shadow)" : enforced.join(", ") || "none" },
        { name: "Last 24h", value: `${st.total} logged · ${st.judged} judged · ${st.matched} matched a rule · ${st.inputTokens + st.outputTokens} tokens` },
        { name: "Mod log", value: state.settings.modlogChannelId ? `<#${state.settings.modlogChannelId}>` : "not set: run /modbot channels", inline: true },
        { name: "Alerts", value: state.settings.alertChannelId ? `<#${state.settings.alertChannelId}>` : "same as mod log", inline: true },
      );
    return i.reply({ embeds: [embed], flags: ephemeral });
  }
  if (sub === "channels") {
    const modlog = i.options.getChannel("modlog", true);
    const alerts = i.options.getChannel("alerts");
    const role = i.options.getRole("ping_role");
    await saveSetting(state.db, "modlogChannelId", modlog.id, i.user.id, i.user.tag);
    await saveSetting(state.db, "alertChannelId", alerts?.id ?? null, i.user.id, i.user.tag);
    await saveSetting(state.db, "alertRoleId", role?.id ?? null, i.user.id, i.user.tag);
    await state.reload();
    return i.reply({ content: `Mod log: <#${modlog.id}> · alerts: ${alerts ? `<#${alerts.id}>` : "mod log"} · ping: ${role ? `<@&${role.id}>` : "nobody"}`, flags: ephemeral, allowedMentions: { parse: [] } });
  }
  if (sub === "recrawl") {
    await i.reply({ content: "Re-reading support.nu.fi; this takes a few minutes.", flags: ephemeral });
    const r = await crawlKnowledgeBase(state.db, state.settings, log.info);
    await audit(state.db, i.user.id, i.user.tag, "kb.recrawl", undefined, r);
    return i.followUp({ content: `Done: ${r.articles} articles, ${r.updated} updated, ${r.removed} removed, ${r.errors.length} errors.`, flags: ephemeral });
  }
}

async function report(state: BotState, i: MessageContextMenuCommandInteraction) {
  const message = i.targetMessage;
  if (!message.inGuild()) return i.reply({ content: "Only works in the server.", flags: ephemeral });
  await i.deferReply({ flags: ephemeral });
  let row = await getDecisionByMessage(state.db, message.id);
  if (!row) {
    const d = await runPipeline(await toInput(message), {
      settings: { ...state.settings, judgeAll: true },
      rules: state.rules,
      duplicates: state.duplicates,
      verdicts: state.verdicts,
    });
    if (d) await insertDecision(state.db, d, [], null);
    row = await getDecisionByMessage(state.db, message.id);
  }
  if (!row) return i.editReply("Couldn't record that message (bot or exempt author).");
  await labelDecision(state.db, row.id, row.ruleId ? "correct" : "missed", i.user.id, i.user.tag);
  await i.editReply(`Recorded as ${row.ruleId ? "a correct catch" : "a miss"} (#${row.id}). Thanks, this improves the rules.`);
}

async function button(state: BotState, i: ButtonInteraction) {
  const [kind, ...rest] = i.customId.split(":");
  const perms = i.memberPermissions;
  if (kind === "lbl") {
    if (!perms?.has(BUTTON_PERMS.label)) return i.reply({ content: "You need Manage Messages to review.", flags: ephemeral });
    const [which, idStr] = rest;
    const id = Number(idStr);
    const row = await getDecision(state.db, id);
    if (!row) return i.reply({ content: "Decision not found.", flags: ephemeral });
    const label = which === "correct" ? "correct" : row.ruleId ? "wrong" : "missed";
    await labelDecision(state.db, id, label, i.user.id, i.user.tag);
    return i.update({ content: `Reviewed by <@${i.user.id}>: **${label}**`, components: [], allowedMentions: { parse: [] } });
  }
  if (kind === "act") {
    const [action, ...args] = rest;
    const need = BUTTON_PERMS[action as keyof typeof BUTTON_PERMS];
    if (!need || !perms?.has(need)) return i.reply({ content: "You don't have permission for that.", flags: ephemeral });
    const guild = i.guild!;
    let done = "";
    if (action === "ban") {
      await guild.members.ban(args[0]!, { reason: `mrmod alert #${args[1]} by ${i.user.tag}`, deleteMessageSeconds: 86_400 });
      done = `banned <@${args[0]}>`;
    } else if (action === "timeout") {
      const m = await guild.members.fetch(args[0]!);
      await m.timeout(86_400_000, `mrmod alert #${args[1]} by ${i.user.tag}`);
      done = `timed out <@${args[0]}> for 24h`;
    } else if (action === "delete") {
      const ch = await guild.channels.fetch(args[0]!);
      if (ch?.isTextBased()) await ch.messages.delete(args[1]!).catch(() => {});
      done = "deleted the message";
    } else if (action === "dismiss") {
      done = "dismissed";
    }
    await audit(state.db, i.user.id, i.user.tag, `alert.${action}`, args.at(-1), { args });
    return i.update({ content: `<@${i.user.id}> ${done}.`, components: [], allowedMentions: { parse: [] } });
  }
}
