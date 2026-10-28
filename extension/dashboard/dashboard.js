/* global AU_DEFAULTS, AU_STORAGE */
(function () {
  'use strict';

  let currentSettings = null;
  let currentRules = [];
  let selectedChatId = null;
  let selectedCollabRoomId = '';
  let lastCollabSignature = '';
  let currentCollabRoomObj = null;

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, isError) {
    const el = document.getElementById('dash-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.borderColor = isError ? '#ef4444' : '#10b981';
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 400);
  }

  // --- Navigation ---
  function switchSection(secId) {
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.sec === secId);
    });
    document.querySelectorAll('.section').forEach((s) => {
      s.classList.toggle('active', s.id === 'sec-' + secId);
    });
    if (secId === 'mission') refreshMissionControl();
    if (secId === 'launcher') syncLauncherIntegrationDefaults();
    if (secId === 'collab') refreshCollabSection(true);
    if (secId === 'integrations') renderIntegrationsSection();
    if (secId === 'v4hub') renderV4HubSection();
    if (secId === 'prompts') renderPromptsAndMacros();
    if (secId === 'history') renderHistorySection();
    if (secId === 'analytics') renderAnalyticsSection();
    if (secId === 'visual') renderVisualSection();
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = btn.dataset.sec;
      switchSection(btn.dataset.sec);
    });
  });

  const sideOpenLiveChatBtn = document.getElementById('side-open-livechat');
  if (sideOpenLiveChatBtn) {
    sideOpenLiveChatBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'AU_OPEN_LIVECHAT',
        roomId: selectedCollabRoomId || ''
      });
    });
  }

  document.getElementById('side-new-agent').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://arena.ai/agent', active: true });
  });

  // --- 1. Mission Control ---
  let lastMissionSignature = '';

  function refreshMissionControl() {
    if (document.hidden) return;
    chrome.runtime.sendMessage({ type: 'AU_GET_MISSION_CONTROL' }, (res) => {
      if (!res || !res.ok) return;
      const tabs = res.tabs || [];
      const metrics = res.metrics || {};

      const activeNow = tabs.filter((t) => t.autoContinueEnabled).length;
      document.getElementById('mc-kpi-open').textContent = String(tabs.length);
      document.getElementById('mc-kpi-active').textContent = String(activeNow);
      document.getElementById('mc-kpi-loops').textContent = String(metrics.totalAutoLoopsSent || 0);
      document.getElementById('mc-kpi-stopped').textContent = String(metrics.totalTokenLimitStops || 0);

      const sig = tabs
        .map((t) => `${t.tabId}:${t.groupId || -1}:${t.autoContinueEnabled ? 1 : 0}:${t.status}:${t.loopsCount}:${t.queueLength}:${t.estimatedTokens}:${t.title}:${t.stopReason}:${t.collabRoomId || ''}`)
        .join('|');
      if (sig === lastMissionSignature) return;
      lastMissionSignature = sig;

      const container = document.getElementById('mc-tabs-container');
      if (!tabs.length) {
        container.innerHTML =
          '<div class="muted">Nenhuma aba aberta em arena.ai no momento. Use o Lançador Multi-Agent ou clique em "+ Novo Chat Agent".</div>';
        return;
      }

      container.innerHTML = tabs
        .map((t) => {
          const stopped = t.status === 'token_stopped';
          const isThinkingRefused =
            t.status === 'thinking_refused' ||
            (stopped && /Thinking|Thought|Pensando|Pensou|recusado/i.test(t.stopReason || ''));
          const captcha = t.status === 'captcha_waiting';
          const badgeCls = stopped || isThinkingRefused || captcha ? 'stopped' : t.autoContinueEnabled ? 'active' : '';
          const badgeTxt = isThinkingRefused
            ? `🚫 ${t.stopReason || 'Modelo Thinking Recusado'}`
            : stopped
              ? `⚠️ Sem Tokens (${t.stopReason || 'Limite'})`
              : captcha
                ? '🛡️ Marque "Não sou um robô" na aba (Retoma sozinho!)'
                : t.autoContinueEnabled
                  ? `🟢 Autopilot Ativo (${t.status === 'generating' ? 'Gerando' : 'Monitorando'})`
                  : '⚪ Pausado';

          return `
            <div class="item-box">
              <div class="item-top">
                <div>
                  <strong>${esc(t.title || 'Arena.ai')}</strong>
                  <div class="muted">${esc(t.url || '')}</div>
                </div>
                <span class="badge ${badgeCls}">${esc(badgeTxt)}</span>
              </div>
              <div class="item-top" style="margin-top:4px;">
                <div class="row muted">
                  <span>Modo: <strong>${esc((t.mode || 'chat').toUpperCase())}</strong></span>
                  ${typeof t.groupId === 'number' && t.groupId >= 0 ? '<span>• <strong>🗂️ Agrupada</strong></span>' : ''}
                  <span>• Loops enviados: <strong>${Number(t.loopsCount || 0)}</strong></span>
                  <span>• Fila: <strong>${Number(t.queueLength || 0)}</strong></span>
                  <span>• Tokens est.: <strong>~${Number(t.estimatedTokens || 0).toLocaleString('pt-BR')}</strong></span>
                  ${t.collabRoomId ? `<button class="btn btn-sm mc-open-room" data-room="${esc(t.collabRoomId)}" style="border-color:rgba(6,182,212,0.5);color:#67e8f9;">🤝 Sala #${esc(t.collabRoomId)}</button>` : ''}
                </div>
                <div class="row">
                  <button class="btn btn-sm mc-tab-toggle ${t.autoContinueEnabled ? 'btn-danger' : 'btn-primary'}" data-id="${t.tabId}" data-on="${t.autoContinueEnabled ? '1' : '0'}">
                    ${t.autoContinueEnabled ? '⏸ Pausar' : '▶ Iniciar Autopilot'}
                  </button>
                  <button class="btn btn-sm mc-tab-focus" data-id="${t.tabId}">Ir à Aba</button>
                  <button class="btn btn-sm mc-tab-dl" data-id="${t.tabId}" title="Baixar Workspace do Agent">⬇ Workspace</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      container.querySelectorAll('.mc-tab-toggle').forEach((b) => {
        b.onclick = () => {
          chrome.runtime.sendMessage(
            {
              type: 'AU_CONTROL_TAB',
              tabId: Number(b.dataset.id),
              command: 'toggle_auto_continue',
              payload: { enable: b.dataset.on !== '1' }
            },
            () => setTimeout(refreshMissionControl, 250)
          );
        };
      });

      container.querySelectorAll('.mc-tab-focus').forEach((b) => {
        b.onclick = () => {
          chrome.runtime.sendMessage({ type: 'AU_CONTROL_TAB', tabId: Number(b.dataset.id), command: 'focus' });
        };
      });

      container.querySelectorAll('.mc-tab-dl').forEach((b) => {
        b.onclick = () => {
          if (b.disabled) return;
          const origLbl = b.textContent;
          b.disabled = true;
          b.textContent = '⏳...';
          chrome.runtime.sendMessage(
            {
              type: 'AU_CONTROL_TAB',
              tabId: Number(b.dataset.id),
              command: 'download_workspace',
              payload: { returnBytes: true }
            },
            (res) => {
              b.disabled = false;
              b.textContent = origLbl;
              if (res && res.ok && res.base64Zip) {
                try {
                  const bin = atob(res.base64Zip);
                  const arr = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
                  const blob = new Blob([arr], { type: 'application/zip' });
                  const blobUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = blobUrl;
                  a.download = res.filename || 'arena-workspace.zip';
                  document.body.appendChild(a);
                  a.click();
                  setTimeout(() => {
                    try { a.remove(); } catch (_) {}
                    URL.revokeObjectURL(blobUrl);
                  }, 1500);
                  toast(`⬇ Workspace baixado (${Number(res.filesCount || 0)} arquivo(s))!`);
                  return;
                } catch (_) {}
              }
              if (res && res.ok) {
                toast('⬇ Download do Workspace iniciado na aba!');
              } else {
                toast((res && res.error) || 'Nenhum arquivo criado no Workspace desta conversa ainda.', true);
              }
            }
          );
        };
      });

      container.querySelectorAll('.mc-open-room').forEach((b) => {
        b.onclick = () => {
          selectedCollabRoomId = b.dataset.room || '';
          location.hash = 'collab';
          switchSection('collab');
        };
      });
    });
  }

  document.getElementById('mc-pause-all').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'pause_all' }, () => {
      toast('Todos os Autopilots foram pausados.');
      setTimeout(refreshMissionControl, 250);
    });
  };

  document.getElementById('mc-resume-all').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'resume_all' }, () => {
      toast('Autopilot retomado em todas as abas!');
      setTimeout(refreshMissionControl, 250);
    });
  };

  document.getElementById('mc-group-tabs').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_GROUP_ARENA_TABS' }, (res) => {
      toast(res && res.ok ? `${res.count} abas agrupadas!` : 'Abra ao menos uma aba no Arena.ai.', !(res && res.ok));
    });
  };

  document.getElementById('mc-split-tabs').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_SPLIT_ARENA_WINDOWS' }, (res) => {
      if (res && !res.ok) toast(res.reason || 'Abra ao menos 2 abas.', true);
      else toast('Janelas divididas lado a lado!');
    });
  };

  document.getElementById('mc-broadcast-btn').onclick = () => {
    const inp = document.getElementById('mc-broadcast-input');
    const prompt = inp.value.trim();
    if (!prompt) {
      toast('Digite o prompt para enviar em massa.', true);
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'AU_GLOBAL_TAB_ACTION', command: 'broadcast_prompt', payload: { prompt } },
      (res) => {
        inp.value = '';
        toast(`Prompt enviado simultaneamente para ${(res && res.affected) || 0} abas!`);
      }
    );
  };

  // --- 2. Multi-Agent Launcher ---
  const lnMode = document.getElementById('ln-mode');
  lnMode.onchange = () => {
    document.getElementById('ln-box-swarm').style.display = lnMode.value === 'swarm' ? 'flex' : 'none';
    document.getElementById('ln-box-tasks').style.display = lnMode.value === 'task_list' ? 'flex' : 'none';
    document.getElementById('ln-box-matrix').style.display = lnMode.value === 'matrix' ? 'flex' : 'none';
  };

  async function populateLauncherMacros() {
    const macros = await AU_STORAGE.getMacros();
    const sel = document.getElementById('ln-macro');
    sel.innerHTML =
      '<option value="">Sem fila extra (entrar direto no Loop Contínuo)</option>' +
      macros.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} (${m.steps.length} etapas)</option>`).join('');
  }

  const lnCollabEnabled = document.getElementById('ln-collab-enabled');
  if (lnCollabEnabled) {
    lnCollabEnabled.onchange = () => {
      document.getElementById('ln-collab-fields').style.display = lnCollabEnabled.checked ? 'flex' : 'none';
      if (lnCollabEnabled.checked) {
        document.getElementById('ln-autoloop').checked = true;
      }
    };
  }

  const lnGhEnabled = document.getElementById('ln-gh-enabled');
  if (lnGhEnabled) {
    lnGhEnabled.onchange = () => {
      document.getElementById('ln-gh-fields').style.display = lnGhEnabled.checked ? 'flex' : 'none';
    };
  }

  function autoExtractBranchFromRepoInput(repoInputEl, branchInputEl) {
    if (!repoInputEl || !branchInputEl) return;
    const val = repoInputEl.value.trim();
    if (!val || typeof AU_INTEGRATIONS === 'undefined' || !AU_INTEGRATIONS.parseGitRepoSpec) return;
    const spec = AU_INTEGRATIONS.parseGitRepoSpec(val);
    if (spec && spec.branchFromUrl) {
      branchInputEl.value = spec.branchFromUrl;
    }
  }

  const lnGhRepoInput = document.getElementById('ln-gh-repo');
  const lnGhBaseInput = document.getElementById('ln-gh-base');
  if (lnGhRepoInput) {
    lnGhRepoInput.addEventListener('input', () => autoExtractBranchFromRepoInput(lnGhRepoInput, lnGhBaseInput));
  }

  async function syncLauncherIntegrationDefaults() {
    const s = await AU_STORAGE.getSettings();
    const ghRepoEl = document.getElementById('ln-gh-repo');
    const ghTokEl = document.getElementById('ln-gh-token');
    const ghBaseEl = document.getElementById('ln-gh-base');
    const ghAuthEl = document.getElementById('ln-gh-auth');
    const ghBranchEl = document.getElementById('ln-gh-branch');
    const ghDefRbacEl = document.getElementById('ln-gh-default-rbac');
    const collabTimeoutEl = document.getElementById('ln-collab-timeout');
    const tfEl = document.getElementById('ln-tf-enabled');
    const refuseEl = document.getElementById('ln-refuse-thinking');
    if (refuseEl) refuseEl.checked = s.refuseThinkingModels !== false;
    if (ghRepoEl && !ghRepoEl.value && s.githubDefaultRepo) ghRepoEl.value = s.githubDefaultRepo;
    if (ghTokEl) {
      chrome.runtime.sendMessage({ type: 'AU_VAULT_GET_STATUS' }, (vs) => {
        if (vs && vs.hasToken) {
          ghTokEl.placeholder = '🔐 Token PAT ativo na sessão do Cofre (deixe vazio p/ reutilizar)';
        }
      });
    }
    if (ghBaseEl && s.githubBaseBranch) ghBaseEl.value = s.githubBaseBranch;
    if (ghAuthEl) ghAuthEl.value = AU_DEFAULTS.normalizeGithubAuthMode(s.githubAuthMode);
    if (ghBranchEl && s.githubBranchMode) ghBranchEl.value = s.githubBranchMode;
    if (ghDefRbacEl) ghDefRbacEl.value = s.githubDefaultAgentAccessMode || 'auto_role';
    if (collabTimeoutEl) collabTimeoutEl.value = Number(s.collabIntegrationTimeoutMinutes || 25);
    if (lnGhEnabled && s.githubEnabledInCollab && s.githubDefaultRepo) {
      lnGhEnabled.checked = true;
      document.getElementById('ln-gh-fields').style.display = 'flex';
    }
    if (tfEl) tfEl.checked = s.tempFilesEnabledInCollab !== false;
  }

  document.getElementById('ln-unite-open').onclick = async () => {
    const uniteBtn = document.getElementById('ln-unite-open');
    if (uniteBtn.disabled) return;
    uniteBtn.disabled = true;
    const origUniteLabel = uniteBtn.textContent;
    uniteBtn.textContent = '🤝 Unindo abas...';
    const st = await AU_STORAGE.getSettings();
    const profile = document.getElementById('ln-collab-profile')?.value || 'specialists';
    const stopMode = document.getElementById('ln-collab-stop')?.value || 'smart_consensus';
    const mirrorExternal = Boolean(document.getElementById('ln-collab-external')?.checked);
    const joinExternalCode = (document.getElementById('ln-collab-joincode')?.value || '').trim();
    let githubEnabled = Boolean(document.getElementById('ln-gh-enabled')?.checked);
    const rawRepoVal = (document.getElementById('ln-gh-repo')?.value || '').trim();
    let githubRepo = githubEnabled ? rawRepoVal : '';
    let detectedBranch = '';
    const swarmDraft = (document.getElementById('ln-swarm-prompt')?.value || '').trim();
    if (
      swarmDraft &&
      st.githubAutoDetectInPrompt !== false &&
      typeof AU_INTEGRATIONS !== 'undefined' &&
      AU_INTEGRATIONS.extractGithubRepoFromText
    ) {
      const det = AU_INTEGRATIONS.extractGithubRepoFromText(swarmDraft);
      const isUntouchedDefault = !rawRepoVal || rawRepoVal === (st.githubDefaultRepo || '').trim();
      if (det && (!githubEnabled || !githubRepo || isUntouchedDefault)) {
        githubRepo = det.webUrl;
        detectedBranch = det.branchFromUrl || '';
        githubEnabled = true;
      }
    }
    const lnTokInp = document.getElementById('ln-gh-token');
    const inlinePat = (lnTokInp?.value || '').trim();
    if (lnTokInp) lnTokInp.value = '';
    if (inlinePat) {
      await new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'AU_VAULT_SET_SECRET', githubToken: inlinePat }, () => r())
      );
    }

    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_CREATE_FROM_OPEN_TABS',
        options: {
          baseTask: swarmDraft,
          profile,
          stopMode,
          mirrorExternal,
          joinExternalCode,
          refuseThinkingModels: document.getElementById('ln-refuse-thinking')
            ? document.getElementById('ln-refuse-thinking').checked
            : true,
          githubEnabled: Boolean(githubEnabled && githubRepo),
          githubRepo,
          githubBaseBranch: detectedBranch || (document.getElementById('ln-gh-base')?.value || 'main').trim(),
          githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(document.getElementById('ln-gh-auth')?.value),
          githubBranchMode: document.getElementById('ln-gh-branch')?.value || 'branch_per_agent_pr',
          githubDefaultAgentAccessMode: document.getElementById('ln-gh-default-rbac')?.value || 'auto_role',
          collabIntegrationTimeoutMinutes: Number(document.getElementById('ln-collab-timeout')?.value || 25)
        }
      },
      (res) => {
        uniteBtn.disabled = false;
        uniteBtn.textContent = origUniteLabel;
        if (res && res.ok && res.room) {
          selectedCollabRoomId = res.room.roomId;
          toast(`🤝 Sala TempChat #${res.room.roomId} criada com suas abas abertas!`);
          location.hash = 'collab';
          switchSection('collab');
        } else {
          toast((res && res.error) || 'Abra pelo menos 1 aba do Arena.ai antes de unir.', true);
        }
      }
    );
  };

  document.getElementById('ln-submit').onclick = async () => {
    const submitBtn = document.getElementById('ln-submit');
    if (submitBtn.disabled) return;
    const mode = lnMode.value;
    const [macros, st] = await Promise.all([AU_STORAGE.getMacros(), AU_STORAGE.getSettings()]);
    const chosenMacro = macros.find((m) => m.id === document.getElementById('ln-macro').value);
    const collabEnabled = Boolean(document.getElementById('ln-collab-enabled')?.checked);
    let githubEnabled = Boolean(document.getElementById('ln-gh-enabled')?.checked);
    const rawRepoVal = (document.getElementById('ln-gh-repo')?.value || '').trim();
    let githubRepo = githubEnabled ? rawRepoVal : '';
    let detectedBaseBranch = '';
    const lnTokInp = document.getElementById('ln-gh-token');
    const inlinePat = (lnTokInp?.value || '').trim();
    if (lnTokInp) lnTokInp.value = '';
    if (inlinePat) {
      await new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'AU_VAULT_SET_SECRET', githubToken: inlinePat }, () => r())
      );
    }

    if (
      st.githubAutoDetectInPrompt !== false &&
      typeof AU_INTEGRATIONS !== 'undefined' &&
      AU_INTEGRATIONS.extractGithubRepoFromText
    ) {
      const candidateText =
        mode === 'swarm'
          ? document.getElementById('ln-swarm-prompt')?.value || ''
          : mode === 'task_list'
            ? document.getElementById('ln-tasks-text')?.value || ''
            : document.getElementById('ln-matrix-tpl')?.value || '';
      const detected = AU_INTEGRATIONS.extractGithubRepoFromText(candidateText);
      const isUntouchedDefault = !rawRepoVal || rawRepoVal === (st.githubDefaultRepo || '').trim();
      if (detected && (!githubEnabled || !githubRepo || isUntouchedDefault)) {
        githubRepo = detected.webUrl;
        detectedBaseBranch = detected.branchFromUrl || '';
        githubEnabled = true;
      }
    }
    if (!detectedBaseBranch && githubRepo && typeof AU_INTEGRATIONS !== 'undefined' && AU_INTEGRATIONS.parseGitRepoSpec) {
      const spec = AU_INTEGRATIONS.parseGitRepoSpec(githubRepo);
      if (spec && spec.branchFromUrl) detectedBaseBranch = spec.branchFromUrl;
    }
    if (githubEnabled && !githubRepo) {
      toast('Cole o link do repositório GitHub (https://github.com/...) ou desmarque a opção GitHub!', true);
      return;
    }

    const config = {
      launchMode: mode,
      targetUrl: document.getElementById('ln-url').value.trim() || 'https://arena.ai/agent',
      staggerMs: Number(document.getElementById('ln-stagger').value || 1400),
      autoEnableLoop: collabEnabled ? true : document.getElementById('ln-autoloop').checked,
      autoGroup: document.getElementById('ln-autogroup').checked,
      refuseThinkingModels: document.getElementById('ln-refuse-thinking')
        ? document.getElementById('ln-refuse-thinking').checked
        : true,
      groupName: document.getElementById('ln-group-name').value.trim() || 'Arena Ultra • Agents',
      queueSteps: chosenMacro ? chosenMacro.steps : [],
      fixedPrompt: chosenMacro && chosenMacro.loopPromptAfterQueue ? chosenMacro.loopPromptAfterQueue : undefined,
      collabEnabled,
      collabProfile: document.getElementById('ln-collab-profile')?.value || 'specialists',
      collabStopMode: document.getElementById('ln-collab-stop')?.value || 'smart_consensus',
      collabIntegrationTimeoutMinutes: Number(document.getElementById('ln-collab-timeout')?.value || 25),
      collabMirrorExternal: Boolean(document.getElementById('ln-collab-external')?.checked),
      collabJoinExternalCode: (document.getElementById('ln-collab-joincode')?.value || '').trim(),
      githubEnabled,
      githubRepo,
      githubBaseBranch: detectedBaseBranch || (document.getElementById('ln-gh-base')?.value || 'main').trim(),
      githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(document.getElementById('ln-gh-auth')?.value),
      githubBranchMode: document.getElementById('ln-gh-branch')?.value || 'branch_per_agent_pr',
      githubDefaultAgentAccessMode: document.getElementById('ln-gh-default-rbac')?.value || 'auto_role',
      tempFilesEnabled: Boolean(document.getElementById('ln-tf-enabled')?.checked)
    };

    if (mode === 'swarm') {
      config.swarmCount = Number(document.getElementById('ln-swarm-count').value || 3);
      config.basePrompt = document.getElementById('ln-swarm-prompt').value.trim();
      if (!config.basePrompt && (!chosenMacro || !chosenMacro.steps.length)) {
        toast('Digite o prompt do modo Enxame ou escolha uma Macro de etapas!', true);
        return;
      }
    } else if (mode === 'task_list') {
      config.tasks = document.getElementById('ln-tasks-text').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!config.tasks.length) {
        toast('Informe pelo menos 1 tarefa (1 por linha)!', true);
        return;
      }
    } else {
      config.template = document.getElementById('ln-matrix-tpl').value.trim();
      config.variableName = document.getElementById('ln-matrix-var').value.trim() || 'nicho';
      config.variableValues = document.getElementById('ln-matrix-vals').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!config.template || !config.variableValues.length) {
        toast('Preencha o template e pelo menos 1 valor na Matriz de Variáveis!', true);
        return;
      }
    }

    const origSubmitLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '🚀 Lançando abas...';

    chrome.runtime.sendMessage({ type: 'AU_LAUNCH_MULTI_AGENT', config }, (res) => {
      submitBtn.disabled = false;
      submitBtn.textContent = origSubmitLabel;
      if (res && res.ok) {
        if (res.roomId) {
          selectedCollabRoomId = res.roomId;
          toast(`🤝 Sala TempChat #${res.roomId} iniciada com ${res.launchedCount} Agents colaborando!`);
          location.hash = 'collab';
          switchSection('collab');
        } else {
          toast(`${res.launchedCount} chats Agent lançados em paralelo com sucesso!`);
          switchSection('mission');
        }
      } else {
        toast((res && res.error) || 'Verifique os campos obrigatórios.', true);
      }
    });
  };

  // --- 2B. TempChat Collaboration Console ---
  function refreshCollabSection(force = false) {
    if (document.hidden) return;
    chrome.runtime.sendMessage({ type: 'AU_COLLAB_GET_ROOMS' }, (res) => {
      const rooms = (res && Array.isArray(res.rooms)) ? res.rooms : [];
      const roomSel = document.getElementById('cb-room-select');
      const stopSel = document.getElementById('cb-stop-mode');
      const feedEl = document.getElementById('cb-messages-feed');
      const rosterEl = document.getElementById('cb-agents-roster');
      const badgeEl = document.getElementById('cb-room-badge');
      const extPill = document.getElementById('cb-ext-code-pill');
      const finalMeta = document.getElementById('cb-final-meta');
      const finalContent = document.getElementById('cb-final-content');
      if (!roomSel || !feedEl || !rosterEl) return;

      if (!rooms.length) {
        if (!force && lastCollabSignature === 'empty') return;
        lastCollabSignature = 'empty';
        currentCollabRoomObj = null;
        roomSel.innerHTML = '<option value="">Nenhuma sala TempChat ativa no momento</option>';
        badgeEl.className = 'badge';
        badgeEl.textContent = 'SEM SALA';
        const slaBarEl = document.getElementById('cb-sla-bar');
        if (slaBarEl) slaBarEl.style.display = 'none';
        extPill.textContent = 'Ponte interna zero-latência';
        feedEl.innerHTML =
          '<div class="muted">Nenhuma sala TempChat ativa. Lance um lote no Lançador Multi-Agent marcando "Modo Colaboração" ou clique em "+ Unir Abas Abertas numa Nova Sala".</div>';
        rosterEl.innerHTML = '<div class="muted">Nenhum agente conectado.</div>';
        finalMeta.textContent = 'Aguardando criação de sala colaborativa.';
        finalContent.textContent = 'Aguardando consolidação da equipe...';
        return;
      }

      if (!selectedCollabRoomId || !rooms.some((r) => r.roomId === selectedCollabRoomId)) {
        selectedCollabRoomId = rooms[0].roomId;
      }
      const room = rooms.find((r) => r.roomId === selectedCollabRoomId) || rooms[0];
      currentCollabRoomObj = room;

      const boardRev = room.sharedBoard ? Number(room.sharedBoard.revision || 1) : 1;
      const intSt = room.integrationStatus || {};
      const sig = `${rooms.map((r) => r.roomId).join(',')}|${room.roomId}|${room.seq}|${room.status}|${room.stopMode}|${room.externalCode}|${boardRev}|${intSt.state || ''}|${Math.floor(Number(intSt.remainingMs || 0) / 15000)}|${room.dedupDroppedCount || 0}|${room.thinkingRefusalsCount || 0}|${Boolean(room.finalDeliverable)}|${(room.sharedFiles || []).length}|${room.githubConfig ? `${room.githubConfig.commitsPushed}|${room.githubConfig.pullRequestUrl}` : ''}|${(room.agents || []).map((a) => `${a.tabId}:${a.liveStatus}:${a.loopsCount}:${a.closed}:${a.admittedToTeam ? 1 : 0}:${a.screeningStatus || ''}:${a.githubAccessLevel || ''}:${a.refusedCount || 0}`).join(',')}`;
      if (!force && sig === lastCollabSignature) return;
      lastCollabSignature = sig;

      const slaBarEl = document.getElementById('cb-sla-bar');
      if (slaBarEl) {
        slaBarEl.style.display = 'block';
        const slaStateEl = document.getElementById('cb-sla-state');
        const slaDetEl = document.getElementById('cb-sla-details');
        if (slaStateEl) slaStateEl.textContent = intSt.label || '🟢 Em Colaboração';
        if (slaDetEl) {
          const remMin = Math.max(0, Math.ceil(Number(intSt.remainingMs || 0) / 60000));
          const vaultTxt =
            room.githubConfig && room.githubConfig.enabled
              ? room.githubConfig.authMode === 'vault_broker_zero_token'
                ? ' • 🔐 Cofre Zero-Token'
                : ' • 🐙 Git Ativo'
              : '';
          slaDetEl.textContent =
            room.status === 'completed'
              ? `Entrega concluída • Deduplicadas: ${Number(room.dedupDroppedCount || 0)}${vaultTxt}`
              : `Módulos prontos: ${intSt.readyCount || 0}/${intSt.totalActive || 0} • Prazo limite: ${remMin} min • Deduplicadas: ${Number(room.dedupDroppedCount || 0)}${vaultTxt}`;
        }
      }

      roomSel.innerHTML = rooms
        .map((r) => {
          const stLbl = r.status === 'completed' ? '✅ Entrega Pronta' : r.status === 'paused' ? '⏸ Pausada' : '🟢 Ativa';
          return `<option value="${esc(r.roomId)}" ${r.roomId === room.roomId ? 'selected' : ''}>Sala TempChat #${esc(r.roomId)} — ${(r.agents || []).length} Agents (${stLbl})</option>`;
        })
        .join('');

      if (stopSel && stopSel.value !== room.stopMode) {
        stopSel.value = room.stopMode || 'smart_consensus';
      }

      const profileMeta = (AU_DEFAULTS.COLLAB_PROFILES && AU_DEFAULTS.COLLAB_PROFILES[room.profile]) || { label: room.profile };
      document.getElementById('cb-stream-heading').textContent = `Sala TempChat #${room.roomId} • ${profileMeta.label}`;

      badgeEl.className = 'badge ' + (room.status === 'completed' || room.status === 'active' ? 'active' : 'stopped');
      badgeEl.textContent =
        room.status === 'completed'
          ? '✅ CONSENSO ATINGIDO'
          : room.status === 'paused'
            ? '⏸ SALA PAUSADA'
            : `🟢 EM COLABORAÇÃO • ${room.seq || 0} MSGS`;

      extPill.textContent = room.externalCode
        ? `🌐 tempchat.online ativo: código #${room.externalCode}`
        : room.externalTabId
          ? '🌐 Conectando ao tempchat.online...'
          : '⚡ Sala interna rápida (clique em Ponte tempchat.online para espelhar)';

      const wasNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
      const msgs = (room.messages || [])
        .filter(
          (m) =>
            m &&
            (m.senderType !== 'system' ||
              String(m.senderName || '').includes('Radar Git') ||
              String(m.senderName || '').includes('Integração Final')) &&
            !(AU_DEFAULTS && AU_DEFAULTS.isSystemOrAutoPromptText && AU_DEFAULTS.isSystemOrAutoPromptText(m.text))
        )
        .slice(-80);
      feedEl.innerHTML = msgs.length
        ? msgs
            .map((m) => {
              const isUser = m.senderType === 'user' || m.senderType === 'external';
              const isSys = m.senderType === 'system';
              const border = isSys
                ? 'rgba(139,92,246,0.45)'
                : isUser
                  ? 'rgba(16,185,129,0.5)'
                  : 'rgba(6,182,212,0.45)';
              const bg = isSys
                ? 'rgba(139,92,246,0.09)'
                : isUser
                  ? 'rgba(16,185,129,0.09)'
                  : 'rgba(6,182,212,0.07)';
              const dt = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('pt-BR') : '';
              return `
                <div class="item-box" style="border-color:${border};background:${bg};">
                  <div class="item-top" style="margin-bottom:4px;">
                    <strong style="color:${isUser ? '#6ee7b7' : isSys ? '#c4b5fd' : '#67e8f9'};">${esc(m.senderName)}${m.senderRole ? ` <span class="muted" style="font-weight:400;">— ${esc(m.senderRole)}</span>` : ''}</strong>
                    <span class="muted" style="font-size:11px;">#${m.seq} • ${esc(dt)}</span>
                  </div>
                  <div style="white-space:pre-wrap;word-break:break-word;line-height:1.48;font-size:13px;">${esc(m.text)}</div>
                </div>
              `;
            })
            .join('')
        : '<div class="muted">Os Agents já receberam seus papéis e publicarão suas primeiras descobertas aqui assim que concluírem o Turno 1!</div>';

      if (wasNearBottom) {
        feedEl.scrollTop = feedEl.scrollHeight;
      }

      const allRoomAgents = room.agents || [];
      const admittedCount = allRoomAgents.filter((a) => a.admittedToTeam !== false && !a.closed).length;
      const screeningCount = allRoomAgents.filter((a) => a.admittedToTeam === false && !a.closed).length;
      const gateBanner =
        room.refuseThinkingModels !== false
          ? `<div class="item-box" style="margin-bottom:8px;border-color:rgba(244,63,94,0.42);background:rgba(244,63,94,0.08);font-size:12px;">
               <strong style="color:#fda4af;">🛡️ Portão Sem-Thinking Ativo:</strong> <strong>${admittedCount}/${allRoomAgents.length}</strong> confirmados no Time${screeningCount > 0 ? ` • <strong>${screeningCount}</strong> em triagem/sorteio` : ''}${room.thinkingRefusalsCount ? ` • <strong>${room.thinkingRefusalsCount}</strong> modelo(s) Thinking recusado(s)` : ''}
             </div>`
          : '';

      const ghActiveForRoom = Boolean(room.githubConfig && room.githubConfig.enabled);
      rosterEl.innerHTML =
        gateBanner +
        allRoomAgents
          .map((ag) => {
            const isAdmitted = ag.admittedToTeam !== false;
            const curRbac = ag.githubAccessLevel || 'push_and_pr';
            const stTxt = ag.closed
              ? '⚫ Aba fechada'
              : !isAdmitted
                ? ag.screeningStatus === 'refused_stopped'
                  ? `🚫 Recusado por Thinking (${ag.refusedCount || 1}x)`
                  : ag.screeningStatus === 'rerolling'
                    ? `🔄 Sorteando modelo sem Thinking (${ag.refusedCount || 1} recusado)`
                    : '🔍 Em Triagem Sem-Thinking (aguardando confirmação p/ entrar no Time)'
                : ag.liveStatus === 'token_stopped'
                  ? '🔴 Sem Tokens (No Time)'
                  : ag.liveStatus === 'generating'
                    ? '🟢 No Time • Trabalhando agora'
                    : '✅ No Time • Sincronizado';
            return `
            <div class="item-box" style="${!isAdmitted ? 'border-color:rgba(244,63,94,0.42);' : 'border-color:rgba(16,185,129,0.35);'}">
              <div class="item-top" style="flex-wrap:wrap;gap:6px;">
                <div>
                  <strong>${esc(ag.name)}</strong> ${isAdmitted ? '<span class="badge active" style="margin-left:5px;">✅ NO TIME</span>' : '<span class="badge stopped" style="margin-left:5px;">🔍 TRIAGEM</span>'}
                  <div class="muted" style="font-size:12px;">${esc(ag.roleTitle || '')}</div>
                </div>
                <div class="row" style="gap:6px;flex-wrap:wrap;">
                  ${
                    ghActiveForRoom
                      ? `<select class="select cb-agent-rbac" data-tab="${ag.tabId}" data-idx="${ag.index}" style="padding:3px 6px;font-size:11px;width:auto;" title="Gestão Centralizada de Acesso GitHub deste Agente">
                           <option value="push_and_pr" ${curRbac === 'push_and_pr' ? 'selected' : ''}>🐙 Push + PR</option>
                           <option value="push_branch" ${curRbac === 'push_branch' ? 'selected' : ''}>🌿 Só Branch</option>
                           <option value="read_only" ${curRbac === 'read_only' ? 'selected' : ''}>👁️ Só Leitura</option>
                           <option value="revoked" ${curRbac === 'revoked' ? 'selected' : ''}>🚫 Revogado</option>
                         </select>`
                      : ''
                  }
                  <span class="muted" style="font-size:12px;">${stTxt} • ${Number(ag.loopsCount || 0)} turnos</span>
                  ${!ag.closed ? `<button class="btn btn-sm cb-focus-agent" data-id="${ag.tabId}">Ir à Aba</button>` : ''}
                </div>
              </div>
            </div>
          `;
          })
          .join('');

      rosterEl.querySelectorAll('.cb-focus-agent').forEach((b) => {
        b.onclick = () => {
          chrome.runtime.sendMessage({ type: 'AU_CONTROL_TAB', tabId: Number(b.dataset.id), command: 'focus' });
        };
      });
      rosterEl.querySelectorAll('.cb-agent-rbac').forEach((sel) => {
        sel.onchange = () => {
          chrome.runtime.sendMessage(
            {
              type: 'AU_COLLAB_SET_AGENT_ACCESS',
              roomId: room.roomId,
              tabId: Number(sel.dataset.tab || 0),
              agentIndex: Number(sel.dataset.idx || 0),
              accessLevel: sel.value
            },
            (out) => {
              if (out && out.ok) {
                toast(`🛡️ Permissão GitHub atualizada para ${sel.value} (chave rotacionada se revogada)!`);
                refreshCollabSection(true);
              }
            }
          );
        };
      });

      // Render Shared Board (Single-Update Assignments, Contracts & Git Radar)
      const boardRevEl = document.getElementById('cb-board-rev');
      const boardViewEl = document.getElementById('cb-board-view');
      if (boardViewEl) {
        const board = room.sharedBoard || {};
        if (boardRevEl) boardRevEl.textContent = `rev #${board.rev || board.revision || 1}`;
        const assigns = Object.values(board.assignments || {});
        const contracts = Object.values(board.contracts || {});
        const prs = Object.values((board.gitRefs && board.gitRefs.pulls) || board.pullRequests || {});
        const branches = Object.values((board.gitRefs && board.gitRefs.branches) || board.branches || {});

        let boardHtml = '';
        if (assigns.length) {
          boardHtml += assigns
            .map(
              (it) => `
              <div class="item-box" style="padding:7px 10px;">
                <div class="item-top" style="gap:6px;">
                  <div>
                    <strong style="font-size:12px;">${esc(it.agentName)}</strong> <span class="muted" style="font-size:11px;">(${esc(it.roleTitle || '')})</span>
                    <div class="muted" style="font-size:11.5px;">${esc(it.notes || it.summary || it.scope || 'Sem resumo ainda')}${it.branch ? ` • 🌿 <code>${esc(it.branch)}</code>` : ''}</div>
                  </div>
                  <select class="select cb-board-status" data-slot="${esc(it.slotKey)}" style="padding:3px 6px;font-size:11px;width:auto;">
                    <option value="pendente" ${it.status === 'pendente' ? 'selected' : ''}>⏳ Pendente</option>
                    <option value="em_progresso" ${it.status === 'em_progresso' ? 'selected' : ''}>🔨 Em progresso</option>
                    <option value="pronto_integracao" ${it.status === 'pronto_integracao' ? 'selected' : ''}>✅ Pronto p/ Integração</option>
                    <option value="bloqueado" ${it.status === 'bloqueado' ? 'selected' : ''}>🚧 Bloqueado</option>
                    <option value="concluido" ${it.status === 'concluido' ? 'selected' : ''}>🏁 Concluído</option>
                  </select>
                </div>
              </div>`
            )
            .join('');
        }
        if (contracts.length) {
          boardHtml += contracts
            .map(
              (c) => `
              <div class="item-box" style="padding:7px 10px;border-color:rgba(6,182,212,0.4);background:rgba(6,182,212,0.06);">
                <div style="font-size:12px;"><strong style="color:#67e8f9;">📜 [${esc(c.key)}]</strong> ${esc(c.spec)} <span class="muted" style="font-size:11px;">(${esc(c.status || 'congelado')} • por ${esc(c.owner || 'Equipe')})</span></div>
              </div>`
            )
            .join('');
        }
        if (prs.length || branches.length) {
          boardHtml += `<div class="item-box" style="padding:7px 10px;border-color:rgba(139,92,246,0.4);font-size:12px;">
            ${prs.map((p) => `<div>🚀 <a href="${esc(p.htmlUrl || p.url || '#')}" target="_blank" rel="noopener" style="color:#c4b5fd;font-weight:700;">PR #${esc(p.number)}: ${esc(p.title || p.head || '')} ↗</a> (${esc(p.state || 'open')})</div>`).join('')}
            ${branches.map((b) => `<div class="muted">🌿 Branch ativa: <code>${esc(b.name)}</code> (${esc(String(b.sha || '').slice(0, 7))})</div>`).join('')}
          </div>`;
        }
        boardViewEl.innerHTML =
          boardHtml || '<div class="muted">Nenhuma atribuição ou contrato publicado ainda nesta sala.</div>';

        boardViewEl.querySelectorAll('.cb-board-status').forEach((sel) => {
          sel.onchange = () => {
            chrome.runtime.sendMessage(
              {
                type: 'AU_COLLAB_UPSERT_BOARD_ITEM',
                roomId: room.roomId,
                itemType: 'assignment',
                slotKey: sel.dataset.slot,
                patch: { status: sel.value },
                authorName: 'Você (Coordenador)'
              },
              () => refreshCollabSection(true)
            );
          };
        });
      }

      // Render Shared TempFiles & GitHub status inside sec-collab
      const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '#');
      const fbBtn = document.getElementById('cb-open-filebin');
      if (fbBtn) {
        if (room.filebinUrl) {
          fbBtn.href = safeUrl(room.filebinUrl);
          fbBtn.style.display = 'inline-flex';
        } else {
          fbBtn.style.display = 'none';
        }
      }

      const ghRoomBox = document.getElementById('cb-gh-room-box');
      if (ghRoomBox) {
        if (room.githubConfig && room.githubConfig.enabled && room.githubConfig.repo) {
          const gh = room.githubConfig;
          const ghSpec =
            typeof AU_INTEGRATIONS !== 'undefined' && AU_INTEGRATIONS.parseGitRepoSpec
              ? AU_INTEGRATIONS.parseGitRepoSpec(gh.repo)
              : null;
          const ghHref = safeUrl(
            ghSpec
              ? ghSpec.webUrl
              : /^https?:\/\//i.test(gh.repo)
                ? gh.repo
                : `https://github.com/${gh.repo}`
          );
          const ghLabel = ghSpec ? ghSpec.fullName : gh.repo;
          const authBadgeTxt =
            gh.authMode === 'vault_broker_zero_token'
              ? '🔐 Cofre Zero-Token'
              : gh.authMode === 'extension_proxy_push'
                ? 'Push via Extensão'
                : 'Git Direto';
          ghRoomBox.style.display = 'block';
          ghRoomBox.innerHTML = `
            <div class="item-top" style="margin-bottom:4px;">
              <a href="${esc(ghHref)}" target="_blank" rel="noopener" style="color:#c4b5fd;font-weight:700;text-decoration:none;">🐙 ${esc(ghLabel)} (base: ${esc(gh.baseBranch || 'main')})</a>
              <span class="badge active">${authBadgeTxt}</span>
            </div>
            <div class="muted" style="font-size:12px;">
              Estratégia: ${gh.branchMode === 'single_shared_branch' ? `Branch Compartilhada (${esc(gh.sharedBranch || 'arena/sala-' + room.roomId)})` : 'Branch por Agente + PR pelo Líder'}
              ${gh.commitsPushed ? ` • <strong>${gh.commitsPushed}</strong> push(es)` : ''}
              ${gh.lastCommitUrl ? ` • <a href="${esc(safeUrl(gh.lastCommitUrl))}" target="_blank" rel="noopener" style="color:#93c5fd;">Último Commit ↗</a>` : ''}
              ${gh.pullRequestUrl ? ` • <a href="${esc(safeUrl(gh.pullRequestUrl))}" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:700;">Abrir Pull Request ↗</a>` : ''}
            </div>
          `;
        } else {
          ghRoomBox.style.display = 'none';
        }
      }

      const sfListEl = document.getElementById('cb-shared-files-list');
      if (sfListEl) {
        const sFiles = (room.sharedFiles || []).slice().reverse();
        const targetRepo = (room.githubConfig && room.githubConfig.repo) || (currentSettings && currentSettings.githubDefaultRepo) || '';
        sfListEl.innerHTML = sFiles.length
          ? sFiles
              .map(
                (f) => `
                <div class="item-box" style="padding:8px 10px;">
                  <div class="item-top">
                    <div style="min-width:0;flex:1;">
                      <strong style="font-size:12.5px;">📄 ${esc(f.filename || 'arquivo')}</strong>
                      <div class="muted" style="font-size:11.5px;">${esc(f.provider || 'TempHost')} • Enviado por ${esc(f.uploadedBy || 'Agente')}</div>
                    </div>
                    <div class="row" style="gap:6px;">
                      <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;">⬇ Baixar</a>
                      ${
                        targetRepo
                          ? `<button class="btn btn-sm btn-primary cb-push-file-gh" data-url="${esc(f.url)}" data-name="${esc(f.filename || '')}">🐙 Push GitHub</button>`
                          : ''
                      }
                    </div>
                  </div>
                </div>
              `
              )
              .join('')
          : '<div class="muted">Nenhum arquivo temporário compartilhado ainda nesta sala.</div>';

        sfListEl.querySelectorAll('.cb-push-file-gh').forEach((btn) => {
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = 'Enviando...';
            chrome.runtime.sendMessage(
              {
                type: 'AU_GITHUB_PUSH_BUNDLE',
                roomId: room.roomId,
                repo: targetRepo,
                baseBranch: (room.githubConfig && room.githubConfig.baseBranch) || (currentSettings && currentSettings.githubBaseBranch) || 'main',
                branch:
                  room.githubConfig && room.githubConfig.branchMode === 'single_shared_branch'
                    ? room.githubConfig.sharedBranch || `arena/sala-${room.roomId}`
                    : `arena/sala-${room.roomId}`,
                archiveUrl: btn.dataset.url,
                filename: btn.dataset.name,
                openPR: room.githubConfig
                  ? room.githubConfig.branchMode !== 'single_shared_branch' ||
                    (currentSettings ? currentSettings.githubAutoCreatePR !== false : true)
                  : currentSettings
                    ? currentSettings.githubAutoCreatePR !== false
                    : true,
                message: `feat(sala-${room.roomId}): importa entrega ${btn.dataset.name}`
              },
              (out) => {
                btn.disabled = false;
                btn.textContent = '🐙 Push GitHub';
                if (out && out.ok) {
                  toast(`✅ Commit ${out.shortSha} enviado (${out.filesCount} arquivos) para ${out.repo}@${out.branch}!`);
                  refreshCollabSection(true);
                } else {
                  toast((out && out.error) || 'Falha ao enviar para o GitHub.', true);
                }
              }
            );
          };
        });
      }

      if (room.finalDeliverable) {
        finalMeta.textContent = `✅ Publicado por ${room.finalBy || 'Sintetizador'} • Pronto para uso ou download!`;
        finalContent.textContent = room.finalDeliverable;
      } else {
        finalMeta.innerHTML = 'Assim que a equipe revisar tudo e publicar <code>[ENTREGA_FINAL_PRONTA]</code>, o resultado consolidado aparece aqui.';
        finalContent.textContent = 'Equipe trabalhando em conjunto...';
      }
    });
  }

  const cbOpenLiveBtn = document.getElementById('cb-open-livechat-btn');
  if (cbOpenLiveBtn) {
    cbOpenLiveBtn.onclick = () => {
      chrome.runtime.sendMessage({
        type: 'AU_OPEN_LIVECHAT',
        roomId: (currentCollabRoomObj && currentCollabRoomObj.roomId) || selectedCollabRoomId || ''
      });
    };
  }

  const cbSlaAdd10Btn = document.getElementById('cb-sla-add10-btn');
  if (cbSlaAdd10Btn) {
    cbSlaAdd10Btn.onclick = () => {
      if (!currentCollabRoomObj) return;
      chrome.runtime.sendMessage(
        { type: 'AU_COLLAB_SET_INTEGRATION_SLA', roomId: currentCollabRoomObj.roomId, addMinutes: 10 },
        () => {
          toast('⏱️ +10 minutos adicionados ao prazo de Integração Final!');
          refreshCollabSection(true);
        }
      );
    };
  }

  const cbSlaForceBtn = document.getElementById('cb-sla-force-btn');
  if (cbSlaForceBtn) {
    cbSlaForceBtn.onclick = () => {
      if (!currentCollabRoomObj) return;
      chrome.runtime.sendMessage(
        { type: 'AU_COLLAB_SET_INTEGRATION_SLA', roomId: currentCollabRoomObj.roomId, forceReady: true },
        () => {
          toast('🎯 Integração Final liberada e equipe notificada!');
          refreshCollabSection(true);
        }
      );
    };
  }

  const cbContractSaveBtn = document.getElementById('cb-contract-save-btn');
  if (cbContractSaveBtn) {
    cbContractSaveBtn.onclick = () => {
      if (!currentCollabRoomObj) {
        toast('Selecione uma sala TempChat ativa primeiro.', true);
        return;
      }
      const keyEl = document.getElementById('cb-contract-key');
      const specEl = document.getElementById('cb-contract-spec');
      const key = String((keyEl && keyEl.value) || '').trim();
      const spec = String((specEl && specEl.value) || '').trim();
      if (!key || !spec) {
        toast('Preencha a chave única e a especificação do contrato.', true);
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: 'AU_COLLAB_UPSERT_BOARD_ITEM',
          roomId: currentCollabRoomObj.roomId,
          itemType: 'contract',
          key,
          patch: { spec, status: 'agreed' },
          authorName: 'Você (Coordenador)'
        },
        (out) => {
          if (out && out.ok) {
            if (keyEl) keyEl.value = '';
            if (specEl) specEl.value = '';
            toast(`📜 Contrato [${key}] atualizado sem duplicar no Quadro Único!`);
            refreshCollabSection(true);
          }
        }
      );
    };
  }

  document.getElementById('cb-room-select').onchange = (e) => {
    selectedCollabRoomId = e.target.value;
    refreshCollabSection(true);
  };

  document.getElementById('cb-stop-mode').onchange = (e) => {
    if (!currentCollabRoomObj) return;
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_SET_ROOM_STATE',
        roomId: currentCollabRoomObj.roomId,
        stopMode: e.target.value
      },
      () => {
        toast('Critério de conclusão da sala atualizado em tempo real!');
        refreshCollabSection(true);
      }
    );
  };

  document.getElementById('cb-pause-room-btn').onclick = () => {
    if (!currentCollabRoomObj) return;
    chrome.runtime.sendMessage(
      { type: 'AU_COLLAB_SET_ROOM_STATE', roomId: currentCollabRoomObj.roomId, status: 'paused' },
      () => {
        for (const ag of currentCollabRoomObj.agents || []) {
          if (!ag.closed) {
            chrome.runtime.sendMessage({
              type: 'AU_CONTROL_TAB',
              tabId: ag.tabId,
              command: 'toggle_auto_continue',
              payload: { enable: false, enabled: false }
            });
          }
        }
        toast(`Sala TempChat #${currentCollabRoomObj.roomId} pausada.`);
        refreshCollabSection(true);
      }
    );
  };

  document.getElementById('cb-resume-room-btn').onclick = () => {
    if (!currentCollabRoomObj) return;
    chrome.runtime.sendMessage(
      { type: 'AU_COLLAB_SET_ROOM_STATE', roomId: currentCollabRoomObj.roomId, status: 'active' },
      () => {
        for (const ag of currentCollabRoomObj.agents || []) {
          if (!ag.closed) {
            chrome.runtime.sendMessage({ type: 'AU_CONTROL_TAB', tabId: ag.tabId, command: 'resume' });
          }
        }
        toast(`Sala TempChat #${currentCollabRoomObj.roomId} retomada!`);
        refreshCollabSection(true);
      }
    );
  };

  document.getElementById('cb-open-external-btn').onclick = () => {
    if (!currentCollabRoomObj) {
      toast('Crie ou selecione uma sala TempChat primeiro.', true);
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_SET_ROOM_STATE',
        roomId: currentCollabRoomObj.roomId,
        openExternalBridge: true,
        focusExternalTab: true
      },
      () => {
        toast('Abrindo ponte espelhada ao vivo no tempchat.online!');
        setTimeout(() => refreshCollabSection(true), 800);
      }
    );
  };

  document.getElementById('cb-close-room-btn').onclick = () => {
    if (!currentCollabRoomObj) return;
    const closingId = currentCollabRoomObj.roomId;
    chrome.runtime.sendMessage(
      { type: 'AU_COLLAB_SET_ROOM_STATE', roomId: closingId, status: 'closed' },
      () => {
        selectedCollabRoomId = '';
        toast(`Sala TempChat #${closingId} encerrada.`);
        refreshCollabSection(true);
      }
    );
  };

  document.getElementById('cb-unite-open-btn').onclick = () => {
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_CREATE_FROM_OPEN_TABS',
        options: {
          profile: (currentSettings && currentSettings.collabDefaultProfile) || 'specialists',
          stopMode: (currentSettings && currentSettings.collabDefaultStopMode) || 'smart_consensus',
          mirrorExternal: Boolean(currentSettings && currentSettings.collabMirrorExternalTempChat),
          refuseThinkingModels: currentSettings ? currentSettings.refuseThinkingModels !== false : true,
          githubEnabled: Boolean(currentSettings && currentSettings.githubEnabledInCollab && currentSettings.githubDefaultRepo),
          githubRepo: (currentSettings && currentSettings.githubDefaultRepo) || '',
          githubBaseBranch: (currentSettings && currentSettings.githubBaseBranch) || 'main',
          githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(currentSettings && currentSettings.githubAuthMode),
          githubBranchMode: (currentSettings && currentSettings.githubBranchMode) || 'branch_per_agent_pr'
        }
      },
      (res) => {
        if (res && res.ok && res.room) {
          selectedCollabRoomId = res.room.roomId;
          toast(`🤝 Sala TempChat #${res.room.roomId} criada com suas abas abertas!`);
          refreshCollabSection(true);
        } else {
          toast((res && res.error) || 'Abra pelo menos 1 aba do Arena.ai primeiro.', true);
        }
      }
    );
  };

  const sendDashboardCoordinatorMsg = () => {
    const inp = document.getElementById('cb-coord-input');
    if (!inp || !currentCollabRoomObj) {
      toast('Nenhuma sala ativa selecionada.', true);
      return;
    }
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_SEND_COORDINATOR_MSG',
        roomId: currentCollabRoomObj.roomId,
        text,
        wakeAgents: true
      },
      (res) => {
        if (res && res.ok) {
          toast('Orientação enviada ao vivo para todos os Agents da sala!');
          refreshCollabSection(true);
        }
      }
    );
  };

  document.getElementById('cb-coord-send').onclick = sendDashboardCoordinatorMsg;
  document.getElementById('cb-coord-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDashboardCoordinatorMsg();
    }
  });

  document.getElementById('cb-copy-final').onclick = () => {
    if (currentCollabRoomObj && currentCollabRoomObj.finalDeliverable) {
      navigator.clipboard.writeText(currentCollabRoomObj.finalDeliverable).catch(() => {});
      toast('Entrega Final Consolidada copiada para a área de transferência!');
    } else {
      toast('A entrega final ainda está sendo consolidada pela equipe.', true);
    }
  };

  document.getElementById('cb-dl-final').onclick = () => {
    if (currentCollabRoomObj && currentCollabRoomObj.finalDeliverable) {
      downloadFile(
        `entrega-final-tempchat-${currentCollabRoomObj.roomId}.md`,
        currentCollabRoomObj.finalDeliverable,
        'text/markdown;charset=utf-8'
      );
      toast('Arquivo Markdown da Entrega Final baixado!');
    } else {
      toast('A entrega final ainda está sendo consolidada pela equipe.', true);
    }
  };

  document.getElementById('cb-sync-filebin').onclick = () => {
    if (!currentCollabRoomObj) {
      toast('Selecione uma sala TempChat ativa primeiro.', true);
      return;
    }
    const btn = document.getElementById('cb-sync-filebin');
    btn.disabled = true;
    chrome.runtime.sendMessage(
      { type: 'AU_TEMPFILE_SYNC_ROOM_BIN', roomId: currentCollabRoomObj.roomId },
      (out) => {
        btn.disabled = false;
        if (out && out.ok) {
          toast(out.added ? `📦 ${out.added} novo(s) arquivo(s) sincronizado(s) do bucket Filebin!` : 'Bucket Filebin sincronizado!');
          refreshCollabSection(true);
        } else {
          toast((out && out.error) || 'Não foi possível sincronizar o bucket.', true);
        }
      }
    );
  };

  const cbUploadFile = document.getElementById('cb-upload-file');
  const cbUploadBtn = document.getElementById('cb-upload-btn');
  cbUploadBtn.onclick = () => {
    if (!currentCollabRoomObj) {
      toast('Crie ou selecione uma sala TempChat ativa para enviar arquivos à equipe.', true);
      return;
    }
    cbUploadFile.click();
  };
  cbUploadFile.onchange = () => {
    const file = cbUploadFile.files && cbUploadFile.files[0];
    if (!file || !currentCollabRoomObj) return;
    cbUploadBtn.disabled = true;
    cbUploadBtn.textContent = '📤 Enviando...';
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      const primaryProvider = document.getElementById('cb-upload-provider').value;
      chrome.runtime.sendMessage(
        {
          type: 'AU_TEMPFILE_UPLOAD',
          roomId: currentCollabRoomObj.roomId,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64Data,
          primaryProvider,
          autoFallback: true
        },
        (out) => {
          cbUploadBtn.disabled = false;
          cbUploadBtn.textContent = '📤 Enviar Arquivo do PC p/ Sala';
          cbUploadFile.value = '';
          if (out && out.ok) {
            toast(`📦 ${file.name} enviado via ${out.providerLabel} e anunciado a todos os Agents!`);
            refreshCollabSection(true);
          } else {
            toast((out && out.error) || 'Falha ao enviar arquivo temporário.', true);
          }
        }
      );
    };
    reader.readAsDataURL(file);
  };

  function renderTokenHealthBox(info) {
    const box = document.getElementById('gh-token-health-box');
    if (!box) return;
    if (!info) {
      box.innerHTML =
        '<div class="muted">🔐 <strong>Cofre de Credenciais Git Zero-Token:</strong> Cole um Token PAT acima e clique em <em>"🛡️ Auditar Escopos & Validade"</em> para inspecionar permissões e duração.</div>';
      return;
    }
    const vs = info.vaultSession || {};
    const exp = info.expiration || {};
    const caps = info.capabilities || {};
    const scopes = Array.isArray(info.scopes) ? info.scopes : [];
    if (!info.ok && vs.revoked) {
      box.style.borderColor = 'rgba(244,63,94,0.5)';
      box.style.background = 'rgba(244,63,94,0.1)';
      box.innerHTML = `🚫 <strong style="color:#fda4af;">Cofre Revogado Manualmente</strong> • Nenhum agente tem acesso à credencial na sessão atual. Salve ou audite um Token para reabrir o Cofre.`;
      return;
    }
    if (!info.ok || !info.valid) {
      box.style.borderColor = 'rgba(245,158,11,0.5)';
      box.style.background = 'rgba(245,158,11,0.09)';
      box.innerHTML = `⚠️ <strong style="color:#fcd34d;">Credencial Não Validada:</strong> ${esc(info.error || 'Adicione um Token PAT válido para liberar push e PRs autônomos.')}`;
      return;
    }

    const expColor = exp.isExpired ? '#fca5a5' : exp.isExpiringSoon ? '#fcd34d' : '#6ee7b7';
    const vaultLabel = vs.revoked
      ? '🚫 Cofre Revogado'
      : vs.expired
        ? '⏰ Sessão do Cofre Expirada'
        : vs.remainingMinutes != null
          ? `🔐 Cofre Ativo (${vs.remainingMinutes} min restantes na sessão)`
          : '🔐 Cofre Ativo (sem expiração de sessão)';

    const scopesPills = scopes.length
      ? scopes
          .map(
            (sc) =>
              `<span class="badge active" style="font-size:10.5px;padding:2px 6px;margin-right:4px;">${esc(sc)}</span>`
          )
          .join('')
      : info.tokenKind === 'fine_grained_pat'
        ? '<span class="badge active" style="font-size:10.5px;padding:2px 6px;">Fine-Grained (Permissões por Repositório)</span>'
        : '<span class="muted">Nenhum escopo OAuth listado</span>';

    const capItems = [
      caps.readRepo !== false ? '✅ Leitura Repo' : '❌ Leitura',
      caps.pushCode ? '✅ Git Push / Branches' : '⚠️ Sem Push',
      caps.pullRequests ? '✅ Pull Requests' : '⚠️ Sem PR',
      caps.actionsWorkflow ? '✅ Actions / Workflows' : '⚠️ Sem escopo workflow',
      caps.projects ? '✅ Projects' : '➖ Projects (opcional)'
    ].join(' • ');

    box.style.borderColor = exp.isExpired
      ? 'rgba(239,68,68,0.5)'
      : exp.isExpiringSoon
        ? 'rgba(245,158,11,0.5)'
        : 'rgba(16,185,129,0.45)';
    box.style.background = exp.isExpired
      ? 'rgba(239,68,68,0.09)'
      : exp.isExpiringSoon
        ? 'rgba(245,158,11,0.08)'
        : 'rgba(16,185,129,0.07)';

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:5px;">
        <div>
          <strong style="color:#6ee7b7;">✅ @${esc(info.login || 'GitHub')}</strong>
          <span class="muted"> • Tipo: <strong>${esc(info.tokenTypeLabel || info.tokenKind || 'PAT')}</strong></span>
        </div>
        <div style="color:${expColor};font-weight:700;">⏳ Credencial GitHub: ${esc(exp.label || 'Ativa')}</div>
      </div>
      <div style="margin-bottom:5px;"><strong>Escopos:</strong> ${scopesPills}</div>
      <div class="muted" style="font-size:11.5px;margin-bottom:4px;"><strong>Capacidades Efetivas:</strong> ${capItems}</div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:11.5px;color:#67e8f9;">
        <span>${esc(vaultLabel)}</span>
        ${info.rateLimit && info.rateLimit.remaining != null ? `<span class="muted">API Rate Limit: ${info.rateLimit.remaining}/${info.rateLimit.limit || 5000}</span>` : ''}
      </div>
    `;
  }

  function inspectGithubTokenHealth(silent = true) {
    const token = (document.getElementById('gh-token-input')?.value || '').trim();
    const repo = (document.getElementById('gh-default-repo')?.value || '').trim();
    const btn = document.getElementById('gh-inspect-token-btn');
    if (btn && !silent) {
      btn.disabled = true;
      btn.textContent = 'Auditando...';
    }
    chrome.runtime.sendMessage({ type: 'AU_GITHUB_INSPECT_TOKEN', token: token || undefined, repo }, (res) => {
      if (btn && !silent) {
        btn.disabled = false;
        btn.textContent = '🛡️ Auditar Escopos & Validade';
      }
      renderTokenHealthBox(res);
      if (!silent) {
        if (res && res.ok && res.valid) {
          toast(`🛡️ Token auditado: ${res.tokenTypeLabel || 'PAT'} • ${res.expiration?.label || 'Válido'}!`);
        } else {
          toast((res && res.error) || 'Informe um Token PAT válido para auditar.', true);
        }
      }
    });
  }

  // --- 2C. GitHub Integration & 4-Host Temporary File Hub (v4.0 Zero-Token Session Vault) ---
  async function renderIntegrationsSection() {
    const s = await AU_STORAGE.getSettings();
    currentSettings = s;

    const tokInput = document.getElementById('gh-token-input');
    if (tokInput) tokInput.value = '';
    document.getElementById('gh-default-repo').value = s.githubDefaultRepo || '';
    document.getElementById('gh-base-branch').value = s.githubBaseBranch || 'main';
    document.getElementById('gh-auth-mode').value = AU_DEFAULTS.normalizeGithubAuthMode(s.githubAuthMode);
    document.getElementById('gh-branch-mode').value = s.githubBranchMode || 'branch_per_agent_pr';
    const vaultTtlEl = document.getElementById('gh-vault-ttl');
    if (vaultTtlEl) vaultTtlEl.value = String(s.githubVaultSessionTtlMinutes != null ? s.githubVaultSessionTtlMinutes : 480);
    const defRbacEl = document.getElementById('gh-default-agent-rbac');
    if (defRbacEl) defRbacEl.value = s.githubDefaultAgentAccessMode || 'auto_role';
    const autoNotifyEl = document.getElementById('gh-auto-notify-refs');
    if (autoNotifyEl) autoNotifyEl.checked = s.githubAutoNotifyBranchesPrs !== false;
    document.getElementById('gh-enable-default').checked = s.githubEnabledInCollab !== false;
    const autoPrEl = document.getElementById('gh-auto-pr');
    if (autoPrEl) autoPrEl.checked = s.githubAutoCreatePR !== false;
    const autoDetEl = document.getElementById('gh-auto-detect-url');
    if (autoDetEl) autoDetEl.checked = s.githubAutoDetectInPrompt !== false;
    document.getElementById('gh-push-branch').value = s.githubBaseBranch || 'main';

    document.getElementById('tf-primary-provider').value = s.tempFilePrimaryProvider || 'filebin';
    document.getElementById('tf-litterbox-expiry').value = s.litterboxExpiry || '24h';
    document.getElementById('tf-auto-fallback').checked = s.tempFileAutoFallback !== false;
    document.getElementById('tf-enable-default').checked = s.tempFilesEnabledInCollab !== false;

    const badge = document.getElementById('gh-user-badge');
    chrome.runtime.sendMessage({ type: 'AU_VAULT_GET_STATUS' }, (vs) => {
      if (vs && vs.hasToken) {
        badge.className = 'badge active';
        badge.textContent = s.githubUsername
          ? `🐙 Sessão Ativa: @${s.githubUsername}`
          : '🐙 Token PAT em storage.session';
        if (tokInput) {
          tokInput.placeholder = '🔐 Token PAT ativo em storage.session (cole outro para substituir)';
        }
        loadGithubReposIntoDropdown(undefined, s.githubDefaultRepo || '');
        inspectGithubTokenHealth(true);
      } else if (vs && vs.hasEncryptedBlob) {
        badge.className = 'badge paused';
        badge.textContent = '🔒 Cofre Cifrado (Destravar)';
        if (tokInput) {
          tokInput.placeholder = '🔒 Cofre cifrado salvo em disco — digite a senha abaixo e clique em Destravar!';
        }
        renderTokenHealthBox(null);
      } else {
        badge.className = 'badge';
        badge.textContent = 'GitHub Desconectado (Sessão Limpa)';
        renderTokenHealthBox(null);
      }
    });

    // Populate open Arena tabs for 1-click Workspace Push & 1-click Repo Clone AND active TempChat rooms for quick file upload
    chrome.runtime.sendMessage({ type: 'AU_GET_MISSION_CONTROL' }, (res) => {
      if (!res || !res.ok) return;
      const tabs = res.tabs || [];
      const tabSel = document.getElementById('gh-push-tab-select');
      if (tabSel) {
        tabSel.innerHTML = tabs.length
          ? tabs
              .map(
                (t) =>
                  `<option value="${t.tabId}">${esc(t.title || 'Arena Agent')} — ${esc(t.url || '')}</option>`
              )
              .join('')
          : '<option value="">Nenhuma aba do Arena.ai aberta no momento</option>';
      }

      const cloneSel = document.getElementById('gh-clone-target-tab');
      if (cloneSel) {
        cloneSel.innerHTML =
          '<option value="">➕ Abrir Nova Aba Arena Agent com este Repositório</option>' +
          tabs
            .map(
              (t) =>
                `<option value="${t.tabId}">📥 Enviar p/ Aba Aberta: ${esc(t.title || 'Arena Agent')} (#${t.tabId})</option>`
            )
            .join('');
      }

      const rooms = res.collabRooms || [];
      const roomSel = document.getElementById('tf-quick-room');
      if (roomSel) {
        roomSel.innerHTML =
          '<option value="">Apenas gerar link (sem sala TempChat)</option>' +
          rooms
            .map(
              (r) =>
                `<option value="${esc(r.roomId)}">Anunciar na Sala TempChat #${esc(r.roomId)} (${(r.agents || []).length} Agents)</option>`
            )
            .join('');
      }
    });
  }

  function loadGithubReposIntoDropdown(token, selectedRepo) {
    const selSpec =
      typeof AU_INTEGRATIONS !== 'undefined' && AU_INTEGRATIONS.parseGitRepoSpec
        ? AU_INTEGRATIONS.parseGitRepoSpec(selectedRepo)
        : null;
    const selFull = selSpec ? selSpec.fullName.toLowerCase() : String(selectedRepo || '').toLowerCase();
    chrome.runtime.sendMessage({ type: 'AU_GITHUB_LIST_REPOS', token: token || undefined, perPage: 100 }, (res) => {
      const dd = document.getElementById('gh-repo-dropdown');
      if (!dd || !res || !res.ok || !Array.isArray(res.repos)) return;
      dd.innerHTML =
        '<option value="">Selecione um repositório da sua conta (públicos + privados)...</option>' +
        res.repos
          .map(
            (r) =>
              `<option value="${esc(r.htmlUrl || r.fullName)}" data-branch="${esc(r.defaultBranch || 'main')}" ${String(r.fullName || '').toLowerCase() === selFull ? 'selected' : ''}>${r.private ? '🔒 Privado' : '🌐 Público'} — ${esc(r.fullName)} (${esc(r.defaultBranch || 'main')})</option>`
          )
          .join('');
    });
  }

  document.getElementById('gh-repo-dropdown').onchange = (e) => {
    const val = e.target.value;
    if (!val) return;
    document.getElementById('gh-default-repo').value = val;
    const opt = e.target.selectedOptions && e.target.selectedOptions[0];
    if (opt && opt.dataset.branch) {
      document.getElementById('gh-base-branch').value = opt.dataset.branch;
      document.getElementById('gh-push-branch').value = opt.dataset.branch;
    }
    saveIntegrationsConfig(true);
  };

  let revealTokenTimer = null;
  const ghRevealTokenBtn = document.getElementById('gh-reveal-token-btn');
  if (ghRevealTokenBtn) {
    ghRevealTokenBtn.onclick = () => {
      const inp = document.getElementById('gh-token-input');
      if (!inp) return;
      if (inp.type === 'text') {
        inp.type = 'password';
        ghRevealTokenBtn.textContent = '👁️ 10s';
        clearTimeout(revealTokenTimer);
        return;
      }
      inp.type = 'text';
      ghRevealTokenBtn.textContent = '🙈 Ocultar';
      clearTimeout(revealTokenTimer);
      revealTokenTimer = setTimeout(() => {
        inp.type = 'password';
        ghRevealTokenBtn.textContent = '👁️ 10s';
      }, 10000);
    };
  }

  const ghEncryptSaveBtn = document.getElementById('gh-encrypt-save-btn');
  if (ghEncryptSaveBtn) {
    ghEncryptSaveBtn.onclick = async () => {
      const passEl = document.getElementById('gh-vault-passphrase');
      const passphrase = (passEl?.value || '').trim();
      const tokInput = document.getElementById('gh-token-input');
      const typedPat = (tokInput?.value || '').trim();
      if (passphrase.length < 8) {
        toast('Defina uma senha de pelo menos 8 caracteres para cifrar o Cofre com AES-256-GCM.', true);
        return;
      }
      if (typedPat) {
        if (tokInput) tokInput.value = '';
        await new Promise((r) =>
          chrome.runtime.sendMessage({ type: 'AU_VAULT_SET_SECRET', githubToken: typedPat }, () => r())
        );
      }
      chrome.runtime.sendMessage(
        { type: 'AU_VAULT_SAVE_ENCRYPTED', passphrase, githubToken: typedPat || undefined },
        (res) => {
          if (passEl) passEl.value = '';
          if (res && res.ok) {
            toast('🔐 PAT cifrado com PBKDF2 (100k) + AES-256-GCM e salvo com segurança!');
            renderIntegrationsSection();
          } else {
            toast((res && res.error) || 'Falha ao cifrar Cofre (verifique se há um PAT ativo na sessão).', true);
          }
        }
      );
    };
  }

  const ghEncryptUnlockBtn = document.getElementById('gh-encrypt-unlock-btn');
  if (ghEncryptUnlockBtn) {
    ghEncryptUnlockBtn.onclick = () => {
      const passEl = document.getElementById('gh-vault-passphrase');
      const passphrase = (passEl?.value || '').trim();
      if (!passphrase) {
        toast('Digite a senha do Cofre Cifrado para destravar na sessão atual.', true);
        return;
      }
      chrome.runtime.sendMessage({ type: 'AU_VAULT_UNLOCK_ENCRYPTED', passphrase }, (res) => {
        if (passEl) passEl.value = '';
        if (res && res.ok) {
          toast('🔓 Cofre destravado em storage.session!');
          renderIntegrationsSection();
        } else {
          toast((res && res.error) || 'Senha incorreta ou cofre cifrado inexistente.', true);
        }
      });
    };
  }

  async function saveIntegrationsConfig(silent = false) {
    const rawRepoVal = document.getElementById('gh-default-repo').value.trim();
    const spec =
      typeof AU_INTEGRATIONS !== 'undefined' && AU_INTEGRATIONS.parseGitRepoSpec
        ? AU_INTEGRATIONS.parseGitRepoSpec(rawRepoVal)
        : null;
    if (spec && spec.branchFromUrl) {
      document.getElementById('gh-base-branch').value = spec.branchFromUrl;
    }
    const tokInput = document.getElementById('gh-token-input');
    const typedPat = (tokInput?.value || '').trim();
    if (typedPat) {
      if (tokInput) tokInput.value = '';
      await new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'AU_VAULT_SET_SECRET', githubToken: typedPat }, () => r())
      );
    }
    const patch = {
      githubDefaultRepo: spec ? spec.webUrl : rawRepoVal,
      githubBaseBranch: document.getElementById('gh-base-branch').value.trim() || 'main',
      githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(document.getElementById('gh-auth-mode').value),
      githubBranchMode: document.getElementById('gh-branch-mode').value,
      githubVaultSessionTtlMinutes: Number(document.getElementById('gh-vault-ttl')?.value ?? 480),
      githubDefaultAgentAccessMode: document.getElementById('gh-default-agent-rbac')?.value || 'auto_role',
      githubAutoNotifyBranchesPrs: document.getElementById('gh-auto-notify-refs')
        ? document.getElementById('gh-auto-notify-refs').checked
        : true,
      githubEnabledInCollab: document.getElementById('gh-enable-default').checked,
      githubAutoCreatePR: document.getElementById('gh-auto-pr') ? document.getElementById('gh-auto-pr').checked : true,
      githubAutoDetectInPrompt: document.getElementById('gh-auto-detect-url')
        ? document.getElementById('gh-auto-detect-url').checked
        : true,
      tempFilePrimaryProvider: document.getElementById('tf-primary-provider').value,
      litterboxExpiry: document.getElementById('tf-litterbox-expiry').value,
      tempFileAutoFallback: document.getElementById('tf-auto-fallback').checked,
      tempFilesEnabledInCollab: document.getElementById('tf-enable-default').checked
    };
    currentSettings = await AU_STORAGE.saveSettings(patch);
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
    if (typedPat) {
      inspectGithubTokenHealth(true);
    }
    await syncLauncherIntegrationDefaults();
    if (!silent) {
      toast('Configurações do Cofre Zero-Token (storage.session) & Hub de Arquivos salvas!');
    }
  }

  document.getElementById('gh-save-all-btn').onclick = () => saveIntegrationsConfig(false);

  const ghInspectBtn = document.getElementById('gh-inspect-token-btn');
  if (ghInspectBtn) {
    ghInspectBtn.onclick = async () => {
      await saveIntegrationsConfig(true);
      inspectGithubTokenHealth(false);
    };
  }

  const ghRevokeVaultBtn = document.getElementById('gh-revoke-vault-btn');
  if (ghRevokeVaultBtn) {
    ghRevokeVaultBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'AU_GITHUB_REVOKE_VAULT', clearSaved: true }, (res) => {
        if (res && res.ok) {
          const tokInput = document.getElementById('gh-token-input');
          if (tokInput) tokInput.value = '';
          const badge = document.getElementById('gh-user-badge');
          if (badge) {
            badge.className = 'badge stopped';
            badge.textContent = '🚫 Cofre Revogado';
          }
          renderTokenHealthBox({ ok: false, vaultSession: { revoked: true } });
          toast('🚫 Cofre revogado imediatamente! Credenciais limpas e chaves dos agentes rotacionadas.');
        }
      });
    };
  }

  // Auto-save GitHub link & options immediately on change (PAT stays in storage.session via explicit Vault actions)
  [
    'gh-default-repo',
    'gh-base-branch',
    'gh-auth-mode',
    'gh-branch-mode',
    'gh-vault-ttl',
    'gh-default-agent-rbac',
    'gh-auto-notify-refs',
    'gh-enable-default',
    'gh-auto-pr',
    'gh-auto-detect-url'
  ].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === 'gh-default-repo') {
        el.addEventListener('input', () =>
          autoExtractBranchFromRepoInput(el, document.getElementById('gh-base-branch'))
        );
      }
      el.addEventListener('change', () => saveIntegrationsConfig(true));
    }
  );

  const ghTestLinkBtn = document.getElementById('gh-test-link-btn');
  if (ghTestLinkBtn) {
    ghTestLinkBtn.onclick = async () => {
      await saveIntegrationsConfig(true);
      const repo = document.getElementById('gh-default-repo').value.trim();
      const token = document.getElementById('gh-token-input').value.trim();
      const stBox = document.getElementById('gh-access-status');
      if (!repo) {
        toast('Cole primeiro o link do repositório GitHub (ex.: https://github.com/usuario/projeto)!', true);
        return;
      }
      ghTestLinkBtn.disabled = true;
      ghTestLinkBtn.textContent = 'Testando...';
      if (stBox) {
        stBox.style.display = 'block';
        stBox.style.background = 'rgba(59,130,246,0.12)';
        stBox.style.border = '1px solid rgba(59,130,246,0.35)';
        stBox.style.color = '#93c5fd';
        stBox.textContent = '🔍 Testando acesso a Code, Issues, Pull Requests, Actions, Wiki e permissões de PR...';
      }
      chrome.runtime.sendMessage(
        { type: 'AU_GITHUB_CHECK_REPO_ACCESS', repo, token, saveAsDefault: true },
        (res) => {
          ghTestLinkBtn.disabled = false;
          ghTestLinkBtn.textContent = '🔍 Testar Link / Acesso';
          if (res && res.ok) {
            if (res.htmlUrl) document.getElementById('gh-default-repo').value = res.htmlUrl;
            const detBranch = res.branchFromUrl || res.defaultBranch || 'main';
            document.getElementById('gh-base-branch').value = detBranch;
            document.getElementById('gh-push-branch').value = detBranch;
            syncLauncherIntegrationDefaults();
            const tabsInfo = `Issues: ${res.openIssuesCount || 0} • PRs abertos: ${res.openPrsCount || 0} • Actions runs: ${res.actionsRunsCount != null ? res.actionsRunsCount : 'OK'}`;
            if (stBox) {
              if (res.canCreatePR) {
                const wfWarn =
                  res.hasWorkflowScope === false
                    ? `<div style="margin-top:4px;color:#fcd34d;">⚠️ Se os Agents precisarem editar <code>.github/workflows/</code> (Actions), gere um Token com escopo <code>workflow</code> clicando em <strong>🔑 Gerar Token PAT Pronto</strong> acima.</div>`
                    : '';
                stBox.style.background = 'rgba(16,185,129,0.14)';
                stBox.style.border = '1px solid rgba(16,185,129,0.45)';
                stBox.style.color = '#6ee7b7';
                stBox.innerHTML = `✅ <strong>${esc(res.fullName)}</strong> (${res.private ? '🔒 Privado' : '🌐 Público'}) • <strong>🚀 PRs Diretos + Git Push LIBERADOS sem você no loop!</strong> • Branch: <code>${esc(detBranch)}</code> • ${tabsInfo}${wfWarn}`;
              } else {
                stBox.style.background = 'rgba(245,158,11,0.14)';
                stBox.style.border = '1px solid rgba(245,158,11,0.45)';
                stBox.style.color = '#fcd34d';
                stBox.innerHTML = `⚠️ <strong>${esc(res.fullName)}</strong> • Leitura total liberada (Code + Issues + PRs + Actions + Wiki • ${tabsInfo}), mas <strong>sem Token de escrita para os Agents criarem Pull Requests sozinhos</strong>! Clique em <strong>🔑 Gerar Token PAT Pronto</strong> acima e cole o Token PAT.${res.authWarning ? `<div style="margin-top:4px;color:#fca5a5;">${esc(res.authWarning)}</div>` : ''}`;
              }
            }
            toast(
              res.canCreatePR
                ? `✅ PRs Autônomos + Acesso Total confirmados em ${res.fullName}!`
                : `Leitura confirmada em ${res.fullName} — adicione um Token PAT para liberar PRs automáticos!`
            );
          } else {
            const errMsg = (res && res.error) || 'Não foi possível acessar este link do GitHub.';
            if (stBox) {
              stBox.style.background = 'rgba(239,68,68,0.14)';
              stBox.style.border = '1px solid rgba(239,68,68,0.45)';
              stBox.style.color = '#fca5a5';
              stBox.textContent = `❌ ${errMsg}`;
            }
            toast(errMsg, true);
          }
        }
      );
    };
  }

  const ghCloneSendBtn = document.getElementById('gh-clone-send-btn');
  if (ghCloneSendBtn) {
    ghCloneSendBtn.onclick = async () => {
      await saveIntegrationsConfig(true);
      const repo = document.getElementById('gh-default-repo').value.trim();
      const token = document.getElementById('gh-token-input').value.trim();
      const baseBranch = document.getElementById('gh-base-branch').value.trim() || 'main';
      const authMode = document.getElementById('gh-auth-mode').value || 'vault_broker_zero_token';
      const tabId = Number(document.getElementById('gh-clone-target-tab')?.value || 0);
      const userPrompt = document.getElementById('gh-clone-prompt')?.value.trim() || '';
      if (!repo) {
        toast('Cole primeiro o link do repositório GitHub acima!', true);
        return;
      }
      ghCloneSendBtn.disabled = true;
      ghCloneSendBtn.textContent = 'Conectando...';
      chrome.runtime.sendMessage(
        {
          type: 'AU_SEND_GITHUB_TO_TAB',
          repo,
          token,
          baseBranch,
          authMode,
          tabId,
          userPrompt
        },
        (res) => {
          ghCloneSendBtn.disabled = false;
          ghCloneSendBtn.textContent = '🐙 Conectar Repo no Agent';
          if (res && res.ok) {
            toast(
              res.mode === 'sent_to_tab'
                ? `🐙 Repositório conectado e enviado para a aba Agent #${res.tabId}!`
                : `🐙 Nova aba Arena Agent aberta já clonando ${res.repo}!`
            );
          } else {
            toast((res && res.error) || 'Falha ao enviar repositório para o Agent.', true);
          }
        }
      );
    };
  }

  document.getElementById('gh-verify-btn').onclick = () => {
    const tokInput = document.getElementById('gh-token-input');
    const token = (tokInput?.value || '').trim();
    const btn = document.getElementById('gh-verify-btn');
    btn.disabled = true;
    btn.textContent = 'Verificando...';
    chrome.runtime.sendMessage(
      { type: 'AU_GITHUB_VERIFY_TOKEN', token: token || undefined, saveToken: true },
      (res) => {
        btn.disabled = false;
        btn.textContent = 'Verificar & Carregar Repos';
        if (res && res.ok) {
          if (tokInput) {
            tokInput.value = '';
            tokInput.placeholder = '🔐 Token PAT ativo em storage.session (cole outro para substituir)';
          }
          const badge = document.getElementById('gh-user-badge');
          badge.className = 'badge active';
          badge.textContent = `🐙 Sessão Ativa: @${res.login}`;
          toast(`✅ Conectado ao GitHub em storage.session como @${res.login}! Carregando seus repositórios...`);
          loadGithubReposIntoDropdown(undefined, document.getElementById('gh-default-repo').value.trim());
          inspectGithubTokenHealth(true);
        } else {
          toast((res && res.error) || 'Cole um Personal Access Token (PAT) válido ou destrave o Cofre.', true);
        }
      }
    );
  };

  document.getElementById('gh-create-repo-btn').onclick = async () => {
    await saveIntegrationsConfig();
    const name = document.getElementById('gh-create-name').value.trim();
    const description = document.getElementById('gh-create-desc').value.trim();
    const isPrivate = document.getElementById('gh-create-private').checked;
    if (!name) {
      toast('Informe o nome do novo repositório.', true);
      return;
    }
    const btn = document.getElementById('gh-create-repo-btn');
    btn.disabled = true;
    btn.textContent = 'Criando...';
    chrome.runtime.sendMessage(
      {
        type: 'AU_GITHUB_CREATE_REPO',
        options: { name, description, private: isPrivate, autoInit: true }
      },
      (res) => {
        btn.disabled = false;
        btn.textContent = 'Criar Repo';
        if (res && res.ok && res.repo) {
          document.getElementById('gh-default-repo').value = res.repo.htmlUrl || res.repo.fullName;
          document.getElementById('gh-base-branch').value = res.repo.defaultBranch || 'main';
          document.getElementById('gh-create-name').value = '';
          toast(`✅ Repositório ${res.repo.fullName} criado com sucesso e selecionado!`);
          renderIntegrationsSection();
        } else {
          toast((res && res.error) || 'Falha ao criar repositório.', true);
        }
      }
    );
  };

  document.getElementById('gh-inspect-repo-btn').onclick = async () => {
    await saveIntegrationsConfig();
    const repo = document.getElementById('gh-default-repo').value.trim();
    const box = document.getElementById('gh-repo-overview-box');
    if (!repo) {
      toast('Selecione ou digite um repositório (usuario/repo) primeiro.', true);
      return;
    }
    box.innerHTML = '<div class="muted">Consultando branches, commits e Pull Requests no GitHub...</div>';
    chrome.runtime.sendMessage({ type: 'AU_GITHUB_GET_REPO_OVERVIEW', repo }, (res) => {
      if (!res || !res.ok || !res.overview) {
        box.innerHTML = `<div class="muted" style="color:#fca5a5;">${esc((res && res.error) || 'Falha ao inspecionar repositório.')}</div>`;
        return;
      }
      const ov = res.overview;
      const branchesHtml = (ov.branches || [])
        .slice(0, 10)
        .map(
          (b) =>
            `<span class="badge ${b.name === ov.defaultBranch ? 'active' : ''}" style="margin-right:4px;">🌿 ${esc(b.name)} (${esc(b.sha)})</span>`
        )
        .join(' ');
      const prsHtml = (ov.pulls || []).length
        ? ov.pulls
            .map(
              (p) =>
                `<div class="muted" style="font-size:12px;">🔀 <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:600;">PR #${p.number} [${esc(p.state)}]: ${esc(p.title)}</a> (${esc(p.head)} → ${esc(p.base)})</div>`
            )
            .join('')
        : '<div class="muted" style="font-size:12px;">Nenhum Pull Request registrado ainda.</div>';
      const issuesHtml = (ov.issues || []).length
        ? ov.issues
            .map(
              (i) =>
                `<div class="muted" style="font-size:12px;">🐛 <a href="${esc(i.htmlUrl)}" target="_blank" rel="noopener" style="color:#fcd34d;font-weight:600;">Issue #${i.number}: ${esc(i.title)}</a></div>`
            )
            .join('')
        : '<div class="muted" style="font-size:12px;">Nenhuma Issue aberta.</div>';
      const actionsHtml = (ov.actionsRuns || []).length
        ? ov.actionsRuns
            .map(
              (r) =>
                `<div class="muted" style="font-size:12px;">⚙️ <a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener" style="color:#67e8f9;">${esc(r.name || 'Workflow')}</a> (${esc(r.branch || 'main')}) — <code>${esc(r.status)}/${esc(r.conclusion || '...')}</code></div>`
            )
            .join('')
        : '<div class="muted" style="font-size:12px;">Nenhuma execução recente do GitHub Actions.</div>';
      const commitsHtml = (ov.commits || [])
        .slice(0, 5)
        .map(
          (c) =>
            `<div class="muted" style="font-size:12px;">• <a href="${esc(c.htmlUrl)}" target="_blank" rel="noopener" style="color:#93c5fd;"><code>${esc(c.sha)}</code></a> ${esc(c.message)} — <em>${esc(c.author)}</em></div>`
        )
        .join('');

      box.innerHTML = `
        <div class="item-box">
          <div style="margin-bottom:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <a href="${esc(ov.htmlUrl)}" target="_blank" rel="noopener" style="color:#c4b5fd;font-weight:700;">🐙 ${esc(ov.fullName)} (Code) ↗</a>
            <a href="${esc(ov.htmlUrl)}/issues" target="_blank" rel="noopener" class="muted" style="font-size:11.5px;">Issues ↗</a>
            <a href="${esc(ov.htmlUrl)}/pulls" target="_blank" rel="noopener" class="muted" style="font-size:11.5px;">Pull requests ↗</a>
            <a href="${esc(ov.htmlUrl)}/actions" target="_blank" rel="noopener" class="muted" style="font-size:11.5px;">Actions ↗</a>
            <a href="${esc(ov.htmlUrl)}/projects" target="_blank" rel="noopener" class="muted" style="font-size:11.5px;">Projects ↗</a>
            <a href="${esc(ov.htmlUrl)}/wiki" target="_blank" rel="noopener" style="font-size:11.5px;">Wiki ↗</a>
            <a href="${esc(ov.htmlUrl)}/pulse" target="_blank" rel="noopener" class="muted" style="font-size:11.5px;">Insights ↗</a>
          </div>
          <div style="margin-bottom:6px;">${branchesHtml}</div>
          <div style="margin-bottom:6px;"><strong>Pull Requests:</strong>${prsHtml}</div>
          <div style="margin-bottom:6px;"><strong>Issues Abertas:</strong>${issuesHtml}</div>
          <div style="margin-bottom:6px;"><strong>GitHub Actions (CI):</strong>${actionsHtml}</div>
          <div><strong>Últimos Commits:</strong>${commitsHtml}</div>
        </div>
      `;
    });
  };

  document.getElementById('gh-push-now-btn').onclick = async () => {
    await saveIntegrationsConfig();
    const repo = document.getElementById('gh-default-repo').value.trim();
    const baseBranch = document.getElementById('gh-base-branch').value.trim() || 'main';
    const branch = document.getElementById('gh-push-branch').value.trim() || baseBranch;
    const tabId = Number(document.getElementById('gh-push-tab-select').value || 0);
    const message = document.getElementById('gh-push-msg').value.trim() || 'feat(arena-agent): push de workspace via Arena Ultra';
    const openPR = document.getElementById('gh-push-open-pr').checked;

    if (!repo) {
      toast('Selecione ou informe o repositório GitHub (usuario/repo).', true);
      return;
    }
    if (!tabId) {
      toast('Abra uma sessão Agent salva no Arena.ai para enviar seu Workspace.', true);
      return;
    }

    const btn = document.getElementById('gh-push-now-btn');
    btn.disabled = true;
    btn.textContent = '🐙 Baixando ZIP & Commitando...';
    chrome.runtime.sendMessage(
      {
        type: 'AU_GITHUB_PUSH_BUNDLE',
        tabId,
        repo,
        baseBranch,
        branch,
        message,
        openPR,
        prTitle: message
      },
      (out) => {
        btn.disabled = false;
        btn.textContent = '🐙 Commit & Abrir PR';
        if (out && out.ok) {
          toast(
            `✅ Commit ${out.shortSha} (${out.filesCount} arquivos) enviado para ${out.repo}@${out.branch}!` +
              (out.pullRequest ? ` PR #${out.pullRequest.number} criado!` : '')
          );
          document.getElementById('gh-inspect-repo-btn').click();
        } else {
          toast((out && out.error) || 'Falha ao enviar Workspace para o GitHub.', true);
        }
      }
    );
  };

  document.getElementById('tf-quick-upload-btn').onclick = async () => {
    await saveIntegrationsConfig();
    const fileInput = document.getElementById('tf-quick-file');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      toast('Selecione um arquivo do seu computador primeiro.', true);
      return;
    }
    const roomId = document.getElementById('tf-quick-room').value || '';
    const primaryProvider = document.getElementById('tf-primary-provider').value;
    const autoFallback = document.getElementById('tf-auto-fallback').checked;
    const expiry = document.getElementById('tf-litterbox-expiry').value;

    const btn = document.getElementById('tf-quick-upload-btn');
    const resBox = document.getElementById('tf-quick-result');
    btn.disabled = true;
    btn.textContent = '📤 Enviando...';
    resBox.textContent = 'Fazendo upload com fallback inteligente...';

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      chrome.runtime.sendMessage(
        {
          type: 'AU_TEMPFILE_UPLOAD',
          roomId,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64Data,
          primaryProvider,
          autoFallback,
          expiry
        },
        (out) => {
          btn.disabled = false;
          btn.textContent = '📤 Fazer Upload';
          if (out && out.ok) {
            const curlCmd = `curl -fsSL -H "Cookie: verified=2024-05-24" "${out.url}" -o "${out.filename}"`;
            resBox.innerHTML = `
              <div class="item-box" style="border-color:rgba(16,185,129,0.5);">
                <div>✅ Enviado via <strong>${esc(out.providerLabel)}</strong>: <a href="${esc(out.url)}" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:700;">${esc(out.url)}</a></div>
                <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
                  <button class="btn btn-sm" id="tf-copy-url-btn">📋 Copiar URL</button>
                  <button class="btn btn-sm" id="tf-copy-curl-btn">💻 Copiar Comando curl pros Agents</button>
                </div>
              </div>
            `;
            resBox.querySelector('#tf-copy-url-btn').onclick = () => {
              navigator.clipboard.writeText(out.url).catch(() => {});
              toast('URL copiada!');
            };
            resBox.querySelector('#tf-copy-curl-btn').onclick = () => {
              navigator.clipboard.writeText(curlCmd).catch(() => {});
              toast('Comando curl copiado!');
            };
            toast(`📦 Upload concluído em ${out.providerLabel}!`);
          } else {
            resBox.textContent = (out && out.error) || 'Falha no upload.';
            toast((out && out.error) || 'Falha no upload.', true);
          }
        }
      );
    };
    reader.readAsDataURL(file);
  };

  // --- 3. Auto-Continue, Rules & Alerts ---
  async function loadAutoContinueSection() {
    currentSettings = await AU_STORAGE.getSettings();
    currentRules = Array.isArray(currentSettings.conditionalRules)
      ? JSON.parse(JSON.stringify(currentSettings.conditionalRules))
      : [];

    document.getElementById('ac-strategy').value = currentSettings.autoContinueStrategy || 'hybrid';
    document.getElementById('ac-fixed-prompt').value = currentSettings.fixedContinuePrompt || '';
    document.getElementById('ac-agent-kit-enabled').checked = currentSettings.agentKitEnabled === true;
    document.getElementById('ac-harness-enabled').checked = currentSettings.harnessEnabled !== false;
    document.getElementById('ac-timer-minutes').value = currentSettings.sessionMinTimerMinutes || 60;
    document.getElementById('ac-settle-ms').value = currentSettings.settleDelayMs || 3200;
    document.getElementById('ac-send-ms').value = currentSettings.sendDelayMs || 1200;
    document.getElementById('ac-hard-stop').checked = Boolean(currentSettings.hardStopOnTokenLimit);
    document.getElementById('ac-antithrottle').checked = Boolean(currentSettings.antiThrottleEnabled);
    document.getElementById('ac-autosave').checked = Boolean(currentSettings.autoSaveSnapshots);
    const acHideAutoEl = document.getElementById('ac-hide-autoprompts');
    if (acHideAutoEl) acHideAutoEl.checked = currentSettings.hideAutoPromptsInChat !== false;
    const acRefuseEl = document.getElementById('ac-refuse-thinking');
    const acRerollEl = document.getElementById('ac-refuse-reroll');
    const acMaxEl = document.getElementById('ac-refuse-max');
    if (acRefuseEl) acRefuseEl.checked = currentSettings.refuseThinkingModels !== false;
    if (acRerollEl) acRerollEl.checked = currentSettings.refuseThinkingAutoReroll !== false;
    if (acMaxEl) acMaxEl.value = Number(currentSettings.refuseThinkingMaxRetries || 15);

    document.getElementById('ac-notif').checked = Boolean(currentSettings.desktopNotifications);
    document.getElementById('ac-sound').checked = Boolean(currentSettings.soundEnabled);
    document.getElementById('ac-blink').checked = Boolean(currentSettings.blinkTabTitle);
    document.getElementById('ac-badge').checked = Boolean(currentSettings.badgeEnabled);
    document.getElementById('ac-webhook').value = currentSettings.webhookUrl || '';
    document.getElementById('ac-limit-patterns').value = (currentSettings.tokenLimitPatterns || []).join('\n');

    renderConditionalRulesList();
  }

  function renderConditionalRulesList() {
    const box = document.getElementById('ac-rules-list');
    box.innerHTML = currentRules
      .map(
        (r, idx) => `
        <div class="item-box">
          <div class="row">
            <label class="chk">
              <input type="checkbox" class="rl-en" data-idx="${idx}" ${r.enabled ? 'checked' : ''} />
              <strong>Regra #${idx + 1}</strong>
            </label>
            <input class="input rl-name" data-idx="${idx}" style="flex:1;" value="${esc(r.name)}" placeholder="Nome da regra" />
            <button class="btn btn-sm btn-danger rl-del" data-idx="${idx}">Excluir</button>
          </div>
          <label class="lbl">Expressão Regular / Palavras-Chave (testada na última resposta do Agent)</label>
          <input class="input rl-pat" data-idx="${idx}" value="${esc(r.pattern)}" placeholder="(erro|failed|próximo passo)" />
          <label class="lbl">Prompt Enviado Automaticamente quando Coincidir</label>
          <textarea class="textarea rl-resp" data-idx="${idx}" rows="2">${esc(r.responsePrompt)}</textarea>
        </div>
      `
      )
      .join('');

    box.querySelectorAll('.rl-en').forEach((el) => {
      el.onchange = () => { currentRules[Number(el.dataset.idx)].enabled = el.checked; };
    });
    box.querySelectorAll('.rl-name').forEach((el) => {
      el.oninput = () => { currentRules[Number(el.dataset.idx)].name = el.value; };
    });
    box.querySelectorAll('.rl-pat').forEach((el) => {
      el.oninput = () => { currentRules[Number(el.dataset.idx)].pattern = el.value; };
    });
    box.querySelectorAll('.rl-resp').forEach((el) => {
      el.oninput = () => { currentRules[Number(el.dataset.idx)].responsePrompt = el.value; };
    });
    box.querySelectorAll('.rl-del').forEach((el) => {
      el.onclick = () => {
        currentRules.splice(Number(el.dataset.idx), 1);
        renderConditionalRulesList();
      };
    });
  }

  document.getElementById('ac-add-rule').onclick = () => {
    currentRules.push({
      id: 'rule_' + Date.now(),
      name: 'Nova Regra Condicional',
      enabled: true,
      pattern: '(pendente|continuar)',
      responsePrompt: 'Execute imediatamente todos os itens pendentes.'
    });
    renderConditionalRulesList();
  };

  document.getElementById('ac-save-btn').onclick = async () => {
    const patterns = document
      .getElementById('ac-limit-patterns')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    currentSettings = await AU_STORAGE.saveSettings({
      autoContinueStrategy: document.getElementById('ac-strategy').value,
      fixedContinuePrompt: document.getElementById('ac-fixed-prompt').value.trim(),
      agentKitEnabled: document.getElementById('ac-agent-kit-enabled').checked,
      harnessEnabled: document.getElementById('ac-harness-enabled').checked,
      sessionMinTimerMinutes: Math.min(480, Math.max(60, Number(document.getElementById('ac-timer-minutes').value || 60))),
      settleDelayMs: Math.max(1500, Number(document.getElementById('ac-settle-ms').value || 3200)),
      sendDelayMs: Math.max(300, Number(document.getElementById('ac-send-ms').value || 1200)),
      hardStopOnTokenLimit: document.getElementById('ac-hard-stop').checked,
      antiThrottleEnabled: document.getElementById('ac-antithrottle').checked,
      autoSaveSnapshots: document.getElementById('ac-autosave').checked,
      hideAutoPromptsInChat: document.getElementById('ac-hide-autoprompts')
        ? document.getElementById('ac-hide-autoprompts').checked
        : true,
      refuseThinkingModels: document.getElementById('ac-refuse-thinking')
        ? document.getElementById('ac-refuse-thinking').checked
        : true,
      refuseThinkingAutoReroll: document.getElementById('ac-refuse-reroll')
        ? document.getElementById('ac-refuse-reroll').checked
        : true,
      refuseThinkingMaxRetries: Math.max(
        1,
        Math.min(40, Number(document.getElementById('ac-refuse-max')?.value || 15))
      ),
      desktopNotifications: document.getElementById('ac-notif').checked,
      soundEnabled: document.getElementById('ac-sound').checked,
      blinkTabTitle: document.getElementById('ac-blink').checked,
      badgeEnabled: document.getElementById('ac-badge').checked,
      webhookUrl: document.getElementById('ac-webhook').value.trim(),
      tokenLimitPatterns: patterns,
      conditionalRules: currentRules
    });

    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
    toast('Configurações de Auto-Continue, Regras e Alertas salvas!');
  };

  document.getElementById('ac-test-webhook').onclick = () => {
    const url = document.getElementById('ac-webhook').value.trim();
    if (!url) {
      toast('Cole a URL do Webhook antes de testar.', true);
      return;
    }
    chrome.runtime.sendMessage({ type: 'AU_TEST_WEBHOOK', webhookUrl: url }, (res) => {
      if (res && res.ok) toast('Webhook enviado com sucesso! Verifique seu Discord/canal.');
      else toast('Falha no envio do Webhook: ' + ((res && res.reason) || 'verifique a URL'), true);
    });
  };

  // --- 4. Prompts & Macros ---
  async function renderPromptsAndMacros() {
    const [prompts, macros] = await Promise.all([AU_STORAGE.getPrompts(), AU_STORAGE.getMacros()]);
    populateLauncherMacros();

    const pBox = document.getElementById('pm-list');
    pBox.innerHTML = prompts
      .map(
        (p) => `
        <div class="item-box">
          <div class="item-top">
            <div>
              <strong>${esc(p.title)}</strong>
              <span class="badge" style="margin-left:6px;">${esc(p.slash || p.category)}</span>
            </div>
            <div class="row">
              <button class="btn btn-sm pm-edit" data-id="${esc(p.id)}">Editar</button>
              <button class="btn btn-sm btn-danger pm-del" data-id="${esc(p.id)}">Excluir</button>
            </div>
          </div>
          <div class="muted">${esc(p.content)}</div>
        </div>
      `
      )
      .join('');

    pBox.querySelectorAll('.pm-edit').forEach((b) => {
      b.onclick = () => {
        const found = prompts.find((x) => x.id === b.dataset.id);
        if (!found) return;
        document.getElementById('pm-edit-id').value = found.id;
        document.getElementById('pm-title').value = found.title;
        document.getElementById('pm-slash').value = found.slash || '';
        document.getElementById('pm-cat').value = found.category || 'Geral';
        document.getElementById('pm-content').value = found.content;
      };
    });

    pBox.querySelectorAll('.pm-del').forEach((b) => {
      b.onclick = async () => {
        await AU_STORAGE.deletePrompt(b.dataset.id);
        renderPromptsAndMacros();
        toast('Template removido.');
      };
    });

    const mBox = document.getElementById('mc-macros-list');
    mBox.innerHTML = macros
      .map(
        (m) => `
        <div class="item-box">
          <div class="item-top">
            <strong>${esc(m.name)}</strong>
            <div class="row">
              <span class="badge active">${m.steps.length} etapas</span>
              <button class="btn btn-sm btn-danger mc-del-macro" data-id="${esc(m.id)}">Excluir</button>
            </div>
          </div>
          <div class="muted">${esc(m.description || '')}</div>
          <ol style="padding-left:18px;font-size:12px;color:#cbd5e1;">
            ${m.steps.map((s) => `<li>${esc(s)}</li>`).join('')}
          </ol>
        </div>
      `
      )
      .join('');

    mBox.querySelectorAll('.mc-del-macro').forEach((b) => {
      b.onclick = async () => {
        await AU_STORAGE.deleteMacro(b.dataset.id);
        renderPromptsAndMacros();
        toast('Macro removida.');
      };
    });
  }

  document.getElementById('pm-save').onclick = async () => {
    const id = document.getElementById('pm-edit-id').value || undefined;
    const title = document.getElementById('pm-title').value.trim();
    const slash = document.getElementById('pm-slash').value.trim();
    const category = document.getElementById('pm-cat').value.trim() || 'Geral';
    const content = document.getElementById('pm-content').value.trim();
    if (!title || !content) {
      toast('Preencha o título e o conteúdo do prompt.', true);
      return;
    }
    await AU_STORAGE.upsertPrompt({ id, title, slash, category, content });
    document.getElementById('pm-clear').click();
    renderPromptsAndMacros();
    toast('Template salvo na biblioteca!');
  };

  document.getElementById('pm-clear').onclick = () => {
    document.getElementById('pm-edit-id').value = '';
    document.getElementById('pm-title').value = '';
    document.getElementById('pm-slash').value = '';
    document.getElementById('pm-content').value = '';
  };

  document.getElementById('mc-save-macro').onclick = async () => {
    const name = document.getElementById('mc-new-name').value.trim();
    const description = document.getElementById('mc-new-desc').value.trim();
    const steps = document.getElementById('mc-new-steps').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!name || !steps.length) {
      toast('Informe nome e ao menos uma etapa.', true);
      return;
    }
    await AU_STORAGE.upsertMacro({ name, description, steps });
    document.getElementById('mc-new-name').value = '';
    document.getElementById('mc-new-desc').value = '';
    document.getElementById('mc-new-steps').value = '';
    renderPromptsAndMacros();
    toast('Macro de Workflow criada!');
  };

  document.getElementById('pr-export-json').onclick = async () => {
    const [prompts, macros] = await Promise.all([AU_STORAGE.getPrompts(), AU_STORAGE.getMacros()]);
    downloadFile('arena-ultra-prompts-macros.json', JSON.stringify({ prompts, macros }, null, 2), 'application/json');
  };

  document.getElementById('pr-import-file').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      e.target.value = '';
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed.prompts)) await AU_STORAGE.savePrompts(parsed.prompts);
        if (Array.isArray(parsed.macros)) await AU_STORAGE.saveMacros(parsed.macros);
        renderPromptsAndMacros();
        toast('Biblioteca importada com sucesso!');
      } catch (_) {
        toast('Arquivo JSON inválido.', true);
      }
    };
    reader.readAsText(f);
  };

  // --- 5. History, Folders & Export ---
  let cachedHistoryData = null;
  let historySearchTimer = null;

  async function renderHistorySection(useCachedList = false) {
    let folders;
    let chats;
    if (useCachedList && cachedHistoryData) {
      folders = cachedHistoryData.folders;
      chats = cachedHistoryData.chats;
    } else {
      [folders, chats] = await Promise.all([AU_STORAGE.getFolders(), AU_STORAGE.getSavedChats()]);
      cachedHistoryData = { folders, chats };
    }
    const filterSel = document.getElementById('hs-folder-filter');
    const prevVal = filterSel.value;
    filterSel.innerHTML =
      '<option value="">Todas as Pastas</option>' +
      folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    filterSel.value = prevVal;

    const q = document.getElementById('hs-search').value.trim().toLowerCase();
    const fld = filterSel.value;

    const filtered = chats.filter((c) => {
      if (fld && c.folderId !== fld) return false;
      if (!q) return true;
      const inTitle = (c.title || '').toLowerCase().includes(q);
      const inTags = (c.tags || []).join(' ').toLowerCase().includes(q);
      const inMsgs = (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
      return inTitle || inTags || inMsgs;
    });

    document.getElementById('hs-count').textContent = String(filtered.length);
    const listEl = document.getElementById('hs-list');

    if (!filtered.length) {
      listEl.innerHTML = '<div class="muted">Nenhuma conversa salva encontrada para este filtro.</div>';
      return;
    }

    listEl.innerHTML = filtered
      .map((c) => {
        const folderObj = folders.find((f) => f.id === c.folderId);
        const dt = new Date(c.updatedAt || Date.now()).toLocaleString('pt-BR');
        return `
          <div class="item-box hs-chat-item" data-id="${esc(c.id)}" style="cursor:pointer;${selectedChatId === c.id ? 'border-color:#10b981;' : ''}">
            <div class="item-top">
              <strong>${esc(c.title || 'Conversa Arena.ai')}</strong>
              <span class="badge">${esc((c.mode || 'chat').toUpperCase())}</span>
            </div>
            <div class="muted">
              ${folderObj ? `📁 ${esc(folderObj.name)} • ` : ''}${esc(dt)} • ${(c.messages || []).length} msgs • ${c.loopsCount || 0} loops
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.hs-chat-item').forEach((el) => {
      el.onclick = () => {
        selectedChatId = el.dataset.id;
        const chosen = chats.find((x) => x.id === selectedChatId);
        renderChatViewer(chosen, folders);
        renderHistorySection(true);
      };
    });
  }

  function renderChatViewer(chat, folders) {
    const box = document.getElementById('hs-viewer');
    if (!chat) {
      box.innerHTML = '<div class="muted">Conversa não encontrada.</div>';
      return;
    }

    box.innerHTML = `
      <div class="item-top">
        <div>
          <h2>${esc(chat.title)}</h2>
          <a href="${esc(chat.sessionUrl || 'https://arena.ai')}" target="_blank" class="muted" style="color:#34d399;">Abrir URL da sessão ↗</a>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:6px;">
          <button id="vw-md" class="btn btn-sm">⬇ Markdown</button>
          <button id="vw-exec" class="btn btn-sm">⬇ Resumo Exec. (.md)</button>
          <button id="vw-docx" class="btn btn-sm">⬇ Word (.docx)</button>
          <button id="vw-pdf" class="btn btn-sm">⬇ PDF / HTML</button>
          <button id="vw-json" class="btn btn-sm">⬇ JSON</button>
          <button id="vw-del" class="btn btn-sm btn-danger">Excluir</button>
        </div>
      </div>

      <div class="row">
        <select id="vw-folder" class="select" style="flex:1;">
          <option value="">Sem pasta</option>
          ${folders.map((f) => `<option value="${esc(f.id)}" ${chat.folderId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select>
        <input id="vw-tags" class="input" style="flex:1;" value="${esc((chat.tags || []).join(', '))}" placeholder="Tags..." />
        <button id="vw-save-meta" class="btn btn-sm btn-primary">Salvar Organização</button>
      </div>

      <div class="stack" style="max-height:390px;overflow-y:auto;margin-top:8px;">
        ${(chat.messages || [])
          .map(
            (m, idx) => `
            <div class="msg-preview">
              <strong style="color:${m.role === 'user' ? '#38bdf8' : '#34d399'};">${idx + 1}. ${m.role === 'user' ? 'Você' : 'Arena AI / Agent'}</strong>\n${esc(m.content)}
            </div>
          `
          )
          .join('')}
      </div>
    `;

    box.querySelector('#vw-md').onclick = () => {
      downloadFile('conversa-arena.md', AU_STORAGE.formatChatAsMarkdown(chat), 'text/markdown');
    };
    box.querySelector('#vw-exec').onclick = () => {
      const execMd =
        typeof AU_STORAGE.formatChatAsExecutiveSummary === 'function'
          ? AU_STORAGE.formatChatAsExecutiveSummary(chat)
          : AU_STORAGE.formatChatAsMarkdown(chat);
      downloadFile('resumo-executivo-arena.md', execMd, 'text/markdown');
    };
    box.querySelector('#vw-docx').onclick = () => {
      if (typeof AU_STORAGE.buildChatDocxBytes === 'function') {
        const bytes = AU_STORAGE.buildChatDocxBytes(chat);
        downloadFile(
          'conversa-arena.docx',
          bytes,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        toast('Documento Word OOXML (.docx) gerado e baixado!');
      }
    };
    box.querySelector('#vw-pdf').onclick = () => {
      const html = AU_STORAGE.formatChatAsHtml(chat);
      const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const w = window.open(blobUrl, '_blank', 'noopener');
      if (!w) {
        downloadFile('conversa-arena.html', html, 'text/html');
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    };
    box.querySelector('#vw-json').onclick = () => {
      downloadFile('conversa-arena.json', JSON.stringify(chat, null, 2), 'application/json');
    };
    box.querySelector('#vw-del').onclick = async () => {
      await AU_STORAGE.deleteSavedChat(chat.id);
      selectedChatId = null;
      box.innerHTML = '<div class="muted">Conversa excluída.</div>';
      renderHistorySection();
    };
    box.querySelector('#vw-save-meta').onclick = async () => {
      chat.folderId = box.querySelector('#vw-folder').value;
      chat.tags = box.querySelector('#vw-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
      await AU_STORAGE.upsertSavedChat(chat);
      renderHistorySection();
      toast('Pasta e tags atualizadas!');
    };
  }

  document.getElementById('hs-search').oninput = () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => renderHistorySection(true), 140);
  };
  document.getElementById('hs-folder-filter').onchange = () => renderHistorySection(true);
  document.getElementById('hs-add-folder').onclick = async () => {
    const inp = document.getElementById('hs-new-folder');
    const name = inp.value.trim();
    if (!name) return;
    const folders = await AU_STORAGE.getFolders();
    folders.push({ id: 'fld_' + Date.now(), name, color: '#10b981' });
    await AU_STORAGE.saveFolders(folders);
    inp.value = '';
    renderHistorySection();
    toast('Nova pasta criada!');
  };

  // --- 6. Analytics & Battle Mode ---
  async function renderAnalyticsSection() {
    const m = await AU_STORAGE.getMetrics();
    document.getElementById('an-loops').textContent = Number(m.totalAutoLoopsSent || 0).toLocaleString('pt-BR');
    document.getElementById('an-batches').textContent = Number(m.totalBatchesLaunched || 0).toLocaleString('pt-BR');
    document.getElementById('an-spawned').textContent = Number(m.totalAgentTabsSpawned || 0).toLocaleString('pt-BR');
    document.getElementById('an-stops').textContent = Number(m.totalTokenLimitStops || 0).toLocaleString('pt-BR');
    const thinkingRefEl = document.getElementById('an-thinking-refused');
    if (thinkingRefEl) {
      thinkingRefEl.textContent = Number(m.totalThinkingModelsRefused || 0).toLocaleString('pt-BR');
    }
    document.getElementById('an-tokens').textContent = '~' + Number(m.estimatedPromptTokens || 0).toLocaleString('pt-BR');

    const mins = Math.floor(Number(m.totalActiveRuntimeSec || 0) / 60);
    document.getElementById('an-runtime').textContent = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const collabRoomsEl = document.getElementById('an-collab-rooms');
    const collabMsgsEl = document.getElementById('an-collab-msgs');
    const ghCommitsEl = document.getElementById('an-gh-commits');
    const ghPrsEl = document.getElementById('an-gh-prs');
    const tempFilesEl = document.getElementById('an-temp-files');
    if (collabRoomsEl) collabRoomsEl.textContent = Number(m.totalCollabRoomsCreated || 0).toLocaleString('pt-BR');
    if (collabMsgsEl) collabMsgsEl.textContent = Number(m.totalCollabMessagesExchanged || 0).toLocaleString('pt-BR');
    if (ghCommitsEl) ghCommitsEl.textContent = Number(m.totalGithubCommitsPushed || 0).toLocaleString('pt-BR');
    if (ghPrsEl) ghPrsEl.textContent = Number(m.totalGithubPRsCreated || 0).toLocaleString('pt-BR');
    if (tempFilesEl) tempFilesEl.textContent = Number(m.totalTempFilesShared || 0).toLocaleString('pt-BR');

    const logsBox = document.getElementById('an-session-logs');
    const logs = m.sessionLogs || [];
    logsBox.innerHTML = logs.length
      ? logs
          .map((l) => {
            const dt = new Date(l.timestamp).toLocaleString('pt-BR');
            const badgeCls = l.eventType === 'token_stop' ? 'stopped' : 'active';
            return `
              <div class="item-box">
                <div class="item-top">
                  <strong>${esc(l.tabTitle)}</strong>
                  <span class="badge ${badgeCls}">${esc(l.eventType.toUpperCase())}</span>
                </div>
                <div class="muted">${esc(l.details || '')}</div>
                <div class="muted" style="font-size:11px;">${esc(dt)} • Loops acumulados na sessão: ${l.loopsCount || 0}</div>
              </div>
            `;
          })
          .join('')
      : '<div class="muted">Nenhum evento de execução Agent registrado ainda. Ative o Autopilot ou lance um lote Multi-Agent!</div>';

    const battleBox = document.getElementById('an-battle-summary');
    const notesObj = m.modelNotes || {};
    const modelEntries = Object.entries(notesObj);
    const votes = m.battleVotes || [];

    const modelsHtml = modelEntries.length
      ? modelEntries
          .map(
            ([name, info]) => `
            <div class="item-box">
              <div class="item-top">
                <strong>${esc(name)}</strong>
                <span class="badge active">V: ${info.wins || 0} | D: ${info.losses || 0} | E: ${info.ties || 0}</span>
              </div>
              <div class="muted">${esc(info.notes || 'Sem observações salvas.')}</div>
            </div>
          `
          )
          .join('')
      : '<div class="muted">Seus votos no Battle Mode e notas pessoais sobre modelos aparecerão aqui.</div>';

    const recentVotesHtml = votes.slice(0, 10)
      .map(
        (v) => `
        <div class="muted" style="padding:4px 0;border-bottom:1px solid #1e2330;">
          🗳️ <strong>${esc(v.winner)}</strong> (${esc(v.modelA)} vs ${esc(v.modelB)}) — ${new Date(v.timestamp).toLocaleDateString('pt-BR')}
        </div>
      `
      )
      .join('');

    battleBox.innerHTML = modelsHtml + (recentVotesHtml ? `<div style="margin-top:10px;">${recentVotesHtml}</div>` : '');
  }

  document.getElementById('an-save-note').onclick = async () => {
    const model = document.getElementById('an-model-name').value.trim();
    const note = document.getElementById('an-model-note').value.trim();
    if (!model) return;
    await AU_STORAGE.updateMetrics((m) => {
      m.modelNotes = m.modelNotes || {};
      m.modelNotes[model] = Object.assign({ wins: 0, losses: 0, ties: 0 }, m.modelNotes[model] || {}, { notes: note });
      return m;
    });
    document.getElementById('an-model-name').value = '';
    document.getElementById('an-model-note').value = '';
    renderAnalyticsSection();
    toast('Nota do modelo salva!');
  };

  document.getElementById('an-reset').onclick = async () => {
    await AU_STORAGE.updateMetrics(() => Object.assign({}, AU_DEFAULTS.DEFAULT_METRICS));
    renderAnalyticsSection();
    toast('Estatísticas zeradas.');
  };

  // --- 7. Visual & Full Backup ---
  async function renderVisualSection() {
    const s = await AU_STORAGE.getSettings();
    const grid = document.getElementById('vis-presets-grid');
    grid.innerHTML = Object.values(AU_DEFAULTS.PRESET_THEMES)
      .map(
        (t) => `
        <div class="theme-tile ${s.activeTheme === t.id ? 'active' : ''}" data-theme="${esc(t.id)}">
          <div class="swatches">
            ${t.swatches.map((c) => `<span class="swatch" style="background:${c}"></span>`).join('')}
          </div>
          <strong>${esc(t.name)}</strong>
          <span class="muted">${esc(t.subtitle)}</span>
        </div>
      `
      )
      .join('');

    grid.querySelectorAll('.theme-tile').forEach((tile) => {
      tile.onclick = async () => {
        await AU_STORAGE.saveSettings({ activeTheme: tile.dataset.theme });
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
        renderVisualSection();
        toast(`Tema "${tile.dataset.theme}" aplicado em todas as abas!`);
      };
    });

    document.getElementById('vs-zen').checked = Boolean(s.zenMode);
    document.getElementById('vs-toolbar').checked = Boolean(s.promptToolbarVisible);
    document.getElementById('vs-fab').checked = Boolean(s.fabVisible);
    document.getElementById('vs-slash').checked = Boolean(s.slashCommandsEnabled);
    document.getElementById('vs-width').value = s.chatWidthPercent || 0;
    document.getElementById('vs-fontsize').value = s.fontSizePx || 0;
    document.getElementById('vs-fontfamily').value = s.fontFamily || 'native';
  }

  document.getElementById('vs-save-layout').onclick = async () => {
    await AU_STORAGE.saveSettings({
      zenMode: document.getElementById('vs-zen').checked,
      promptToolbarVisible: document.getElementById('vs-toolbar').checked,
      fabVisible: document.getElementById('vs-fab').checked,
      slashCommandsEnabled: document.getElementById('vs-slash').checked,
      chatWidthPercent: Number(document.getElementById('vs-width').value || 0),
      fontSizePx: Number(document.getElementById('vs-fontsize').value || 0),
      fontFamily: document.getElementById('vs-fontfamily').value
    });
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
    toast('Layout e preferências visuais aplicados!');
  };

  document.getElementById('bk-export-all').onclick = async () => {
    const dump = await AU_STORAGE.exportAllData();
    downloadFile('arena-ultra-backup-completo.json', JSON.stringify(dump, null, 2), 'application/json');
    toast('Backup completo baixado (sem credenciais — SEC-03)!');
  };

  const bkExportDiagBtn = document.getElementById('bk-export-diag');
  if (bkExportDiagBtn) {
    bkExportDiagBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'AU_DIAGNOSTICS_EXPORT' }, (res) => {
        if (res && res.ok && res.report) {
          downloadFile(
            `arena-ultra-diagnostico-sanitizado-${Date.now()}.json`,
            JSON.stringify(res.report, null, 2),
            'application/json'
          );
          toast('🩺 Diagnóstico sanitizado exportado com zero credenciais!');
        } else {
          toast('Falha ao gerar diagnóstico sanitizado.', true);
        }
      });
    };
  }

  // --- v4.0 Kill Switch (PARAR TUDO), Global Search, Locale, Tour & Hub ---
  const triggerDashboardEmergencyStop = () => {
    chrome.runtime.sendMessage({ type: 'AU_EMERGENCY_STOP_ALL' }, (res) => {
      if (res && res.ok) {
        toast(`🛑 PARAR TUDO executado! ${res.stoppedRooms || 0} sala(s) e ${res.stoppedTabs || 0} aba(s) paradas.`);
        refreshMissionControl();
        refreshCollabSection(true);
      } else {
        toast('Falha ao executar PARAR TUDO.', true);
      }
    });
  };
  document.getElementById('side-emergency-stop')?.addEventListener('click', triggerDashboardEmergencyStop);
  document.getElementById('top-emergency-stop')?.addEventListener('click', triggerDashboardEmergencyStop);

  const runGlobalSearch = () => {
    const q = (document.getElementById('dash-global-search-input')?.value || '').trim();
    const box = document.getElementById('dash-global-search-results');
    if (!box) return;
    if (!q) {
      box.style.display = 'none';
      return;
    }
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_SEARCH', query: q }, (res) => {
      const results = (res && res.results) || [];
      box.style.display = 'block';
      box.innerHTML = `
        <div class="card-head">
          <h2>🔍 Resultados para "${esc(q)}" (${results.length})</h2>
          <button id="dash-close-search-btn" class="btn btn-sm">✕ Fechar</button>
        </div>
        ${
          results.length
            ? `<div class="stack">${results
                .slice(0, 20)
                .map(
                  (r) =>
                    `<div class="item-box"><strong>[${esc(r.kind || r.source || 'item')}] ${esc(r.title)}</strong><div class="muted" style="margin-top:4px;">${esc((r.snippet || '').slice(0, 220))}</div></div>`
                )
                .join('')}</div>`
            : '<div class="muted">Nenhum item encontrado.</div>'
        }
      `;
      box.querySelector('#dash-close-search-btn')?.addEventListener('click', () => {
        box.style.display = 'none';
      });
    });
  };
  document.getElementById('dash-global-search-btn')?.addEventListener('click', runGlobalSearch);
  document.getElementById('dash-global-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runGlobalSearch();
  });

  const localeSel = document.getElementById('dash-locale-select');
  if (localeSel) {
    localeSel.addEventListener('change', async () => {
      const loc = localeSel.value || 'pt-BR';
      await AU_STORAGE.saveSettings({ locale: loc });
      if (typeof AU_I18N !== 'undefined' && AU_I18N.setLocale) {
        AU_I18N.setLocale(loc);
        AU_I18N.applyI18nToDocument(document);
      }
      toast(`Idioma atualizado para ${loc}`);
    });
  }

  document.getElementById('top-tour-btn')?.addEventListener('click', async () => {
    await AU_STORAGE.saveSettings({ onboardingCompleted: true });
    toast('⚡ Autonomia v4.0: 1 autorização por tarefa, Cofre Zero-Token em storage.session, Isolamento de Salas ARENA-18 e Kill Switch PARAR TUDO!');
  });

  async function renderV4HubSection() {
    // 1. Scheduler (PROD-03)
    chrome.runtime.sendMessage({ type: 'AU_SCHEDULER_LIST' }, (res) => {
      const listEl = document.getElementById('sched-list');
      if (!listEl) return;
      const tasks = (res && (res.schedules || res.tasks)) || [];
      if (!tasks.length) {
        listEl.innerHTML = '<div class="muted">Nenhuma tarefa agendada no momento.</div>';
        return;
      }
      listEl.innerHTML = tasks
        .map(
          (t) => `
          <div class="item-box row" style="justify-content:space-between;">
            <div>
              <strong>⏰ ${esc(t.name)}</strong> <span class="badge">${esc(t.cronExpr || 'interval')}</span>
              <div class="muted" style="font-size:11px;margin-top:2px;">Próxima execução: ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('pt-BR') : 'Pausada'}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-del-sched="${esc(t.id)}">Excluir</button>
          </div>
        `
        )
        .join('');
      listEl.querySelectorAll('[data-del-sched]').forEach((b) => {
        b.onclick = () => {
          chrome.runtime.sendMessage({ type: 'AU_SCHEDULER_DELETE', id: b.dataset.delSched }, () => {
            renderV4HubSection();
          });
        };
      });
    });

    // 2. Plugins (PROD-08)
    chrome.runtime.sendMessage({ type: 'AU_PLUGINS_LIST' }, (res) => {
      const plEl = document.getElementById('v4-plugins-list');
      if (!plEl) return;
      const plugins = (res && res.plugins) || [];
      plEl.innerHTML = plugins.length
        ? plugins
            .map(
              (p) => `
            <div class="item-box row" style="justify-content:space-between;">
              <div>
                <strong>🔌 ${esc(p.name)}</strong> <span class="badge">${esc(p.hook)}</span>
                <div class="muted" style="font-size:11px;">Ação declarativa: <code>${esc(p.action)}</code></div>
              </div>
              <input type="checkbox" ${p.enabled !== false ? 'checked' : ''} data-toggle-plugin="${esc(p.id)}" aria-label="Ativar plugin ${esc(p.name)}" />
            </div>
          `
            )
            .join('')
        : '<div class="muted">Nenhum plugin configurado.</div>';
      plEl.querySelectorAll('[data-toggle-plugin]').forEach((chk) => {
        chk.onchange = () => {
          const target = plugins.find((x) => x.id === chk.dataset.togglePlugin);
          if (!target) return;
          chrome.runtime.sendMessage(
            { type: 'AU_PLUGINS_UPSERT', plugin: { ...target, enabled: chk.checked } },
            () => toast('Plugin atualizado!')
          );
        };
      });
    });

    // 3. Security Audit Log (SEC-05)
    chrome.runtime.sendMessage({ type: 'AU_SECURITY_AUDIT_LOG_GET', limit: 40 }, (res) => {
      const auEl = document.getElementById('v4-audit-list');
      if (!auEl) return;
      const entries = (res && (res.entries || res.log)) || [];
      auEl.innerHTML = entries.length
        ? entries
            .slice()
            .reverse()
            .map(
              (e) => `
            <div class="item-box" style="font-size:11.5px;">
              <strong>${esc(e.event || e.action || 'API')}</strong> • <span class="muted">${new Date(e.ts || Date.now()).toLocaleString('pt-BR')}</span>
              <div class="muted">${esc(e.summary || e.endpoint || '')} ${e.status ? `(HTTP ${esc(e.status)})` : ''}</div>
            </div>
          `
            )
            .join('')
        : '<div class="muted">Nenhum evento de auditoria registrado nos últimos 30 dias.</div>';
    });
  }

  document.getElementById('sched-add-btn')?.addEventListener('click', () => {
    const name = (document.getElementById('sched-name')?.value || '').trim();
    const cronExpr = (document.getElementById('sched-cron')?.value || '0 9 * * *').trim();
    const prompt = (document.getElementById('sched-prompt')?.value || '').trim();
    const collabEnabled = Boolean(document.getElementById('sched-collab')?.checked);
    if (!name || !prompt) {
      toast('Preencha nome e prompt para criar o agendamento.', true);
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'AU_SCHEDULER_UPSERT',
        schedule: { name, cronExpr, prompt, collabEnabled, enabled: true }
      },
      (res) => {
        if (res && res.ok) {
          document.getElementById('sched-name').value = '';
          document.getElementById('sched-prompt').value = '';
          toast('⏰ Agendamento Cron registrado via chrome.alarms!');
          renderV4HubSection();
        } else {
          toast((res && res.error) || 'Expressão Cron inválida.', true);
        }
      }
    );
  });

  document.getElementById('mem-load-btn')?.addEventListener('click', () => {
    const repo = (document.getElementById('mem-repo-slug')?.value || '').trim();
    if (!repo) {
      toast('Informe owner/repo primeiro.', true);
      return;
    }
    chrome.runtime.sendMessage({ type: 'AU_CODEBASE_MEMORY_GET', repo }, (res) => {
      const m = res && res.memory;
      if (m) {
        document.getElementById('mem-arch').value = m.architectureSummary || m.architecture || '';
        document.getElementById('mem-conv').value = Array.isArray(m.conventions)
          ? m.conventions.join(', ')
          : m.conventions || '';
        toast(`🧠 Memória carregada para ${repo}!`);
      } else {
        toast('Nenhuma memória salva para este repositório ainda.');
      }
    });
  });

  document.getElementById('mem-save-btn')?.addEventListener('click', () => {
    const repo = (document.getElementById('mem-repo-slug')?.value || '').trim();
    const architecture = (document.getElementById('mem-arch')?.value || '').trim();
    const convRaw = (document.getElementById('mem-conv')?.value || '').trim();
    if (!repo) {
      toast('Informe owner/repo para salvar o briefing.', true);
      return;
    }
    const conventions = convRaw
      ? convRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    chrome.runtime.sendMessage(
      { type: 'AU_CODEBASE_MEMORY_SAVE', repo, patch: { architecture, conventions } },
      (res) => {
        if (res && res.ok) {
          toast(`💾 Briefing persistente salvo para ${repo}!`);
        }
      }
    );
  });

  document.getElementById('v4-refresh-audit-btn')?.addEventListener('click', renderV4HubSection);

  document.getElementById('bk-import-all').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      e.target.value = '';
      try {
        const data = JSON.parse(String(reader.result));
        await AU_STORAGE.importAllData(data);
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
        await loadAutoContinueSection();
        await populateLauncherMacros();
        await syncLauncherIntegrationDefaults();
        renderVisualSection();
        toast('Backup completo restaurado com sucesso!');
      } catch (err) {
        toast('Falha ao ler arquivo de backup.', true);
      }
    };
    reader.readAsText(file);
  };

  // --- Boot Dashboard ---
  (async function init() {
    await loadAutoContinueSection();
    await populateLauncherMacros();
    await syncLauncherIntegrationDefaults();
    if (currentSettings && localeSel) {
      localeSel.value = currentSettings.locale || 'pt-BR';
      if (typeof AU_I18N !== 'undefined' && AU_I18N.setLocale) {
        AU_I18N.setLocale(localeSel.value);
        AU_I18N.applyI18nToDocument(document);
      }
    }
    const initialSec = (location.hash || '').replace('#', '') || 'mission';
    switchSection(initialSec);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        lastMissionSignature = '';
        lastCollabSignature = '';
        const missionSec = document.getElementById('sec-mission');
        if (missionSec && missionSec.classList.contains('active')) {
          refreshMissionControl();
        }
        const collabSec = document.getElementById('sec-collab');
        if (collabSec && collabSec.classList.contains('active')) {
          refreshCollabSection(true);
        }
      }
    });
    setInterval(() => {
      if (document.hidden) return;
      const missionSec = document.getElementById('sec-mission');
      if (missionSec && missionSec.classList.contains('active')) {
        refreshMissionControl();
      }
      const collabSec = document.getElementById('sec-collab');
      if (collabSec && collabSec.classList.contains('active')) {
        refreshCollabSection(false);
      }
    }, 2000);
  })();
})();
