(function (global) {
  'use strict';

  const SCHEDULES_KEY = 'au_schedules_v1';
  const ALARM_PREFIX = 'au_sched_';

  function parseCronField(fieldStr, minVal, maxVal) {
    const allowed = new Set();
    const parts = String(fieldStr || '*').trim().split(',');
    for (let p = 0; p < parts.length; p++) {
      const tok = parts[p].trim();
      if (!tok) continue;
      const stepParts = tok.split('/');
      const rangePart = stepParts[0];
      const step = stepParts[1] ? Math.max(1, parseInt(stepParts[1], 10) || 1) : 1;

      let start = minVal;
      let end = maxVal;
      if (rangePart !== '*') {
        if (rangePart.includes('-')) {
          const [a, b] = rangePart.split('-');
          start = Math.max(minVal, Math.min(maxVal, parseInt(a, 10)));
          end = Math.max(minVal, Math.min(maxVal, parseInt(b, 10)));
        } else {
          const v = parseInt(rangePart, 10);
          if (!Number.isNaN(v)) {
            start = Math.max(minVal, Math.min(maxVal, v));
            end = stepParts[1] ? maxVal : start;
          }
        }
      }
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      for (let v = start; v <= end; v += step) {
        allowed.add(v);
      }
    }
    if (allowed.size === 0) {
      for (let v = minVal; v <= maxVal; v++) allowed.add(v);
    }
    return allowed;
  }

  function computeNextCronTimestamp(cronExpr, fromMs) {
    const base = typeof fromMs === 'number' ? fromMs : Date.now();
    const raw = String(cronExpr || '').trim();

    // Friendly interval shorthands
    const everyMinMatch = raw.match(/^@every_(\d+)m$/i);
    if (everyMinMatch) {
      const mins = Math.max(1, parseInt(everyMinMatch[1], 10) || 60);
      return base + mins * 60 * 1000;
    }
    if (/^@hourly$/i.test(raw)) return base + 60 * 60 * 1000;
    if (/^@daily$/i.test(raw)) return base + 24 * 60 * 60 * 1000;

    const fields = raw.split(/\s+/);
    if (fields.length !== 5) {
      throw new Error('Expressão cron inválida: use 5 campos (min hora dia mês diaSemana), ex: "0 9 * * 1-5".');
    }

    const minsSet = parseCronField(fields[0], 0, 59);
    const hoursSet = parseCronField(fields[1], 0, 23);
    const domSet = parseCronField(fields[2], 1, 31);
    const monthSet = parseCronField(fields[3], 1, 12);
    const dowSet = parseCronField(fields[4], 0, 6);

    const candidate = new Date(base);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Search up to 366 days ahead (minute granularity with fast hour/day skips)
    const maxIterations = 366 * 24 * 60;
    for (let iter = 0; iter < maxIterations; iter++) {
      const month = candidate.getMonth() + 1;
      if (!monthSet.has(month)) {
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }
      const dom = candidate.getDate();
      const dow = candidate.getDay();
      if (!domSet.has(dom) || !dowSet.has(dow)) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }
      const hr = candidate.getHours();
      if (!hoursSet.has(hr)) {
        candidate.setHours(hr + 1, 0, 0, 0);
        continue;
      }
      const mn = candidate.getMinutes();
      if (!minsSet.has(mn)) {
        candidate.setMinutes(mn + 1, 0, 0);
        continue;
      }
      return candidate.getTime();
    }
    return base + 24 * 60 * 60 * 1000;
  }

  async function getSchedules() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    const res = await new Promise((r) => chrome.storage.local.get(SCHEDULES_KEY, (x) => r(x || {})));
    return Array.isArray(res[SCHEDULES_KEY]) ? res[SCHEDULES_KEY] : [];
  }

  async function saveSchedules(list) {
    const clean = Array.isArray(list) ? list.slice(0, 50) : [];
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise((r) => chrome.storage.local.set({ [SCHEDULES_KEY]: clean }, () => r()));
    }
    await syncChromeAlarms(clean);
    return clean;
  }

  async function syncChromeAlarms(schedules) {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    const list = Array.isArray(schedules) ? schedules : await getSchedules();
    const allAlarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a || [])));
    for (const al of allAlarms) {
      if (al && al.name && al.name.startsWith(ALARM_PREFIX)) {
        await new Promise((r) => chrome.alarms.clear(al.name, () => r()));
      }
    }
    for (const item of list) {
      if (!item || !item.enabled || !item.id) continue;
      const when = Math.max(Date.now() + 5000, Number(item.nextRunAt || 0) || computeNextCronTimestamp(item.cronExpr));
      chrome.alarms.create(ALARM_PREFIX + item.id, { when });
    }
  }

  async function upsertSchedule(input) {
    const list = await getSchedules();
    const cronExpr = String((input && input.cronExpr) || '0 9 * * 1-5').trim();
    const nextRunAt = computeNextCronTimestamp(cronExpr, Date.now());
    const item = {
      id: (input && input.id) || 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: String((input && input.name) || 'Tarefa Agendada').slice(0, 90),
      enabled: input && input.enabled !== undefined ? Boolean(input.enabled) : true,
      cronExpr,
      actionType: String((input && input.actionType) || 'launch_batch'), // 'launch_batch' | 'broadcast_open_tabs' | 'cleanup_completed_rooms'
      prompt: String((input && input.prompt) || '').slice(0, 12000),
      agentCount: Math.max(1, Math.min(8, Number((input && input.agentCount) || 2))),
      collabProfile: String((input && input.collabProfile) || 'specialists'),
      githubRepo: String((input && input.githubRepo) || '').trim(),
      catchUpOnWake: input && input.catchUpOnWake !== undefined ? Boolean(input.catchUpOnWake) : true,
      nextRunAt,
      lastRunAt: Number((input && input.lastRunAt) || 0),
      lastStatus: String((input && input.lastStatus) || 'agendado'),
      runCount: Number((input && input.runCount) || 0)
    };
    const idx = list.findIndex((s) => s.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    await saveSchedules(list);
    return item;
  }

  async function deleteSchedule(id) {
    const list = await getSchedules();
    const next = list.filter((s) => s.id !== id);
    await saveSchedules(next);
    return next;
  }

  global.AU_SCHEDULER = {
    SCHEDULES_KEY,
    ALARM_PREFIX,
    computeNextCronTimestamp,
    getSchedules,
    saveSchedules,
    syncChromeAlarms,
    upsertSchedule,
    deleteSchedule
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
