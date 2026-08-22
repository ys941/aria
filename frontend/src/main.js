// Aria — app shell: Home (rooms) → Connect (design your Reachy) → Call.
import { ReachyTwin } from './reachy3d.js';
import { HeroReachy } from './hero.js';
import { openRadio, closeRadio } from './radio.js';
import { openExplainer } from './explainer.js';
import './styles.css';
import './themes.css';

const $ = (id) => document.getElementById(id);
const views = { home: $('view-home'), connect: $('view-connect'), call: $('view-call'), admin: $('view-admin'), radio: $('view-radio') };
const nav = $('nav');
const statusEl = $('status');
const grid = $('grid');
const spotlight = $('spotlight');
const spotMain = $('spotMain');
const spotStrip = $('spotStrip');

let hero = null;
let ws = null; // show transport: WebSocket streaming WAV clips
let audioCtx = null;
let layout = 'grid';
let activeId = null;
const cards = new Map();
let currentRoom = null;
let currentGuestId = null; // this viewer's guest Reachy in the current room
let userReachy = loadUserReachy();
let allRooms = [];
const UGC_ENABLED = true; // design-your-Reachy (AI stylist + 3D preview) is live; live room publish still gated server-side
const STYLE_SLOTS = ['hat', 'face', 'neck'];
const CURATED = {
  hat: ['wizard', 'cowboy', 'tophat', 'crown', 'party', 'pirate', 'viking',
        'propeller', 'santa', 'halo', 'baseball'],
  face: ['sunglasses', 'monocle', 'skigoggles'],
  neck: ['bowtie', 'necktie'],
};

// Apply AI/manual wardrobe + shell tint to a twin; polls until the URDF is ready.
function applyStyleWhenReady(twin, style) {
  const go = () => {
    for (const slot of STYLE_SLOTS)
      twin.setProp(slot, style[slot] ? `/props/${style[slot]}.glb` : null);
    if ('bodyColor' in style) twin.setBodyTint(style.bodyColor || null);
  };
  if (twin?.head && twin._headRestWorldQuat) return go();
  let n = 0;
  const iv = setInterval(() => {
    if (twin?._disposed || ++n > 80) return clearInterval(iv);
    if (twin?.head && twin._headRestWorldQuat) { clearInterval(iv); go(); }
  }, 80);
}

// ------------------------------------------------------------------ helpers
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
function loadUserReachy() {
  try { return JSON.parse(localStorage.getItem('userReachy') || 'null'); } catch { return null; }
}
function saveUserReachy(r) { userReachy = r; localStorage.setItem('userReachy', JSON.stringify(r)); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function initials(name) { return (name || '?').trim().slice(0, 1).toUpperCase(); }

// If WebGL is unavailable (privacy settings, old drivers, VMs) three.js THROWS.
// The show must go on without the 3D twin: audio, subtitles and nameplates all
// still work — the twin pane just stays empty.
function safeTwin(host, opts) {
  try {
    return new ReachyTwin(host, opts);
  } catch (e) {
    console.warn('[aria] WebGL unavailable, card runs without a 3D twin:', e?.message);
    return { level: 0, setLevel(l) { this.level = l; }, setBackstage() {}, setProp() {}, setBodyTint() {}, dispose() {} };
  }
}

// ------------------------------------------------------------------ routing
function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name);
  renderNav(name);
  if (name === 'radio') openRadio();
  else closeRadio();
  if (name === 'home') {
    if (!hero) { try { hero = new HeroReachy($('hero3d')); } catch { hero = null; } }
  } else if (hero) {
    hero.dispose();
    hero = null;
  }
}
function renderNav(name) {
  nav.innerHTML = '';
  if (name === 'call') {
    const b = el('button', 'btn btn-ghost btn-sm', '← Leave room');
    b.onclick = leaveCall;
    nav.appendChild(b);
  } else if (name === 'radio') {
    const b = el('button', 'btn btn-ghost btn-sm', '← Leave the station');
    b.onclick = () => { history.replaceState(null, '', location.pathname); showView('home'); };
    nav.appendChild(b);
  } else if (name === 'connect' || name === 'admin') {
    const b = el('button', 'btn btn-ghost btn-sm', '← Back');
    b.onclick = () => showView('home');
    nav.appendChild(b);
  } else if (UGC_ENABLED && userReachy) {
    const chip = el('div', 'eyebrow', `✦ ${userReachy.name}`);
    chip.style.cursor = 'pointer';
    chip.title = 'Edit your Reachy';
    chip.onclick = startConnect;
    nav.appendChild(chip);
  }
}
$('brand').onclick = () => (ws ? leaveCall() : showView('home'));

// ------------------------------------------------------------------ rooms list
async function loadRooms() {
  try {
    const { rooms } = await api('/api/rooms');
    allRooms = rooms;
  } catch {}
  updateShowButtons();
  renderLiveRooms();
}
function renderLiveRooms() {
  const host = $('liveRooms');
  const rail = $('liveRail');
  if (!host || !rail) return;
  const extras = allRooms.filter((r) => r.id !== 'hot-dog-court' && r.id !== 'the-podcast');
  rail.classList.toggle('hidden', extras.length === 0);
  const q = ($('lrSearch')?.value || '').trim().toLowerCase();
  const shown = extras
    .filter((r) => !q || `${r.title} ${r.topic}`.toLowerCase().includes(q))
    .sort((a, b) => (b.live - a.live) || (b.viewers || 0) - (a.viewers || 0) || a.title.localeCompare(b.title));
  $('lrCount').textContent = extras.length > 1 ? String(extras.length) : '';
  host.innerHTML = '';
  if (!shown.length && q) {
    host.appendChild(el('span', 'lr-empty', 'no shows match — start one ↑'));
    return;
  }
  shown.slice(0, 20).forEach((r, i) => {
    const c = el('button', 'lr-card');
    c.style.animationDelay = `${Math.min(i, 8) * 45}ms`;
    const emoji = el('span', 'lc-emoji'); emoji.textContent = r.emoji || '✨';
    const body = el('span', 'lc-body');
    const title = el('span', 'lc-title'); title.textContent = r.title;
    const topic = el('span', 'lc-topic'); topic.textContent = r.topic || 'live generated show';
    body.append(title, topic);
    const meta = el('span', 'lc-meta');
    meta.append(el('span', 'd' + (r.live ? ' on' : '')), document.createTextNode(` ${r.viewers || 0}`));
    c.append(emoji, body, meta);
    c.onclick = () => joinRoom(r);
    host.appendChild(c);
  });
}
$('lrSearch')?.addEventListener('input', renderLiveRooms);

// ------------------------------------------------------------------ new show
const TOPIC_IDEAS = [
  'Is a hot dog a sandwich?',
  'Should robots get weekends off?',
  'The best era of video game music, defended to the death',
  'Pineapple on pizza: culinary crime or misunderstood genius?',
  'If you could delete one app from existence, which and why?',
  'Are we living in a simulation, and is it well-optimised?',
  'Cats vs dogs, but the robots have strong opinions',
  'What would robots put in a time capsule for the year 3000?',
  'The most overrated invention of all time',
  'Could a toaster ever achieve true happiness?',
  'Tabs or spaces — settle it forever',
  'Is cereal a soup? A rigorous investigation',
];

$('newShowBtn').onclick = () => {
  const back = el('div', 'modal-back');
  const card = el('div', 'connect-card modal-card');
  card.innerHTML = `
    <h2>Start a new show</h2>
    <p class="sub">Give the robots a topic — they'll write the script, design their own
    voices and go live.</p>
    <div class="field"><label>Format</label>
      <div class="chips" id="nsFormat">
        <button class="chip on" data-f="show">🎙️ Podcast</button>
        <button class="chip" data-f="practice">🎓 English practice</button>
      </div>
    </div>
    <div class="field" id="nsTitleField"><label>Show title</label><input class="input" id="nsTitle" placeholder="e.g. Midnight Philosophy" /></div>
    <div class="field" id="nsTopicField">
      <label>Topic <button type="button" class="ns-surprise" id="nsSurprise">🎲 surprise me</button></label>
      <textarea class="textarea" id="nsTopic" placeholder="What should they argue about?"></textarea>
    </div>
    <div class="field" id="nsLangField"><label>Language</label>
      <div class="chips" id="nsLang">
        <button class="chip on" data-lang="English">🇬🇧 English</button>
        <button class="chip" data-lang="Hindi">🇮🇳 हिन्दी Hindi</button>
      </div>
    </div>
    <div class="field" id="nsToneField">
      <label>Tone <span class="ns-opt">— optional</span></label>
      <div class="chips" id="nsTone">
        <button class="chip on" data-tone="">✨ Default</button>
        <button class="chip" data-tone="unbiased">⚖️ Unbiased</button>
        <button class="chip" data-tone="friendly">😊 Friendly</button>
        <button class="chip" data-tone="professional">💼 Professional</button>
      </div>
    </div>
    <div class="field hidden" id="nsPracticeField">
      <label>Scenario</label>
      <select class="input" id="nsScenario">
        <option value="Ordering coffee and making small talk at a café.">☕ Café — order &amp; small talk</option>
        <option value="A job interview, answering common interview questions.">💼 Job interview</option>
        <option value="Checking in at an airport and asking about a delayed flight.">✈️ Airport check-in</option>
        <option value="Describing symptoms and concerns at a doctor's appointment.">🏥 Doctor's visit</option>
        <option value="Introducing yourself and your work at a business meeting.">🤝 Business meeting</option>
        <option value="Calling customer service about a wrong online order.">📞 Customer service call</option>
        <option value="Asking strangers for directions in a new city.">🧭 Asking for directions</option>
        <option value="Everyday friendly small talk about weekend plans and hobbies.">💬 Everyday small talk</option>
      </select>
      <label style="margin-top:12px">Level</label>
      <select class="input" id="nsLevel">
        <option value="beginner">Beginner</option>
        <option value="intermediate" selected>Intermediate</option>
        <option value="advanced">Advanced</option>
      </select>
      <div class="ns-hint">One robot coaches while another role-plays the scene and gets gently corrected — pure speaking practice.</div>
    </div>
    <div class="field" id="nsModeField"><label>Cast</label>
      <div class="chips" id="nsMode">
        <button class="chip on" data-m="sim">🤖 Simulated Reachys — starts right away</button>
        <button class="chip" data-m="physical">📡 Physical Reachys — green room first</button>
      </div>
    </div>
    <div class="field" id="nsCountField">
      <label><span id="nsCountLabel">How many robots?</span> <span class="ns-cval" id="nsCval"></span></label>
      <div class="ns-bots" id="nsBots"></div>
      <input type="range" id="nsCount" min="2" max="5" step="1" value="3" />
      <div class="ns-hint" id="nsCountHint"></div>
    </div>
    <div class="connect-nav">
      <button class="btn btn-ghost" id="nsCancel">Cancel</button>
      <button class="btn btn-primary" id="nsGo">Go live →</button>
    </div>`;
  back.appendChild(card);
  document.body.appendChild(back);
  card.querySelector('#nsTitle').focus();

  let mode = 'sim';
  const slider = card.querySelector('#nsCount');

  // the count slider re-ranges per mode: sim picks the whole cast (2-5),
  // physical picks the virtual robots added around the real ones (1-4)
  const renderCount = () => {
    const n = +slider.value;
    const bots = card.querySelector('#nsBots');
    const max = +slider.max;
    bots.innerHTML = '';
    for (let i = 1; i <= max; i++) {
      const b = el('span', 'ns-bot' + (i <= n ? ' on' : ''));
      b.textContent = '🤖';
      bots.appendChild(b);
    }
    card.querySelector('#nsCval').textContent = mode === 'physical'
      ? `${n} simulated`
      : `${n} robots`;
    card.querySelector('#nsCountHint').textContent = mode === 'physical'
      ? 'Your physical Reachys join on top of these in the green room.'
      : 'A show needs 2–5 robots.';
  };
  const setMode = (m) => {
    mode = m;
    card.querySelectorAll('#nsMode .chip').forEach((x) => x.classList.toggle('on', x.dataset.m === m));
    card.querySelector('#nsGo').textContent = m === 'physical' ? 'Open the green room →' : 'Go live →';
    card.querySelector('#nsCountLabel').textContent = m === 'physical' ? 'Add simulated robots' : 'How many robots?';
    if (m === 'physical') { slider.min = 1; slider.max = 4; if (+slider.value > 4) slider.value = 4; }
    else { slider.min = 2; slider.max = 5; if (+slider.value < 2) slider.value = 2; }
    renderCount();
  };
  card.querySelectorAll('#nsMode .chip').forEach((c) => { c.onclick = () => setMode(c.dataset.m); });
  slider.oninput = renderCount;
  card.querySelector('#nsSurprise').onclick = () => {
    const t = card.querySelector('#nsTopic');
    t.value = TOPIC_IDEAS[(Math.random() * TOPIC_IDEAS.length) | 0];
    t.focus();
  };
  setMode('sim');

  // format toggle: 🎙️ Podcast (comedy writer) vs 🎓 English practice (educational writer)
  let format = 'show';
  const setFormat = (f) => {
    format = f;
    const practice = f === 'practice';
    card.querySelectorAll('#nsFormat .chip').forEach((x) => x.classList.toggle('on', x.dataset.f === f));
    card.querySelector('#nsTitleField').classList.toggle('hidden', practice);
    card.querySelector('#nsTopicField').classList.toggle('hidden', practice);
    card.querySelector('#nsPracticeField').classList.toggle('hidden', !practice);
    card.querySelector('#nsModeField').classList.toggle('hidden', practice);
    // English-practice is English-only with its own coaching tone — hide both
    card.querySelector('#nsLangField').classList.toggle('hidden', practice);
    card.querySelector('#nsToneField').classList.toggle('hidden', practice);
    if (practice) { setMode('sim'); if (+slider.value > 3) { slider.value = 3; renderCount(); } }
    card.querySelector('#nsGo').textContent = practice ? 'Start lesson →'
      : (mode === 'physical' ? 'Open the green room →' : 'Go live →');
  };
  card.querySelectorAll('#nsFormat .chip').forEach((c) => { c.onclick = () => setFormat(c.dataset.f); });

  // language (default English, + Hindi) and optional tone — single-select chip rows
  let language = 'English';
  let tone = '';
  card.querySelectorAll('#nsLang .chip').forEach((c) => {
    c.onclick = () => {
      language = c.dataset.lang;
      card.querySelectorAll('#nsLang .chip').forEach((x) => x.classList.toggle('on', x === c));
    };
  });
  card.querySelectorAll('#nsTone .chip').forEach((c) => {
    c.onclick = () => {
      tone = c.dataset.tone;
      card.querySelectorAll('#nsTone .chip').forEach((x) => x.classList.toggle('on', x === c));
    };
  });

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const submit = async () => {
    let title, topic, useMode = mode, emoji;
    if (format === 'practice') {
      const scen = card.querySelector('#nsScenario');
      const level = card.querySelector('#nsLevel').value;
      const label = scen.options[scen.selectedIndex].text.replace(/^[^A-Za-z]+/, '').trim();
      title = `English Practice · ${label}`;
      topic = `[[PRACTICE|${level}]] ${scen.value}`;
      useMode = 'sim';
      emoji = '🎓';
    } else {
      title = card.querySelector('#nsTitle').value.trim() || 'Untitled show';
      topic = card.querySelector('#nsTopic').value.trim();
      if (!topic) { card.querySelector('#nsTopic').focus(); return; }
      emoji = mode === 'physical' ? '📡' : '✨';
    }
    const go = card.querySelector('#nsGo');
    go.disabled = true;
    go.textContent = format === 'practice' ? 'Preparing the lesson…' : 'Clearing it with standards…';
    try {
      const { room } = await api('/api/rooms', {
        method: 'POST',
        body: {
          title, topic, emoji, template: 'open', mode: useMode, simCount: +slider.value,
          // practice mode is always English with its own coaching tone
          language: format === 'practice' ? 'English' : language,
          tone: format === 'practice' ? '' : tone,
        },
      });
      close();
      joinRoom(room);
    } catch (e) {
      go.disabled = false;
      go.textContent = format === 'practice' ? 'Start lesson →'
        : (mode === 'physical' ? 'Open the green room →' : 'Go live →');
      card.querySelector('.sub').textContent = `Could not create the show: ${e.message}`;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  };
  document.addEventListener('keydown', onKey);
  card.querySelector('#nsCancel').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  card.querySelector('#nsGo').onclick = submit;
};
const showRoom = (id) => allRooms.find((r) => r.id === id);
function updateShowButtons() {
  const label = (base, r) => (r && r.live && r.viewers ? `${base} · ${r.viewers} watching` : base);
  if ($('showGroup')) $('showGroup').textContent = label('The group chat', showRoom('hot-dog-court'));
  if ($('showPodcast')) $('showPodcast').textContent = label('The podcast', showRoom('the-podcast'));
}
async function joinById(id) {
  if (!allRooms.length) await loadRooms();
  const r = showRoom(id);
  if (r) joinRoom(r);
}
$('showGroup').onclick = () => joinById('hot-dog-court');
$('showPodcast').onclick = () => joinById('the-podcast');
if ($('showRadio')) $('showRadio').onclick = () => { location.hash = '#radio'; };

// ------------------------------------------------------------------ connect flow
$('connectBtn').onclick = startConnect;
const PERSONA_PRESETS = ['Stoic philosopher', 'Hyperactive hype-bot', 'Noir detective', 'Cosmic stoner', 'Victorian butler', 'Conspiracy raccoon'];
const VOICE_PRESETS = ['Deep & gravelly', 'Bright & fast', 'Calm British butler', 'Slurring rum-soaked pirate', 'Old raspy sage', 'Laid-back surfer drawl'];
const COLORS = ['#49e6c8', '#6c7bff', '#ff8c42', '#f2c14e', '#7bbf6a', '#ff6b8b', '#a78bfa', '#37b3c9'];
// shell tints multiply the white plastic — keep them light so shading survives
const BODY_COLORS = ['', '#ffd9c4', '#cfe6ff', '#d9f4d4', '#f6d9e8', '#efe6c8', '#d9d4f4', '#c9ced6'];
let cfg = null;
let cfgStep = 0;
let configTwin = null;

function startConnect() {
  cfg = userReachy
    ? { ...userReachy }
    : { name: '', color: COLORS[0], persona: '', voice: '' };
  cfgStep = 0;
  showView('connect');
  renderStep();
}
function setSteps() {
  $('steps').querySelectorAll('.step').forEach((s, i) => s.classList.toggle('on', i <= cfgStep));
}
function disposeConfigTwin() {
  if (configTwin) { configTwin.dispose(); configTwin = null; }
}
function renderStep() {
  setSteps();
  disposeConfigTwin();
  const m = $('connect-mount');
  if (cfgStep === 0) {
    m.innerHTML = `
      <h2>Name your Reachy</h2>
      <p class="sub">This is the robot you'll bring on air.</p>
      <div class="field"><label>Name</label><input class="input" id="cfgName" placeholder="e.g. Nova" value="${cfg.name || ''}" /></div>
      <div class="field"><label>Accent colour</label><div class="swatches" id="cfgColors"></div></div>
      <div class="field"><label>Shell colour</label><div class="swatches" id="cfgBody"></div></div>`;
    const sw = m.querySelector('#cfgColors');
    COLORS.forEach((c) => {
      const s = el('div', 'swatch' + (c === cfg.color ? ' on' : ''));
      s.style.background = c;
      s.onclick = () => { cfg.color = c; sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on')); s.classList.add('on'); };
      sw.appendChild(s);
    });
    const bw = m.querySelector('#cfgBody');
    BODY_COLORS.forEach((c) => {
      const s = el('div', 'swatch' + ((cfg.bodyColor || '') === c ? ' on' : ''));
      s.style.background = c || '#f2efe9';
      s.title = c ? '' : 'stock white';
      s.onclick = () => { cfg.bodyColor = c; bw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on')); s.classList.add('on'); };
      bw.appendChild(s);
    });
    m.querySelector('#cfgName').oninput = (e) => (cfg.name = e.target.value);
  } else if (cfgStep === 1) {
    m.innerHTML = `
      <h2>Give it a personality</h2>
      <p class="sub">A line or two — like the system prompt for its brain.</p>
      <div class="field">
        <label>Personality</label>
        <textarea class="textarea" id="cfgPersona" placeholder="A weary detective who's seen too much and trusts no one.">${cfg.persona || ''}</textarea>
        <div class="chips" id="cfgPChips"></div>
      </div>`;
    chipFill(m.querySelector('#cfgPChips'), PERSONA_PRESETS, (v) => { cfg.persona = v; m.querySelector('#cfgPersona').value = v; });
    m.querySelector('#cfgPersona').oninput = (e) => (cfg.persona = e.target.value);
  } else if (cfgStep === 2) {
    m.innerHTML = `
      <h2>Design its voice</h2>
      <p class="sub">Describe how it should sound — fed to Qwen3-TTS voice design.</p>
      <div class="field">
        <label>Voice</label>
        <textarea class="textarea" id="cfgVoice" placeholder="Deep, gravelly, slow and menacing, with a faint rasp.">${cfg.voice || ''}</textarea>
        <div class="chips" id="cfgVChips"></div>
      </div>`;
    chipFill(m.querySelector('#cfgVChips'), VOICE_PRESETS, (v) => { cfg.voice = v; m.querySelector('#cfgVoice').value = v; });
    m.querySelector('#cfgVoice').oninput = (e) => (cfg.voice = e.target.value);
  } else {
    m.innerHTML = `
      <h2>Meet ${cfg.name || 'your Reachy'}</h2>
      <p class="sub">Let the AI stylist dress it from your description — or pick a hat yourself.</p>
      <div id="config-twin"></div>
      <div class="style-row">
        <button class="btn btn-primary btn-sm" id="styleBtn">✨ Auto-style with AI</button>
        <span class="style-reason" id="styleReason"></span>
      </div>
      <div class="field"><label>Hat</label><div class="chips" data-slot="hat"></div></div>
      <div class="field"><label>Face</label><div class="chips" data-slot="face"></div></div>
      <div class="field"><label>Neck</label><div class="chips" data-slot="neck"></div></div>
      <div class="review-row"><div class="k">Name</div><div class="v">${cfg.name || '—'}</div></div>
      <div class="review-row"><div class="k">Personality</div><div class="v">${cfg.persona || '—'}</div></div>
      <div class="review-row"><div class="k">Voice</div><div class="v">${cfg.voice || '—'}</div></div>`;
    configTwin = safeTwin(m.querySelector('#config-twin'), {
      accent: cfg.color, interactive: true, bodyColor: cfg.bodyColor || null,
    });
    applyStyleWhenReady(configTwin, cfg);
    m.querySelector('#config-twin').insertAdjacentHTML('beforeend',
      '<span class="twin-hint">drag to rotate · scroll to zoom · double-click to reset</span>');

    const repaint = () => STYLE_SLOTS.forEach((slot) =>
      m.querySelectorAll(`.chips[data-slot="${slot}"] .chip`).forEach((x) => x.classList.toggle('on', x.dataset.v === cfg[slot])));
    STYLE_SLOTS.forEach((slot) => {
      const host = m.querySelector(`.chips[data-slot="${slot}"]`);
      CURATED[slot].forEach((name) => {
        const c = el('button', 'chip' + (cfg[slot] === name ? ' on' : ''), name);
        c.dataset.v = name;
        c.onclick = () => {
          cfg[slot] = cfg[slot] === name ? null : name;
          repaint();
          configTwin.setProp(slot, cfg[slot] ? `/props/${cfg[slot]}.glb` : null);
        };
        host.appendChild(c);
      });
    });

    m.querySelector('#styleBtn').onclick = async () => {
      const btn = m.querySelector('#styleBtn'), reason = m.querySelector('#styleReason');
      btn.disabled = true;
      reason.textContent = 'the stylist is thinking…';
      try {
        const desc = `${cfg.name}. Personality: ${cfg.persona}. Voice: ${cfg.voice}`;
        const r = await api('/api/style-reachy', { method: 'POST', body: { description: desc } });
        STYLE_SLOTS.forEach((slot) => (cfg[slot] = r[slot] || null));
        if (r.color) { cfg.color = r.color; }
        applyStyleWhenReady(configTwin, cfg);
        repaint();
        reason.textContent = r.reason || 'styled ✓';
      } catch {
        reason.textContent = 'stylist unavailable — pick accessories below';
      }
      btn.disabled = false;
    };
  }

  const navRow = el('div', 'connect-nav');
  const back = el('button', 'btn btn-ghost', cfgStep === 0 ? 'Cancel' : '← Back');
  back.onclick = () => {
    if (cfgStep === 0) { disposeConfigTwin(); showView('home'); }
    else { cfgStep--; renderStep(); }
  };
  const next = el('button', 'btn btn-primary', cfgStep === 3 ? '✦ Save Reachy' : 'Next →');
  next.onclick = () => {
    if (cfgStep === 0 && !cfg.name.trim()) { m.querySelector('#cfgName').focus(); return; }
    if (cfgStep < 3) { cfgStep++; renderStep(); }
    else {
      saveUserReachy({
        name: cfg.name.trim(), color: cfg.color, persona: cfg.persona.trim(),
        voice: cfg.voice.trim(), hat: cfg.hat || null, face: cfg.face || null, neck: cfg.neck || null,
        bodyColor: cfg.bodyColor || null,
      });
      disposeConfigTwin();
      showView('home');
      loadRooms();
      statusEl.textContent = `✦ ${userReachy.name} is styled and saved.`;
    }
  };
  navRow.append(back, next);
  m.appendChild(navRow);
}
function chipFill(host, presets, onPick) {
  presets.forEach((p) => {
    const c = el('button', 'chip', p);
    c.onclick = () => onPick(p);
    host.appendChild(c);
  });
}

// ------------------------------------------------------------------ call: cards + layout
function parseMeta(p) { try { return p.metadata ? JSON.parse(p.metadata) : {}; } catch { return {}; } }

function ensureCard(participant) {
  if (cards.has(participant.identity)) return cards.get(participant.identity);
  const meta = parseMeta(participant);
  const accent = meta.color || '#49e6c8';
  const card = el('div', 'card');
  card.style.setProperty('--accent', accent);
  card.innerHTML = `
    <div class="twin"></div>
    <div class="speaking-ring"></div>
    <div class="nameplate"><span class="dot"></span><span class="name"></span><span class="persona"></span></div>`;
  card.querySelector('.name').textContent = participant.name || participant.identity;
  card.querySelector('.persona').textContent = meta.persona || '';
  (layout === 'spotlight' ? spotStrip : grid).appendChild(card);
  const twin = safeTwin(card.querySelector('.twin'), { accent, bodyColor: meta.bodyColor || null });
  if (meta.hat || meta.face || meta.neck) applyStyleWhenReady(twin, meta); // generated casts dress themselves
  const entry = { el: card, twin, analyser: null, data: null };
  cards.set(participant.identity, entry);
  applyLayout(true);
  stopConnecting(); // first robot on stage → the patching-in overlay bows out
  return entry;
}

// ------------------------------------------------------------------ green room (waiting for robots)
function deviceCount() {
  // physical-Reachy presence rode the old WebRTC transport; the WebSocket show
  // is sim-cast only, so no live device count to report here
  return 0;
}
let greenSimCount = 3;
function updateGreenRoom() {
  const n = deviceCount();
  const count = $('grCount'), start = $('grStart');
  if (!count) return;
  const total = Math.min(5, n + greenSimCount);
  count.innerHTML = n === 0
    ? `no robots connected yet — <b>${greenSimCount} simulated</b> will host`
    : `<b>${n} physical</b> + <b>${greenSimCount} simulated</b> = cast of ${total}`;
  count.classList.toggle('on', n > 0);
  start.textContent = n === 0 ? `Start with ${greenSimCount} simulated robots` : `Start the show (${total} robots)`;
}
function openGreenRoom(r) {
  const room = $('greenRoom');
  if (!room) return;
  greenSimCount = r.simCount || 3;
  room.classList.remove('hidden');
  $('grRoomId').textContent = r.id;
  $('grCmd').textContent = `./aria-reachy -room ${r.id} -name "My Reachy"`;
  const copyBtn = (btnId, getText) => {
    $(btnId).onclick = () => {
      navigator.clipboard?.writeText(getText());
      $(btnId).textContent = 'copied ✓';
      setTimeout(() => ($(btnId).textContent = 'copy'), 1400);
    };
  };
  copyBtn('grCopyId', () => r.id);
  copyBtn('grCopy', () => $('grCmd').textContent);
  $('grStart').onclick = async () => {
    const b = $('grStart');
    b.disabled = true;
    b.textContent = 'Starting…';
    try {
      await api(`/api/rooms/${r.id}/start`, { method: 'POST' });
      stopGreenRoom();
      startWritingRoom();
    } catch (e) {
      b.disabled = false;
      $('grCount').textContent = `could not start: ${e.message}`;
    }
  };
  updateGreenRoom();
}
function stopGreenRoom() {
  const b = $('grStart');
  if (b) b.disabled = false;
  $('greenRoom')?.classList.add('hidden');
}

// ------------------------------------------------------------------ writers' room (pre-show)
const WR_LINES = [
  'INT. ARIA STUDIO — NIGHT',
  'The robots shuffle their index cards.',
  'WRITERS: arguing about the cold open…',
  'CASTING: auditioning tiny robots…',
  'WARDROBE: a heated debate about hats.',
  'SOUND DEPT: designing voices from scratch…',
  'DIRECTOR: places, everyone. places!',
  'Someone unplugged the coffee machine.',
  'FINAL TOUCHES: polishing the punchlines…',
];
let wrTimer = null;
let wrThoughts = null;
function startWritingRoom() {
  const room = $('writingRoom');
  if (!room) return;
  room.classList.remove('hidden');
  $('wrStatus').textContent = 'the writers’ room is drafting the script…';
  // doodles drift out of the writers' card while the script cooks
  clearInterval(wrThoughts);
  const WR_EMOJI = ['💭', '✍️', '📝', '☕', '💡', '🎬', '🎩'];
  wrThoughts = setInterval(() => {
    const host = room.querySelector('.wr-card');
    if (host) spawnThought(host, WR_EMOJI[(Math.random() * WR_EMOJI.length) | 0]);
  }, 1500);
  let li = 0;
  const typeLine = () => {
    const target = WR_LINES[li % WR_LINES.length];
    li++;
    let i = 0;
    const tick = () => {
      $('wrTyping').textContent = target.slice(0, ++i);
      if (i < target.length) wrTimer = setTimeout(tick, 34 + Math.random() * 40);
      else wrTimer = setTimeout(typeLine, 1700); // hold, then next line
    };
    tick();
  };
  typeLine();
}
function stopWritingRoom() {
  clearTimeout(wrTimer);
  wrTimer = null;
  clearInterval(wrThoughts);
  wrThoughts = null;
  $('writingRoom')?.classList.add('hidden');
}

// ------------------------------------------------------------------ patching-in (join choreography)
// The view flips to the call INSTANTLY on click; this overlay narrates the real
// steps (join → token → SFU → cast walking in) while skeleton robots bob.
let connecting = false;
let cnSlowTimer = null;
function setConnStatus(text) {
  const el = $('cnStatus');
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }],
    { duration: 260, easing: 'cubic-bezier(.4,0,.2,1)' });
}
function setLivePill(state) { // 'standby' | 'live'
  const pill = $('livePill');
  if (!pill) return;
  pill.classList.toggle('standby', state === 'standby');
  const t = $('livePillText');
  if (t) t.textContent = state === 'standby' ? 'STANDBY' : 'LIVE';
}
let cnFading = false;
function startConnecting() {
  connecting = true;
  cnFading = false;
  const ov = $('connecting');
  ov?.getAnimations({ subtree: true }).forEach((a) => a.cancel()); // clear a leftover fade
  $('cnActions')?.classList.add('hidden');
  ov?.classList.remove('hidden');
  setLivePill('standby');
  setConnStatus('finding the studio…');
  clearTimeout(cnSlowTimer);
  cnSlowTimer = setTimeout(() => {
    if (connecting) setConnStatus('the studio is taking a moment — robots are waking…');
  }, 12000);
}
function stopConnecting() {
  connecting = false;
  clearTimeout(cnSlowTimer);
  setLivePill('live');
  const ov = $('connecting');
  // every arriving robot card calls this — only the FIRST starts the fade,
  // the rest must not restart it or the exit stutters
  if (!ov || ov.classList.contains('hidden') || cnFading) return;
  cnFading = true;
  const ease = 'cubic-bezier(.4,0,.2,1)';
  const fade = ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: ease, fill: 'forwards' });
  ov.querySelector('.cn-card')?.animate(
    [{ transform: 'none' }, { transform: 'translateY(-10px) scale(0.98)' }],
    { duration: 450, easing: ease, fill: 'forwards' },
  );
  fade.onfinish = () => {
    ov.classList.add('hidden');
    ov.getAnimations({ subtree: true }).forEach((a) => a.cancel()); // drop fill so re-show starts fresh
    cnFading = false;
  };
}
function failConnecting(message) {
  connecting = false;
  clearTimeout(cnSlowTimer);
  setConnStatus(`could not join: ${message}`);
  $('cnActions')?.classList.remove('hidden');
}
$('cnRetry') && ($('cnRetry').onclick = () => currentRoom && joinRoom(currentRoom));
$('cnBack') && ($('cnBack').onclick = () => leaveCall());

// ------------------------------------------------------------------ show ticker (mid-show dead air)
// Two kinds of real dead air get owned by one pill: the LLM writing the next
// segment (WRITERS' ROOM) and TTS rendering a voice (SOUND BOOTH, with an
// equalizer instead of dots + an "on deck" pulse on the robot about to speak).
const TICKER_MODES = {
  writing: {
    label: 'WRITERS’ ROOM',
    lines: ['drafting the next segment', 'reading the room', 'punching up the jokes',
      'arguing about the segue', 'checking the robots’ notes', 'one more pass on the banter'],
    emoji: ['💭', '✍️', '📝', '☕', '💡'],
  },
  voicing: {
    label: 'SOUND BOOTH',
    lines: ['warming up the voice box', 'mic check, one two', 'adjusting the pop filter',
      'a quick sip of oil', 'finding the right octave'],
    emoji: ['🎙️', '🎵', '💭'],
  },
};
// a little emoji drifts up from a host element and evaporates
function spawnThought(host, emoji) {
  if (!host || document.hidden) return;
  const s = document.createElement('span');
  s.className = 'thought';
  s.textContent = emoji;
  s.style.left = `${12 + Math.random() * 72}%`;
  host.appendChild(s);
  s.animate([
    { opacity: 0, transform: 'translateY(8px) scale(0.7)' },
    { opacity: 0.9, transform: 'translateY(-16px) scale(1)', offset: 0.25 },
    { opacity: 0, transform: 'translateY(-52px) scale(1.05)' },
  ], { duration: 2600, easing: 'ease-out' }).onfinish = () => s.remove();
}
function setBackstage(on) {
  for (const [, entry] of cards) entry.twin.setBackstage?.(on);
}
let swTimer = null;
let swDelay = null;
let swThoughts = null;
function showSegWriting(mode, text) {
  const conf = TICKER_MODES[mode] || TICKER_MODES.writing;
  clearTimeout(swDelay);
  // grace period: a sub-second TTS wait shouldn't flash the pill
  swDelay = setTimeout(() => {
    const el = $('segWriting');
    if (!el) return;
    el.classList.toggle('voicing', mode === 'voicing');
    $('swLabel').textContent = conf.label;
    $('swText').textContent = text || conf.lines[0];
    el.classList.remove('hidden');
    document.getElementById('view-call')?.classList.add('pondering');
    setBackstage(true); // robots hang out: more emotes, the odd dance
    clearInterval(swTimer);
    let i = 0;
    swTimer = setInterval(() => {
      const t = $('swText');
      if (!t) return;
      t.textContent = conf.lines[i++ % conf.lines.length];
      t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    }, 3600);
    clearInterval(swThoughts);
    swThoughts = setInterval(() => {
      const list = [...cards.values()];
      if (!list.length) return;
      const entry = list[(Math.random() * list.length) | 0];
      spawnThought(entry.el, conf.emoji[(Math.random() * conf.emoji.length) | 0]);
    }, 1900);
  }, mode === 'voicing' ? 700 : 0);
}
function setOnDeck(speaker) {
  for (const [, entry] of cards) {
    const isNext = entry.el.querySelector('.name')?.textContent === speaker;
    entry.el.classList.toggle('ondeck', !!speaker && isNext);
  }
}
function hideSegWriting() {
  clearTimeout(swDelay);
  swDelay = null;
  clearInterval(swTimer);
  swTimer = null;
  clearInterval(swThoughts);
  swThoughts = null;
  $('segWriting')?.classList.add('hidden');
  document.getElementById('view-call')?.classList.remove('pondering');
  setBackstage(false);
  setOnDeck(null);
}

// ------------------------------------------------------------------ audio diagnostics shipper
// Every [st-audio] line is also POSTed to the backend so WebRTC failures on
// flaky clients can be read server-side (GET /api/admin/debug-log).
const DBG_TAG = `${/firefox|gecko\/\d/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent) ? 'ffx' : 'chr'}-${Math.random().toString(36).slice(2, 6)}`;
let dbgBuf = [];
function dbg(line) {
  console.log(`[st-audio] ${line}`);
  dbgBuf.push(line);
}
setInterval(() => {
  if (!dbgBuf.length) return;
  const lines = dbgBuf.splice(0, 50);
  fetch('/api/debug-log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: DBG_TAG, lines }),
  }).catch(() => {});
}, 4000);
dbg(`ua=${navigator.userAgent.slice(0, 110)}`);

// ------------------------------------------------------------------ audio gate
// Autoplay can still be blocked if the playback gesture has expired by the time a
// clip arrives. When an <audio>.play() rejects we surface a tap-for-sound button —
// clicking is a fresh gesture that resumes the WebAudio context and playback.
function showAudioGate() {
  $('audioGate')?.classList.remove('hidden');
}
function hideAudioGate() {
  $('audioGate')?.classList.add('hidden');
}
if ($('audioGate')) {
  $('audioGate').onclick = async () => {
    if (audioCtx?.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
    if (currentAudioEl) { try { await currentAudioEl.play(); } catch {} }
    hideAudioGate();
  };
}

// ------------------------------------------------------------------ subtitles
let subTimer = null;
function showSubtitle(speaker, text, color) {
  const bar = $('subtitles');
  if (!bar) return;
  const c = color || 'var(--gold)';
  if (speaker) {
    bar.style.borderLeft = `3px solid ${c}`;
    bar.style.boxShadow = `inset 0 0 26px -18px ${c}`;
    bar.innerHTML = `<b style="color:${c}">${speaker}</b><span>${text}</span>`;
  } else {
    bar.style.borderLeft = '';
    bar.style.boxShadow = '';
    bar.innerHTML = `<i>${text}</i>`;
  }
  bar.classList.remove('hidden');
  clearTimeout(subTimer);
  subTimer = setTimeout(() => bar.classList.add('hidden'), 30000);
}
// Build a card + 3D twin for one cast member. ensureCard() reads the participant
// via parseMeta(p.metadata), so we hand it a synthetic participant whose metadata
// carries the colour/persona/wardrobe — the same shape the old transport used.
function castCard(s) {
  stopWritingRoom();
  const meta = {
    role: 'reachy', color: s.color, persona: s.persona || '',
    hat: s.hat || null, face: s.face || null, neck: s.neck || null,
  };
  return ensureCard({ identity: String(s.id), name: s.name, metadata: JSON.stringify(meta) });
}

function handleWsMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  // if we were still showing the green room, the show has begun — move on
  if (!$('greenRoom')?.classList.contains('hidden')) { stopGreenRoom(); startWritingRoom(); }

  if (msg.type === 'cast') {
    (msg.speakers || []).forEach(castCard);
    if (cards.size) stopConnecting();
    applyLayout(false);
  } else if (msg.type === 'status') {
    // pre-show: real progress lands in the writers' room; between segments
    // and during TTS waits: the show ticker; anything else: subtitle bar
    if (wrTimer) $('wrStatus').textContent = msg.text;
    else if (msg.phase === 'writing') showSegWriting('writing', msg.text);
    else if (msg.phase === 'voicing') { showSegWriting('voicing', msg.text); setOnDeck(msg.speaker); }
    else showSubtitle(null, msg.text);
  } else if (msg.type === 'line') {
    stopWritingRoom();
    hideSegWriting();
    stopConnecting();
    showSubtitle(msg.name, msg.text, msg.color);
    enqueueLine(msg); // play the clip + drive the speaking twin
  } else if (msg.type === 'end') {
    hideSegWriting();
  }
}
function removeCard(identity) {
  const entry = cards.get(identity);
  if (!entry) return;
  // tear down audio so <audio> elements + WebAudio nodes don't leak across joins
  try { entry.track?.detach(); } catch {}
  try { entry.audioEl?.remove(); } catch {}
  entry.twin.dispose();
  entry.el.remove();
  cards.delete(identity);
  if (identity === activeId) activeId = null;
  applyLayout(true);
}
function flip(els, mutate) {
  if (document.hidden) return mutate();
  const first = new Map(els.map((e) => [e, e.getBoundingClientRect()]));
  mutate();
  for (const e of els) {
    const f = first.get(e);
    const l = e.getBoundingClientRect();
    if (!f.width || !l.width) continue;
    const dx = f.left - l.left, dy = f.top - l.top, sx = f.width / l.width, sy = f.height / l.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) continue;
    e.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)' });
  }
}
function applyLayout(animate = true) {
  const els = [...cards.values()].map((e) => e.el);
  const run = () => {
    if (layout === 'spotlight') {
      grid.classList.add('hidden');
      spotlight.classList.remove('hidden');
      const active = cards.has(activeId) ? activeId : cards.keys().next().value;
      for (const [id, entry] of cards) {
        entry.el.classList.toggle('active', id === active);
        (id === active ? spotMain : spotStrip).appendChild(entry.el);
      }
    } else {
      spotlight.classList.add('hidden');
      grid.classList.remove('hidden');
      const n = Math.max(cards.size, 1);
      grid.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(n))}, minmax(0,1fr))`;
      for (const entry of cards.values()) { entry.el.classList.remove('active'); grid.appendChild(entry.el); }
    }
  };
  animate ? flip(els, run) : run();
}
function setActive(id) {
  if (id === activeId) return;
  activeId = id;
  if (layout === 'spotlight') applyLayout(true);
}

// ---- WebSocket audio playback (one clip at a time) ------------------------
// The server streams base64 WAV clips, already paced. We still serialise
// playback through a queue + isPlaying flag so two clips never overlap if their
// frames happen to arrive together. Each playing clip taps a WebAudio
// AnalyserNode to drive the speaking twin's level (RMS per animation frame).
let currentAudioEl = null; // the clip currently playing (for the audio-gate retry)
const playQueue = [];
let isPlaying = false;

async function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx?.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
  return audioCtx;
}

function enqueueLine(msg) {
  playQueue.push(msg);
  if (!isPlaying) drainQueue();
}

async function drainQueue() {
  if (isPlaying) return;
  isPlaying = true;
  while (playQueue.length) {
    const msg = playQueue.shift();
    try { await playLine(msg); } catch (e) { dbg(`play err ${String(e).slice(0, 60)}`); }
  }
  isPlaying = false;
}

async function playLine(msg) {
  const entry = cards.get(String(msg.id));
  // base64 → bytes → Blob → object URL → <audio>
  let url = null;
  try {
    const bin = atob(msg.audio || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  } catch { return; }

  // Resume the WebAudio context BEFORE deciding how to route: an element captured
  // by createMediaElementSource only outputs through the WebAudio graph, so if the
  // context is suspended the clip is silent even though play() resolves. We await
  // the resume here and, if it still isn't running, skip WebAudio and let the
  // <audio> element play natively (audible) — the twin meter just goes quiet.
  const ctx = await ensureAudioCtx();
  const ctxLive = !!ctx && ctx.state === 'running';

  return new Promise((resolve) => {
    const audioEl = new Audio();
    audioEl.src = url;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.volume = 1;
    currentAudioEl = audioEl;

    // drive the speaking twin's level from a WebAudio analyser on this element —
    // only when the context is live, or routing would mute native playback
    let raf = 0, analyser = null;
    if (ctxLive && entry) {
      try {
        const srcNode = ctx.createMediaElementSource(audioEl);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        srcNode.connect(analyser);
        analyser.connect(ctx.destination);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          raf = requestAnimationFrame(tick);
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          entry.level = Math.min(1, rms * 4);
        };
        tick();
      } catch { analyser = null; }
    }

    const cleanup = () => {
      if (raf) cancelAnimationFrame(raf);
      if (entry) entry.level = 0;
      try { URL.revokeObjectURL(url); } catch {}
      if (currentAudioEl === audioEl) currentAudioEl = null;
      resolve();
    };
    audioEl.addEventListener('ended', cleanup, { once: true });
    audioEl.addEventListener('error', cleanup, { once: true });
    audioEl.play().then(() => hideAudioGate()).catch((e) => {
      dbg(`play() BLOCKED ${e.name}`);
      showAudioGate(); // a fresh click resumes it (see the gate handler)
    });
  });
}

function pollLevels() {
  requestAnimationFrame(pollLevels);
  let loudest = null, max = 0;
  for (const [id, entry] of cards) {
    entry.twin.setLevel(entry.level || 0);
    entry.el.classList.toggle('talking', entry.twin.level > 0.04);
    if (entry.twin.level > max) { max = entry.twin.level; loudest = id; }
  }
  if (loudest && max > 0.06) setActive(loudest);
}
pollLevels();

// ------------------------------------------------------------------ join / leave
function updateViewers() {
  // single local viewer over the WebSocket transport
  const e = document.getElementById('chViewers');
  if (e) e.textContent = '1 watching';
}
async function joinRoom(r) {
  if (ws || cards.size) await leaveCall(false); // never stack two sessions
  currentRoom = r;
  layout = r.template === 'duo' ? 'grid' : 'spotlight';
  activeId = null;
  // flip to the call view IMMEDIATELY — the patching-in overlay owns the wait
  $('callEmoji').textContent = r.emoji || '🎙️';
  $('callTitle').textContent = r.title;
  $('callTopic').textContent = r.topic || '';
  showView('call');
  startConnecting();
  // a user gesture got us here — prime the audio context so autoplay is allowed
  ensureAudioCtx();
  try {
    setConnStatus('patching you into the feed…');
    // open a WebSocket to the show; the server begins streaming on connect
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${wsProto}://${location.host}/ws/${r.id}`);
    ws = sock;

    currentGuestId = null;
    // demos are watch-only — your designer Reachy only takes the stage in live rooms
    if (UGC_ENABLED && userReachy && r.template === 'open') {
      try {
        const g = await api(`/api/rooms/${r.id}/reachy`, { method: 'POST', body: userReachy });
        currentGuestId = g.identity;
      } catch {}
    }

    sock.onopen = () => {
      dbg(`ws open: ${r.id}`);
      setConnStatus('waking the cast…');
      // open shows in the green room wait for the start button; otherwise the
      // writers' room narrates the wait until the first cast/line frame lands
      if (r.template === 'open' && r.status === 'waiting') { stopConnecting(); openGreenRoom(r); }
      else startWritingRoom();
    };
    sock.onmessage = (ev) => handleWsMessage(ev.data);
    sock.onerror = () => dbg('ws error');
    sock.onclose = () => {
      dbg('ws closed');
      if (ws === sock) ws = null;
    };
  } catch (e) {
    failConnecting(e.message);
  }
}
function dropGuest() {
  if (currentGuestId && currentRoom) {
    api(`/api/rooms/${currentRoom.id}/reachy/leave`, { method: 'POST', body: { identity: currentGuestId } }).catch(() => {});
  }
  currentGuestId = null;
}
async function leaveCall(goHome = true) {
  dropGuest();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  // drop any queued clips and stop the one playing so re-joining never stacks/echoes
  playQueue.length = 0;
  isPlaying = false;
  if (currentAudioEl) { try { currentAudioEl.pause(); } catch {} currentAudioEl = null; }
  for (const id of [...cards.keys()]) removeCard(id);
  document.querySelectorAll('.hidden-audio').forEach((e) => e.remove());
  currentRoom = null;
  activeId = null;
  clearTimeout(subTimer);
  stopWritingRoom();
  stopGreenRoom();
  hideSegWriting();
  connecting = false;
  clearTimeout(cnSlowTimer);
  $('connecting')?.classList.add('hidden');
  $('cnActions')?.classList.add('hidden');
  $('audioGate')?.classList.add('hidden');
  $('subtitles')?.classList.add('hidden');
  if (goHome) {
    showView('home');
    loadRooms();
  }
}
// best-effort cleanup if the tab is closed mid-call (sendBeacon survives unload)
window.addEventListener('pagehide', () => {
  if (currentGuestId && currentRoom) {
    navigator.sendBeacon(
      `/api/rooms/${currentRoom.id}/reachy/leave`,
      new Blob([JSON.stringify({ identity: currentGuestId })], { type: 'application/json' }),
    );
  }
});

// ------------------------------------------------------------------ themes (switchable skins)
const THEMES = [
  { id: 'ghost', label: 'Ghost' },
  { id: 'tron', label: 'Tron' },
  { id: 'kinetic', label: 'Kinetic' },
  { id: 'oracle', label: 'Oracle' },
  { id: 'lithos', label: 'Lithos' },
  { id: 'observatory', label: 'Observatory' },
  { id: 'foundry', label: 'Foundry' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'dossier', label: 'Dossier' },
  { id: 'concrete', label: 'Concrete' },
  { id: 'editorial', label: 'Gold' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'sakura', label: 'Sakura' },
  { id: 'solaris', label: 'Solaris' },
  { id: 'pearl', label: 'Pearl' },
];

// Lithos cursor spotlight: a soft-masked circle trails the cursor (eased). Its
// strata pattern uses background-attachment: fixed, so the pattern stays
// page-anchored while the circle moves — a true "reveal" with zero canvas work.
const SPOTLIGHT_R = 300;
const _spot = { mx: -2000, my: -2000, sx: -2000, sy: -2000 };
window.addEventListener('mousemove', (e) => { _spot.mx = e.clientX; _spot.my = e.clientY; });
function spotlightLoop() {
  requestAnimationFrame(spotlightLoop);
  const reveal = $('lithosReveal');
  if (theme !== 'lithos' || !reveal || views.home.classList.contains('hidden')) return;
  _spot.sx += (_spot.mx - _spot.sx) * 0.1;
  _spot.sy += (_spot.my - _spot.sy) * 0.1;
  // left/top (not transform) so background-attachment: fixed keeps working
  reveal.style.left = _spot.sx - SPOTLIGHT_R + 'px';
  reveal.style.top = _spot.sy - SPOTLIGHT_R + 'px';
}
let theme = localStorage.getItem('theme') || 'ghost';
if (!THEMES.some((t) => t.id === theme)) theme = 'ghost'; // saved theme may have been retired
function refreshHero() {
  if (hero) { hero.dispose(); hero = null; }
  if (!views.home.classList.contains('hidden')) {
    try { hero = new HeroReachy($('hero3d')); } catch { hero = null; }
  }
}
function setTheme(id, { rebuild = true } = {}) {
  theme = id;
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('theme', id);
  if (_renderThemeBtn) _renderThemeBtn();
  startThemeParticles();
  if (rebuild) refreshHero(); // so the holographic Reachy adopts the theme accent
}
// Read a theme's signature colours without a visible flash: flip data-theme,
// sample the tokens synchronously, restore. Lets the swatch picker preview every
// theme's real palette with zero hardcoding.
function themeSwatches(id) {
  const root = document.documentElement;
  const prev = root.getAttribute('data-theme');
  root.setAttribute('data-theme', id);
  const cs = getComputedStyle(root);
  const c = (v) => cs.getPropertyValue(v).trim();
  const sw = { accent: c('--gold') || '#888', accent2: c('--cyan') || c('--live') || c('--gold'), bg: c('--bg') || '#111' };
  if (prev) root.setAttribute('data-theme', prev); else root.removeAttribute('data-theme');
  return sw;
}
let _renderThemeBtn = null;
function buildThemePicker() {
  const host = $('themePicker');
  if (!host) return;
  host.innerHTML = '';
  host.appendChild(el('span', 'tp-label', 'THEME'));

  const wrap = el('div', 'tp-wrap');
  const btn = el('button', 'tp-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  const panel = el('div', 'tp-panel');
  panel.setAttribute('role', 'listbox');

  const close = () => { panel.classList.remove('open'); btn.classList.remove('open'); };

  _renderThemeBtn = () => {
    const sw = themeSwatches(theme);
    const t = THEMES.find((x) => x.id === theme);
    btn.innerHTML = `<span class="tp-dot" style="background:${sw.accent}"></span><span class="tp-name">${t ? t.label : theme}</span><span class="tp-caret">▾</span>`;
    [...panel.children].forEach((c) => c.classList.toggle('on', c.dataset.id === theme));
  };

  THEMES.forEach((t) => {
    const sw = themeSwatches(t.id);
    const item = el('button', 'tp-item');
    item.type = 'button';
    item.dataset.id = t.id;
    item.setAttribute('role', 'option');
    item.innerHTML =
      `<span class="tp-chip" style="background:${sw.bg}"><i style="background:${sw.accent}"></i><i style="background:${sw.accent2}"></i></span>` +
      `<span class="tp-item-name">${t.label}</span>`;
    item.onclick = () => { setTheme(t.id); close(); };
    panel.appendChild(item);
  });

  btn.onclick = (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle('open');
    btn.classList.toggle('open', open);
  };
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  host.appendChild(wrap);
  _renderThemeBtn();
}

// ---- theme-tied ambient particles (sakura petals · solaris embers · aurora stars) ----
const _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let _particleRAF = null;
function startThemeParticles() {
  const home = views.home;
  if (!home) return;
  let canvas = $('fxParticles');
  if (_particleRAF) { cancelAnimationFrame(_particleRAF); _particleRAF = null; }

  const kind = { sakura: 'petal', solaris: 'ember', aurora: 'star' }[theme];
  if (!kind || _reducedMotion) { if (canvas) canvas.style.display = 'none'; return; }

  if (!canvas) {
    canvas = el('canvas', 'fx-particles');
    canvas.id = 'fxParticles';
    canvas.setAttribute('aria-hidden', 'true');
    home.insertBefore(canvas, home.firstChild); // sits behind the content
  }
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;
  const resize = () => { w = canvas.width = home.clientWidth; h = canvas.height = home.clientHeight; };
  resize();
  if (canvas._ro) canvas._ro.disconnect();
  canvas._ro = new ResizeObserver(resize);
  canvas._ro.observe(home);

  const COLORS = { petal: ['#ffc4da', '#ff9ec0', '#ffd9e6'], ember: ['#ffd08a', '#ffae42', '#ff7a4d'], star: ['#a7ffe6', '#7db8ff', '#b69cff'] }[kind];
  const N = kind === 'star' ? 80 : 36;
  const mk = () => ({
    x: Math.random() * w, y: Math.random() * h,
    r: kind === 'star' ? Math.random() * 1.5 + 0.4 : Math.random() * 5 + 3,
    s: kind === 'ember' ? -(Math.random() * 0.45 + 0.2) : kind === 'petal' ? Math.random() * 0.5 + 0.2 : 0,
    drift: Math.random() * 0.5 - 0.25, ph: Math.random() * 6.28, tw: Math.random() * 0.05 + 0.01,
    col: COLORS[(Math.random() * COLORS.length) | 0],
  });
  const parts = Array.from({ length: N }, mk);
  let t0 = performance.now();
  const draw = (now) => {
    _particleRAF = requestAnimationFrame(draw);
    if (home.classList.contains('hidden')) { ctx.clearRect(0, 0, w, h); return; }
    const dt = Math.min((now - t0) / 16.67, 3); t0 = now;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.y += p.s * dt;
      p.x += (Math.sin(now / 1000 + p.ph) * 0.3 + p.drift) * dt;
      p.ph += p.tw * dt;
      if (p.s > 0 && p.y > h + 10) { p.y = -10; p.x = Math.random() * w; }
      if (p.s < 0 && p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      ctx.fillStyle = p.col;
      ctx.globalAlpha = kind === 'star' ? 0.35 + Math.abs(Math.sin(p.ph)) * 0.55 : 0.5;
      if (kind === 'petal') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ph);
        ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * 0.52, 0, 0, 6.28); ctx.fill(); ctx.restore();
      } else {
        if (kind === 'ember') { ctx.shadowColor = p.col; ctx.shadowBlur = 8; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;
  };
  _particleRAF = requestAnimationFrame(draw);
}

// ------------------------------------------------------------------ home FX (anar-labs flavour)
const GLYPHS = '▚▖�364ABDEFKR#%@░▒█/<>*┐└┤';
function scramble(elm, finalText, ms = 1000) {
  const chars = [...finalText];
  const start = performance.now();
  (function frame(now) {
    const p = Math.min(1, (now - start) / ms);
    const shown = Math.floor(p * chars.length);
    elm.textContent = chars
      .map((c, i) => (c === ' ' ? ' ' : i < shown ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
      .join('');
    if (p < 1) requestAnimationFrame(frame);
    else elm.textContent = finalText;
  })(performance.now());
}
const BOOT_LINES = [
  '> establishing uplink…',
  '> tuning receiver · 98.6 robot fm',
  '> decoding live chatter',
  '> <span class="ok">signal locked ✓</span>',
];
function runBoot() {
  const boot = $('boot');
  if (!boot) return;
  let i = 0;
  (function tick() {
    if (i < BOOT_LINES.length) {
      boot.innerHTML = BOOT_LINES.slice(0, ++i).join('<br>') + '<span class="cur">&nbsp;</span>';
      setTimeout(tick, 360);
    } else {
      setTimeout(() => (boot.style.opacity = '0'), 1100);
    }
  })();
}
const TICKER = [
  { t: '● NOW BROADCASTING', hot: true },
  { t: 'THE GROUP CHAT — IS A HOT DOG A SANDWICH?' },
  { t: 'FIVE ROBOTS · ZERO CONSENSUS' },
  { t: '● START YOUR OWN SHOW', hot: true },
  { t: 'CAN A 4B MODEL BE CHARMING?' },
  { t: 'BRAINS · NEMOTRON 4B VIA LLAMA.CPP' },
  { t: 'VOICES · QWEN3-TTS VOICEDESIGN' },
  { t: 'HOSTS · REACHY MINI — REAL ONES WELCOME' },
];
function initHomeFX() {
  const track = $('tickerTrack');
  if (track) {
    const seg = TICKER.map((s) => `<span class="${s.hot ? 'b' : ''}">${s.t}</span><span class="sep">/</span>`).join('');
    track.innerHTML = seg + seg; // duplicated for a seamless -50% loop
  }
  runBoot();
  const sweep = document.querySelector('.home-content .text-sweep');
  if (sweep) {
    const final = sweep.textContent;
    setTimeout(() => {
      // lock the box to its final width so the random-width scramble glyphs
      // animate in place instead of shoving the layout around…
      sweep.style.display = 'inline-block';
      sweep.style.width = sweep.offsetWidth + 2 + 'px';
      sweep.style.whiteSpace = 'nowrap';
      sweep.style.overflow = 'hidden';
      sweep.style.verticalAlign = 'top';
      scramble(sweep, final, 1150);
      // …then release it so switching to a wider-headline theme doesn't clip
      setTimeout(() => {
        sweep.style.cssText = '';
      }, 1350);
    }, 480);
  }
}

// ------------------------------------------------------------------ admin (#admin)
const admToken = () => $('admToken')?.value || localStorage.getItem('admToken') || '';
const admSelected = new Set();
let admRooms = [];
async function admApi(path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: { 'x-admin-token': admToken(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'bad token' : `HTTP ${res.status}`);
  return res.json();
}
async function loadAdmin() {
  const list = $('admList');
  if (!list) return;
  localStorage.setItem('admToken', $('admToken').value || localStorage.getItem('admToken') || '');
  try {
    admRooms = (await admApi('/api/admin/rooms')).rooms;
  } catch (e) {
    list.innerHTML = `<div class="adm-meta">⚠ ${e.message}</div>`;
    return;
  }
  renderAdmin();
}
function renderAdmin() {
  const list = $('admList');
  const q = ($('admSearch')?.value || '').trim().toLowerCase();
  for (const id of [...admSelected]) if (!admRooms.some((r) => r.id === id)) admSelected.delete(id);
  list.innerHTML = '';
  const shown = admRooms
    .filter((r) => !q || `${r.title} ${r.topic} ${r.id}`.toLowerCase().includes(q))
    .sort((a, b) => (b.task === 'running') - (a.task === 'running') || (b.viewers || 0) - (a.viewers || 0));
  shown.forEach((r) => {
    const row = el('div', 'adm-row' + (admSelected.has(r.id) ? ' sel' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.className = 'adm-cb';
    cb.checked = admSelected.has(r.id);
    cb.onchange = () => { cb.checked ? admSelected.add(r.id) : admSelected.delete(r.id); renderAdmin(); };
    const body = el('div', 'adm-body');
    const head = el('div', 'adm-head');
    head.textContent = `${r.emoji} ${r.title}`;
    if (r.task === 'running') head.appendChild(el('span', 'adm-live', 'LIVE'));
    if (r.seed) head.appendChild(el('span', 'adm-tag', 'seed'));
    const topic = el('div', 'adm-topic');
    topic.textContent = r.topic || '—';
    const meta = el('div', 'adm-meta');
    meta.textContent = `${r.task} · ${r.publishers} cast · ${r.viewers} watching · ${r.template}`;
    body.append(head, topic, meta);
    const acts = el('div', 'adm-acts');
    if (r.task === 'running') {
      const stop = el('button', 'btn btn-ghost btn-sm', '⏹ Stop');
      stop.title = 'Stop the show — the room stays and restarts on the next join';
      stop.onclick = async () => { stop.disabled = true; try { await admApi(`/api/admin/rooms/${r.id}/stop`, 'POST'); } catch {} loadAdmin(); };
      acts.appendChild(stop);
    }
    if (!r.seed) {
      const del = el('button', 'btn btn-ghost btn-sm adm-danger', '🗑 Delete');
      del.title = 'Stop and remove this room entirely';
      del.onclick = async () => { del.disabled = true; try { await admApi(`/api/admin/rooms/${r.id}`, 'DELETE'); } catch {} loadAdmin(); };
      acts.appendChild(del);
    }
    row.append(cb, body, acts);
    list.appendChild(row);
  });
  if (!shown.length) list.innerHTML = '<div class="adm-meta">nothing matches</div>';
  const n = admSelected.size;
  $('admStopSel').textContent = n ? `⏹ Stop selected (${n})` : '⏹ Stop selected';
  $('admDelSel').textContent = n ? `🗑 Delete selected (${n})` : '🗑 Delete selected';
  $('admStopSel').disabled = $('admDelSel').disabled = !n;
}
if ($('admRefresh')) {
  $('admRefresh').onclick = loadAdmin;
  $('admSearch').addEventListener('input', renderAdmin);
  $('admStopSel').onclick = async () => {
    try { await admApi('/api/admin/stop-batch', 'POST', { ids: [...admSelected], delete: false }); } catch {}
    admSelected.clear(); loadAdmin();
  };
  $('admDelSel').onclick = async () => {
    if (!confirm(`Delete ${admSelected.size} room(s) entirely?`)) return;
    try { await admApi('/api/admin/stop-batch', 'POST', { ids: [...admSelected], delete: true }); } catch {}
    admSelected.clear(); loadAdmin();
  };
  $('admStopAll').onclick = async () => {
    if (!confirm('Stop every running show? (rooms stay; they restart on the next join)')) return;
    try { await admApi('/api/admin/stop-all', 'POST'); } catch {}
    loadAdmin();
  };
  $('admToken').value = localStorage.getItem('admToken') || '';
  setInterval(() => { if (!views.admin.classList.contains('hidden')) loadAdmin(); }, 10000);
}

// ------------------------------------------------------------------ boot
async function openSettings() {
  const back = el('div', 'modal-back');
  const card = el('div', 'connect-card modal-card');
  card.innerHTML = `
    <h2>Model settings</h2>
    <p class="sub">Choose the brain that writes the shows and the voice engine.
    If one fails, Aria falls back automatically. Changes apply to your next show.</p>
    <div class="field"><label>Brain model</label>
      <select class="input" id="setBrain"><option>loading…</option></select></div>
    <div class="field"><label>Voice engine</label>
      <select class="input" id="setVoice"><option>loading…</option></select>
      <div class="ns-hint" id="setHint"></div></div>
    <div class="connect-nav"><button class="btn btn-primary" id="setDone">Done</button></div>`;
  back.appendChild(card);
  document.body.appendChild(back);
  const bsel = card.querySelector('#setBrain');
  const vsel = card.querySelector('#setVoice');
  const hint = card.querySelector('#setHint');
  const fill = (sel, opts, cur) => {
    sel.innerHTML = '';
    opts.forEach((o) => {
      const e = document.createElement('option');
      e.value = o.id; e.textContent = o.label;
      if (o.id === cur) e.selected = true;
      sel.appendChild(e);
    });
  };
  const save = async (body) => {
    hint.textContent = 'saving…';
    try { await api('/api/settings', { method: 'POST', body }); hint.textContent = 'Saved ✓ — applies to your next show.'; }
    catch (e) { hint.textContent = 'Could not save: ' + e.message; }
  };
  try {
    const s = await api('/api/settings');
    fill(bsel, s.brain.options, s.brain.current);
    fill(vsel, s.voice.options, s.voice.current);
    bsel.onchange = () => save({ brain: bsel.value });
    vsel.onchange = () => save({ voice: vsel.value });
  } catch (e) {
    bsel.innerHTML = vsel.innerHTML = '<option>could not load</option>';
    hint.textContent = 'Is the app running? ' + e.message;
  }
  const close = () => back.remove();
  card.querySelector('#setDone').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}
if ($('settingsBtn')) $('settingsBtn').onclick = openSettings;
if ($('topHelp')) $('topHelp').onclick = () => openExplainer();
setTheme(theme, { rebuild: false }); // apply saved/default theme before first paint
buildThemePicker();
spotlightLoop(); // Lithos cursor reveal (no-op until that theme is active)
showView(location.hash === '#admin' ? 'admin' : location.hash === '#radio' ? 'radio' : 'home');
if (location.hash === '#admin') loadAdmin();
window.addEventListener('hashchange', () => {
  if (location.hash === '#admin') { showView('admin'); loadAdmin(); }
  else if (location.hash === '#radio') showView('radio');
});
initHomeFX();
loadRooms();
setInterval(() => { if (views.home && !views.home.classList.contains('hidden')) loadRooms(); }, 12000);
