/* global AU_I18N, AU_DEFAULTS, AU_STORAGE, AU_INTEGRATIONS */
(function () {
  'use strict';

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showFeedback(text, isError) {
    const el = document.getElementById('launch-feedback');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#fca5a5' : '#34d399';
  }

  async function renderThemes() {
    const settings = await AU_STORAGE.getSettings();
    if (typeof AU_I18N !== 'undefined' && settings.locale) {
      AU_I18N.setLocale(settings.locale);
      AU_I18N.applyI18nToDocument(document);
    }
    const box = document.getElementById('theme-pills');
    const presets = Object.values(AU_DEFAULTS.PRESET_THEMES);

    box.innerHTML = presets
      .map(
        (t) => `
        <button class="theme-pill ${settings.activeTheme === t.id ? 'active' : ''}" data-id="${esc(t.id)}" aria-pressed="${settings.activeTheme === t.id ? 'true' : 'false'}">
          ${esc(t.name.split(' ')[0])}
        </button>
      `
      )
      .join('');

    box.querySelectorAll('.theme-pill').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await AU_STORAGE.saveSettings({ activeTheme: btn.dataset.id });
        chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
        renderThemes();
      });
    });
  }

  let lastPopupSignature = '';

  function loadMissionControl() {
    if (document.hidden) return;
    chrome.runtime.sendMessage({ type: 'AU_GET_MISSION_CONTROL' }, (res) => {
      if (!res || !res.ok) return;
      const tabs = res.tabs || [];
      const metrics = res.metrics || {};
      const collabRooms = res.collabRooms || [];

      const activeLoops = tabs.filter((t) => t.autoContinueEnabled).length;
      document.getElementById('st-active-tabs').textContent = String(activeLoops);
      document.getElementById('st-total-loops').textContent = String(metrics.totalAutoLoopsSent || 0);
      document.getElementById('st-batches').textContent = String(metrics.totalBatchesLaunched || 0);

      const banner = document.getElementById('popup-collab-banner');
      if (banner) {
        if (collabRooms.length > 0) {
          const topRoom = collabRooms[0];
          const allAg = topRoom.agents || [];
          const admittedAg = allAg.filter((a) => a.admittedToTeam !== false && !a.closed).length;
          const intSt = topRoom.integrationStatus || {};
          const remMin = Math.max(0, Math.ceil(Number(intSt.remainingMs || 0) / 60000));
          banner.style.display = 'block';
          const statusTitle =
            topRoom.status === 'needs_human'
              ? '⏸ Precisa de Você'
              : intSt.label || (topRoom.status === 'completed' ? '✅ Entrega Pronta' : '🟢 Em Colaboração');
          document.getElementById('popup-collab-title').textContent = `🤝 Sala #${topRoom.roomId} (Epoch #${topRoom.leaderEpoch || 1}) • ${statusTitle}`;
          document.getElementById('popup-collab-sub').textContent = `${admittedAg}/${allAg.length} no Time • Prontos: ${intSt.readyCount || 0}/${intSt.totalActive || 0} • SLA: ${remMin}m • Dedup: ${topRoom.dedupDroppedCount || 0}`;
        } else {
          banner.style.display = 'none';
        }
      }

      const sig =
        tabs
          .map((t) => `${t.tabId}:${t.groupId || -1}:${t.autoContinueEnabled ? 1 : 0}:${t.status}:${t.loopsCount}:${t.title}:${t.collabRoomId || ''}`)
          .join('|') +
        '||' +
        collabRooms.map((r) => `${r.roomId}:${r.seq}:${r.status}:${r.leaderEpoch || 1}`).join(',');
      if (sig === lastPopupSignature) return;
      lastPopupSignature = sig;

      const listEl = document.getElementById('tabs-list');
      if (!tabs.length) {
        listEl.innerHTML = '<div class="empty">Nenhuma aba do Arena.ai aberta. Clique em "+ Agent" ou lance um lote abaixo!</div>';
        return;
      }

      listEl.innerHTML = tabs
        .map((t) => {
          const stopped = t.status === 'token_stopped';
          const isThinkingRefused =
            t.status === 'thinking_refused' ||
            (stopped && /Thinking|Thought|Pensando|Pensou|recusado/i.test(t.stopReason || ''));
          const captcha = t.status === 'captcha_waiting';
          const waitingUser = t.status === 'waiting_user' || t.status === 'needs_human';
          const statusClass =
            stopped || isThinkingRefused || captcha
              ? 'stopped'
              : waitingUser
                ? 'waiting'
                : t.autoContinueEnabled
                  ? 'active'
                  : '';
          const groupTag = typeof t.groupId === 'number' && t.groupId >= 0 ? ' • 🗂️ Grupo' : '';
          const collabTag = t.collabRoomId ? ` • 🤝 #${t.collabRoomId}` : '';
          const statusText = isThinkingRefused
            ? `🚫 Thinking Recusado${groupTag}${collabTag}`
            : stopped
              ? `⚠️ Sem Tokens (${t.loopsCount || 0} loops)${groupTag}${collabTag}`
              : captcha
                ? '🛡️ Marque "Não sou um robô" (Retoma sozinho)'
                : waitingUser
                  ? `⏸ Aguardando Você (${t.stopReason || 'interação pendente'})${collabTag}`
                  : t.autoContinueEnabled
                    ? `🟢 Autopilot Ativo • ${t.loopsCount || 0} loops${groupTag}${collabTag}`
                    : `⚪ Pausado • ${t.loopsCount || 0} loops${groupTag}${collabTag}`;

          const promoteBtnHtml = !t.collabRoomId
            ? `<button class="chip act-promote" data-id="${t.tabId}" title="Promover esta aba solo para Sala Multi-Agent (3 agentes)">🤝 Sala</button>`
            : '';

          return `
            <div class="tab-row" role="listitem">
              <div class="tab-info">
                <div class="tab-title" title="${esc(t.title)}">${esc(t.title || 'Arena.ai')}</div>
                <div class="tab-meta ${statusClass}">${esc(statusText)}</div>
              </div>
              <div class="mini-actions">
                ${promoteBtnHtml}
                <button class="chip act-toggle" data-id="${t.tabId}" data-on="${t.autoContinueEnabled ? '1' : '0'}" aria-label="${t.autoContinueEnabled ? 'Pausar aba' : 'Retomar aba'}">
                  ${t.autoContinueEnabled ? '⏸' : '▶'}
                </button>
                <button class="chip act-focus" data-id="${t.tabId}" aria-label="Ir para aba">Ir</button>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.act-toggle').forEach((btn) => {
        btn.onclick = () => {
          const enable = btn.dataset.on !== '1';
          chrome.runtime.sendMessage(
            {
              type: 'AU_CONTROL_TAB',
              tabId: Number(btn.dataset.id),
              command: 'toggle_auto_continue',
              payload: { enable }
            },
            () => setTimeout(loadMissionControl, 250)
          );
        };
      });

      listEl.querySelectorAll('.act-focus').forEach((btn) => {
        btn.onclick = () => {
          chrome.runtime.sendMessage({
            type: 'AU_CONTROL_TAB',
            tabId: Number(btn.dataset.id),
            command: 'focus'
          });
        };
      });

      listEl.querySelectorAll('.act-promote').forEach((btn) => {
        btn.onclick = () => {
          btn.disabled = true;
          btn.textContent = '...';
          chrome.runtime.sendMessage(
            {
              type: 'AU_PROMOTE_SINGLE_TO_ROOM',
              tabId: Number(btn.dataset.id),
              agentCount: 3
            },
            (res) => {
              if (res && res.ok && res.room) {
                showFeedback(`🤝 Aba promovida para Sala #${res.room.roomId}!`, false);
              } else {
                showFeedback((res && res.error) || 'Não foi possível promover a aba.', true);
              }
              setTimeout(loadMissionControl, 400);
            }
          );
        };
      });
    });
  }

  // ARENA-11: Global 1-click "PARAR TUDO" Kill Switch
  const emergencyStopBtn = document.getElementById('btn-emergency-stop');
  if (emergencyStopBtn) {
    emergencyStopBtn.addEventListener('click', () => {
      emergencyStopBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'AU_EMERGENCY_STOP_ALL' }, (res) => {
        emergencyStopBtn.disabled = false;
        if (res && res.ok) {
          showFeedback(
            `🛑 PARAR TUDO executado em ${res.elapsedMs || 0}ms (${res.stoppedTabs || 0} aba(s), ${res.pausedRooms || 0} sala(s)).`,
            false
          );
          lastPopupSignature = '';
          loadMissionControl();
        }
      });
    });
  }

  const openIntegrationsBtn = document.getElementById('btn-open-integrations');
  if (openIntegrationsBtn) {
    openIntegrationsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD', section: 'integrations' });
    });
  }

  document.getElementById('btn-new-agent').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://arena.ai/agent', active: true });
  });

  document.getElementById('btn-open-dashboard').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD' });
  });

  const openLiveChatBtn = document.getElementById('btn-open-livechat');
  if (openLiveChatBtn) {
    openLiveChatBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AU_OPEN_LIVECHAT' });
    });
  }

  const openCollabDashBtn = document.getElementById('btn-open-collab-dash');
  if (openCollabDashBtn) {
    openCollabDashBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AU_OPEN_LIVECHAT' });
    });
  }

  const quickCollabChk = document.getElementById('quick-collab');
  const quickCollabStop = document.getElementById('quick-collab-stop');
  if (quickCollabChk && quickCollabStop) {
    quickCollabChk.addEventListener('change', () => {
      quickCollabStop.style.display = quickCollabChk.checked ? 'inline-block' : 'none';
      if (quickCollabChk.checked) {
        document.getElementById('quick-autoloop').checked = true;
      }
    });
  }

  document.getElementById('btn-pause-all').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'pause_all' }, () => {
      setTimeout(loadMissionControl, 250);
    });
  });

  document.getElementById('btn-resume-all').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'resume_all' }, () => {
      setTimeout(loadMissionControl, 250);
    });
  });

  document.getElementById('btn-group-tabs').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AU_GROUP_ARENA_TABS' }, (res) => {
      showFeedback(res && res.ok ? 'Abas agrupadas com sucesso!' : 'Abra abas do Arena primeiro.', !(res && res.ok));
    });
  });

  document.getElementById('btn-split-tabs').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AU_SPLIT_ARENA_WINDOWS' }, (res) => {
      if (res && !res.ok) showFeedback(res.reason || 'Abra ao menos 2 abas.', true);
    });
  });

  document.getElementById('btn-quick-launch').addEventListener('click', async () => {
    const launchBtn = document.getElementById('btn-quick-launch');
    if (launchBtn.disabled) return;
    const count = Number(document.getElementById('quick-count').value || 3);
    const prompt = document.getElementById('quick-prompt').value.trim();
    const collabEnabled = Boolean(document.getElementById('quick-collab')?.checked);
    const collabStopMode = document.getElementById('quick-collab-stop')?.value || 'smart_consensus';
    const autoEnableLoop = collabEnabled ? true : document.getElementById('quick-autoloop').checked;

    if (!prompt) {
      showFeedback('Digite um prompt antes de lançar os Agents.', true);
      return;
    }

    const st = await AU_STORAGE.getSettings();
    const refuseThinkingModels = document.getElementById('quick-refuse-thinking')
      ? document.getElementById('quick-refuse-thinking').checked
      : st.refuseThinkingModels !== false;
    let githubEnabled = Boolean(document.getElementById('quick-github')?.checked);
    const rawBoxVal = (document.getElementById('quick-github-repo')?.value || '').trim();
    let githubRepoInput = githubEnabled ? rawBoxVal || (st.githubDefaultRepo || '').trim() : '';
    let detectedBaseBranch = '';
    if (
      st.githubAutoDetectInPrompt !== false &&
      typeof AU_INTEGRATIONS !== 'undefined' &&
      AU_INTEGRATIONS.extractGithubRepoFromText
    ) {
      const det = AU_INTEGRATIONS.extractGithubRepoFromText(prompt);
      const boxUntouchedDefault = !rawBoxVal || rawBoxVal === (st.githubDefaultRepo || '').trim();
      if (det && (!githubEnabled || !githubRepoInput || boxUntouchedDefault)) {
        githubRepoInput = det.webUrl;
        detectedBaseBranch = det.branchFromUrl || '';
        githubEnabled = true;
      }
    }
    if (!detectedBaseBranch && githubRepoInput && typeof AU_INTEGRATIONS !== 'undefined' && AU_INTEGRATIONS.parseGitRepoSpec) {
      const spec = AU_INTEGRATIONS.parseGitRepoSpec(githubRepoInput);
      if (spec && spec.branchFromUrl) detectedBaseBranch = spec.branchFromUrl;
    }
    const tempFilesEnabled = Boolean(document.getElementById('quick-tempfiles')?.checked);
    if (githubEnabled && !githubRepoInput) {
      showFeedback('Cole o link do repositório GitHub acima (ex.: https://github.com/usuario/projeto)!', true);
      const box = document.getElementById('quick-github-box');
      if (box) box.style.display = 'block';
      document.getElementById('quick-github-repo')?.focus();
      return;
    }

    const origLabel = launchBtn.textContent;
    launchBtn.disabled = true;
    launchBtn.textContent = '🚀 Lançando...';
    showFeedback('Autorizando política da tarefa e iniciando abas Agent...', false);

    chrome.runtime.sendMessage(
      {
        type: 'AU_LAUNCH_MULTI_AGENT',
        config: {
          launchMode: 'swarm',
          swarmCount: count,
          basePrompt: prompt,
          autoEnableLoop,
          autoGroup: true,
          refuseThinkingModels,
          collabEnabled,
          collabProfile: st.collabDefaultProfile || 'specialists',
          collabStopMode,
          collabIntegrationTimeoutMinutes: Number(st.collabIntegrationTimeoutMinutes || 25),
          collabMirrorExternal: Boolean(st.collabMirrorExternalTempChat),
          githubEnabled,
          githubRepo: githubRepoInput,
          githubBaseBranch: detectedBaseBranch || st.githubBaseBranch || 'main',
          githubAuthMode: AU_DEFAULTS.normalizeGithubAuthMode(st.githubAuthMode),
          githubBranchMode: st.githubBranchMode || 'branch_per_agent_pr',
          githubDefaultAgentAccessMode: st.githubDefaultAgentAccessMode || 'auto_role',
          tempFilesEnabled
        }
      },
      (res) => {
        launchBtn.disabled = false;
        launchBtn.textContent = origLabel;
        if (res && res.ok) {
          showFeedback(
            res.roomId
              ? `🤝 Sala TempChat #${res.roomId} autorizada e lançada com ${res.launchedCount} Agents!`
              : `${res.launchedCount} abas Agent autorizadas e criadas!`,
            false
          );
          document.getElementById('quick-prompt').value = '';
          setTimeout(loadMissionControl, 500);
        } else {
          showFeedback((res && res.error) || 'Falha ao lançar lote.', true);
        }
      }
    );
  });

  const refuseQuickChk = document.getElementById('quick-refuse-thinking');
  if (refuseQuickChk) {
    refuseQuickChk.addEventListener('change', async () => {
      await AU_STORAGE.saveSettings({ refuseThinkingModels: refuseQuickChk.checked });
      chrome.runtime.sendMessage({ type: 'AU_GLOBAL_TAB_ACTION', command: 'apply_settings' });
    });
  }

  const quickGhChk = document.getElementById('quick-github');
  const quickGhBox = document.getElementById('quick-github-box');
  if (quickGhChk && quickGhBox) {
    quickGhChk.addEventListener('change', () => {
      quickGhBox.style.display = quickGhChk.checked ? 'block' : 'none';
    });
  }

  // SEC-02: Query session vault status from Service Worker — NEVER read plaintext githubToken from storage.local!
  AU_STORAGE.getSettings().then((st) => {
    const ghLbl = document.getElementById('quick-github-lbl');
    const ghChk = document.getElementById('quick-github');
    const ghRepoInp = document.getElementById('quick-github-repo');
    const tfChk = document.getElementById('quick-tempfiles');
    if (refuseQuickChk) {
      refuseQuickChk.checked = st.refuseThinkingModels !== false;
    }
    if (ghRepoInp && st.githubDefaultRepo) {
      ghRepoInp.value = st.githubDefaultRepo;
    }
    if (ghLbl && st.githubDefaultRepo) {
      const shortRepo = st.githubDefaultRepo.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '');
      ghLbl.textContent = `🐙 ${shortRepo}`;
    }
    if (ghChk) {
      if (st.githubEnabledInCollab && st.githubDefaultRepo) {
        ghChk.checked = true;
        if (quickGhBox) quickGhBox.style.display = 'block';
      } else {
        ghChk.checked = false;
        if (quickGhBox) quickGhBox.style.display = 'none';
      }
    }
    if (tfChk) {
      tfChk.checked = st.tempFilesEnabledInCollab !== false;
    }

    const vaultBanner = document.getElementById('popup-vault-banner');
    const vaultTitle = document.getElementById('popup-vault-title');
    const vaultSub = document.getElementById('popup-vault-sub');
    if (vaultBanner) {
      chrome.runtime.sendMessage({ type: 'AU_VAULT_GET_STATUS' }, (vStat) => {
        if (!vStat || !vStat.ok) return;
        if (vStat.hasToken) {
          vaultBanner.style.display = 'block';
          chrome.runtime.sendMessage(
            { type: 'AU_GITHUB_INSPECT_TOKEN', repo: st.githubDefaultRepo || '' },
            (info) => {
              if (!info) return;
              if (info.ok && info.valid) {
                const vs = info.vaultSession || {};
                const exp = info.expiration || {};
                const scopesTxt = (info.scopes || []).length ? info.scopes.join(', ') : info.tokenTypeLabel || 'PAT';
                vaultTitle.textContent = `🔐 Cofre Sessão: @${info.login || 'Ativo'} (${exp.label || 'Válido'})`;
                vaultSub.textContent = `Escopos: ${scopesTxt}${vs.remainingMinutes != null ? ` • Sessão: ${vs.remainingMinutes}m` : ''}`;
              }
            }
          );
        } else if (vStat.hasEncryptedDiskVault) {
          vaultBanner.style.display = 'block';
          vaultTitle.style.color = '#fbbf24';
          vaultTitle.textContent = '🔒 Cofre Cifrado (AES-256-GCM) Bloqueado';
          vaultSub.textContent = 'Abra a Central → Cofre GitHub para destravar com sua senha.';
        }
      });
    }
  });

  const revokePopupBtn = document.getElementById('btn-popup-revoke-vault');
  if (revokePopupBtn) {
    revokePopupBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AU_GITHUB_REVOKE_VAULT' }, (res) => {
        if (res && res.ok) {
          const vaultTitle = document.getElementById('popup-vault-title');
          const vaultSub = document.getElementById('popup-vault-sub');
          if (vaultTitle) {
            vaultTitle.style.color = '#fda4af';
            vaultTitle.textContent = '🚫 Cofre GitHub Revogado';
          }
          if (vaultSub) vaultSub.textContent = 'Credencial de sessão removida e capacidades rotacionadas.';
          showFeedback('🚫 Cofre GitHub revogado com sucesso!', false);
        }
      });
    });
  }

  loadMissionControl();
  renderThemes();
  setInterval(loadMissionControl, 2500);
})();
