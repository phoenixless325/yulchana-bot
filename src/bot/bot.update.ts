import { Logger, OnModuleInit } from '@nestjs/common';
import { Command, Ctx, InjectBot, On, Update } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

// Unicode-aware word boundary — \b doesn't work for Cyrillic
function triggerPattern(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu');
}

const REPLY_TRIGGERS: Array<{ word: string; action: string }> = [
  { word: 'цем', action: 'засосал(а)' },
  { word: 'ебнуть', action: 'ебнул(а)' },
  { word: 'пиздануть', action: 'пизданул(а)' },
  { word: 'ударить', action: 'ударил(а)' },
  { word: 'вьебать', action: 'вьебал(а)' },
  { word: 'обнять', action: 'нежно обнял(а)' },
  { word: 'цемнуть', action: 'цемнул(а) в щечку' },
  { word: 'толкнуть', action: 'толкнул(а)' },
  { word: 'кусь', action: 'укусил(а)' },
  { word: 'пять', action: 'дал(а) пять' },
  { word: 'покормить', action: 'покормил(а)' },
];

const COMPILED_REPLY_TRIGGERS = REPLY_TRIGGERS.map((t) => ({
  pattern: triggerPattern(t.word),
  action: t.action,
}));

const BLYA_PATTERN = triggerPattern('бля');
const OKAK_PATTERN = triggerPattern('окак');
const PLAKAT_PATTERN = triggerPattern('плакать');
const VSKRYTSYA_PATTERN = triggerPattern('вскрыться');
const VOSKRESNUT_PATTERN = triggerPattern('воскреснуть');
const YULCHANA_USERNAME = 'yulchana1';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function userLink(user: { id?: number; first_name?: string; username?: string } | undefined): string {
  const name = escapeHtml(user?.first_name ?? user?.username ?? 'кто-то');
  return user?.id ? `<a href="tg://user?id=${user.id}">${name}</a>` : name;
}

@Update()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);

  constructor(@InjectBot() private readonly bot: Telegraf<Context>) {}

  onModuleInit(): void {
    this.bot.telegram
      .setMyCommands([{ command: 'help', description: 'Список доступных триггеров' }])
      .catch((error) => this.logger.error('Failed to set bot commands', error as Error));

    this.bot.use(async (ctx, next) => {
      const u = ctx.update;
      const kind = Object.keys(u)
        .filter((k) => k !== 'update_id')
        .join(',');
      const msg = ctx.message ?? ctx.editedMessage;
      const body =
        msg && 'text' in msg
          ? JSON.stringify(msg.text)
          : msg
            ? '<non-text>'
            : '';
      this.logger.log(
        `update id=${u.update_id} ${kind} chat=${msg?.chat.id ?? '?'} from=@${msg?.from?.username ?? msg?.from?.first_name ?? '?'} ${body}`,
      );
      await next();
    });
  }

  @Command('help')
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    const lines = REPLY_TRIGGERS.map((t) => `<code>${t.word}</code> — ${t.action}`);
    const text = [
      'Триггеры (в реплае на сообщение):',
      ...lines,
    ].join('\n');
    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('Failed to send help reply', error as Error);
    }
  }

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage | undefined;
    if (!message) return;
    if (message.from?.is_bot) return;

    if (message.reply_to_message) {
      const trigger = COMPILED_REPLY_TRIGGERS.find((t) => t.pattern.test(message.text));
      if (trigger) {
        const triggerLink = userLink(message.from);
        const repliedLink = userLink(message.reply_to_message.from);
        try {
          await ctx.reply(`${triggerLink} ${trigger.action} ${repliedLink}`, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: message.reply_to_message.message_id },
          });
        } catch (error) {
          this.logger.error('Failed to send reply trigger', error as Error);
        }
        return;
      }
    }

    if (VOSKRESNUT_PATTERN.test(message.text)) {
      try {
        await ctx.reply(`${userLink(message.from)} воскрес(ла) ☦️`, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
        });
      } catch (error) {
        this.logger.error('Failed to send воскреснуть reply', error as Error);
      }
      return;
    }

    if (VSKRYTSYA_PATTERN.test(message.text)) {
      try {
        await ctx.reply(`${userLink(message.from)} покончил(а) с собой ☠️`, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
        });
      } catch (error) {
        this.logger.error('Failed to send вскрыться reply', error as Error);
      }
      return;
    }

    if (PLAKAT_PATTERN.test(message.text)) {
      try {
        await ctx.reply(`${userLink(message.from)} рыдает в подушку 😭`, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.message_id },
        });
      } catch (error) {
        this.logger.error('Failed to send плакать reply', error as Error);
      }
      return;
    }

    if (OKAK_PATTERN.test(message.text)) {
      try {
        await ctx.reply('отак', {
          reply_parameters: { message_id: message.message_id },
        });
      } catch (error) {
        this.logger.error('Failed to send окак reply', error as Error);
      }
      return;
    }

    if (BLYA_PATTERN.test(message.text)) {
      try {
        await ctx.reply(
          `<a href="https://t.me/${YULCHANA_USERNAME}">Бля</a> вызывали?`,
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: message.message_id },
          },
        );
      } catch (error) {
        this.logger.error('Failed to send бля reply', error as Error);
      }
      return;
    }
  }
}
