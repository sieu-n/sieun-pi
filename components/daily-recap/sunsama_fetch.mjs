#!/usr/bin/env node
// Read an explicitly configured Sunsama cookie store and fetch a recap as JSON.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TZ = process.env.SUNSAMA_TZ || process.env.DAILY_RECAP_TZ || 'UTC';
const COOKIE_DB = process.env.SUNSAMA_COOKIE_DB;
let DatabaseSync;

function readSessionCookie() {
  const dir = mkdtempSync(join(tmpdir(), 'sunsama-cookies-'));
  const copy = join(dir, 'Cookies');
  try {
    copyFileSync(COOKIE_DB, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    const row = db
      .prepare(
        // expires_utc is microseconds since 1601 and overflows a JS number; scale it in SQL.
        "select value, length(encrypted_value) as enc, cast(expires_utc / 1000000 as integer) as expires_s from cookies where name = 'sunsamaSession' and host_key like '%sunsama.com' order by expires_utc desc limit 1",
      )
      .get();
    db.close();
    if (!row) throw new Error(`no sunsamaSession cookie in ${COOKIE_DB} — sign in to the Sunsama desktop app`);
    if (!row.value && row.enc > 0) throw new Error('sunsamaSession is stored encrypted in this Sunsama version; the plain-value read no longer works');
    const expiresMs = (Number(row.expires_s) - 11644473600) * 1000;
    if (expiresMs < Date.now()) throw new Error(`sunsamaSession expired ${new Date(expiresMs).toISOString()} — sign in to the Sunsama desktop app again`);
    return { token: row.value, expiresAt: new Date(expiresMs).toISOString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function localDate(d, tz) {
  return d.toLocaleDateString('sv-SE', { timeZone: tz });
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(iso) {
  const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  return addDays(iso, -dow);
}

function actualMinutes(task) {
  let seconds = 0;
  for (const a of task.actualTime || []) {
    if (typeof a.duration === 'number') seconds += a.duration;
    else if (a.startDate && a.endDate) seconds += (new Date(a.endDate) - new Date(a.startDate)) / 1000;
  }
  return Math.round(seconds / 60);
}

function slim(task, day, streamsById) {
  return {
    _id: task._id,
    text: task.text,
    completed: !!task.completed,
    completeDate: task.completeDate || null,
    timeEstimate: task.timeEstimate ?? null,
    actualMinutes: actualMinutes(task),
    streams: (task.streamIds || []).map((id) => streamsById.get(id)?.streamName || id),
    objectiveId: task.objectiveId || null,
    createdAt: task.createdAt || null,
    day,
  };
}

const OBJECTIVES_QUERY = `query getObjectivesByPeriod($period: ObjectivePeriodInput!, $groupId: String!) {
  objectivesByPeriod(period: $period, groupId: $groupId) {
    _id createdAt completed completedAt deleted lastModified groupId ordinal parentObjectiveId
    period { interval start end } streamId taskIds text timeEstimate userId
  }
}`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node sunsama_fetch.mjs [--help]\nRequires SUNSAMA_COOKIE_DB. Optional SUNSAMA_TZ and SUNSAMA_TODAY.');
    return;
  }
  if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
  if (!COOKIE_DB) throw new Error('SUNSAMA_COOKIE_DB is required; no cookie store was read');
  ({ DatabaseSync } = await import('node:sqlite'));
  const { SunsamaClient } = await import('sunsama-api');
  const session = readSessionCookie();
  const client = new SunsamaClient({ sessionToken: session.token });
  const user = await client.getUser();
  const groupId = user.primaryGroup.groupId;
  const streams = await client.getStreamsByGroupId();
  const streamsById = new Map(streams.map((s) => [s._id, s]));

  const today = process.env.SUNSAMA_TODAY || localDate(new Date(), TZ);
  const weekStart = mondayOf(today);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(weekStart, i);
    const tasks = await client.getTasksByDay(day, TZ);
    days.push({ date: day, tasks: tasks.map((t) => slim(t, day, streamsById)) });
  }
  const todayEntry = days.find((d) => d.date === today) || { date: today, tasks: [] };

  let objectives = [];
  let objectivesError = null;
  try {
    const res = await client.graphqlRequest({
      operationName: 'getObjectivesByPeriod',
      query: OBJECTIVES_QUERY,
      variables: { period: { start: weekStart, interval: 'week' }, groupId },
    });
    objectives = (res.data?.objectivesByPeriod || [])
      .filter((o) => !o.deleted)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      .map((o) => ({
        _id: o._id,
        text: o.text,
        completed: !!o.completed,
        completedAt: o.completedAt,
        streamName: o.streamId ? streamsById.get(o.streamId)?.streamName || null : null,
        taskIds: o.taskIds || [],
        timeEstimate: o.timeEstimate ?? null,
      }));
  } catch (err) {
    objectivesError = String(err?.message || err).slice(0, 300);
  }

  let backlogCount = null;
  try {
    backlogCount = (await client.getTasksBacklog()).length;
  } catch {
    backlogCount = null;
  }

  process.stdout.write(
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      timezone: TZ,
      sessionExpiresAt: session.expiresAt,
      user: { firstname: user.profile?.firstname || null, groupId },
      today: todayEntry,
      week: { start: weekStart, days },
      objectives,
      objectivesError,
      backlogCount,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
