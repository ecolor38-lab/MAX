import crypto from "node:crypto";

import { Bot, Keyboard } from "@maxhub/max-bot-api";

import type { AppConfig } from "./config";
import { runDeterministicDraw } from "./draw";
import { ContestRepository } from "./repository";
import type { Contest } from "./types";

type Ctx = any;

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

function toContestLine(contest: Contest): string {
  return `#${contest.id} | ${contest.title} | status=${contest.status} | participants=${contest.participants.length} | winners=${contest.maxWinners}`;
}

function tryJoinContest(
  repository: ContestRepository,
  contestId: string,
  user: { id: string; username?: string },
): { ok: true; contest: Contest; already: boolean } | { ok: false; message: string } {
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

  const already = contest.participants.some((participant) => participant.userId === user.id);
  if (already) {
    return { ok: true, contest, already: true };
  }

  const participant = {
    userId: user.id,
    joinedAt: new Date().toISOString(),
    tickets: 1,
    ...(user.username ? { username: user.username } : {}),
  };

  const updated = repository.addParticipant(contestId, participant);
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

    if (updated.publishChatId) {
      await bot.api.sendMessageToChat(
        updated.publishChatId,
        [
          `Итоги конкурса: ${updated.title}`,
          `Победители: ${updated.winners.join(", ") || "нет победителей"}`,
          `Proof seed: ${updated.drawSeed ?? "-"}`,
        ].join("\n"),
      );
    }
  }
}

export function createContestBot(config: AppConfig): Bot {
  const repository = new ContestRepository(config.storagePath);
  const bot = new Bot(config.botToken);

  bot.api.setMyCommands([
    { name: "start", description: "Помощь и команды" },
    { name: "whoami", description: "Показать ваш user ID" },
    {
      name: "newcontest",
      description: "Создать конкурс: /newcontest Название | 2026-12-31T20:00:00Z | 3",
    },
    { name: "contests", description: "Показать конкурсы" },
    { name: "join", description: "Участвовать: /join contest_id" },
    { name: "publish", description: "Опубликовать конкурс: /publish contest_id chat_id [текст]" },
    { name: "draw", description: "Выбрать победителей: /draw contest_id" },
    { name: "reroll", description: "Перевыбрать победителей: /reroll contest_id" },
  ]);

  bot.command("start", (ctx: Ctx) => {
    return ctx.reply(
      [
        "MAX Contest Bot запущен.",
        "",
        "Команды:",
        "/whoami",
        "/newcontest Название | ISO-дата-окончания | число_победителей",
        "/contests",
        "/join contest_id",
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

  bot.command("join", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /join contest_id");
    }

    const result = tryJoinContest(repository, contestId, user);
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

  bot.command("publish", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!isAdmin(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
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
      `Конкурс: ${contest.title}\nУсловия: нажать кнопку "Участвовать"\nОкончание: ${contest.endsAt}`;

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

    const payload = ctx.callback?.payload ?? "";
    const contestId = String(payload).replace(/^join:/, "");
    if (!contestId) {
      await ctx.answerOnCallback({ notification: "Некорректный payload." });
      return;
    }

    const result = tryJoinContest(repository, contestId, user);
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

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /draw contest_id");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
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

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /reroll contest_id");
    }

    const contest = repository.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
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
