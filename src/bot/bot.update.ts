import { Logger, OnModuleInit } from '@nestjs/common';
import { Ctx, InjectBot, On, Update } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

// Unicode-aware word boundary — \b doesn't work for Cyrillic
function triggerPattern(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu');
}

const CEM_PATTERN = triggerPattern('цем');
const BLYA_PATTERN = triggerPattern('бля');
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

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage | undefined;
    if (!message) return;
    if (message.from?.is_bot) return;

    if (
      message.reply_to_message &&
      CEM_PATTERN.test(message.text)
    ) {
      const triggerLink = userLink(message.from);
      const repliedLink = userLink(message.reply_to_message.from);
      try {
        await ctx.reply(`${triggerLink} засосал ${repliedLink}`, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.reply_to_message.message_id },
        });
      } catch (error) {
        this.logger.error('Failed to send цем reply', error as Error);
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
