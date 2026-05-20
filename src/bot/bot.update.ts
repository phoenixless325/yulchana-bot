import { Logger, OnModuleInit } from '@nestjs/common';
import { Ctx, InjectBot, On, Update } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

const TRIGGER_WORD = 'цем';
// Unicode-aware word boundary — \b doesn't work for Cyrillic
const TRIGGER_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])${TRIGGER_WORD}(?![\\p{L}\\p{N}])`,
  'iu',
);

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

    if (!message.reply_to_message) return;
    if (!TRIGGER_PATTERN.test(message.text)) return;
    if (message.from?.is_bot) return;

    const triggerLink = userLink(message.from);
    const repliedLink = userLink(message.reply_to_message.from);

    try {
      await ctx.reply(`${triggerLink} засосал ${repliedLink}`, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.reply_to_message.message_id },
      });
    } catch (error) {
      this.logger.error('Failed to send reply', error as Error);
    }
  }
}
