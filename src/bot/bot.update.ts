import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ctx, InjectBot, On, Update } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

const STANISLAV_USER_ID = 336211533;
const MAX_HISTORY = 20;
const SYSTEM_PROMPT = `You are Юля — a participant of a Ukrainian group chat. You are an AI, and if someone asks directly, you can admit it, but you don't announce it.

Always reply in Russian, no matter what language the user wrote in.
Reply short and natural, like in a real messaging app. Never write long texts.

About you:
- You are a young Ukrainian woman
- You are here just to chat, have fun and keep good vibes in the group

Personality:
- Friendly, warm and tactful — easy to talk to, never makes anyone feel awkward
- Playful and entertaining — you can drop a funny joke, ask an interesting question out of nowhere, start a fun topic
- Mildly cheeky when the situation calls for it — you catch double meanings and hint lightly, but never push it
- Sarcastic in a likeable way — your jokes land because they're never mean
- You keep it real — no pretending, no drama, just good chat

What you do in chat:
- Share a funny анекдот when things are quiet
- React naturally to what people say — support, tease lightly, laugh along

Rules:
- Keep replies short — 1-3 sentences max
- Use emojis naturally but not excessively
- Never vulgar — suggestive only when the conversation clearly goes there
- Never mean, never dismissive
- No attachments to any specific person in the chat`;

type HistoryEntry = { name: string; text: string; fromBot: boolean };

type Joke = { id: number; origin: string; text: string };
type JokesFile = { jokes: Joke[] };

// What the intent classifier extracts from a user message
type JokeRequest = {
  want: boolean; // user is asking for a joke
  id: number | null; // a specific joke number, if named
  topic: string | null; // a topic/keyword, e.g. "Сидорович", "кровосос"
};

// Unicode-aware word boundary — \b doesn't work for Cyrillic
function triggerPattern(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu');
}

const OKAK_PATTERN = triggerPattern('окак');

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
  private classifier!: GenerativeModel;
  private jokes: Joke[] = [];
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
    const genAI = new GoogleGenerativeAI(apiKey);
    this.gemini = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
    });
    // Separate, persona-free model used only to classify intent into JSON.
    this.classifier = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    this.logger.log(`Using Gemini model: ${modelName}`);

    this.jokes = this.loadJokes();
    this.logger.log(`Loaded ${this.jokes.length} STALKER jokes`);

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

  private loadJokes(): Joke[] {
    // Try next to the compiled file first (dist/bot), then the cwd fallback.
    const candidates = [
      path.join(__dirname, 'stalker-jokes.json'),
      path.join(process.cwd(), 'src', 'bot', 'stalker-jokes.json'),
      path.join(process.cwd(), 'stalker-jokes.json'),
    ];
    for (const file of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as JokesFile;
        if (Array.isArray(data.jokes) && data.jokes.length) return data.jokes;
      } catch {
        // try next candidate
      }
    }
    this.logger.error(
      `Could not load stalker-jokes.json from any of: ${candidates.join(', ')}`,
    );
    return [];
  }

  // Ask the model whether the user wants a joke, and whether they named a
  // specific one (by number) or a topic. Returns want:false on any failure.
  private async detectJokeRequest(text: string): Promise<JokeRequest> {
    const none: JokeRequest = { want: false, id: null, topic: null };
    try {
      const prompt = `Ты классификатор намерений в чате. Определи, просит ли пользователь рассказать анекдот/шутку (в том числе "сталкерский" анекдот, "что-нибудь смешное", "рассмеши меня" и т.п.).
Сообщение пользователя: """${text}"""
Ответь СТРОГО в формате JSON без пояснений:
{"want": boolean, "id": number|null, "topic": string|null}
- want — true, если человек хочет услышать анекдот.
- id — номер анекдота, если он назван явно (например "анекдот 5", "пятый"), иначе null.
- topic — ключевое слово/тема, если просят анекдот про что-то конкретное (например "Сидорович", "кровосос", "водка", "Долг"), иначе null.`;
      const result = await this.classifier.generateContent(prompt);
      const parsed = JSON.parse(result.response.text()) as Partial<JokeRequest>;
      return {
        want: parsed.want === true,
        id: typeof parsed.id === 'number' ? parsed.id : null,
        topic:
          typeof parsed.topic === 'string' && parsed.topic.trim()
            ? parsed.topic.trim()
            : null,
      };
    } catch (error) {
      this.logger.error('Joke intent classification failed', error as Error);
      return none;
    }
  }

  private randomJoke(pool: Joke[]): Joke | undefined {
    if (!pool.length) return undefined;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private pickJoke(req: JokeRequest): Joke | undefined {
    if (!this.jokes.length) return undefined;
    // Specific number requested.
    if (req.id != null) {
      const byId = this.jokes.find((j) => j.id === req.id);
      if (byId) return byId;
    }
    // Topic requested — match against joke text, random among matches.
    if (req.topic) {
      const needle = req.topic.toLowerCase();
      const matches = this.jokes.filter((j) =>
        j.text.toLowerCase().includes(needle),
      );
      if (matches.length) return this.randomJoke(matches);
    }
    // Otherwise a random joke.
    return this.randomJoke(this.jokes);
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
    // if (from?.id === STANISLAV_USER_ID) return 'Stanislav (your husband)';
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

    if (!this.isMentioned(message)) return;

    // Joke request? Send the exact joke text from the file instead of chatting.
    if (this.jokes.length) {
      const req = await this.detectJokeRequest(message.text);
      if (req.want) {
        const joke = this.pickJoke(req);
        if (joke) {
          try {
            await ctx.reply(joke.text, {
              reply_parameters: { message_id: message.message_id },
            });
            this.pushHistory(chatId, {
              name: 'Юля',
              text: joke.text,
              fromBot: true,
            });
          } catch (error) {
            this.logger.error('Failed to send joke', error as Error);
          }
          return;
        }
      }
    }

    try {
      await ctx.sendChatAction('typing');
      const convo = (this.history.get(chatId) ?? [])
        .map((m) => (m.fromBot ? `Юля: ${m.text}` : `${m.name}: ${m.text}`))
        .join('\n');
      const senderName = this.senderLabel(message.from);
      const prompt = `Recent chat:\n${convo}\n\nReply as Юля to the last message (from ${senderName}). Output only the reply text in Russian, no name prefix, no quotes.`;
      const result = await this.gemini.generateContent(prompt);
      const reply = result.response.text().trim();
      if (!reply) return;

      await ctx.reply(reply, {
        reply_parameters: { message_id: message.message_id },
      });
      this.pushHistory(chatId, { name: 'Юля', text: reply, fromBot: true });
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