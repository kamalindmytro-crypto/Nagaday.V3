// check-reminders.mjs
//
// Runs on a schedule via GitHub Actions. Each run:
//  1. Asks Supabase for reminders that are due (datetime <= now, not completed, not yet notified)
//  2. Sends a Telegram message for each
//  3. If the reminder repeats, advances it to its next occurrence and clears notified_at
//     If it doesn't repeat, marks notified_at so it won't fire again
//
// Requires these environment variables (set as GitHub Actions secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// The workflow also sets TZ=Europe/Warsaw so that Date methods like getDate()/
// getDay()/setMonth() below operate on Warsaw wall-clock time — matching how
// the reminders were created in the browser (index.html assumes the browser's
// local time is Europe/Warsaw too).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    'Відсутні необхідні змінні середовища: SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID'
  );
  process.exit(1);
}

const DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function fetchDueReminders() {
  const nowIso = new Date().toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/reminders?select=*&completed=eq.false&notified_at=is.null` +
    `&datetime=lte.${encodeURIComponent(nowIso)}`;
  const resp = await fetch(url, { headers: sbHeaders() });
  if (!resp.ok) {
    throw new Error(`Supabase fetch failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function patchReminder(id, patch) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${id}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(patch)
  });
  if (!resp.ok) {
    throw new Error(`Supabase patch failed: ${resp.status} ${await resp.text()}`);
  }
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  });
  if (!resp.ok) {
    throw new Error(`Telegram send failed: ${resp.status} ${await resp.text()}`);
  }
}

// Mirrors the recurrence logic in index.html exactly, so the "next occurrence"
// computed here always agrees with what the browser would compute.
function addOccurrence(fromDate, rec) {
  const d = new Date(fromDate);
  const interval = Math.max(1, parseInt(rec.interval, 10) || 1);
  if (rec.type === 'daily') {
    d.setDate(d.getDate() + interval);
  } else if (rec.type === 'weekly') {
    if (rec.days && rec.days.length) {
      for (let i = 1; i <= 8; i++) {
        const cand = new Date(d);
        cand.setDate(d.getDate() + i);
        if (rec.days.includes(DAY_ORDER[cand.getDay()])) return cand;
      }
      d.setDate(d.getDate() + 7 * interval);
    } else {
      d.setDate(d.getDate() + 7 * interval);
    }
  } else if (rec.type === 'monthly') {
    d.setMonth(d.getMonth() + interval);
  } else if (rec.type === 'yearly') {
    d.setFullYear(d.getFullYear() + interval);
  }
  return d;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function formatMessage(r) {
  const lines = [`🔔 <b>${escapeHtml(r.title)}</b>`];
  if (r.note) lines.push(escapeHtml(r.note));
  return lines.join('\n');
}

async function main() {
  let due;
  try {
    due = await fetchDueReminders();
  } catch (e) {
    console.error('Помилка отримання нагадувань з Supabase:', e.message);
    process.exit(1);
  }

  if (!due.length) {
    console.log('Немає нагадувань, що настали.');
    return;
  }

  for (const r of due) {
    try {
      await sendTelegramMessage(formatMessage(r));
      console.log(`Надіслано в Telegram: ${r.title}`);
    } catch (e) {
      console.error(`Не вдалося надіслати "${r.title}":`, e.message);
      // Don't touch the row if the message failed — try again next run.
      continue;
    }

    const rec = {
      type: r.recurrence_type || 'none',
      interval: r.recurrence_interval || 1,
      days: r.recurrence_days || []
    };

    try {
      if (rec.type && rec.type !== 'none') {
        const now = new Date();
        let next = addOccurrence(new Date(r.datetime), rec);
        let guard = 0;
        while (next <= now && guard < 2000) {
          next = addOccurrence(next, rec);
          guard++;
        }
        await patchReminder(r.id, { datetime: next.toISOString(), notified_at: null });
      } else {
        await patchReminder(r.id, { notified_at: new Date().toISOString() });
      }
    } catch (e) {
      console.error(`Не вдалося оновити рядок "${r.title}" після надсилання:`, e.message);
    }
  }
}

main();
