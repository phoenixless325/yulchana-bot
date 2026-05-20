# yulchana-bot

NestJS Telegram bot for group chats. When a user replies to someone's message and the reply contains the trigger word (`цем`), the bot posts:

```
@replier засосал @original
```

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather), copy the token.
2. **Disable privacy mode** so the bot can read all group messages, not just commands:
   - In BotFather: `/mybots` → pick the bot → `Bot Settings` → `Group Privacy` → `Turn off`.
3. Add the bot to your group.
4. Copy env file and fill in the token:

   ```bash
   cp .env.example .env
   ```

5. Install and run:

   ```bash
   npm install
   npm run start:dev
   ```

## Configuration

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |

The trigger word is `цем`, hard-coded in `src/bot/bot.update.ts`. Edit the `TRIGGER_PATTERN` constant to change it.

## How it works

- `@On('text')` in `src/bot/bot.update.ts` receives every text message.
- The handler ignores messages that are not replies or do not contain the trigger word.
- It also ignores self-targeted messages and replies to/from bots.
- Username falls back to first/last name if the user has no `@username`.
