'use strict';
// Mood Bricks, website version. Everything runs in the browser; the shared team data lives in
// Firebase Firestore. The key below is public by design: firestore.rules decides what anyone can do.

const PROJECT = 'mood-bricks';
const API_KEY = 'AIzaSyD9kl4er8K00JVM4G8REZYMxMOpeQ_9Pvk';
const DB = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const MIN_ANSWERS_TO_SHOW = 3; // a day with fewer answers stays grey, so nobody can be singled out
const MIN_TEAM_SIZE = 5;
const TEAM_GOAL = 0.8; // 80% of possible check-ins this month
const WEEKS_ON_WALL = 5;
const WEEKS_ANALYSED = 12; // patterns look at the last 12 weeks
const MAX_IMAGE_CHARS = 940000; // one database entry holds about 1 MB

const MOODS = [
  { score: 1, emoji: '🫠', label: 'drained' },
  { score: 2, emoji: '😕', label: 'meh' },
  { score: 3, emoji: '🙂', label: 'okay' },
  { score: 4, emoji: '😊', label: 'into it' },
  { score: 5, emoji: '🔥', label: 'fired up' },
];
const HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ---------- dates (in your local time) ----------
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const prevWorkday = (d) => { let x = addDays(d, -1); while (isWeekend(x)) x = addDays(x, -1); return x; };
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
// Week numbers as used in Denmark (ISO 8601): weeks start on Monday, week 1 holds the first Thursday.
function weekNumber(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
const analysedFrom = () => dayStr(addDays(mondayOf(new Date()), -7 * (WEEKS_ANALYSED - 1)));

// ---------- the team database ----------
const toFields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) =>
  [k, Number.isInteger(v) ? { integerValue: String(v) } : { stringValue: String(v) }]));
const fromDoc = (doc) => {
  const out = { id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = 'integerValue' in v ? Number(v.integerValue) : v.stringValue;
  return out;
};

async function request(url, body) {
  let res;
  try {
    res = await fetch(url, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
  } catch {
    throw new Error('Can’t reach the team database. Check your internet connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('The team database didn’t accept that.');
  if (res.status === 429) throw new Error('The team database hit its free daily limit. Try again tomorrow.');
  if (!res.ok) throw new Error('Something went wrong with the team database.');
  return data;
}

const addDoc = (collection, data) => request(`${DB}/${collection}?key=${API_KEY}`, { fields: toFields(data) });
const getDoc = (collection, id) => request(`${DB}/${collection}/${id}?key=${API_KEY}`).then(fromDoc);

// Lists a whole collection, fetching only the named fields.
async function listDocs(collection, fields) {
  const mask = fields.map((f) => `&mask.fieldPaths=${f}`).join('');
  const out = [];
  let pageToken = '';
  do {
    const data = await request(`${DB}/${collection}?key=${API_KEY}&pageSize=300${mask}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    out.push(...(data.documents || []).map(fromDoc));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Everything in a collection dated on or after a day.
async function since(collection, date) {
  const rows = await request(`${DB}:runQuery?key=${API_KEY}`, {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: date } } },
    },
  });
  return rows.filter((r) => r.document).map((r) => fromDoc(r.document));
}

// Past days don't change, so after the first load only today's data is fetched again.
// That keeps the shared screen well inside the database's free daily allowance.
const cache = { answers: [], checkins: [], events: [], loadedOn: null };
async function refreshTeamData() {
  const today = dayStr(new Date());
  const from = cache.loadedOn === today ? today : analysedFrom();
  const [answers, checkins, events] = await Promise.all([
    since('answers', from), since('checkins', from), listDocs('events', ['date', 'label']),
  ]);
  const keepOlder = (rows) => rows.filter((r) => r.date < from);
  cache.answers = [...keepOlder(cache.answers), ...answers];
  cache.checkins = [...keepOlder(cache.checkins), ...checkins];
  cache.events = events;
  cache.loadedOn = today;
}

// ---------- you (stored only in this browser) ----------
// A random id kept in this browser, used only to count the team goal. No names anywhere.
function deviceId() {
  let id = localStorage.getItem('mb-device');
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('mb-device', id);
  }
  return id;
}
const DEVICE = deviceId();
const myDays = () => JSON.parse(localStorage.getItem('mb-days') || '[]');

function streakFor(days) {
  const set = new Set(days);
  const today = startOfDay(new Date());
  let d = set.has(dayStr(today)) ? today : prevWorkday(today);
  let n = 0;
  while (set.has(dayStr(d))) { n++; d = prevWorkday(d); }
  return n;
}

async function checkIn(score) {
  const now = new Date();
  const today = dayStr(now);
  await addDoc('answers', { date: today, hour: now.getHours(), score });
  const days = myDays();
  if (!days.includes(today)) {
    days.push(today);
    localStorage.setItem('mb-days', JSON.stringify(days));
    await addDoc('checkins', { device: DEVICE, date: today }).catch(() => {}); // only feeds the team goal
  }
  return streakFor(days);
}

// ---------- surprises ----------
const BUILT_IN = [
  ['🐈‍⬛💨', 'Me leaving the 4pm meeting'],
  ['🦆', 'Rubber duck asks: have you tried turning it off and on again?'],
  ['🐢', 'Me waiting for the render to finish'],
  ['🦥', 'Friday afternoon energy'],
  ['🐕', 'Office dog approves your work'],
  ['🦖', 'Legacy code, but make it cute'],
].map(([emoji, caption], i) => ({ id: `built-in-${i}`, emoji, caption }));

async function surprisePool() {
  const team = await listDocs('memes', ['addedAt']);
  return team.length ? team : BUILT_IN; // the built-in emoji only fill in while the team hasn't added any
}

// Some links people paste are web pages around an image, not the image itself. Where we can, find the image.
function directImage(link) {
  try {
    const url = new URL(link);
    // Google Images result page: the real address is inside the link.
    if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === '/imgres' && url.searchParams.get('imgurl')) {
      return url.searchParams.get('imgurl');
    }
    // Giphy page, e.g. giphy.com/gifs/happy-cat-AbC123: the GIF lives at media.giphy.com.
    const giphy = /^\/gifs\/(?:.*-)?([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (/(^|\.)giphy\.com$/.test(url.hostname) && giphy) return `https://media.giphy.com/media/${giphy[1]}/giphy.gif`;
  } catch { /* not a link; leave it as it is */ }
  return link;
}

// Pasted links: add a missing https://, upgrade http://, and look through page links for the image.
function cleanLink(text) {
  const link = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  return directImage(link.replace(/^http:\/\//i, 'https://'));
}

// no-referrer: some sites refuse to show their images on other websites, and this hides which site is asking.
const loadsAsImage = (src) => new Promise((resolve) => {
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  const timer = setTimeout(() => resolve(false), 10000);
  img.onload = () => { clearTimeout(timer); resolve(true); };
  img.onerror = () => { clearTimeout(timer); resolve(false); };
  img.src = src;
});

async function pickMeme() {
  const all = await surprisePool().catch(() => BUILT_IN);
  const last = localStorage.getItem('mb-last-meme');
  const pool = all.length > 1 ? all.filter((m) => m.id !== last) : all;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  localStorage.setItem('mb-last-meme', pick.id);
  return pick.emoji ? pick : getDoc('memes', pick.id);
}

// ---------- sample data, so the wall has patterns from day one ----------
function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSampleData() {
  const rand = seededRandom(42);
  const firstMonday = addDays(mondayOf(new Date()), -7 * (WEEKS_ON_WALL - 1));
  const releases = [addDays(firstMonday, 7 + 3), addDays(firstMonday, 21 + 3)]; // Thursdays of weeks 2 and 4
  const events = releases.map((d) => ({ date: dayStr(d), label: 'Release' }));
  events.push({ date: dayStr(addDays(firstMonday, 14)), label: 'Sprint start' });

  const answers = [];
  for (let w = 0; w < WEEKS_ON_WALL - 1; w++) {
    for (let wd = 0; wd < 5; wd++) {
      const d = addDays(firstMonday, w * 7 + wd);
      const untilRelease = Math.min(99, ...releases.map((r) => daysBetween(d, r)).filter((n) => n >= 0));
      let base = 4.0;
      if (untilRelease === 0) base -= 2.3;
      else if (untilRelease <= 2) base -= 1.3;
      if (wd === 0) base -= 0.3;
      if (wd === 4) base += 0.5;
      const count = w === 2 && wd === 2 ? 2 : 4 + Math.floor(rand() * 3); // one quiet day stays grey
      for (let i = 0; i < count; i++) {
        const hour = 9 + Math.floor(rand() * 8);
        const mood = base - (hour >= 15 ? 0.5 : 0) + (rand() - 0.5) * 1.2;
        answers.push({ date: dayStr(d), hour, score: Math.max(1, Math.min(5, Math.round(mood))) });
      }
    }
  }
  return { answers, events };
}
const SAMPLE = makeSampleData();

// ---------- patterns and the team goal ----------
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const one = (x) => x.toFixed(1);

function findPatterns(answers, events) {
  if (answers.length < 15) return ['Not enough check-ins yet to spot patterns. Keep going!'];
  const out = [];
  const overall = mean(answers.map((a) => a.score));

  const byWeekday = {};
  for (const a of answers) (byWeekday[parseDay(a.date).getDay()] ||= []).push(a.score);
  const weekdays = Object.entries(byWeekday)
    .filter(([, v]) => v.length >= 5)
    .map(([wd, v]) => ({ wd: Number(wd), avg: mean(v) }));
  if (weekdays.length >= 3) {
    const low = weekdays.reduce((a, b) => (b.avg < a.avg ? b : a));
    const high = weekdays.reduce((a, b) => (b.avg > a.avg ? b : a));
    if (overall - low.avg >= 0.3) out.push(`${WEEKDAYS[low.wd]}s are the toughest day (average ${one(low.avg)} vs ${one(overall)} overall).`);
    if (high.avg - overall >= 0.3) out.push(`${WEEKDAYS[high.wd]}s feel best (average ${one(high.avg)}).`);
  }

  if (events.length) {
    const near = new Set();
    for (const e of events) {
      const d = parseDay(e.date);
      near.add(e.date).add(dayStr(prevWorkday(d))).add(dayStr(prevWorkday(prevWorkday(d))));
    }
    const nearScores = answers.filter((a) => near.has(a.date)).map((a) => a.score);
    const otherScores = answers.filter((a) => !near.has(a.date)).map((a) => a.score);
    if (nearScores.length >= 5 && otherScores.length >= 5) {
      const diff = mean(otherScores) - mean(nearScores);
      if (diff >= 0.3) out.push(`Mood drops in the run-up to work events: ${one(mean(nearScores))} in the 2 days before and on the day, vs ${one(mean(otherScores))} otherwise.`);
      if (diff <= -0.3) out.push(`Mood is higher around work events (${one(mean(nearScores))} vs ${one(mean(otherScores))} otherwise).`);
    }
  }

  const morning = answers.filter((a) => a.hour < 12).map((a) => a.score);
  const afternoon = answers.filter((a) => a.hour >= 12).map((a) => a.score);
  if (morning.length >= 5 && afternoon.length >= 5) {
    const diff = mean(morning) - mean(afternoon);
    if (diff >= 0.3) out.push(`Mornings feel better than afternoons (${one(mean(morning))} vs ${one(mean(afternoon))}).`);
    if (diff <= -0.3) out.push(`Afternoons feel better than mornings (${one(mean(afternoon))} vs ${one(mean(morning))}).`);
  }

  const days = [...new Set(answers.map((a) => a.date))].sort();
  const recent = new Set(days.slice(-10));
  const before = new Set(days.slice(-20, -10));
  if (before.size >= 5) {
    const r = mean(answers.filter((a) => recent.has(a.date)).map((a) => a.score));
    const b = mean(answers.filter((a) => before.has(a.date)).map((a) => a.score));
    if (r - b >= 0.3) out.push(`Trending up: the last 2 weeks average ${one(r)}, up from ${one(b)}.`);
    if (b - r >= 0.3) out.push(`Trending down: the last 2 weeks average ${one(r)}, down from ${one(b)}.`);
  }

  return out.length ? out : ['No clear patterns yet. Mood looks steady.'];
}

function goal() {
  const today = startOfDay(new Date());
  let workdays = 0;
  for (let d = new Date(today.getFullYear(), today.getMonth(), 1); d <= today; d = addDays(d, 1)) if (!isWeekend(d)) workdays++;
  const month = dayStr(today).slice(0, 7);
  const teamSize = Math.max(MIN_TEAM_SIZE, new Set(cache.checkins.map((c) => c.device)).size);
  const checkins = new Set(cache.checkins
    .filter((c) => c.date.startsWith(month) && !isWeekend(parseDay(c.date)))
    .map((c) => `${c.device} ${c.date}`)).size;
  const rate = workdays ? Math.min(1, checkins / (teamSize * workdays)) : 0;
  return { rate, target: TEAM_GOAL, teamSize, reached: rate >= TEAM_GOAL };
}

function wall(includeSample) {
  const from = analysedFrom();
  const answers = [...cache.answers, ...(includeSample ? SAMPLE.answers : [])].filter((a) => a.date >= from);
  const events = [...cache.events, ...(includeSample ? SAMPLE.events : [])];
  const byDay = {};
  for (const a of answers) (byDay[a.date] ||= []).push(a.score);
  const today = dayStr(new Date());
  const thisMonday = mondayOf(new Date());

  const weeks = [];
  for (let w = WEEKS_ON_WALL - 1; w >= 0; w--) {
    const monday = addDays(thisMonday, -7 * w);
    const days = [];
    for (let i = 0; i < 5; i++) {
      const date = dayStr(addDays(monday, i));
      const scores = byDay[date] || [];
      const shown = scores.length >= MIN_ANSWERS_TO_SHOW;
      days.push({
        date,
        count: scores.length,
        avg: shown ? Math.round(mean(scores) * 10) / 10 : null,
        mix: shown ? MOODS.map((m) => scores.filter((s) => s === m.score).length) : null, // answers per emoji
        future: date > today,
        events: events.filter((e) => e.date === date).map((e) => e.label),
      });
    }
    weeks.push({ label: `Week ${weekNumber(monday)}`, sub: `${monday.getDate()} ${MONTHS[monday.getMonth()]}`, days });
  }
  const recentEvents = events.filter((e) => e.date >= from);
  return { weeks, patterns: findPatterns(answers, recentEvents), goal: goal() };
}

// ---------- tabs ----------
const tabButtons = document.querySelectorAll('.tabs button');
function showTab(name) {
  tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (name === 'wall') loadWall();
  else loadMe();
}
tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- your streak ----------
function loadMe() {
  const days = myDays();
  renderStreak(streakFor(days), days.includes(dayStr(new Date())));
  surprisePool()
    .then((pool) => { $('#poolCount').textContent = `${pool.length} surprises in the pool so far.`; })
    .catch(() => { $('#poolCount').textContent = ''; });
}
function renderStreak(streak, checkedInToday) {
  $('#streak').textContent = streak > 0 ? `🔥 ${streak}-day streak` : 'No streak yet';
  $('#streakSub').textContent = checkedInToday ? 'You checked in today. Nice.' : 'Check in today to keep it going.';
}

// ---------- the random daily ping ----------
const todayKey = () => new Date().toDateString();
const isWeekendToday = () => isWeekend(new Date());

function pingTime() {
  const key = `mb-ping-${todayKey()}`;
  let t = Number(localStorage.getItem(key));
  if (!t) {
    const nine = new Date();
    nine.setHours(9, 0, 0, 0);
    t = nine.getTime() + Math.floor(Math.random() * 8 * 3600 * 1000); // somewhere between 9:00 and 17:00
    localStorage.setItem(key, String(t));
  }
  return t;
}
const pingDone = () => localStorage.getItem(`mb-pinged-${todayKey()}`) === '1';

function checkPing() {
  if (!isWeekendToday() && !pingDone() && Date.now() >= pingTime() && $('#ping').hidden) {
    localStorage.setItem(`mb-pinged-${todayKey()}`, '1');
    openPing();
  }
  $('#pingInfo').textContent = isWeekendToday()
    ? 'It’s the weekend. No pings today 🌴'
    : pingDone()
      ? 'Today’s surprise ping has been. Come back tomorrow, or use the button to check in again.'
      : 'Today’s ping is hiding somewhere between 9:00 and 17:00 🤫';
}

function openPing() {
  $('#gift').replaceChildren(el('span', { className: 'box', textContent: '🎁' }));
  $('#gift').className = 'gift';
  $('#giftCap').textContent = 'Something from your team is inside…';
  $('#askBlock').hidden = false;
  $('#doneBlock').hidden = true;
  $('#emo').replaceChildren(...MOODS.map((m) => el('button', {
    type: 'button',
    onclick: () => answer(m.score),
    ariaLabel: m.label,
  }, el('span', { className: 'e', textContent: m.emoji }), el('small', { textContent: m.label }))));
  $('#ping').hidden = false;
  $('#emo button').focus();
}
const closePing = () => { $('#ping').hidden = true; loadMe(); };

async function answer(score) {
  $('#emo').querySelectorAll('button').forEach((b) => { b.disabled = true; });
  let streak;
  try {
    streak = await checkIn(score);
  } catch (err) {
    $('#giftCap').textContent = err.message;
    $('#emo').querySelectorAll('button').forEach((b) => { b.disabled = false; });
    return;
  }
  $('#gift').classList.add('opening');
  const [meme] = await Promise.all([pickMeme().catch(() => null), new Promise((r) => setTimeout(r, 650))]);
  reveal(meme);
  $('#askBlock').hidden = true;
  $('#thanks').textContent = `Thanks! 🔥 ${streak}-day streak`;
  $('#doneBlock').hidden = false;
}

function reveal(meme) {
  const gift = $('#gift');
  gift.classList.remove('opening');
  gift.classList.add('open');
  if (!meme) {
    gift.replaceChildren(el('span', { className: 'emoji-meme', textContent: '🎉' }));
    $('#giftCap').textContent = 'Your answer is in. The surprise didn’t load this time.';
    return;
  }
  if (meme.emoji) {
    gift.replaceChildren(el('span', { className: 'emoji-meme', textContent: meme.emoji }));
  } else {
    const img = el('img', { referrerPolicy: 'no-referrer', src: directImage(meme.src), alt: meme.caption || 'A surprise from your team' });
    img.onerror = () => {
      gift.replaceChildren(el('span', { className: 'emoji-meme', textContent: '🙈' }));
      $('#giftCap').textContent = 'This surprise didn’t load. The link might not be a direct image.';
    };
    gift.replaceChildren(img);
  }
  $('#giftCap').textContent = meme.caption ? `“${meme.caption}”` : 'From a teammate';
}

$('#pingNow').addEventListener('click', openPing);
$('#pingClose').addEventListener('click', closePing);
$('#doneBtn').addEventListener('click', closePing);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#ping').hidden) closePing();
  else if (!$('#day').hidden) closeDay();
});

// ---------- team wall ----------
const moodFor = (avg) => MOODS[Math.min(4, Math.max(0, Math.round(avg) - 1))];
const prettyDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

async function loadWall() {
  try {
    await refreshTeamData();
  } catch (err) {
    $('#patterns').replaceChildren(el('li', { textContent: err.message }));
    return;
  }
  const data = wall($('#showSample').checked);
  $('#minAnswers').textContent = MIN_ANSWERS_TO_SHOW;

  const cells = [el('div'), ...HEADS.map((d) => el('div', { className: 'head', textContent: d }))];
  for (const week of data.weeks) {
    cells.push(el('div', { className: 'week' }, el('b', { textContent: week.label }), el('small', { textContent: week.sub })));
    for (const day of week.days) {
      let brick;
      if (day.future) {
        brick = el('div', { className: 'brick future', title: prettyDate(day.date) });
      } else if (day.avg == null) {
        brick = el('div', { className: 'brick grey', title: day.count ? `${prettyDate(day.date)}: too few answers to show` : `${prettyDate(day.date)}: no answers` });
      } else {
        const mood = moodFor(day.avg);
        const summary = `${prettyDate(day.date)}: average ${day.avg} (${mood.label}) from ${day.count} answers`;
        brick = el('button', {
          type: 'button', className: `brick m${mood.score}`, textContent: mood.emoji,
          title: `${summary}. Click for details.`, ariaLabel: `${summary}. Open details`,
          onclick: () => openDay(week, day),
        });
      }
      cells.push(el('div', { className: 'cell' }, brick, ...day.events.map((e) => el('span', { className: 'tag', textContent: e }))));
    }
  }
  $('#wall').replaceChildren(...cells);

  $('#legend').replaceChildren(
    ...MOODS.map((m) => el('span', {}, el('i', { className: `m${m.score}` }), `${m.emoji} ${m.label}`)),
    el('span', {}, el('i', { className: 'grey' }), 'too few answers'),
  );

  $('#patterns').replaceChildren(...data.patterns.map((p) => el('li', { textContent: p })));

  const { rate, target, teamSize, reached } = data.goal;
  $('#goalText').textContent = `${Math.round(rate * 100)}% of possible check-ins so far · goal ${Math.round(target * 100)}%`;
  $('#goalBar').style.width = `${Math.round(rate * 100)}%`;
  $('#goalTarget').style.left = `${Math.round(target * 100)}%`;
  $('#goalSub').textContent = reached
    ? 'Goal reached! Everyone unlocks a minifig badge 🏅'
    : `Reach ${Math.round(target * 100)}% and everyone unlocks a minifig badge 🏅 (counted for a team of ${teamSize})`;
}
// ---------- one day, up close ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
};
const moodColour = (score) => getComputedStyle(document.documentElement).getPropertyValue(`--mood-${score}`).trim();

function openDay(week, day) {
  const mood = moodFor(day.avg);
  $('#dayTitle').textContent = `${prettyDate(day.date)} · ${week.label}`;
  $('#dayEvents').replaceChildren(...day.events.map((e) => el('span', { className: 'tag', textContent: e })));
  $('#dayAvg').replaceChildren(
    el('span', { className: 'big', textContent: day.avg.toFixed(1) }),
    el('span', { className: 'muted', textContent: `${mood.emoji} ${mood.label} on average, from ${day.count} answers` }),
  );
  $('#day').hidden = false; // shown first, so the charts can measure their width
  $('#dayMix').replaceChildren(...mixChart(day.mix));
  weekChart(week, day);
  $('#dayClose').focus();
}
const closeDay = () => { $('#day').hidden = true; };
$('#dayClose').addEventListener('click', closeDay);
$('#day').addEventListener('click', (e) => { if (e.target.id === 'day') closeDay(); });

// How many people picked each emoji: one bar per mood, best at the top, count at the tip.
function mixChart(mix) {
  const most = Math.max(...mix);
  return [...MOODS].reverse().map((m) => {
    const n = mix[m.score - 1];
    return el('div', { className: 'mix-row', title: `${n} ${n === 1 ? 'answer' : 'answers'}: ${m.emoji} ${m.label}` },
      el('span', { className: 'mix-label', textContent: `${m.emoji} ${m.label}` }),
      el('span', { className: 'mix-track' },
        n ? el('span', { className: 'mix-bar', style: `width:calc((100% - 32px) * ${n / most});background:var(--mood-${m.score})` }) : '',
        el('span', { className: n ? 'mix-val' : 'mix-val muted', textContent: String(n) })));
  });
}

// The team's average for each workday of that week. Days with too few answers are left as gaps.
function weekChart(week, selected) {
  const box = $('#dayWeek');
  const W = Math.max(260, box.clientWidth);
  const H = 180;
  const pad = { l: 34, r: 16, t: 22, b: 28 };
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / 4;
  const y = (v) => pad.t + ((5 - v) * (H - pad.t - pad.b)) / 4;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Team average per day in ${week.label}` });

  for (const m of MOODS) { // hairline grid, with the emoji as the scale
    chart.append(
      svg('line', { x1: pad.l, x2: W - pad.r, y1: y(m.score), y2: y(m.score), class: 'grid' }),
      svg('text', { x: pad.l - 10, y: y(m.score) + 5, 'text-anchor': 'end', class: 'tick' }, m.emoji),
    );
  }

  let path = '';
  week.days.forEach((d, i) => {
    if (d.avg == null) return;
    const prev = week.days[i - 1];
    path += `${prev && prev.avg != null ? 'L' : 'M'}${x(i)},${y(d.avg)}`;
  });
  if (path) chart.append(svg('path', { d: path, class: 'line' }));

  week.days.forEach((d, i) => {
    const isSelected = d.date === selected.date;
    chart.append(svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: isSelected ? 'day sel' : 'day' }, HEADS[i]));
    if (d.avg == null) return;
    const mood = moodFor(d.avg);
    const point = svg('g', { class: 'pt', tabindex: 0, role: 'button', 'aria-label': `${prettyDate(d.date)}: average ${d.avg}` },
      svg('title', {}, `${prettyDate(d.date)}: average ${d.avg} (${mood.label}) from ${d.count} answers`),
      svg('circle', { cx: x(i), cy: y(d.avg), r: 14, class: 'hit' }),
      svg('circle', { cx: x(i), cy: y(d.avg), r: isSelected ? 7 : 5, fill: moodColour(mood.score), class: 'dot' }));
    if (isSelected) point.append(svg('text', { x: x(i), y: y(d.avg) - 12, 'text-anchor': 'middle', class: 'val' }, d.avg.toFixed(1)));
    const pick = () => openDay(week, d);
    point.addEventListener('click', pick);
    point.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    chart.append(point);
  });

  // The same numbers as text, so nobody has to hover to read them.
  const table = el('p', { className: 'week-table' }, ...week.days.flatMap((d, i) => [
    i ? ' · ' : '', el(d.date === selected.date ? 'b' : 'span', { textContent: `${HEADS[i]} ${d.avg == null ? '–' : d.avg.toFixed(1)}` }),
  ]));
  box.replaceChildren(chart, table);
}

$('#showSample').addEventListener('change', loadWall);
setInterval(() => { if (!$('#tab-wall').hidden) loadWall(); }, 30000); // live refresh for a shared screen

$('#eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const label = form.label.value.trim();
    if (!form.date.value || !label) throw new Error('Add a date and a name for the event.');
    await addDoc('events', { date: form.date.value, label });
    form.reset();
    $('#eventMsg').textContent = 'Added to the wall.';
    loadWall();
  } catch (err) {
    $('#eventMsg').textContent = err.message;
  }
});

// ---------- add a surprise ----------
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(file);
});

// Big photos are scaled down to fit in the database. GIFs can't be, or they'd stop moving.
async function imageForUpload(file) {
  const original = await readAsDataUrl(file);
  if (original.length <= MAX_IMAGE_CHARS) return original;
  if (file.type === 'image/gif') throw new Error('That GIF is too big to upload (max about 700 KB). Paste a link to it instead.');
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
  const canvas = el('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const small = canvas.toDataURL('image/jpeg', 0.82);
  if (small.length > MAX_IMAGE_CHARS) throw new Error('That image is too big to upload. Paste a link to it instead.');
  return small;
}

$('#memeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#memeMsg');
  const file = form.file.files[0];
  const pasted = form.url.value.trim();
  try {
    if (!file && !pasted) throw new Error('Paste a link or choose an image.');
    if (file && !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Only PNG, JPG, GIF or WebP images, please.');
    msg.textContent = 'Adding…';
    let src;
    if (file) {
      src = await imageForUpload(file);
    } else if (/^data:image\//i.test(pasted)) {
      // "Copy image address" on Google Images often copies the image itself as text, not a link.
      src = pasted.replace(/\s+/g, '');
      if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) throw new Error('Only PNG, JPG, GIF or WebP images, please.');
      if (src.length > MAX_IMAGE_CHARS) throw new Error('That image is too big. Save it and upload the file instead.');
    } else {
      src = cleanLink(pasted);
      let link;
      try { link = new URL(src); } catch { throw new Error('That doesn’t look like a link. Paste an image address, like https://…/cat.gif'); }
      if (/(^|\.)tenor\.com$/.test(link.hostname) && !/\.(gif|webp|png|jpe?g)$/i.test(link.pathname)) {
        throw new Error('That’s a Tenor page, not the GIF. Right-click the GIF and choose "Copy image address".');
      }
      if (!(await loadsAsImage(src))) {
        throw new Error('That link didn’t load as an image. Right-click the image itself and choose "Copy image address", or save it and upload the file.');
      }
    }
    await addDoc('memes', { src, caption: form.caption.value.trim().slice(0, 80), addedAt: dayStr(new Date()) });
    form.reset();
    msg.textContent = 'Added! Someone will unwrap it after their next check-in 🎁';
    loadMe();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---------- start ----------
loadMe();
checkPing();
setInterval(checkPing, 30000);
