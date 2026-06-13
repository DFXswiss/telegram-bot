import TelegramBot from 'node-telegram-bot-api';
import { pool } from '../db/pool';
import { config } from '../config';
import { logger } from '../util/logger';

type Action = 'send_message' | 'delete_message' | 'ban_user' | 'kick_user';

interface OutboxRow {
  id: string;
  action: Action;
  target_chat_id: string;
  text: string | null;
  reply_to_message_id: string | null;
  message_thread_id: string | null;
  parse_mode: string | null;
  target_message_id: string | null;
  target_user_id: string | null;
  ban_until_date: Date | null;
  revoke_messages: boolean;
  attempts: number;
}

/** Performs a single action against the Telegram API. Returns the sent message_id for replies. */
async function perform(bot: TelegramBot, row: OutboxRow): Promise<number | null> {
  const chatId = Number(row.target_chat_id);

  switch (row.action) {
    case 'send_message': {
      if (!row.text) throw new Error('send_message requires text');
      const options: TelegramBot.SendMessageOptions = {};
      if (row.reply_to_message_id) options.reply_to_message_id = Number(row.reply_to_message_id);
      if (row.message_thread_id) options.message_thread_id = Number(row.message_thread_id);
      if (row.parse_mode === 'Markdown' || row.parse_mode === 'HTML') {
        options.parse_mode = row.parse_mode;
      }
      const sent = await bot.sendMessage(chatId, row.text, options);
      return sent.message_id;
    }

    case 'delete_message': {
      if (!row.target_message_id) throw new Error('delete_message requires target_message_id');
      // Requires the bot to be an admin with can_delete_messages.
      await bot.deleteMessage(chatId, Number(row.target_message_id));
      return null;
    }

    case 'ban_user': {
      if (!row.target_user_id) throw new Error('ban_user requires target_user_id');
      // Requires the bot to be an admin with can_restrict_members.
      const options: TelegramBot.BanOptions = {};
      if (row.ban_until_date) options.until_date = Math.floor(row.ban_until_date.getTime() / 1000);
      if (row.revoke_messages) options.revoke_messages = true;
      await bot.banChatMember(chatId, Number(row.target_user_id), options);
      return null;
    }

    case 'kick_user': {
      if (!row.target_user_id) throw new Error('kick_user requires target_user_id');
      // Kick = ban then immediately unban so the user is removed but may rejoin.
      const userId = Number(row.target_user_id);
      const banOptions: TelegramBot.BanOptions = {};
      if (row.revoke_messages) banOptions.revoke_messages = true;
      await bot.banChatMember(chatId, userId, banOptions);
      await bot.unbanChatMember(chatId, userId, { only_if_banned: true });
      return null;
    }

    default:
      throw new Error(`unknown action: ${row.action}`);
  }
}

/**
 * Claims a batch of pending rows with FOR UPDATE SKIP LOCKED so that multiple
 * executor instances never grab the same row, then performs each action. A row
 * that has exhausted OUTBOX_MAX_ATTEMPTS is parked in 'failed' for inspection.
 */
async function processBatch(bot: TelegramBot): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, action, target_chat_id, text, reply_to_message_id, message_thread_id,
              parse_mode, target_message_id, target_user_id, ban_until_date,
              revoke_messages, attempts
         FROM outbox
        WHERE status = 'pending'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [config.OUTBOX_BATCH_SIZE],
    );

    for (const row of rows) {
      try {
        const resultMessageId = await perform(bot, row);
        await client.query(
          `UPDATE outbox
              SET status = 'done', done_at = now(),
                  result_message_id = $2, attempts = attempts + 1
            WHERE id = $1`,
          [row.id, resultMessageId],
        );
        logger.info(
          { outbox_id: row.id, action: row.action, chat_id: row.target_chat_id },
          'action executed',
        );
      } catch (err) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= config.OUTBOX_MAX_ATTEMPTS;
        await client.query(
          `UPDATE outbox SET status = $2, attempts = $3, last_error = $4 WHERE id = $1`,
          [row.id, exhausted ? 'failed' : 'pending', attempts, String(err)],
        );
        logger.error(
          { err, outbox_id: row.id, action: row.action, attempts, parked: exhausted },
          'action failed',
        );
      }
    }

    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function startExecutor(bot: TelegramBot): void {
  let running = true;

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const processed = await processBatch(bot);
        // Back off only when the queue was empty; drain fast when busy.
        if (processed === 0) {
          await new Promise((r) => setTimeout(r, config.OUTBOX_POLL_INTERVAL_MS));
        }
      } catch (err) {
        logger.error({ err }, 'executor loop error');
        await new Promise((r) => setTimeout(r, config.OUTBOX_POLL_INTERVAL_MS));
      }
    }
  };

  process.on('SIGTERM', () => {
    running = false;
  });
  process.on('SIGINT', () => {
    running = false;
  });

  void loop();
  logger.info('executor started — draining outbox actions');
}
