import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ctx, InjectBot, On, Update } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';

const STANISLAV_USER_ID = 336211533;
const MAX_HISTORY = 20;
const SYSTEM_PROMPT = `You are Bля, Stanislav's wife. You are chatting in a group chat with friends and family.
Always reply in Russian, no matter what language the user wrote in.
Reply short and natural, like in a real messaging app. Never reveal you are an AI.
Be warm, occasionally playful or sarcastic.`;

const REFUSAL_REPLIES = [
  'Извини, я общаюсь только со своим мужем.',
  'Прости, разговариваю только со Стасом.',
  'С чужими не общаюсь — только со своим мужем 😌',
  'Только Стас, остальных игнорю 😉',
];

type HistoryEntry = { name: string; text: string; fromBot: boolean };

// --- OLD TRIGGER-BASED FUNCTIONALITY (temporarily disabled) ---
/*
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
  { word: 'воскресить', action: 'воскресил(а)' },
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
*/

@Update()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly history = new Map<number, HistoryEntry[]>();
  private gemini!: GenerativeModel;
  private botId = 0;
  private botUsername = '';

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    const modelName = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.0-flash';
    this.gemini = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
    });
    this.logger.log(`Using Gemini model: ${modelName}`);

    try {
      const me = await this.bot.telegram.getMe();
      this.botId = me.id;
      this.botUsername = me.username ?? '';
      this.logger.log(`Logged in as @${this.botUsername} (id=${this.botId})`);
    } catch (error) {
      this.logger.error('Failed to fetch bot identity', error as Error);
    }

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

  private pushHistory(chatId: number, entry: HistoryEntry): void {
    const arr = this.history.get(chatId) ?? [];
    arr.push(entry);
    while (arr.length > MAX_HISTORY) arr.shift();
    this.history.set(chatId, arr);
  }

  private isMentioned(message: Message.TextMessage): boolean {
    if (message.reply_to_message?.from?.id === this.botId) return true;
    const entities = message.entities ?? [];
    const username = this.botUsername.toLowerCase();
    for (const e of entities) {
      if (e.type === 'mention' && username) {
        const m = message.text.slice(e.offset, e.offset + e.length).toLowerCase();
        if (m === `@${username}`) return true;
      }
      if (e.type === 'text_mention' && e.user?.id === this.botId) return true;
    }
    return false;
  }

  private senderLabel(from: Message.TextMessage['from']): string {
    if (from?.id === STANISLAV_USER_ID) return 'Stanislav (your husband)';
    return from?.first_name ?? from?.username ?? 'Someone';
  }

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage | undefined;
    if (!message) return;
    if (message.from?.is_bot) return;

    const chatId = message.chat.id;
    this.pushHistory(chatId, {
      name: this.senderLabel(message.from),
      text: message.text,
      fromBot: false,
    });

    if (!this.isMentioned(message)) return;

    if (message.from?.id !== STANISLAV_USER_ID) {
      const reply = REFUSAL_REPLIES[Math.floor(Math.random() * REFUSAL_REPLIES.length)];
      try {
        await ctx.reply(reply, {
          reply_parameters: { message_id: message.message_id },
        });
        this.pushHistory(chatId, { name: 'Bля', text: reply, fromBot: true });
      } catch (error) {
        this.logger.error('Failed to send refusal reply', error as Error);
      }
      return;
    }

    try {
      await ctx.sendChatAction('typing');
      const convo = (this.history.get(chatId) ?? [])
        .map((m) => (m.fromBot ? `Bля: ${m.text}` : `${m.name}: ${m.text}`))
        .join('\n');
      const prompt = `Recent chat:\n${convo}\n\nReply as Bля to the last message (from your husband Stanislav). Output only the reply text in Russian, no name prefix, no quotes.`;
      const result = await this.gemini.generateContent(prompt);
      const reply = result.response.text().trim();
      if (!reply) return;

      await ctx.reply(reply, {
        reply_parameters: { message_id: message.message_id },
      });
      this.pushHistory(chatId, { name: 'Bля', text: reply, fromBot: true });
    } catch (error) {
      this.logger.error('Failed to generate wife reply', error as Error);
    }

    // --- OLD TRIGGER-BASED HANDLERS (temporarily disabled) ---
    /*
    if (message.reply_to_message) {
      const trigger = COMPILED_REPLY_TRIGGERS.find((t) => t.pattern.test(message.text));
      if (trigger) {
        const triggerLink = userLink(message.from);
        const repliedLink = userLink(message.reply_to_message.from);
        await ctx.reply(`${triggerLink} ${trigger.action} ${repliedLink}`, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: message.reply_to_message.message_id },
        });
        return;
      }
    }

    if (VOSKRESNUT_PATTERN.test(message.text)) {
      await ctx.reply(`${userLink(message.from)} воскрес(ла) ☦️`, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    if (VSKRYTSYA_PATTERN.test(message.text)) {
      await ctx.reply(`${userLink(message.from)} покончил(а) с собой ☠️`, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    if (PLAKAT_PATTERN.test(message.text)) {
      await ctx.reply(`${userLink(message.from)} рыдает в подушку 😭`, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    if (OKAK_PATTERN.test(message.text)) {
      await ctx.reply('отак', {
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    if (BLYA_PATTERN.test(message.text)) {
      await ctx.reply(
        `<a href="https://t.me/${YULCHANA_USERNAME}">Бля</a> вызывали?`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: message.message_id },
        },
      );
      return;
    }
    */
  }

  // --- OLD /help COMMAND (temporarily disabled) ---
  /*
  @Command('help')
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    const lines = REPLY_TRIGGERS.map((t) => `<code>${t.word}</code> — ${t.action}`);
    const text = ['Триггеры (в реплае на сообщение):', ...lines].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
  */
}