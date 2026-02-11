import crypto from "node:crypto";

import { Bot, Keyboard } from "@maxhub/max-bot-api";

import type { AppConfig } from "./config";
import { runDeterministicDraw } from "./draw";
import { ContestRepository } from "./repository";
import type { Contest, Participant } from "./types";

type Ctx = any;
const COMMAND_COOLDOWN_MS = 1500;
const DRAW_LOCK_TTL_MS = 10_000;

function extractUser(ctx: Ctx): { id: string; username?: string } | null {
  const user = ctx?.user?.();
  if (!user) {
    return null;
  }

  const id = String(user.userId ?? user.id ?? "");
  if (!id) {
    return null;
  }

  return {
    id,
    username: user.username ?? user.name ?? undefined,
  };
}

function extractText(ctx: Ctx): string {
  const value =
    ctx?.message?.body?.text ??
    ctx?.message?.text ??
    ctx?.update?.message?.body?.text ??
    ctx?.update?.message?.text ??
    "";
  return typeof value === "string" ? value.trim() : "";
}

function parseCommandArgs(fullText: string): string {
  const parts = fullText.split(" ");
  parts.shift();
  return parts.join(" ").trim();
}

function isAdmin(config: AppConfig, userId: string): boolean {
  return config.adminUserIds.has(userId);
}

function parseRequiredChatIds(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function parseJoinArgs(raw: string): { contestId: string; referrerId?: string } {
  const [contestId = "", referrerIdRaw] = raw.split(/\s+/).filter(Boolean);
  const referrerId = referrerIdRaw?.trim();
  if (!referrerId) {
    return { contestId };
  }
  return { contestId, referrerId };
}

function parseStartJoinPayload(raw: string): { contestId: string; referrerId?: string } | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("join:")) {
    const parts = normalized.split(":");
    const contestId = (parts[1] ?? "").trim();
    const referrerId = (parts[2] ?? "").trim();
    if (!contestId) {
      return null;
    }
    if (!referrerId) {
      return { contestId };
    }
    return { contestId, referrerId };
  }

  return parseJoinArgs(normalized);
}

function toContestLine(contest: Contest): string {
  return `#${contest.id} | ${contest.title} | status=${contest.status} | participants=${contest.participants.length} | winners=${contest.maxWinners} | requiredChats=${contest.requiredChats.length}`;
}

function hitCooldown(
  state: Map<string, number>,
  key: string,
  cooldownMs: number,
): { ok: true } | { ok: false; waitSeconds: number } {
  const now = Date.now();
  const nextAllowedAt = state.get(key) ?? 0;
  if (nextAllowedAt > now) {
    return {
      ok: false,
      waitSeconds: Math.max(1, Math.ceil((nextAllowedAt - now) / 1000)),
    };
  }
  state.set(key, now + cooldownMs);
  return { ok: true };
}

async function findMissingRequiredChats(
  bot: Bot,
  requiredChats: number[],
  userId: number,
): Promise<number[]> {
  const checks = await Promise.all(
    requiredChats.map(async (chatId) => {
      try {
        const response = await bot.api.getChatMembers(chatId, { user_ids: [userId] });
        const members = Array.isArray((response as { members?: unknown[] }).members)
          ? ((response as { members?: unknown[] }).members ?? [])
          : [];

        const isMember = members.some((member) => {
          const candidateId = Number((member as { user_id?: number }).user_id);
          return Number.isFinite(candidateId) && candidateId === userId;
        });

        return isMember ? null : chatId;
      } catch {
        return chatId;
      }
    }),
  );

  return checks.filter((chatId): chatId is number => chatId !== null);
}

async function tryJoinContest(
  bot: Bot,
  config: AppConfig,
  repository: ContestRepository,
  contestId: string,
  user: { id: string; username?: string },
  referrerId?: string,
): Promise<{ ok: true; contest: Contest; already: boolean } | { ok: false; message: string }> {
  const contest = repository.get(contestId);
  if (!contest) {
    return { ok: false, message: "Конкурс не найден." };
  }
  if (contest.status !== "active") {
    return { ok: false, message: "Этот конкурс уже завершен." };
  }
  if (new Date(contest.endsAt).getTime() < Date.now()) {
    return { ok: false, message: "Срок участия в этом конкурсе уже вышел." };
  }

  if (contest.requiredChats.length > 0) {
    const userId = Number(user.id);
    if (!Number.isFinite(userId)) {
      return {
        ok: false,
        message: "Не удалось проверить подписки для участия. Попробуйте позже.",
      };
    }

    const missingChats = await findMissingRequiredChats(bot, contest.requiredChats, userId);
    if (missingChats.length > 0) {
      return {
        ok: false,
        message: `Для участия подпишитесь на обязательные чаты: ${missingChats.join(", ")}`,
      };
    }
  }

  const already = contest.participants.some((participant) => participant.userId === user.id);
  if (already) {
    return { ok: true, contest, already: true };
  }

  const updated = repository.update(contestId, (currentContest) => {
    const currentAlready = currentContest.participants.some((p) => p.userId === user.id);
    if (currentAlready) {
      return currentContest;
    }

    const participant: Participant = {
      userId: user.id,
      joinedAt: new Date().toISOString(),
      tickets: 1,
      ...(user.username ? { username: user.username } : {}),
    };

    const participants = [...currentContest.participants, participant];
    if (!referrerId || referrerId === user.id) {
      return { ...currentContest, participants };
    }

    const referrerIndex = participants.findIndex((p) => p.userId === referrerId);
    if (referrerIndex < 0) {
      return { ...currentContest, participants };
    }

    const referrer = participants[referrerIndex];
    if (!referrer) {
      return { ...currentContest, participants };
    }

    const currentBonus = Math.max(0, (referrer.tickets ?? 1) - 1);
    const bonusLeft = Math.max(0, config.referralMaxBonusTickets - currentBonus);
    const addBonus = Math.min(config.referralBonusTickets, bonusLeft);
    if (addBonus <= 0) {
      participants[participants.length - 1] = {
        ...participant,
        referredBy: referrerId,
      };
      return { ...currentContest, participants };
    }

    participants[referrerIndex] = {
      ...referrer,
      tickets: referrer.tickets + addBonus,
      referralsCount: (referrer.referralsCount ?? 0) + 1,
    };
    participants[participants.length - 1] = {
      ...participant,
      referredBy: referrerId,
    };

    return { ...currentContest, participants };
  });
  if (!updated) {
    return { ok: false, message: "Не удалось зарегистрировать участие." };
  }

  return { ok: true, contest: updated, already: false };
}

async function autoFinishExpiredContests(bot: Bot, repository: ContestRepository): Promise<void> {
  const now = Date.now();
  const expiredActive = repository
    .list()
    .filter((contest) => contest.status === "active" && new Date(contest.endsAt).getTime() <= now);

  for (const contest of expiredActive) {
    if (contest.participants.length === 0) {
      repository.update(contest.id, (prev) => ({ ...prev, status: "completed" }));
      continue;
    }

    const result = runDeterministicDraw(contest);
    const updated = repository.update(contest.id, (prev) => ({
      ...prev,
      status: "completed",
      winners: result.winners,
      drawSeed: result.seed,
    }));
    if (!updated) {
      continue;
    }

    await publishContestResults(bot, updated);
  }
}

async function publishContestResults(bot: Bot, contest: Contest): Promise<void> {
  if (!contest.publishChatId) {
    return;
  }

  await bot.api.sendMessageToChat(
    contest.publishChatId,
    [
      `Итоги конкурса: ${contest.title}`,
      `Победители: ${contest.winners.join(", ") || "нет победителей"}`,
      `Proof seed: ${contest.drawSeed ?? "-"}`,
    ].join("\n"),
  );
}

export function createContestBot(config: AppConfig): Bot {
  const repository = new ContestRepository(config.storagePath);
  const bot = new Bot(config.botToken);
  const commandCooldowns = new Map<string, number>();
  const drawLocks = new Map<string, number>();

  bot.api.setMyCommands([
    { name: "start", description: "Помощь и команды" },
    { name: "whoami", description: "Показать ваш user ID" },
    {
      name: "newcontest",
      description: "Создать конкурс: /newcontest Название | 2026-12-31T20:00:00Z | 3",
    },
    { name: "contests", description: "Показать конкурсы" },
    { name: "setrequired", description: "Обязательные чаты: /setrequired contest_id chat1,chat2" },
    { name: "myref", description: "Рефкод: /myref contest_id" },
    { name: "join", description: "Участвовать: /join contest_id" },
    { name: "publish", description: "Опубликовать конкурс: /publish contest_id chat_id [текст]" },
    { name: "draw", description: "Выбрать победителей: /draw contest_id" },
    { name: "reroll", description: "Перевыбрать победителей: /reroll contest_id" },
  ]);

  bot.command("start", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const startPayload = typeof ctx?.startPayload === "string" ? ctx.startPayload.trim() : "";
    const messagePayload = parseCommandArgs(extractText(ctx));
    const payloadRaw = startPayload || messagePayload;

    if (payloadRaw) {
      const parsedPayload = parseStartJoinPayload(payloadRaw);
      if (parsedPayload?.contestId) {
        const result = await tryJoinContest(
          bot,
          config,
          repository,
          parsedPayload.contestId,
          user,
          parsedPayload.referrerId,
        );
        if (!result.ok) {
          return ctx.reply(result.message);
        }
        if (result.already) {
          return ctx.reply(
            `Вы уже участвуете в конкурсе "${result.contest.title}". Участников: ${result.contest.participants.length}`,
          );
        }
        return ctx.reply(
          `Участие подтверждено через /start для "${result.contest.title}". Всего участников: ${result.contest.participants.length}`,
        );
      }
    }

    return ctx.reply(
      [
        "MAX Contest Bot запущен.",
        "",
        "Команды:",
        "/whoami",
        "/newcontest Название | ISO-дата-окончания | число_победителей",
        "/contests",
        "/setrequired contest_id chat_id[,chat_id2,...]",
        "/myref contest_id",
        "/join contest_id [referrer_user_id]",
        "/publish contest_id chat_id [текст_поста]",
        "/draw contest_id (только админ)",
        "/reroll contest_id (только админ)",
      ].join("\n"),
    );
  });

  bot.command("whoami", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    return ctx.reply(`Ваш user ID: ${user.id}`);
  });

  bot.command("newcontest", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `newcontest:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const payload = parseCommandArgs(extractText(ctx));
    const [titleRaw, endsAtRaw, winnersRaw] = payload.split("|").map((item) => item?.trim());
    const title = titleRaw ?? "";
    const endsAt = endsAtRaw ?? "";
    const maxWinners = Number(winnersRaw ?? "1");

    if (!title || !endsAt || !Number.isFinite(maxWinners) || maxWinners < 1) {
      return ctx.reply(
        "Неверный формат.\nПример:\n/newcontest iPhone giveaway | 2026-12-31T20:00:00Z | 3",
      );
    }

    const parsedDate = new Date(endsAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return ctx.reply("Дата окончания некорректна. Используйте ISO формат.");
    }

    const contest: Contest = {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      endsAt: parsedDate.toISOString(),
      maxWinners: Math.floor(maxWinners),
      status: "active",
      requiredChats: [],
      participants: [],
      winners: [],
    };

    repository.create(contest);
    return ctx.reply(
      `Конкурс создан.\nID: ${contest.id}\nНазвание: ${contest.title}\nЗавершение: ${contest.endsAt}\nПобедителей: ${contest.maxWinners}`,
    );
  });

  bot.command("contests", (ctx: Ctx) => {
    const contests = repository.list();
    if (contests.length === 0) {
      return ctx.reply("Пока нет созданных конкурсов.");
    }
    return ctx.reply(["Текущие конкурсы:", ...contests.map(toContestLine)].join("\n"));
  });

  bot.command("setrequired", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `setrequired:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const argsRaw = parseCommandArgs(extractText(ctx));
    const [contestId, ...rawChatParts] = argsRaw.split(" ").filter(Boolean);
    if (!contestId || rawChatParts.length === 0) {
      return ctx.reply("Формат: /setrequired contest_id chat_id[,chat_id2,...]");
    }

    const requiredChats = parseRequiredChatIds(rawChatParts.join(" "));
    const uniqueRequiredChats = [...new Set(requiredChats)];
    if (uniqueRequiredChats.length === 0) {
      return ctx.reply("Нужно передать хотя бы один валидный числовой chat_id.");
    }

    const updated = repository.update(contestId, (contest) => ({
      ...contest,
      requiredChats: uniqueRequiredChats,
    }));
    if (!updated) {
      return ctx.reply("Конкурс не найден.");
    }

    return ctx.reply(
      `Обязательные чаты для конкурса "${updated.title}" обновлены: ${updated.requiredChats.join(", ")}`,
    );
  });

  bot.command("join", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const cooldown = hitCooldown(commandCooldowns, `join:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const { contestId, referrerId } = parseJoinArgs(parseCommandArgs(extractText(ctx)));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /join contest_id [referrer_user_id]");
    }

    const result = await tryJoinContest(bot, config, repository, contestId, user, referrerId);
    if (!result.ok) {
      return ctx.reply(result.message);
    }
    if (result.already) {
      return ctx.reply(
        `Вы уже участвуете в конкурсе "${result.contest.title}". Участников: ${result.contest.participants.length}`,
      );
    }

    return ctx.reply(
      `Вы участвуете в конкурсе "${result.contest.title}". Всего участников: ${result.contest.participants.length}`,
    );
  });

  bot.command("myref", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Формат: /myref contest_id");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }

    return ctx.reply(
      [
        `Ваш ref ID: ${user.id}`,
        `Приглашайте так: /join ${contestId} ${user.id}`,
        `Быстрый формат через start: /start join:${contestId}:${user.id}`,
        `Бонус за реферала: +${config.referralBonusTickets} бил.`,
        `Макс бонус на пользователя: +${config.referralMaxBonusTickets} бил.`,
      ].join("\n"),
    );
  });

  bot.command("publish", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `publish:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const argsRaw = parseCommandArgs(extractText(ctx));
    const [contestId, chatIdRaw, ...textParts] = argsRaw.split(" ").filter(Boolean);
    if (!contestId || !chatIdRaw) {
      return ctx.reply("Формат: /publish contest_id chat_id [текст_поста]");
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isFinite(chatId)) {
      return ctx.reply("chat_id должен быть числом.");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }

    const postText =
      textParts.join(" ").trim() ||
      [
        `Конкурс: ${contest.title}`,
        'Условия: нажать кнопку "Участвовать"',
        `Окончание: ${contest.endsAt}`,
        `Рефералка: /myref ${contest.id} (бонус +${config.referralBonusTickets}, лимит +${config.referralMaxBonusTickets})`,
        contest.requiredChats.length > 0
          ? `Обязательные чаты: ${contest.requiredChats.join(", ")}`
          : "Обязательных чатов нет",
      ].join("\n");

    const message = await bot.api.sendMessageToChat(chatId, postText, {
      attachments: [
        Keyboard.inlineKeyboard([[Keyboard.button.callback("Участвовать", `join:${contest.id}`)]]),
      ],
    });

    repository.update(contest.id, (prev) => ({
      ...prev,
      publishChatId: chatId,
      publishMessageId: message.body?.mid ?? undefined,
    }));

    return ctx.reply(`Конкурс опубликован в chat_id=${chatId}.`);
  });

  bot.action(/^join:(.+)$/, async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      await ctx.answerOnCallback({ notification: "Не удалось определить пользователя." });
      return;
    }

    const cooldown = hitCooldown(commandCooldowns, `join_callback:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      await ctx.answerOnCallback({
        notification: `Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`,
      });
      return;
    }

    const payload = ctx.callback?.payload ?? "";
    const contestId = String(payload).replace(/^join:/, "");
    if (!contestId) {
      await ctx.answerOnCallback({ notification: "Некорректный payload." });
      return;
    }

    const result = await tryJoinContest(bot, config, repository, contestId, user);
    if (!result.ok) {
      await ctx.answerOnCallback({ notification: result.message });
      return;
    }

    await ctx.answerOnCallback({
      notification: result.already
        ? `Вы уже участвуете. Участников: ${result.contest.participants.length}`
        : `Участие принято. Участников: ${result.contest.participants.length}`,
    });
  });

  bot.command("draw", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const userCooldown = hitCooldown(commandCooldowns, `draw:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!userCooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${userCooldown.waitSeconds} сек.`);
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /draw contest_id");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status !== "active") {
      return ctx.reply("Конкурс уже завершен. Используйте /reroll для перевыбора.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
    }
    const lock = hitCooldown(drawLocks, `draw:${contest.id}`, DRAW_LOCK_TTL_MS);
    if (!lock.ok) {
      return ctx.reply(`Жеребьевка уже выполняется. Повторите через ${lock.waitSeconds} сек.`);
    }

    const result = runDeterministicDraw(contest);
    const updated = repository.update(contest.id, (prev) => ({
      ...prev,
      status: "completed",
      winners: result.winners,
      drawSeed: result.seed,
    }));

    if (!updated) {
      return ctx.reply("Не удалось завершить конкурс.");
    }

    void publishContestResults(bot, updated);

    return ctx.reply(
      [
        `Конкурс завершен: ${updated.title}`,
        `Winners: ${updated.winners.join(", ")}`,
        `Proof seed: ${updated.drawSeed}`,
      ].join("\n"),
    );
  });

  bot.command("reroll", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const userCooldown = hitCooldown(commandCooldowns, `reroll:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!userCooldown.ok) {
      return ctx.reply(`Слишком часто. Повторите через ${userCooldown.waitSeconds} сек.`);
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /reroll contest_id");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status !== "completed") {
      return ctx.reply("Reroll доступен только после завершения конкурса.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
    }
    const lock = hitCooldown(drawLocks, `reroll:${contest.id}`, DRAW_LOCK_TTL_MS);
    if (!lock.ok) {
      return ctx.reply(`Reroll уже выполняется. Повторите через ${lock.waitSeconds} сек.`);
    }

    const result = runDeterministicDraw({
      ...contest,
      endsAt: new Date().toISOString(),
    });

    const updated = repository.update(contest.id, (prev) => ({
      ...prev,
      status: "completed",
      winners: result.winners,
      drawSeed: result.seed,
    }));

    if (!updated) {
      return ctx.reply("Не удалось выполнить reroll.");
    }

    void publishContestResults(bot, updated);

    return ctx.reply(
      [
        `Reroll выполнен: ${updated.title}`,
        `Новые победители: ${updated.winners.join(", ")}`,
        `Proof seed: ${updated.drawSeed}`,
      ].join("\n"),
    );
  });

  setInterval(() => {
    void autoFinishExpiredContests(bot, repository);
  }, 15000);

  return bot;
}
