/**
 * PlanetPop — vanilla idle game (see plan)
 */
(function () {
  'use strict';

  const SAVE_KEY = 'planetpop_save_v1';
  const WELCOME_KEY = 'planetpop_welcome_dismissed';
  const SAVE_VERSION = 1;
  const MAX_OFFLINE_MS = 48 * 3600 * 1000;
  const TICK_MS = 150;
  const AUTOSAVE_MS = 10000;
  const FLARE_POLL_MS = 5 * 60 * 1000;
  const FLARE_DURATION_MS = 30 * 1000;
  const FLARE_CHANCE = 0.3;
  const BOOST_MS = 3000;
  const LONG_PRESS_MS = 500;
  const INITIAL_BODIES = 4;
  const BASE_UNLOCK_MS = 1000;
  const REFINERY_COST = 100;
  const TRADE_CREDITS = 100;
  const TRADE_MATERIALS = 15;
  const TRADE_COOLDOWN_MS = 30 * 1000;
  const RAID_COOLDOWN_MS = 60 * 1000;
  const RAID_WIN = 200;
  const RAID_LOSE = 100;

  const SYL1 = ['Zor', 'Nyx', 'Kael', 'Vex', 'Ori', 'Thal', 'Ryn', 'Sol'];
  const SYL2 = ['ak', 'ix', 'on', 'us', 'ar', 'en', 'is', 'um'];

  /** @type {ReturnType<typeof createDefaultState>} */
  let state = createDefaultState();
  let lastTickAt = Date.now();
  let lastAutosaveAt = Date.now();
  let lastFlarePollAt = Date.now();
  let moonRoundRobin = 0;
  let bodyIdSeq = 0;
  let audioCtx = null;
  let lastFrameTime = performance.now();
  let longPressTimer = null;
  let longPressFired = false;
  let activePointerBodyId = null;
  let lastThreshold = { credits: 0, materials: 0 };

  const els = {};

  function createDefaultState() {
    const now = Date.now();
    bodyIdSeq = 0;
    const bodies = [
      makeBody('sun', 'Sun', 100, 0, 0, null, 0),
      makeBody('planet', 'Pyra', 10, 70, 0.0004, null, 0),
      makeBody('planet', 'Aqua', 12, 100, 0.00035, null, 1),
      makeBody('planet', 'Terra', 11, 130, 0.0003, null, 2),
    ];
    return {
      saveVersion: SAVE_VERSION,
      startedAt: now,
      lastTickAt: now,
      credits: 0,
      materials: 25,
      intelligence: 1,
      bodies,
      buildingTier: 0,
      refineryBuilt: false,
      totalBodiesUnlocked: INITIAL_BODIES,
      randomEvent: null,
      lastFlarePollAt: now,
      neighbors: [],
      neighborsScanned: false,
      unlockedInterstellar: false,
      galaxySeed: null,
      tradeCooldowns: {},
      raidCooldowns: {},
      comms: [],
      nextUnlockAt: 0,
    };
  }

  function makeBody(type, name, size, orbitRadius, orbitSpeed, parentId, planetSlot) {
    const id = 'b' + ++bodyIdSeq;
    return {
      id,
      type,
      name,
      size,
      orbitRadius,
      orbitSpeed,
      parentId,
      planetSlot: planetSlot != null ? planetSlot : null,
      powerPlants: 0,
      boostedUntil: 0,
      angle: Math.random() * Math.PI * 2,
      moonAngle: 0,
    };
  }

  function rng() {
    return Math.random();
  }

  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function getMaxMoons(intel) {
    let cap = 6;
    if (intel >= 4) cap += 2;
    if (intel >= 7) cap += 4;
    if (intel >= 10) cap = 999;
    return cap;
  }

  function getMaxPlanets(intel) {
    let cap = 6;
    if (intel >= 4) cap += 2;
    if (intel >= 7) cap += 4;
    if (intel >= 10) cap = 999;
    return cap;
  }

  function countByType(type) {
    return state.bodies.filter((b) => b.type === type).length;
  }

  function canAddMoon() {
    return countByType('moon') < getMaxMoons(state.intelligence);
  }

  function canAddPlanet() {
    return countByType('planet') < getMaxPlanets(state.intelligence);
  }

  function maxPlantsForBody(body) {
    let max = 2;
    if (state.intelligence >= 2) max += 1;
    if (state.intelligence >= 6 && body.type === 'moon') max += 1;
    return max;
  }

  function plantPower(body) {
    if (body.type === 'sun') return 0;
    const n = body.powerPlants;
    if (n <= 0) return 0;
    const base = 1;
    let p = base * Math.sqrt(n);
    if (body.type === 'moon' && state.intelligence >= 7) p *= 1.5;
    const now = Date.now();
    if (body.boostedUntil > now) p *= 2;
    return p;
  }

  function totalPower() {
    let t = 0;
    for (const b of state.bodies) t += plantPower(b);
    return t;
  }

  function chainMaterialBonus() {
    return state.buildingTier >= 1 ? 0.1 : 0;
  }

  function refineryCreditsBonus() {
    return state.refineryBuilt ? 0.2 : 0;
  }

  function materialRateForBody(body) {
    if (body.type === 'sun') return 0;
    const factor = body.type === 'planet' ? 0.12 : 0.06;
    let rate = body.size * factor * (1 + 0.05 * state.intelligence);
    if (state.intelligence >= 8) rate *= 1.25;
    rate *= 1 + chainMaterialBonus();
    const now = Date.now();
    if (body.boostedUntil > now) rate *= 2;
    return rate;
  }

  function materialsPerSec() {
    let sum = 0;
    for (const b of state.bodies) sum += materialRateForBody(b);
    return sum;
  }

  function creditsPerSec() {
    const tp = totalPower();
    let powerTerm = 1 + tp * 0.5;
    if (state.intelligence >= 3) powerTerm *= 2;
    let cps = (1 + state.intelligence * 0.1) * powerTerm;
    cps *= 1 + refineryCreditsBonus();
    if (state.randomEvent && state.randomEvent.type === 'solarFlare' && Date.now() < state.randomEvent.endsAt) {
      cps *= 2;
    }
    return cps;
  }

  function plantCost(body) {
    const n = body.powerPlants;
    return Math.floor(10 * Math.pow(1.55, n));
  }

  function buyBodyCost() {
    return Math.floor(30 * Math.pow(1.4, state.bodies.length));
  }

  function researchCost() {
    const L = state.intelligence;
    return {
      materials: Math.floor(50 * Math.pow(2, L - 1)),
      credits: Math.floor(20 * Math.pow(2, L - 1)),
    };
  }

  function nextUnlockDelayMs() {
    return BASE_UNLOCK_MS * Math.pow(2, Math.max(0, state.totalBodiesUnlocked - INITIAL_BODIES));
  }

  function scheduleNextUnlock() {
    const delay = nextUnlockDelayMs();
    state.nextUnlockAt = Date.now() + delay;
  }

  function ensureUnlockSchedule() {
    if (!state.nextUnlockAt || state.nextUnlockAt <= 0) scheduleNextUnlock();
  }

  function addMoon() {
    const planets = state.bodies.filter((b) => b.type === 'planet');
    if (planets.length === 0) return false;
    const parent = planets[moonRoundRobin % planets.length];
    moonRoundRobin++;
    const moon = makeBody('moon', 'Moon', 4 + rng() * 3, 22 + rng() * 8, 0.0012 + rng() * 0.0005, parent.id, null);
    moon.angle = rng() * Math.PI * 2;
    state.bodies.push(moon);
    state.totalBodiesUnlocked++;
    toast('New moon captured in orbit!');
    onBodyAddedJuice();
    return true;
  }

  function addPlanet() {
    const sizes = state.intelligence >= 4 ? [14, 16, 18] : [9, 11, 13];
    const size = sizes[Math.floor(rng() * sizes.length)];
    const orbitBase = 70 + countByType('planet') * 28;
    const p = makeBody('planet', 'Planet-' + (countByType('planet') + 1), size, orbitBase, 0.00025 + rng() * 0.0001, null, null);
    state.bodies.push(p);
    state.totalBodiesUnlocked++;
    toast('A new planet has formed!');
    onBodyAddedJuice();
    return true;
  }

  function tryAddOneUnlock() {
    if (!canAddMoon() && !canAddPlanet()) return false;
    if (canAddMoon() && (countByType('moon') < 5 || rng() < 0.6)) {
      return addMoon();
    }
    if (canAddPlanet()) {
      return addPlanet();
    }
    if (canAddMoon()) {
      return addMoon();
    }
    return false;
  }

  function processUnlocks(now) {
    while (now >= state.nextUnlockAt && state.nextUnlockAt > 0) {
      if (!canAddMoon() && !canAddPlanet()) {
        state.nextUnlockAt = now + 60000;
        break;
      }
      if (!tryAddOneUnlock()) {
        state.nextUnlockAt = now + 60000;
        break;
      }
      scheduleNextUnlock();
    }
  }

  function buyBodySkip() {
    const cost = buyBodyCost();
    if (state.materials < cost) return;
    state.materials -= cost;
    if (!canAddMoon() && canAddPlanet()) addPlanet();
    else if (canAddMoon()) addMoon();
    else if (canAddPlanet()) addPlanet();
    scheduleNextUnlock();
    toast('Body purchased!');
    playPop();
  }

  function applyEconomy(dtSec) {
    const mps = materialsPerSec();
    const cps = creditsPerSec();
    state.materials += mps * dtSec;
    state.credits += cps * dtSec;
  }

  function checkInterstellar() {
    const days = (Date.now() - state.startedAt) / (24 * 3600 * 1000);
    if (days >= 10 && state.intelligence >= 10 && !state.unlockedInterstellar) {
      state.unlockedInterstellar = true;
      state.galaxySeed = hashSeed(String(state.startedAt) + String(rng()));
      toast('Interstellar travel online!');
      logComms('Galaxy chart unlocked. Seed: ' + state.galaxySeed);
    }
  }

  function pollFlare(now) {
    if (now - lastFlarePollAt < FLARE_POLL_MS) return;
    lastFlarePollAt = now;
    state.lastFlarePollAt = now;
    if (rng() < FLARE_CHANCE) {
      state.randomEvent = { type: 'solarFlare', endsAt: now + FLARE_DURATION_MS };
      toast('Solar flare! Double credits for 30s!');
      const sun = document.querySelector('.sun-glow');
      if (sun) sun.classList.add('flare-active');
    }
  }

  function expireFlare(now) {
    if (state.randomEvent && state.randomEvent.endsAt <= now) {
      state.randomEvent = null;
      const sun = document.querySelector('.sun-glow');
      if (sun) sun.classList.remove('flare-active');
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.saveVersion !== SAVE_VERSION) return false;
      state = data;
      bodyIdSeq = state.bodies.reduce((m, b) => {
        const n = parseInt(String(b.id).replace(/^b/, ''), 10);
        return Math.max(m, isNaN(n) ? 0 : n);
      }, 0);
      lastTickAt = state.lastTickAt;
      lastFlarePollAt = state.lastFlarePollAt || lastTickAt;
      if (state.randomEvent && state.randomEvent.endsAt < Date.now()) state.randomEvent = null;
      state.comms = state.comms || [];
      state.tradeCooldowns = state.tradeCooldowns || {};
      state.raidCooldowns = state.raidCooldowns || {};
      if (!state.nextUnlockAt) state.nextUnlockAt = Date.now() + BASE_UNLOCK_MS;
      ensureUnlockSchedule();
      return true;
    } catch {
      return false;
    }
  }

  function saveGame() {
    state.lastTickAt = Date.now();
    state.lastFlarePollAt = lastFlarePollAt;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function resumeAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playPop() {
    resumeAudio();
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.05);
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
    o.start(audioCtx.currentTime);
    o.stop(audioCtx.currentTime + 0.07);
  }

  function sparkleAt(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const host = document.createElement('div');
    host.className = 'sparkle-burst';
    host.style.left = rect.left + rect.width / 2 + 'px';
    host.style.top = rect.top + rect.height / 2 + 'px';
    host.style.transform = 'translate(-50%, -50%)';
    document.body.appendChild(host);
    for (let i = 0; i < 8; i++) {
      const sp = document.createElement('div');
      sp.className = 'sparkle';
      const ang = (i / 8) * Math.PI * 2;
      const d = 24 + rng() * 16;
      sp.style.setProperty('--sx', Math.cos(ang) * d + 'px');
      sp.style.setProperty('--sy', Math.sin(ang) * d + 'px');
      sp.style.animation = 'none';
      sp.offsetHeight;
      sp.style.animation = '';
      host.appendChild(sp);
    }
    setTimeout(() => host.remove(), 500);
  }

  function toast(msg) {
    const c = els.toastContainer;
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function logComms(line) {
    state.comms.unshift({ t: Date.now(), line });
    state.comms = state.comms.slice(0, 30);
    renderComms();
  }

  function onAnyUpgrade(targetEl) {
    playPop();
    sparkleAt(targetEl || document.getElementById('dashboard'));
  }

  function onBodyAddedJuice() {
    playPop();
  }

  function formatNum(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    if (n >= 100) return n.toFixed(1);
    if (n >= 10) return n.toFixed(2);
    return n.toFixed(2);
  }

  function thresholdPop(kind, val) {
    const thresholds = [1000, 10000, 100000, 1000000];
    for (const th of thresholds) {
      if (lastThreshold[kind] < th && val >= th) {
        const el = kind === 'credits' ? els.valCredits : els.valMaterials;
        if (el) {
          el.classList.add('counter-pop');
          setTimeout(() => el.classList.remove('counter-pop'), 400);
        }
        break;
      }
    }
    lastThreshold[kind] = val;
  }

  function getNeighborsModule() {
    return {
      scan() {
        const seed = hashSeed(String(Date.now()) + String(rng()));
        const rand = mulberry32(seed);
        const list = [];
        for (let i = 0; i < 3; i++) {
          const name = SYL1[Math.floor(rand() * SYL1.length)] + SYL2[Math.floor(rand() * SYL2.length)] + '-' + (1 + Math.floor(rand() * 99));
          const power = Math.floor(5 + rand() * 80);
          const planets = 2 + Math.floor(rand() * 8);
          const moons = Math.floor(rand() * 12);
          list.push({ id: 'n' + i + '-' + seed, name, power, planets, moons });
        }
        state.neighbors = list;
        state.neighborsScanned = true;
        return { players: list };
      },
      trade(targetId) {
        const now = Date.now();
        const cd = state.tradeCooldowns[targetId] || 0;
        if (now < cd) return { ok: false, reason: 'cooldown' };
        if (state.credits < TRADE_CREDITS) return { ok: false, reason: 'credits' };
        state.credits -= TRADE_CREDITS;
        state.materials += TRADE_MATERIALS;
        state.tradeCooldowns[targetId] = now + TRADE_COOLDOWN_MS;
        return { ok: true, creditsDelta: -TRADE_CREDITS, materialsDelta: TRADE_MATERIALS };
      },
      raid(targetId) {
        const now = Date.now();
        const cd = state.raidCooldowns[targetId] || 0;
        if (now < cd) return { ok: false, reason: 'cooldown' };
        const win = rng() < 0.5;
        if (win) {
          state.credits += RAID_WIN;
          state.raidCooldowns[targetId] = now + RAID_COOLDOWN_MS;
          return { ok: true, creditsDelta: RAID_WIN };
        }
        state.credits = Math.max(0, state.credits - RAID_LOSE);
        state.raidCooldowns[targetId] = now + RAID_COOLDOWN_MS;
        return { ok: true, creditsDelta: -RAID_LOSE, fail: true };
      },
    };
  }

  const neighborsAPI = getNeighborsModule();

  function threatClass(our, their) {
    if (their < our * 0.8) return 'threat-low';
    if (their < our * 1.2) return 'threat-med';
    return 'threat-high';
  }

  function renderComms() {
    const ul = els.commsLog;
    if (!ul) return;
    ul.innerHTML = '';
    for (const entry of state.comms.slice(0, 15)) {
      const li = document.createElement('li');
      li.textContent = entry.line;
      ul.appendChild(li);
    }
  }

  function renderNeighbors() {
    const wrap = els.neighborsList;
    if (!wrap) return;
    wrap.innerHTML = '';
    const intel = state.intelligence;
    if (intel < 5) return;
    if (!state.neighborsScanned || state.neighbors.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Press Scan to detect nearby systems.';
      wrap.appendChild(p);
      return;
    }
    const ourPow = totalPower();
    const now = Date.now();
    for (const n of state.neighbors) {
      const card = document.createElement('div');
      card.className = 'neighbor-card';
      const h = document.createElement('h4');
      h.textContent = n.name;
      const meta = document.createElement('div');
      meta.className = 'neighbor-meta ' + threatClass(ourPow, n.power);
      meta.textContent = 'Power ' + formatNum(n.power) + ' · Planets ' + n.planets + (n.moons ? ' · Moons ' + n.moons : '');
      card.appendChild(h);
      card.appendChild(meta);
      if (intel >= 9) {
        const actions = document.createElement('div');
        actions.className = 'neighbor-actions';
        const bTrade = document.createElement('button');
        bTrade.type = 'button';
        bTrade.textContent = 'Trade';
        bTrade.dataset.id = n.id;
        const tcd = state.tradeCooldowns[n.id] || 0;
        bTrade.disabled = now < tcd || state.credits < TRADE_CREDITS;
        bTrade.addEventListener('click', () => doTrade(n.id));
        const bRaid = document.createElement('button');
        bRaid.type = 'button';
        bRaid.textContent = 'Raid';
        bRaid.dataset.id = n.id;
        const rcd = state.raidCooldowns[n.id] || 0;
        bRaid.disabled = now < rcd;
        bRaid.addEventListener('click', () => doRaid(n.id));
        actions.appendChild(bTrade);
        actions.appendChild(bRaid);
        card.appendChild(actions);
      }
      wrap.appendChild(card);
    }
  }

  function doTrade(id) {
    const r = neighborsAPI.trade(id);
    if (!r.ok) {
      if (r.reason === 'cooldown') toast('Trade on cooldown');
      else toast('Not enough credits (need ' + TRADE_CREDITS + ')');
      return;
    }
    logComms('Traded: +' + TRADE_MATERIALS + ' materials for ' + TRADE_CREDITS + ' credits.');
    toast('Trade complete!');
    onAnyUpgrade(els.btnScan);
    renderNeighbors();
  }

  function doRaid(id) {
    const r = neighborsAPI.raid(id);
    if (!r.ok) {
      toast('Raid on cooldown');
      return;
    }
    if (r.fail) {
      logComms('Raid failed! Lost ' + RAID_LOSE + ' credits.');
      toast('Raid failed — lost credits!');
    } else {
      logComms('Raid success! +' + RAID_WIN + ' credits.');
      toast('Raid successful!');
    }
    onAnyUpgrade(els.btnScan);
    renderNeighbors();
  }

  function renderDashboard() {
    const cps = creditsPerSec();
    const mps = materialsPerSec();
    const tp = totalPower();

    els.valCredits.textContent = formatNum(state.credits);
    els.valMaterials.textContent = formatNum(state.materials);
    els.rateCredits.textContent = '+' + formatNum(cps) + '/s';
    els.rateMaterials.textContent = '+' + formatNum(mps) + '/s';
    els.valPower.textContent = formatNum(tp);
    els.valIntel.textContent = String(state.intelligence);

    thresholdPop('credits', state.credits);
    thresholdPop('materials', state.materials);

    const cost = researchCost();
    const canResearch =
      state.intelligence < 10 && state.credits >= cost.credits && state.materials >= cost.materials;
    els.btnResearch.disabled = !canResearch;
    els.researchCost.textContent =
      state.intelligence >= 10
        ? 'Max intelligence reached.'
        : 'Cost: ' + formatNum(cost.materials) + ' mat, ' + formatNum(cost.credits) + ' cr';

    const buyCost = buyBodyCost();
    els.btnBuyBody.disabled = state.materials < buyCost;
    els.buyBodyCost.textContent = 'Cost: ' + formatNum(buyCost) + ' materials';

    const now = Date.now();
    const nu = state.nextUnlockAt || now;
    const remain = Math.max(0, nu - now);
    const delay = nextUnlockDelayMs();
    const progress = delay > 0 ? Math.min(100, (100 * (delay - remain)) / delay) : 100;
    els.nextUnlockLabel.textContent =
      remain > 0
        ? 'Next body in: ' + Math.ceil(remain / 1000) + 's'
        : 'Next body soon…';
    els.nextUnlockBar.style.width = progress + '%';

    els.btnScan.disabled = state.intelligence < 5;
    els.btnRefinery.hidden = !(state.buildingTier >= 1 && !state.refineryBuilt);
    els.refineryHint.textContent = state.refineryBuilt
      ? 'Orbital refinery online (+20% credits).'
      : state.buildingTier >= 1
        ? 'Build the refinery for +20% credits/sec.'
        : '';

    const ep = els.eventPanel;
    if (state.randomEvent && state.randomEvent.endsAt > now) {
      ep.hidden = false;
      const left = state.randomEvent.endsAt - now;
      els.eventTimer.textContent = Math.ceil(left / 1000) + 's left';
      els.eventBar.style.width = (100 * left) / FLARE_DURATION_MS + '%';
    } else {
      ep.hidden = true;
    }

    document.getElementById('solar-system').dataset.intel = String(state.intelligence);

    renderNeighbors();
  }

  function renderOrbits() {
    const rings = els.orbitRings;
    rings.innerHTML = '';
    const planets = state.bodies.filter((b) => b.type === 'planet');
    const maxR = Math.max(160, ...planets.map((p) => p.orbitRadius));
    const outermost = state.intelligence >= 10;
    for (const p of planets) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'orbit-ring' + (outermost && p === planets[planets.length - 1] ? ' outermost' : ''));
      circle.setAttribute('cx', '0');
      circle.setAttribute('cy', '0');
      circle.setAttribute('r', String(p.orbitRadius));
      if (state.intelligence >= 4) circle.classList.add('thick');
      rings.appendChild(circle);
    }
    if (state.intelligence >= 10 && planets.length > 0) {
      const last = planets[planets.length - 1];
      const tail = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      tail.setAttribute('class', 'comet-tail');
      tail.setAttribute('cx', String(last.orbitRadius));
      tail.setAttribute('cy', '0');
      tail.setAttribute('rx', '28');
      tail.setAttribute('ry', '6');
      tail.setAttribute('fill', 'rgba(108,240,255,0.15)');
      tail.setAttribute('transform', 'rotate(-15)');
      rings.appendChild(tail);
    }
  }

  function renderBodies() {
    const layer = els.bodiesLayer;
    layer.innerHTML = '';

    const sun = state.bodies.find((b) => b.type === 'sun');
    if (sun) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('class', 'body-hit sun-glow' + (state.randomEvent && Date.now() < state.randomEvent.endsAt ? ' flare-active' : ''));
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      c.setAttribute('r', '18');
      c.setAttribute('fill', 'url(#sunGrad)');
      c.dataset.bodyId = sun.id;
      g.appendChild(c);
      layer.appendChild(g);
    }

    if (state.intelligence >= 8) {
      const dust = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dust.setAttribute('class', 'dust-layer');
      dust.setAttribute('cx', '0');
      dust.setAttribute('cy', '0');
      dust.setAttribute('r', '190');
      dust.setAttribute('fill', 'none');
      dust.setAttribute('stroke', 'rgba(200,200,255,0.08)');
      layer.insertBefore(dust, layer.firstChild);
    }

    if (state.intelligence >= 5) {
      const sweep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      sweep.setAttribute('class', 'radar-sweep');
      sweep.setAttribute('x1', '0');
      sweep.setAttribute('y1', '0');
      sweep.setAttribute('x2', '180');
      sweep.setAttribute('y2', '0');
      sweep.setAttribute('stroke', 'rgba(108,240,255,0.25)');
      layer.appendChild(sweep);
    }

    const planets = state.bodies.filter((b) => b.type === 'planet');
    for (const p of planets) {
      const pg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      pg.setAttribute('data-body-id', p.id);
      const angle = p.angle;
      pg.setAttribute('transform', 'rotate(' + (angle * 180) / Math.PI + ') translate(' + p.orbitRadius + ' 0)');

      const pr = 4 + Math.sqrt(p.size) * 3;
      const pc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const boosted = Date.now() < p.boostedUntil;
      pc.setAttribute('class', 'body-hit planet-glow' + (boosted ? ' boosted' : ''));
      pc.setAttribute('cx', '0');
      pc.setAttribute('cy', '0');
      pc.setAttribute('r', String(pr));
      pc.setAttribute('fill', p.planetSlot === 0 ? '#6cf0ff' : p.planetSlot === 1 ? '#6c9fff' : '#9fff6c');
      pc.dataset.bodyId = p.id;
      pg.appendChild(pc);

      if (state.intelligence >= 6) {
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('class', 'moon-ring-extra');
        ring.setAttribute('cx', '0');
        ring.setAttribute('cy', '0');
        ring.setAttribute('r', String(pr + 6));
        pg.appendChild(ring);
      }

      for (let i = 0; i < p.powerPlants; i++) {
        const pm = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        pm.setAttribute('class', 'plant-marker');
        pm.setAttribute('x', String(-4 + i * 3));
        pm.setAttribute('y', String(-pr - 8));
        pm.setAttribute('width', '3');
        pm.setAttribute('height', '4');
        pg.appendChild(pm);
      }

      const moons = state.bodies.filter((b) => b.type === 'moon' && b.parentId === p.id);
      for (const m of moons) {
        const mg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        mg.setAttribute(
          'transform',
          'rotate(' + (m.moonAngle * 180) / Math.PI + ') translate(' + m.orbitRadius + ' 0)'
        );
        const mr = 3 + Math.sqrt(m.size) * 2;
        const mc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const mb = Date.now() < m.boostedUntil;
        mc.setAttribute('class', 'body-hit planet-glow' + (mb ? ' boosted' : ''));
        mc.setAttribute('cx', '0');
        mc.setAttribute('cy', '0');
        mc.setAttribute('r', String(mr));
        mc.setAttribute('fill', '#c4b4ff');
        mc.dataset.bodyId = m.id;
        mg.appendChild(mc);
        for (let j = 0; j < m.powerPlants; j++) {
          const pm = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          pm.setAttribute('class', 'plant-marker');
          pm.setAttribute('x', String(-3 + j * 2));
          pm.setAttribute('y', String(-mr - 6));
          pm.setAttribute('width', '2');
          pm.setAttribute('height', '3');
          mg.appendChild(pm);
        }
        pg.appendChild(mg);
      }

      layer.appendChild(pg);
    }

    const orphanMoons = state.bodies.filter((b) => b.type === 'moon' && !planets.find((p) => p.id === b.parentId));
    for (const m of orphanMoons) {
      const anchor = planets[0];
      if (!anchor) continue;
      m.parentId = anchor.id;
    }
  }

  function updateAngles(dtSec) {
    const dtMs = dtSec * 1000;
    for (const b of state.bodies) {
      if (b.type === 'planet') b.angle += b.orbitSpeed * dtMs;
      if (b.type === 'moon') b.moonAngle += b.orbitSpeed * dtMs;
    }
  }

  function attachInputHandlers() {
    const svg = els.systemSvg;
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', cancelLongPress);
    svg.addEventListener('pointerleave', cancelLongPress);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());

    els.btnResearch.addEventListener('click', () => {
      const cost = researchCost();
      if (state.intelligence >= 10) return;
      if (state.credits < cost.credits || state.materials < cost.materials) return;
      state.credits -= cost.credits;
      state.materials -= cost.materials;
      state.intelligence++;
      onAnyUpgrade(els.btnResearch);
      if (state.intelligence === 3) els.valCredits.classList.add('gold-shimmer');
      setTimeout(() => els.valCredits.classList.remove('gold-shimmer'), 600);
      toast('Intelligence ' + state.intelligence + '!');
      renderDashboard();
      renderBodies();
      renderOrbits();
      saveGame();
    });

    els.btnBuyBody.addEventListener('click', buyBodySkip);

    els.btnScan.addEventListener('click', () => {
      if (state.intelligence < 5) return;
      neighborsAPI.scan();
      toast('Scan complete — 3 contacts');
      renderNeighbors();
      onAnyUpgrade(els.btnScan);
    });

    els.btnRefinery.addEventListener('click', () => {
      if (state.refineryBuilt || state.materials < REFINERY_COST) return;
      state.materials -= REFINERY_COST;
      state.refineryBuilt = true;
      toast('Orbital refinery online!');
      onAnyUpgrade(els.btnRefinery);
    });

    els.buildClose.addEventListener('click', () => {
      els.buildPanel.hidden = true;
    });

    els.btnBuildPlant.addEventListener('click', () => {
      const id = els.buildPanel.dataset.bodyId;
      if (!id) return;
      const body = state.bodies.find((b) => b.id === id);
      if (!body || body.type === 'sun') return;
      const cost = plantCost(body);
      if (state.materials < cost) {
        toast('Not enough materials');
        return;
      }
      if (body.powerPlants >= maxPlantsForBody(body)) {
        toast('Max plants on this body');
        return;
      }
      state.materials -= cost;
      body.powerPlants++;
      const wasTier = state.buildingTier;
      if (state.buildingTier < 1) {
        state.buildingTier = 1;
        toast('Chain unlocked: +10% materials!');
      }
      onAnyUpgrade(els.btnBuildPlant);
      els.buildPanel.hidden = true;
      renderBodies();
      if (wasTier < 1 && state.buildingTier >= 1) {
        /* first plant */
      }
    });

    els.btnHelp.addEventListener('click', () => {
      els.helpPanel.hidden = false;
    });
    els.helpClose.addEventListener('click', () => {
      els.helpPanel.hidden = true;
    });
  }

  function getBodyFromEvent(e) {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.bodyId) return null;
    return state.bodies.find((b) => b.id === t.dataset.bodyId);
  }

  function onPointerDown(e) {
    resumeAudio();
    const body = getBodyFromEvent(e);
    if (!body) return;
    activePointerBodyId = body.id;
    longPressFired = false;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressFired = true;
      if (body.type !== 'sun') {
        openBuildMenu(body.id);
      }
    }, LONG_PRESS_MS);
  }

  function onPointerUp(e) {
    const body =
      getBodyFromEvent(e) || (activePointerBodyId ? state.bodies.find((b) => b.id === activePointerBodyId) : null);
    const hadTimer = longPressTimer;
    clearTimeout(longPressTimer);
    longPressTimer = null;
    activePointerBodyId = null;

    if (!body) return;
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    if (!hadTimer) return;

    if (body.type === 'sun') {
      state.credits += 1;
      const hit = e.target.closest('[data-body-id]') || e.target;
      if (hit.classList) {
        hit.classList.add('flare-active');
        setTimeout(() => hit.classList.remove('flare-active'), 150);
      }
      return;
    }
    const now = Date.now();
    if (body.boostedUntil > now) return;
    body.boostedUntil = now + BOOST_MS;
    renderBodies();
    playPop();
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    activePointerBodyId = null;
  }

  function openBuildMenu(bodyId) {
    const body = state.bodies.find((b) => b.id === bodyId);
    if (!body || body.type === 'sun') return;
    els.buildPanel.hidden = false;
    els.buildPanel.dataset.bodyId = bodyId;
    els.buildPanelTitle.textContent = body.name;
    els.buildPanelSub.textContent = body.type === 'moon' ? 'Moon · build power plants' : 'Planet · build power plants';
    const cost = plantCost(body);
    els.plantCost.textContent =
      'Next plant: ' +
      formatNum(cost) +
      ' materials · ' +
      body.powerPlants +
      '/' +
      maxPlantsForBody(body) +
      ' plants';
    els.btnBuildPlant.disabled = state.materials < cost || body.powerPlants >= maxPlantsForBody(body);
  }

  function gameLoop() {
    const now = Date.now();
    const frameNow = performance.now();
    const frameDt = Math.min(0.05, (frameNow - lastFrameTime) / 1000);
    lastFrameTime = frameNow;

    let dtMs = now - lastTickAt;
    if (dtMs > MAX_OFFLINE_MS) dtMs = MAX_OFFLINE_MS;
    const dtSec = dtMs / 1000;

    updateAngles(frameDt);

    if (dtMs >= TICK_MS) {
      applyEconomy(dtSec);
      processUnlocks(now);
      checkInterstellar();
      pollFlare(now);
      expireFlare(now);
      lastTickAt = now;
      state.lastTickAt = now;
      renderDashboard();
      renderOrbits();
      if (now - lastAutosaveAt >= AUTOSAVE_MS) {
        saveGame();
        lastAutosaveAt = now;
      }
    }

    renderBodies();

    rafId = requestAnimationFrame(gameLoop);
  }

  function cacheEls() {
    els.systemSvg = document.getElementById('system-svg');
    els.orbitRings = document.getElementById('orbit-rings');
    els.bodiesLayer = document.getElementById('bodies-layer');
    els.valCredits = document.getElementById('val-credits');
    els.valMaterials = document.getElementById('val-materials');
    els.rateCredits = document.getElementById('rate-credits');
    els.rateMaterials = document.getElementById('rate-materials');
    els.valPower = document.getElementById('val-power');
    els.valIntel = document.getElementById('val-intel');
    els.btnResearch = document.getElementById('btn-research');
    els.researchCost = document.getElementById('research-cost');
    els.nextUnlockLabel = document.getElementById('next-unlock-label');
    els.nextUnlockBar = document.getElementById('next-unlock-bar');
    els.btnBuyBody = document.getElementById('btn-buy-body');
    els.buyBodyCost = document.getElementById('buy-body-cost');
    els.btnScan = document.getElementById('btn-scan');
    els.neighborsList = document.getElementById('neighbors-list');
    els.commsLog = document.getElementById('comms-log');
    els.toastContainer = document.getElementById('toast-container');
    els.eventPanel = document.getElementById('event-panel');
    els.eventTimer = document.getElementById('event-timer');
    els.eventBar = document.getElementById('event-bar');
    els.btnRefinery = document.getElementById('btn-refinery');
    els.refineryHint = document.getElementById('refinery-hint');
    els.buildPanel = document.getElementById('build-panel');
    els.buildClose = document.getElementById('build-close');
    els.buildPanelTitle = document.getElementById('build-panel-title');
    els.buildPanelSub = document.getElementById('build-panel-sub');
    els.btnBuildPlant = document.getElementById('btn-build-plant');
    els.plantCost = document.getElementById('plant-cost');
    els.btnHelp = document.getElementById('btn-help');
    els.helpPanel = document.getElementById('help-panel');
    els.helpClose = document.getElementById('help-close');
  }

  function setupWelcome() {
    const overlay = document.getElementById('welcome-overlay');
    const btn = document.getElementById('btn-start-game');
    if (!overlay || !btn) return;

    function dismissWelcome() {
      overlay.hidden = true;
      try {
        localStorage.setItem(WELCOME_KEY, '1');
      } catch (_) {}
      resumeAudio();
      document.removeEventListener('keydown', onWelcomeKeydown);
    }

    function onWelcomeKeydown(e) {
      if (e.key === 'Escape' && !overlay.hidden) dismissWelcome();
    }

    if (overlay.hidden) return;

    btn.addEventListener('click', dismissWelcome);
    document.addEventListener('keydown', onWelcomeKeydown);
  }

  function init() {
    cacheEls();
    setupWelcome();
    const loaded = loadGame();
    if (!loaded) {
      state = createDefaultState();
      lastTickAt = state.lastTickAt;
      lastFlarePollAt = state.lastFlarePollAt;
      scheduleNextUnlock();
    } else {
      const now = Date.now();
      const delta = Math.min(now - state.lastTickAt, MAX_OFFLINE_MS);
      applyEconomy(delta / 1000);
      processUnlocks(now);
      expireFlare(now);
      lastTickAt = now;
      state.lastTickAt = now;
      lastFlarePollAt = state.lastFlarePollAt || lastTickAt;
      ensureUnlockSchedule();
    }

    lastThreshold.credits = state.credits;
    lastThreshold.materials = state.materials;

    attachInputHandlers();
    renderOrbits();
    renderBodies();
    renderDashboard();
    renderComms();
    renderNeighbors();

    lastAutosaveAt = Date.now();
    lastFrameTime = performance.now();
    gameLoop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
