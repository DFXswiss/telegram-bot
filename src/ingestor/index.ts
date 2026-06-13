import TelegramBot from 'node-telegram-bot-api';
import { pool } from '../db/pool';
import { logger } from '../util/logger';

/**
 * Maps a Telegram message to the columns of the `messages` table.
 *
 * IMPORTANT — Privacy Mode: a bot only receives *all* group messages when its
 * privacy mode is DISABLED in @BotFather (/setprivacy -> Disable). With privacy
 * mode on (the default) the bot sees only commands, @mentions and replies to
 * itself, and this logger will record almost nothing.
 */
function buildRow(msg: TelegramBot.Message, edited: boolean) {
  const from = msg.from;
  const fromName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(' ') || null
    : null;
  return {
    chat_id: msg.chat.id,
    chat_title: msg.chat.title ?? null,
    chat_type: msg.chat.type,
    message_id: msg.message_id,
    thread_id: msg.message_thread_id ?? null,
    from_user_id: from?.id ?? null,
    from_username: from?.username ?? null,
    from_name: fromName,
    text: msg.text ?? msg.caption ?? null,
    reply_to_message_id: msg.reply_to_message?.message_id ?? null,
    edited,
    // Telegram dates are unix seconds; edited_message carries `edit_date`.
    message_date: new Date((edited ? (msg.edit_date ?? msg.date) : msg.date) * 1000),
    raw: JSON.stringify(msg),
  };
}

async function persist(msg: TelegramBot.Message, edited: boolean): Promise<void> {
  const r = buildRow(msg, edited);
  // New messages: dedupe replays (DO NOTHING). Edits: update in place.
  const onConflict = edited
    ? `DO UPDATE SET text = EXCLUDED.text, raw = EXCLUDED.raw,
                     edited = TRUE, message_date = EXCLUDED.message_date`
    : 'DO NOTHING';

  await pool.query(
    `INSERT INTO messages
       (chat_id, chat_title, chat_type, message_id, thread_id,
        from_user_id, from_username, from_name, text, reply_to_message_id,
        edited, message_date, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (chat_id, message_id) ${onConflict}`,
    [
      r.chat_id,
      r.chat_title,
      r.chat_type,
      r.message_id,
      r.thread_id,
      r.from_user_id,
      r.from_username,
      r.from_name,
      r.text,
      r.reply_to_message_id,
      r.edited,
      r.message_date,
      r.raw,
    ],
  );

  logger.debug({ chat_id: r.chat_id, message_id: r.message_id, edited }, 'message logged');
}

export function startIngestor(bot: TelegramBot): void {
  const handle =
    (edited: boolean) =>
    (msg: TelegramBot.Message): void => {
      persist(msg, edited).catch((err) =>
        logger.error(
          { err, chat_id: msg.chat?.id, message_id: msg.message_id },
          'failed to log message',
        ),
      );
    };

  bot.on('message', handle(false));
  bot.on('edited_message', handle(true));
  bot.on('channel_post', handle(false));
  bot.on('edited_channel_post', handle(true));

  bot.on('polling_error', (err) => logger.error({ err }, 'telegram polling error'));

  logger.info('ingestor started — logging all incoming messages');
}
