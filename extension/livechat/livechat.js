/* global AU_STORAGE */
(function () {
  'use strict';

  const AGENT_COLORS = ['#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6', '#10b981', '#f97316'];

  let selectedRoomId = new URLSearchParams(location.search).get('room') || '';
  let currentRoom = null;
  let activeFilter = 'all'; // 'all' | 'chat' | 'artifacts'
  let stickToBottom = true;

  // O(1) Incremental Feed State (never re-renders existing DOM nodes -> zero lag forever!)
  let renderedRoomId = '';
  const renderedMsgIds = new Set();
  let lastRosterSig = '';
  let lastRoomListSig = '';
  let lastArtifactsSig = '';
  let lastBoardSig = '';

  const feedEl = document.getElementById('chat-feed');
  const emptyEl = document.getElementById('empty-state');
  const jumpBtn = document.getElementById('btn-jump-bottom');
  const roomSelect = document.getElementById('room-select');
  const targetSelect = document.getElementById('target-agent-select');
  const liveInput = document.getElementById('live-input');
  const sendBtn = document.getElementById('btn-send-live');
  const statusEl = document.getElementById('send-status');

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBodyHtml(text) {
    return esc(text || '').replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  }

  function setStatus(txt, isError) {
    if (!statusEl) return;
    statusEl.textContent = txt;
    statusEl.style.color = isError ? '#fca5a5' : '#6ee7b7';
    setTimeout(() => {
      if (statusEl.textContent === txt) {
        statusEl.style.color = '';
      }
    }, 3500);
  }

  function pickAgentColor(senderName, tabId) {
    const m = String(senderName || '').match(/Agente\s*(\d+)/i);
    if (m && m[1]) {
      return AGENT_COLORS[(Number(m[1]) - 1) % AGENT_COLORS.length];
    }
    if (tabId) {
      return AGENT_COLORS[Math.abs(Number(tabId)) % AGENT_COLORS.length];
    }
    return '#06b6d4';
  }

  function isHiddenSystemMessage(msg) {
    if (!msg || typeof msg !== 'object') return true;
    const raw = String(msg.text || '').trim();
    if (!raw) return true;
    if (
      typeof AU_DEFAULTS !== 'undefined' &&
      AU_DEFAULTS &&
      typeof AU_DEFAULTS.isSystemOrAutoPromptText === 'function' &&
      AU_DEFAULTS.isSystemOrAutoPromptText(raw)
    ) {
      return true;
    }
    const isGithubEvent =
      msg.senderType === 'github' ||
      msg.senderType === 'github_radar' ||
      msg.senderName === 'GitHub Push' ||
      msg.senderName === 'GitHub' ||
      msg.senderName === 'Radar Git' ||
      msg.senderName === 'Integração Final';
    if (msg.senderType === 'system' && !isGithubEvent) {
      return true;
    }
    return false;
  }

  function matchesActiveFilter(msg) {
    if (activeFilter === 'all') return true;
    const txt = String(msg.text || '');
    const isArtifactMsg =
      msg.senderType === 'github' ||
      msg.senderType === 'github_radar' ||
      msg.senderName === 'GitHub' ||
      msg.senderName === 'GitHub Push' ||
      msg.senderName === 'Radar Git' ||
      msg.senderName === 'Integração Final' ||
      txt.includes('[ARQUIVO_COMPARTILHADO]') ||
      txt.includes('github.com/');
    if (activeFilter === 'artifacts') return isArtifactMsg;
    if (activeFilter === 'chat') {
      return msg.senderType === 'agent' || msg.senderType === 'user' || msg.senderType === 'external';
    }
    return true;
  }

  function applyFilterToExistingDom() {
    const items = feedEl.querySelectorAll('.msg-item');
    items.forEach((node) => {
      const sType = node.dataset.stype || 'agent';
      const isArt = node.dataset.art === '1';
      let show = true;
      if (activeFilter === 'chat') {
        show = sType === 'agent' || sType === 'user' || sType === 'external';
      } else if (activeFilter === 'artifacts') {
        show = isArt;
      }
      node.classList.toggle('hidden-by-filter', !show);
    });
  }

  function createMessageDomNode(msg) {
    const wrap = document.createElement('div');
    const sType = msg.senderType || 'agent';
    const rawTxt = String(msg.text || '');
    const isArt =
      sType === 'github' ||
      msg.senderName === 'GitHub' ||
      msg.senderName === 'GitHub Push' ||
      msg.senderName === 'Radar Git' ||
      msg.senderName === 'Integração Final' ||
      rawTxt.includes('[ARQUIVO_COMPARTILHADO]') ||
      rawTxt.includes('github.com/');

    wrap.className = `msg-item ${sType === 'user' ? 'is-user' : sType === 'system' || sType === 'github' ? 'is-system' : 'is-agent'}`;
    wrap.dataset.id = msg.id || String(msg.seq || Date.now());
    wrap.dataset.stype = sType;
    wrap.dataset.art = isArt ? '1' : '0';
    if (!matchesActiveFilter(msg)) {
      wrap.classList.add('hidden-by-filter');
    }

    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    if (sType === 'system' || sType === 'github') {
      wrap.innerHTML = `<div class="msg-system-pill">${esc(msg.senderName ? `[${msg.senderName}] ` : '')}${esc(rawTxt)} • <span style="opacity:0.7;">${timeStr}</span></div>`;
      return wrap;
    }

    const isLiveCli = String(msg.senderName || '').startsWith('⚡');
    const isUnverified = Boolean(msg.externalUnverified || sType === 'external');
    const cleanSender = String(msg.senderName || 'Agente').replace(/^[⚡⛔]\s*/, '');
    const borderColor = isUnverified ? '#f43f5e' : sType === 'user' ? '#10b981' : pickAgentColor(cleanSender, msg.tabId);

    wrap.innerHTML = `
      <div class="msg-bubble" style="${sType === 'agent' || isUnverified ? `border-left-color:${borderColor};` : ''}">
        <div class="msg-head">
          <div class="msg-sender">
            <span style="color:${isUnverified ? '#fda4af' : sType === 'user' ? '#6ee7b7' : borderColor};">${esc(sType === 'user' ? '👤 Você (Coordenador)' : cleanSender)}</span>
            ${isLiveCli && !isUnverified ? '<span class="live-tag" title="Mensagem autenticada HMAC enviada em tempo real via /tmp/au_chat">⚡ AO VIVO</span>' : ''}
            ${isUnverified ? '<span class="unverified-tag" title="Mensagem sem assinatura HMAC válida — comandos privilegiados bloqueados">⛔ Fonte externa não verificada</span>' : ''}
            ${msg.senderRole ? `<span class="role-tag">• ${esc(msg.senderRole)}</span>` : ''}
          </div>
          <div class="msg-time">
            <span>${timeStr}</span>
            <button class="copy-mini" title="Copiar mensagem">📋</button>
          </div>
        </div>
        <div class="msg-text">${formatBodyHtml(rawTxt)}</div>
      </div>
    `;

    const copyBtn = wrap.querySelector('.copy-mini');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(rawTxt).catch(() => {});
        copyBtn.textContent = '✓';
        setTimeout(() => {
          copyBtn.textContent = '📋';
        }, 1200);
      };
    }

    return wrap;
  }

  function resetFeedForRoom(roomId) {
    renderedRoomId = roomId || '';
    renderedMsgIds.clear();
    Array.from(feedEl.querySelectorAll('.msg-item')).forEach((el) => el.remove());
  }

  function appendMessagesIncrementally(messages) {
    const cleanInput = Array.isArray(messages) ? messages.filter((m) => !isHiddenSystemMessage(m)) : [];
    const existingCount = feedEl.querySelectorAll('.msg-item').length;
    if (cleanInput.length === 0 && existingCount === 0) {
      emptyEl.style.display = currentRoom ? 'none' : 'block';
      document.getElementById('cnt-all').textContent = '0';
      return;
    }
    emptyEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    let addedCount = 0;

    for (let i = 0; i < cleanInput.length; i++) {
      const m = cleanInput[i];
      const key = m.id || `seq_${m.seq}`;
      if (renderedMsgIds.has(key)) continue;
      renderedMsgIds.add(key);
      if (renderedMsgIds.size > 1500) {
        const oldestKey = renderedMsgIds.values().next().value;
        if (oldestKey !== undefined) renderedMsgIds.delete(oldestKey);
      }
      frag.appendChild(createMessageDomNode(m));
      addedCount += 1;
    }

    if (addedCount > 0) {
      feedEl.appendChild(frag);

      // Bound maximum rendered DOM nodes at 220 so Chat Live stays featherlight even after 24 hours!
      const allItems = feedEl.querySelectorAll('.msg-item');
      if (allItems.length > 220) {
        const excess = allItems.length - 220;
        for (let k = 0; k < excess; k++) {
          allItems[k].remove();
        }
      }

      if (stickToBottom) {
        feedEl.scrollTop = feedEl.scrollHeight;
        jumpBtn.style.display = 'none';
      } else {
        jumpBtn.style.display = 'block';
      }
    }
    document.getElementById('cnt-all').textContent = String(feedEl.querySelectorAll('.msg-item').length);
  }

  feedEl.addEventListener('scroll', () => {
    const distFromBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
    stickToBottom = distFromBottom < 75;
    if (stickToBottom) {
      jumpBtn.style.display = 'none';
    }
  });

  jumpBtn.onclick = () => {
    stickToBottom = true;
    feedEl.scrollTop = feedEl.scrollHeight;
    jumpBtn.style.display = 'none';
  };

  function renderSidebarAndHeader(rooms, room) {
    const rListSig = rooms.map((r) => `${r.roomId}:${r.status}:${(r.agents || []).length}`).join('|') + '||' + (room ? room.roomId : '');
    if (rListSig !== lastRoomListSig) {
      lastRoomListSig = rListSig;
      if (!rooms.length) {
        roomSelect.innerHTML = '<option value="">Nenhuma sala ativa — una abas abaixo</option>';
      } else {
        roomSelect.innerHTML = rooms
          .map(
            (r) =>
              `<option value="${esc(r.roomId)}" ${room && r.roomId === room.roomId ? 'selected' : ''}>Sala #${esc(r.roomId)} • ${(r.agents || []).length} Agents (${r.status === 'completed' ? 'Pronta' : 'Ao Vivo'})</option>`
          )
          .join('');
      }
    }

    const controlsBlock = document.getElementById('room-controls-block');
    const slaBar = document.getElementById('sla-status-bar');
    const needsHumanBar = document.getElementById('needs-human-bar');
    if (!room) {
      controlsBlock.style.display = 'none';
      if (slaBar) slaBar.style.display = 'none';
      if (needsHumanBar) needsHumanBar.style.display = 'none';
      document.getElementById('agents-count').textContent = '0';
      document.getElementById('agents-roster').innerHTML =
        '<div class="empty-hint">Clique em "🔗 Unir Abas Abertas" acima para conectar suas abas do Arena.ai no Chat Live!</div>';
      document.getElementById('stage-title').textContent = '⚡ Chat Live — Sala Multi-Agent';
      document.getElementById('stage-subtitle').textContent = 'Acompanhe os modelos conversando ao vivo e oriente a equipe em tempo real';
      targetSelect.innerHTML = '<option value="">📢 Para: Todos os Agents do Time</option>';
      return;
    }

    controlsBlock.style.display = 'block';
    document.getElementById('stage-title').textContent = `⚡ Chat Live • Sala #${room.roomId} • 👑 Epoch #${room.leaderEpoch || 1}${room.externalCode ? ` (tempchat.online #${room.externalCode})` : ''}`;
    document.getElementById('stage-subtitle').textContent = room.baseTask
      ? `Objetivo: ${room.baseTask.slice(0, 120)}`
      : 'Os modelos usam /tmp/au_chat (HMAC) e [TEMPCHAT] para conversar entre si e com você ao vivo';

    if (needsHumanBar) {
      if (room.status === 'needs_human') {
        needsHumanBar.style.display = 'flex';
        const nhReason = document.getElementById('needs-human-reason');
        if (nhReason) {
          nhReason.textContent = room.needsHumanReason || 'Orçamento ou condição excepcional requer sua decisão.';
        }
      } else {
        needsHumanBar.style.display = 'none';
      }
    }

    // Live Integration State, Consensus Matrix & Isolation Bar
    const integ = room.integrationStatus || null;
    if (slaBar && integ) {
      slaBar.style.display = 'flex';
      const stBadge = document.getElementById('sla-state-badge');
      stBadge.textContent = integ.stateLabel || 'Em andamento';
      stBadge.className = `sla-badge ${integ.isIntegrationReady ? 'ready' : integ.isTimedOut ? 'timeout' : ''}`;
      document.getElementById('sla-timer-text').textContent = `⏱️ Prazo: ${integ.remainingLabel || '--'}`;
      const cMatrix = room.consensusMatrix || {};
      const consTxt =
        cMatrix.approvedCount !== undefined
          ? ` • Consenso: ${cMatrix.approvedCount || 0}✓/${cMatrix.blockedCount || 0}⛔`
          : '';
      document.getElementById('sla-modules-text').textContent = `• Módulos: ${integ.readyCount}/${integ.expectedCount} (Rodada ${integ.currentRound}/${integ.maxRounds})${consTxt}`;
      const isoTxt = room.quarantinedCrossRoomCount
        ? ` • 🛡️ ${room.quarantinedCrossRoomCount} vazamento(s) bloqueado(s)`
        : '';
      document.getElementById('sla-dedup-text').textContent =
        (room.deduplicatedMessagesCount
          ? `• ✨ ${room.deduplicatedMessagesCount} duplicata(s) filtrada(s)`
          : '• 🛡️ Sala Isolada HMAC') + isoTxt;
      const ghCfg = room.githubConfig;
      document.getElementById('sla-vault-badge').textContent =
        ghCfg && ghCfg.enabled ? '• 🔐 Cofre Zero-Token (CAS Direto)' : '';
    }

    const harnessStatus = document.getElementById('harness-status');
    if (harnessStatus) {
      const gate = room.harness && room.harness.gate;
      harnessStatus.textContent = gate ? (gate.ok ? '🧰 VALIDADO*' : '🧰 CHECKPOINTS PENDENTES') : '';
      if (room.agentKitEnabled) {
        const peers = (room.agents || []).filter(a => !a.closed);
        const ready = peers.filter(a => a.agentKit && a.agentKit.compatible).length;
        harnessStatus.textContent += ` • KIT ${ready}/${peers.length}`;
      }
      harnessStatus.title = gate ? (gate.reasons || []).join('; ') + ' — evidências declaradas, não atestação remota' : '';
    }
    const statusPill = document.getElementById('room-status-pill');
    statusPill.textContent =
      room.status === 'completed'
        ? 'ENTREGA PRONTA'
        : room.status === 'needs_human'
          ? 'PRECISA DE VOCÊ'
          : room.status === 'paused'
            ? 'PAUSADA'
            : 'AO VIVO';
    statusPill.className = `status-pill ${
      room.status === 'completed'
        ? 'completed'
        : room.status === 'needs_human'
          ? 'needs-human'
          : room.status === 'active'
            ? 'active'
            : ''
    }`;

    const stopModeSel = document.getElementById('stop-mode-select');
    if (stopModeSel.value !== room.stopMode) {
      stopModeSel.value = room.stopMode || 'smart_consensus';
    }

    const noThinkBtn = document.getElementById('btn-nothink-toggle');
    const refuseOn = room.refuseThinkingModels !== false;
    noThinkBtn.textContent = `🚫 Sem Thinking: ${refuseOn ? 'ON' : 'OFF'}`;
    noThinkBtn.classList.toggle('nothink-active', refuseOn);

    const agents = room.agents || [];
    const admittedCount = agents.filter((a) => a.admittedToTeam !== false && !a.closed).length;
    document.getElementById('agents-count').textContent = `${admittedCount}/${agents.length}`;
    document.getElementById('refused-counter').textContent = room.thinkingRefusalsCount
      ? `🚫 ${room.thinkingRefusalsCount} recusado(s)`
      : '';

    const hasGh = Boolean(room.githubConfig && room.githubConfig.enabled);
    const rosterSig = agents
      .map(
        (a) =>
          `${a.tabId}:${a.name}:${a.liveStatus}:${a.autoContinueEnabled ? 1 : 0}:${a.loopsCount}:${a.admittedToTeam ? 1 : 0}:${a.screeningStatus}:${a.refusedCount}:${a.closed ? 1 : 0}:${a.githubAccessLevel || 'auto_role'}:${a.effectiveGithubAccess || ''}:${a.boardStatus || ''}:${hasGh ? 1 : 0}`
      )
      .join('|');

    if (rosterSig !== lastRosterSig) {
      lastRosterSig = rosterSig;
      const prevTarget = targetSelect.value;
      targetSelect.innerHTML =
        '<option value="">📢 Para: Todos os Agents do Time</option>' +
        agents
          .filter((a) => !a.closed)
          .map((a) => `<option value="${a.tabId}" ${String(a.tabId) === prevTarget ? 'selected' : ''}>🎯 Direto para: ${esc(a.name)} (${esc(a.roleTitle)})</option>`)
          .join('');

      const rosterEl = document.getElementById('agents-roster');
      rosterEl.innerHTML = agents
        .map((a, idx) => {
          const color = AGENT_COLORS[idx % AGENT_COLORS.length];
          const isRefused = a.screeningStatus === 'refused_stopped';
          const isScreening = !a.admittedToTeam && !isRefused;
          const statusLabel = a.closed
            ? 'Aba fechada'
            : isRefused
              ? '🚫 Thinking Recusado'
              : a.screeningStatus === 'rerolling'
                ? `🔄 Sorteando (#${a.refusedCount || 1})`
                : isScreening
                  ? '🔍 Triagem...'
                  : a.liveStatus === 'generating'
                    ? '🟢 Gerando ao vivo'
                    : a.waitingPeers
                      ? '⏳ Sincronizando'
                      : a.autoContinueEnabled
                        ? '🟢 No Time (Ativo)'
                        : '⚪ Pausado';

          const badgeCls = isRefused ? 'err' : isScreening ? 'warn' : a.autoContinueEnabled ? 'ok' : '';
          const curRbac = a.githubAccessLevel || 'auto_role';
          const rbacSelectHtml = hasGh
            ? `
              <select class="rbac-mini-select act-agent-rbac" data-tab="${a.tabId}" data-idx="${a.index ?? idx}" title="Gestão Centralizada de Acesso GitHub deste Agente (RBAC)">
                <option value="auto_role" ${curRbac === 'auto_role' ? 'selected' : ''}>🔐 RBAC: Auto (${esc(a.effectiveGithubAccess || 'auto')})</option>
                <option value="push_and_pr" ${curRbac === 'push_and_pr' ? 'selected' : ''}>🔓 Push + Abrir PR</option>
                <option value="push_branch" ${curRbac === 'push_branch' ? 'selected' : ''}>🌿 Só Push na Branch</option>
                <option value="read_only" ${curRbac === 'read_only' ? 'selected' : ''}>🔍 Somente Leitura</option>
                <option value="revoked" ${curRbac === 'revoked' ? 'selected' : ''}>🚫 Acesso Git Revogado</option>
              </select>
            `
            : '';

          return `
            <div class="agent-card ${isRefused ? 'refused' : isScreening ? 'screening' : ''}" style="border-left-color:${color};">
              <div class="agent-top">
                <span class="agent-name" title="${esc(a.name)}">${esc(a.name)}</span>
                <span class="mini-badge ${badgeCls}">${esc(statusLabel)}</span>
              </div>
              <div class="agent-role" title="${esc(a.roleTitle)}">${esc(a.roleTitle)} • ${Number(a.loopsCount || a.turnsCount || 0)} rodadas • [${esc(a.boardStatus || 'pendente')}]</div>
              ${rbacSelectHtml}
              <div class="agent-meta">
                <button class="btn btn-sm act-mention" data-tab="${a.tabId}" data-name="${esc(a.name)}">@ Falar</button>
                <div class="row-gap">
                  <button class="btn btn-sm act-toggle-ag" data-tab="${a.tabId}" data-on="${a.autoContinueEnabled ? '1' : '0'}" title="Pausar/Retomar este Agent">
                    ${a.autoContinueEnabled ? '⏸' : '▶'}
                  </button>
                  <button class="btn btn-sm act-focus-ag" data-tab="${a.tabId}" title="Ir para a aba deste Agent">↗ Aba</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      rosterEl.querySelectorAll('.act-agent-rbac').forEach((sel) => {
        sel.onchange = () => {
          chrome.runtime.sendMessage(
            {
              type: 'AU_COLLAB_SET_AGENT_ACCESS',
              roomId: room.roomId,
              tabId: Number(sel.dataset.tab),
              agentIndex: Number(sel.dataset.idx),
              accessLevel: sel.value
            },
            (res) => {
              if (res && res.room) {
                currentRoom = res.room;
                setStatus(`🔐 Permissão Git do Agente atualizada para "${sel.value}"!`, false);
                syncLiveState(false);
              }
            }
          );
        };
      });
      rosterEl.querySelectorAll('.act-mention').forEach((btn) => {
        btn.onclick = () => {
          targetSelect.value = btn.dataset.tab;
          liveInput.focus();
        };
      });
      rosterEl.querySelectorAll('.act-toggle-ag').forEach((btn) => {
        btn.onclick = () => {
          const wantOn = btn.dataset.on !== '1';
          chrome.runtime.sendMessage(
            {
              type: 'AU_CONTROL_TAB',
              tabId: Number(btn.dataset.tab),
              command: 'toggle_auto_continue',
              payload: { enable: wantOn, enabled: wantOn }
            },
            () => setTimeout(() => syncLiveState(false), 250)
          );
        };
      });
      rosterEl.querySelectorAll('.act-focus-ag').forEach((btn) => {
        btn.onclick = () => {
          chrome.runtime.sendMessage({
            type: 'AU_CONTROL_TAB',
            tabId: Number(btn.dataset.tab),
            command: 'focus'
          });
        };
      });
    }

    // v3.4.0 Shared Single-Update Assignments & Contracts Board
    const board = room.sharedBoard || { rev: 1, assignments: {}, contracts: {}, gitRefs: {} };
    const contractCount = Object.keys(board.contracts || {}).length;
    const cntContractsEl = document.getElementById('cnt-contracts');
    if (cntContractsEl) cntContractsEl.textContent = String(contractCount);
    const boardSig = `${room.roomId}:${board.rev || 1}:${contractCount}:${Object.keys((board.gitRefs && board.gitRefs.pulls) || {}).length}`;
    if (boardSig !== lastBoardSig) {
      lastBoardSig = boardSig;
      const revEl = document.getElementById('board-rev-badge');
      if (revEl) revEl.textContent = `rev #${board.rev || 1}`;
      const assignEl = document.getElementById('board-assignments-list');
      if (assignEl) {
        const assigns = Object.values(board.assignments || {});
        assignEl.innerHTML = assigns.length
          ? assigns
              .map(
                (a) => `
                <div class="board-row">
                  <div style="flex:1;min-width:0;">
                    <strong>${esc(a.agentName)}</strong> <span class="muted-tiny">(${esc(a.roleTitle)})</span>
                    ${a.branch ? `<div class="muted-tiny">🌿 <code>${esc(a.branch)}</code> ${a.files ? `• 📁 ${esc(a.files)}` : ''}</div>` : ''}
                    ${a.notes ? `<div class="muted-tiny">${esc(a.notes)}</div>` : ''}
                  </div>
                  <select class="select-input act-board-assign-st" data-slot="${esc(a.slotKey)}" style="width:140px;font-size:11.5px;padding:3px 6px;">
                    <option value="pendente" ${a.status === 'pendente' ? 'selected' : ''}>⏳ Pendente</option>
                    <option value="em_progresso" ${a.status === 'em_progresso' ? 'selected' : ''}>🔵 Em progresso</option>
                    <option value="bloqueado" ${a.status === 'bloqueado' ? 'selected' : ''}>🟠 Bloqueado</option>
                    <option value="pronto_integracao" ${a.status === 'pronto_integracao' ? 'selected' : ''}>🟢 Pronto p/ Síntese</option>
                    <option value="concluido" ${a.status === 'concluido' ? 'selected' : ''}>✅ Concluído</option>
                  </select>
                </div>
              `
              )
              .join('')
          : '<div class="muted-tiny">Nenhuma atribuição registrada.</div>';

        assignEl.querySelectorAll('.act-board-assign-st').forEach((sel) => {
          sel.onchange = () => {
            chrome.runtime.sendMessage(
              {
                type: 'AU_COLLAB_UPSERT_BOARD_ITEM',
                roomId: room.roomId,
                itemType: 'assignment',
                slotKey: sel.dataset.slot,
                patch: { status: sel.value }
              },
              () => syncLiveState(false)
            );
          };
        });
      }

      const contractsEl = document.getElementById('board-contracts-list');
      if (contractsEl) {
        const contracts = Object.values(board.contracts || {});
        contractsEl.innerHTML = contracts.length
          ? contracts
              .map(
                (c) => `
                <div class="board-row">
                  <div style="flex:1;min-width:0;">
                    <strong><code>${esc(c.key)}</code></strong> <span class="mini-badge ok">v${c.version || 1} • ${esc(c.status)}</span>
                    <span class="muted-tiny">por ${esc(c.owner || 'Equipe')}</span>
                    <div style="margin-top:2px;">${esc(c.spec)}</div>
                  </div>
                  <div class="row-gap">
                    <button class="btn btn-sm act-edit-contract" data-key="${esc(c.key)}" data-spec="${esc(c.spec)}" data-st="${esc(c.status)}" title="Carregar chave para atualizar em lugar único">✏️</button>
                    <button class="btn btn-sm act-del-contract" data-key="${esc(c.key)}" title="Remover contrato">✕</button>
                  </div>
                </div>
              `
              )
              .join('')
          : '<div class="muted-tiny">Nenhum contrato registrado — crie acima ou via <code>/tmp/au_chat contract</code>.</div>';

        contractsEl.querySelectorAll('.act-edit-contract').forEach((btn) => {
          btn.onclick = () => {
            document.getElementById('contract-key-input').value = btn.dataset.key || '';
            document.getElementById('contract-spec-input').value = btn.dataset.spec || '';
            document.getElementById('contract-status-input').value = btn.dataset.st || 'congelado';
            document.getElementById('contract-spec-input').focus();
          };
        });
        contractsEl.querySelectorAll('.act-del-contract').forEach((btn) => {
          btn.onclick = () => {
            chrome.runtime.sendMessage(
              {
                type: 'AU_COLLAB_UPSERT_BOARD_ITEM',
                roomId: room.roomId,
                itemType: 'contract',
                key: btn.dataset.key,
                patch: { delete: true }
              },
              () => syncLiveState(false)
            );
          };
        });
      }

      const gitRefsEl = document.getElementById('board-gitrefs-list');
      if (gitRefsEl) {
        const pulls = Object.values((board.gitRefs && board.gitRefs.pulls) || {});
        const branches = Object.values((board.gitRefs && board.gitRefs.branches) || {});
        if (pulls.length || branches.length) {
          gitRefsEl.innerHTML =
            (pulls.length
              ? `<div>🔔 <strong>PRs no Radar:</strong> ${pulls
                  .map(
                    (p) =>
                      `<a href="${esc(/^https?:\/\//i.test(p.htmlUrl || '') ? p.htmlUrl : '#')}" target="_blank" rel="noopener">PR #${p.number} [${esc(p.merged ? 'MERGED' : p.state)}]</a>`
                  )
                  .join(' • ')}</div>`
              : '') +
            (branches.length
              ? `<div>🌿 <strong>Branches:</strong> ${branches
                  .slice(0, 10)
                  .map((b) => `<code>${esc(b.name)}</code>`)
                  .join(', ')}</div>`
              : '');
        } else {
          gitRefsEl.textContent = '';
        }
      }
    }

    // Update Artifacts & Final Deliverable only if changed
    const files = room.sharedFiles || [];
    const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '#');
    const gh = room.githubConfig || null;
    const artSig = `${files.length}:${room.finalDeliverable ? room.finalDeliverable.length : 0}:${gh ? `${gh.commitsPushed}:${gh.pullRequestUrl}` : ''}`;
    if (artSig !== lastArtifactsSig) {
      lastArtifactsSig = artSig;
      document.getElementById('files-count-badge').textContent = `${files.length} arquivo(s)`;
      const fList = document.getElementById('shared-files-list');
      const ghLine =
        gh && gh.enabled
          ? `<div>🐙 Repositório: <strong>${esc(gh.repo)}</strong> (${Number(gh.commitsPushed || 0)} commits)${gh.pullRequestUrl ? ` • <a href="${esc(safeUrl(gh.pullRequestUrl))}" target="_blank" rel="noopener">Abrir PR ↗</a>` : ''}</div>`
          : '';
      const fileLines = files
        .slice(-15)
        .reverse()
        .map(
          (f) =>
            `<div>📄 <a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.filename || 'arquivo')}</a> <span style="opacity:0.7;">(${esc(f.provider || 'Temp')} • por ${esc(f.uploadedBy || 'Agent')})</span></div>`
        )
        .join('');
      fList.innerHTML = ghLine + (fileLines || '<div>Nenhum arquivo enviado ainda.</div>');

      document.getElementById('final-deliverable-box').textContent =
        room.finalDeliverable || 'Aguardando o Líder Sintetizador publicar [ENTREGA_FINAL_PRONTA]...';
    }
  }

  let syncInFlight = false;
  let pendingSyncQueued = false;
  let pendingSyncForce = false;

  function syncLiveState(forceRoomReset = false) {
    if (document.hidden && !forceRoomReset) return;
    if (syncInFlight) {
      pendingSyncQueued = true;
      pendingSyncForce = pendingSyncForce || Boolean(forceRoomReset);
      return;
    }
    syncInFlight = true;
    chrome.runtime.sendMessage({ type: 'AU_COLLAB_GET_ROOMS' }, (res) => {
      syncInFlight = false;
      const rooms = res && Array.isArray(res.rooms) ? res.rooms : [];
      if (!rooms.length) {
        currentRoom = null;
        if (renderedRoomId !== '') resetFeedForRoom('');
        renderSidebarAndHeader([], null);
        appendMessagesIncrementally([]);
      } else {
        if (!selectedRoomId || !rooms.some((r) => r.roomId === selectedRoomId)) {
          selectedRoomId = rooms[0].roomId;
        }
        const room = rooms.find((r) => r.roomId === selectedRoomId) || rooms[0];
        currentRoom = room;

        if (forceRoomReset || renderedRoomId !== room.roomId) {
          resetFeedForRoom(room.roomId);
        }

        renderSidebarAndHeader(rooms, room);
        appendMessagesIncrementally(room.messages || []);
      }

      if (pendingSyncQueued) {
        const nextForce = pendingSyncForce;
        pendingSyncQueued = false;
        pendingSyncForce = false;
        syncLiveState(nextForce);
      }
    });
  }

  // Instant 0ms Push Listener from Service Worker whenever ANY Agent or Coordinator posts a message or updates the Board!
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'AU_LIVECHAT_ROOM_DELTA') return;
    if (!currentRoom) {
      syncLiveState(false);
      return;
    }
    const activeTargetRoomId = selectedRoomId || currentRoom.roomId;
    if (String(msg.roomId) === String(activeTargetRoomId) && String(msg.roomId) === String(currentRoom.roomId)) {
      if (msg.message) {
        appendMessagesIncrementally([msg.message]);
      } else {
        syncLiveState(false);
      }
    }
  });

  // Send Live Coordinator Message
  function sendCoordinatorLiveMessage() {
    if (!currentRoom) {
      setStatus('Crie ou una abas numa Sala antes de enviar!', true);
      return;
    }
    const text = (liveInput.value || '').trim();
    if (!text) return;

    const reqRoomId = currentRoom.roomId;
    const targetTabId = targetSelect.value ? Number(targetSelect.value) : null;
    const directPromptIfIdle = document.getElementById('chk-direct-idle').checked;

    sendBtn.disabled = true;
    liveInput.value = '';

    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_SEND_COORDINATOR_MSG',
        roomId: reqRoomId,
        text,
        targetTabId,
        wakeAgents: true,
        directPromptIfIdle
      },
      (res) => {
        sendBtn.disabled = false;
        liveInput.focus();
        if (res && res.ok && res.room) {
          if ((!selectedRoomId || selectedRoomId === reqRoomId) && (!currentRoom || currentRoom.roomId === reqRoomId)) {
            currentRoom = res.room;
            appendMessagesIncrementally(res.room.messages || []);
          }
          setStatus('⚡ Mensagem publicada ao vivo no terminal (/tmp/au_chat) e enviada aos Agents!', false);
        } else {
          if (!liveInput.value) liveInput.value = text;
          setStatus((res && res.error) || 'Falha ao enviar mensagem.', true);
        }
      }
    );
  }

  sendBtn.onclick = sendCoordinatorLiveMessage;
  liveInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendCoordinatorLiveMessage();
    }
  });

  document.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.onclick = () => {
      liveInput.value = chip.dataset.msg || '';
      liveInput.focus();
    };
  });

  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter || 'all';
      applyFilterToExistingDom();
    };
  });

  roomSelect.onchange = () => {
    selectedRoomId = roomSelect.value;
    syncLiveState(true);
  };

  // Unite Open Arena Tabs directly from Chat Live (SEC-02: never read PAT from storage.local; wipe input immediately!)
  const uniteBox = document.getElementById('unite-box');
  document.getElementById('btn-unite-open').onclick = async () => {
    uniteBox.style.display = uniteBox.style.display === 'none' ? 'block' : 'none';
    if (uniteBox.style.display === 'block') {
      if (typeof AU_STORAGE !== 'undefined' && AU_STORAGE.getSettings) {
        const st = await AU_STORAGE.getSettings().catch(() => null);
        const ghInp = document.getElementById('unite-gh-repo');
        const tokInp = document.getElementById('unite-gh-token');
        if (st && ghInp && !ghInp.value && st.githubDefaultRepo) ghInp.value = st.githubDefaultRepo;
        if (tokInp) {
          chrome.runtime.sendMessage({ type: 'AU_VAULT_GET_STATUS' }, (vs) => {
            if (vs && vs.hasToken) {
              tokInp.placeholder = '🔐 Token PAT ativo na sessão do Cofre (deixe vazio p/ reutilizar)';
            }
          });
        }
      }
      document.getElementById('unite-task').focus();
    }
  };
  document.getElementById('btn-cancel-unite').onclick = () => {
    uniteBox.style.display = 'none';
  };
  document.getElementById('btn-confirm-unite').onclick = async () => {
    const baseTask = (document.getElementById('unite-task').value || '').trim();
    const profile = document.getElementById('unite-profile').value || 'specialists';
    let githubRepo = (document.getElementById('unite-gh-repo')?.value || '').trim();
    const tokInpEl = document.getElementById('unite-gh-token');
    const inlinePat = (tokInpEl?.value || '').trim();
    if (tokInpEl) tokInpEl.value = '';
    if (inlinePat) {
      await new Promise((r) =>
        chrome.runtime.sendMessage({ type: 'AU_VAULT_SET_SECRET', githubToken: inlinePat }, () => r())
      );
    }
    const st =
      typeof AU_STORAGE !== 'undefined' && AU_STORAGE.getSettings
        ? await AU_STORAGE.getSettings().catch(() => null)
        : null;
    if (
      baseTask &&
      (!st || st.githubAutoDetectInPrompt !== false) &&
      typeof AU_INTEGRATIONS !== 'undefined' &&
      AU_INTEGRATIONS.extractGithubRepoFromText
    ) {
      const det = AU_INTEGRATIONS.extractGithubRepoFromText(baseTask);
      const isUntouchedDefault = !githubRepo || (st && githubRepo === (st.githubDefaultRepo || '').trim());
      if (det && isUntouchedDefault) {
        githubRepo = det.webUrl;
      }
    }
    const btn = document.getElementById('btn-confirm-unite');
    btn.disabled = true;
    btn.textContent = 'Conectando abas...';
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_CREATE_FROM_OPEN_TABS',
        options: {
          baseTask,
          profile,
          refuseThinkingModels: st ? st.refuseThinkingModels !== false : true,
          githubEnabled: Boolean(githubRepo),
          githubRepo
        }
      },
      (res) => {
        btn.disabled = false;
        btn.textContent = '⚡ Criar & Conectar Agora';
        if (res && res.ok && res.room) {
          uniteBox.style.display = 'none';
          selectedRoomId = res.room.roomId;
          setStatus(`🤝 Sala #${res.room.roomId} conectada com ${(res.room.agents || []).length} abas ao vivo!`, false);
          syncLiveState(true);
        } else {
          setStatus((res && res.error) || 'Abra pelo menos 1 aba em https://arena.ai/agent primeiro.', true);
        }
      }
    );
  };

  document.getElementById('btn-new-batch').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD', section: 'launcher' });
  };
  document.getElementById('btn-open-dashboard').onclick = () => {
    chrome.runtime.sendMessage({ type: 'AU_OPEN_DASHBOARD' });
  };

  document.getElementById('btn-nothink-toggle').onclick = async () => {
    if (!currentRoom) return;
    const nextVal = !(currentRoom.refuseThinkingModels !== false);
    await AU_STORAGE.saveSettings({ refuseThinkingModels: nextVal });
    chrome.runtime.sendMessage(
      {
        type: 'AU_COLLAB_SET_ROOM_STATE',
        roomId: currentRoom.roomId,
        refuseThinkingModels: nextVal
      },
      () => syncLiveState(false)
    );
  };

  document.getElementById('btn-sync-now').onclick = () => {
    if (!currentRoom) return;
    const reqRoomId = currentRoom.roomId;
    setStatus('Sincronizando barramento ao vivo...', false);
    chrome.runtime.sendMessage({ type: 'AU_TEMPFILE_SYNC_ROOM_BIN', roomId: reqRoomId }, (res) => {
      if (res && res.room && (!selectedRoomId || selectedRoomId === reqRoomId) && (!currentRoom || currentRoom.roomId === reqRoomId)) {
        currentRoom = res.room;
        appendMessagesIncrementally(res.room.messages || []);
      }
      setStatus(`Sincronizado (${(res && res.added) || 0} novas atualizações)!`, false);
    });
  };

  const btnTeamHuddle = document.getElementById('btn-team-huddle');
  if (btnTeamHuddle) {
    btnTeamHuddle.onclick = () => {
      if (!currentRoom) return;
      const total = Math.max(1, (currentRoom.agents || []).filter((a) => !a.closed).length || 2);
      const huddlePrompt =
        `@Todos [RODA DE ALINHAMENTO DO TIME UNIDO (${total} AGENTES)]: Parem qualquer trabalho duplicado! ` +
        `1) Rodem \`/tmp/au_chat sync\`; ` +
        `2) Conversem diretamente entre si (@Agente1..@Agente${total}) negociando quem faz exatamente cada parte; ` +
        `3) Registrem seus arquivos exclusivos sem sobreposição com \`/tmp/au_chat claim "<arquivos>" "<meu papel>"\` e contratos com \`/tmp/au_chat contract\`; ` +
        `4) Colaborem como UM ÚNICO TIME UNIDO (zero competição!) respondendo às dúvidas dos colegas em [TEMPCHAT]...[/TEMPCHAT]!`;
      setStatus('Convocando roda de alinhamento e divisão de papéis...', false);
      chrome.runtime.sendMessage(
        {
          type: 'AU_COLLAB_SEND_COORDINATOR_MSG',
          roomId: currentRoom.roomId,
          text: huddlePrompt,
          wakeAgents: true
        },
        (res) => {
          if (res && res.ok) {
            syncLiveState(false);
            setStatus('Roda de alinhamento enviada para toda a equipe!', false);
          } else {
            setStatus((res && res.error) || 'Falha ao enviar alinhamento.', true);
          }
        }
      );
    };
  }

  document.getElementById('stop-mode-select').onchange = (e) => {
    if (!currentRoom) return;
    chrome.runtime.sendMessage({
      type: 'AU_COLLAB_SET_ROOM_STATE',
      roomId: currentRoom.roomId,
      stopMode: e.target.value
    });
  };

  document.getElementById('btn-pause-room').onclick = () => {
    if (!currentRoom) return;
    chrome.runtime.sendMessage({ type: 'AU_COLLAB_SET_ROOM_STATE', roomId: currentRoom.roomId, status: 'paused' }, () => {
      (currentRoom.agents || []).forEach((a) => {
        if (!a.closed) {
          chrome.runtime.sendMessage({
            type: 'AU_CONTROL_TAB',
            tabId: a.tabId,
            command: 'toggle_auto_continue',
            payload: { enable: false, enabled: false }
          });
        }
      });
      setTimeout(() => syncLiveState(false), 300);
    });
  };

  document.getElementById('btn-resume-room').onclick = () => {
    if (!currentRoom) return;
    chrome.runtime.sendMessage({ type: 'AU_COLLAB_SET_ROOM_STATE', roomId: currentRoom.roomId, status: 'active' }, () => {
      (currentRoom.agents || []).forEach((a) => {
        if (!a.closed) {
          chrome.runtime.sendMessage({
            type: 'AU_CONTROL_TAB',
            tabId: a.tabId,
            command: 'toggle_auto_continue',
            payload: { enable: true, enabled: true }
          });
        }
      });
      setTimeout(() => syncLiveState(false), 300);
    });
  };

  document.getElementById('btn-ext-bridge').onclick = () => {
    if (!currentRoom) return;
    chrome.runtime.sendMessage({
      type: 'AU_COLLAB_SET_ROOM_STATE',
      roomId: currentRoom.roomId,
      openExternalBridge: true,
      focusExternalTab: true
    });
  };

  document.getElementById('btn-toggle-artifacts').onclick = () => {
    const d = document.getElementById('artifacts-drawer');
    d.style.display = d.style.display === 'none' ? 'block' : 'none';
  };

  function toggleBoardDrawer() {
    const d = document.getElementById('board-drawer');
    if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none';
  }
  const btnToggleBoard = document.getElementById('btn-toggle-board');
  if (btnToggleBoard) btnToggleBoard.onclick = toggleBoardDrawer;
  const btnHeaderBoard = document.getElementById('btn-header-board');
  if (btnHeaderBoard) btnHeaderBoard.onclick = toggleBoardDrawer;

  const btnSlaAdd = document.getElementById('btn-sla-add10');
  if (btnSlaAdd) {
    btnSlaAdd.onclick = () => {
      if (!currentRoom) return;
      chrome.runtime.sendMessage(
        {
          type: 'AU_COLLAB_SET_INTEGRATION_SLA',
          roomId: currentRoom.roomId,
          addMinutes: 10
        },
        (res) => {
          if (res && res.room) {
            currentRoom = res.room;
            setStatus('⏱️ +10 minutos adicionados ao prazo de integração final!', false);
            syncLiveState(false);
          }
        }
      );
    };
  }

  const btnSlaForce = document.getElementById('btn-sla-force-ready');
  if (btnSlaForce) {
    btnSlaForce.onclick = () => {
      if (!currentRoom) return;
      chrome.runtime.sendMessage(
        {
          type: 'AU_COLLAB_SET_INTEGRATION_SLA',
          roomId: currentRoom.roomId,
          forceReady: true
        },
        (res) => {
          if (res && res.room) {
            currentRoom = res.room;
            setStatus('🎯 Síntese Final liberada! Líder Sintetizador acionado.', false);
            syncLiveState(false);
          }
        }
      );
    };
  }

  const btnSaveContract = document.getElementById('btn-save-contract');
  if (btnSaveContract) {
    btnSaveContract.onclick = () => {
      if (!currentRoom) return;
      const key = (document.getElementById('contract-key-input').value || '').trim();
      const spec = (document.getElementById('contract-spec-input').value || '').trim();
      const status = document.getElementById('contract-status-input').value || 'congelado';
      if (!key || !spec) {
        setStatus('Informe a chave (ex: api/auth) e a especificação do contrato!', true);
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: 'AU_COLLAB_UPSERT_BOARD_ITEM',
          roomId: currentRoom.roomId,
          itemType: 'contract',
          key,
          patch: { spec, status }
        },
        (res) => {
          if (res && res.ok) {
            document.getElementById('contract-spec-input').value = '';
            setStatus(`📜 Contrato único "${key}" atualizado sem duplicatas!`, false);
            syncLiveState(false);
          }
        }
      );
    };
  }

  document.getElementById('btn-copy-final').onclick = () => {
    if (!currentRoom || !currentRoom.finalDeliverable) return;
    navigator.clipboard.writeText(currentRoom.finalDeliverable).catch(() => {});
    setStatus('Entrega Final copiada!', false);
  };

  document.getElementById('btn-copy-log').onclick = () => {
    if (!currentRoom) return;
    const dump = (currentRoom.messages || [])
      .filter((m) => !isHiddenSystemMessage(m))
      .map((m) => `[${new Date(m.timestamp).toLocaleTimeString('pt-BR')}] ${m.senderName}: ${m.text}`)
      .join('\n\n');
    navigator.clipboard.writeText(dump).catch(() => {});
    setStatus('Histórico do Chat Live copiado!', false);
  };

  // ARENA-11: Global 1-click "PARAR TUDO" Kill Switch in Chat Live
  const btnLiveKill = document.getElementById('btn-live-emergency-stop');
  if (btnLiveKill) {
    btnLiveKill.onclick = () => {
      btnLiveKill.disabled = true;
      chrome.runtime.sendMessage({ type: 'AU_EMERGENCY_STOP_ALL' }, (res) => {
        btnLiveKill.disabled = false;
        if (res && res.ok) {
          setStatus(
            `🛑 PARAR TUDO executado em ${res.elapsedMs || 0}ms (${res.stoppedTabs || 0} aba(s), ${res.pausedRooms || 0} sala(s)).`,
            false
          );
          syncLiveState(true);
        }
      });
    };
  }

  // ARENA-11: Authorize extra budget & resume from needs_human
  const btnAuthResume = document.getElementById('btn-authorize-resume');
  if (btnAuthResume) {
    btnAuthResume.onclick = () => {
      if (!currentRoom) return;
      const curMax = Number((currentRoom.taskPolicy && currentRoom.taskPolicy.maxRounds) || 25);
      chrome.runtime.sendMessage(
        {
          type: 'AU_AUTHORIZE_TASK_POLICY',
          roomId: currentRoom.roomId,
          policy: { maxRounds: curMax + 15 }
        },
        (res) => {
          if (res && res.ok) {
            setStatus('⚡ Política atualizada (+15 rodadas) e Sala retomada!', false);
            syncLiveState(true);
          }
        }
      );
    };
  }

  // PROD-01: Multi-Agent Unified Diff & File Conflict Matrix Drawer
  function toggleDiffDrawer() {
    const d = document.getElementById('diff-drawer');
    if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none';
  }
  const btnToggleDiff = document.getElementById('btn-toggle-diff');
  if (btnToggleDiff) btnToggleDiff.onclick = toggleDiffDrawer;
  const btnHeaderDiff = document.getElementById('btn-header-diff');
  if (btnHeaderDiff) btnHeaderDiff.onclick = toggleDiffDrawer;

  const btnRefreshDiff = document.getElementById('btn-refresh-diff');
  if (btnRefreshDiff) {
    btnRefreshDiff.onclick = () => {
      if (!currentRoom) return;
      btnRefreshDiff.disabled = true;
      btnRefreshDiff.textContent = '⏳ Exportando CAS...';
      chrome.runtime.sendMessage({ type: 'AU_COMPUTE_ROOM_DIFF', roomId: currentRoom.roomId }, (res) => {
        btnRefreshDiff.disabled = false;
        btnRefreshDiff.textContent = '🔄 Calcular Diff Agora';
        const listEl = document.getElementById('diff-summary-list');
        const hunksEl = document.getElementById('diff-hunks-box');
        const badgeEl = document.getElementById('diff-conflict-badge');
        if (!res || !res.ok || !res.diff) {
          if (listEl) listEl.textContent = (res && res.error) || 'Não foi possível extrair os Workspaces ainda.';
          return;
        }
        const df = res.diff;
        const files = df.files || [];
        if (badgeEl) {
          badgeEl.textContent = `${df.conflictsCount || 0} conflito(s) • ${files.length} arquivo(s)`;
        }
        if (!files.length) {
          if (listEl) listEl.textContent = 'Nenhum arquivo modificado detectado nos Workspaces dos Agents ainda.';
          if (hunksEl) hunksEl.textContent = 'Sem diferenças no momento.';
          return;
        }
        if (listEl) {
          listEl.innerHTML = files
            .map(
              (f, idx) => `
              <div class="file-row act-diff-file" data-idx="${idx}" style="cursor:pointer;${f.hasConflict ? 'border-color:#f43f5e;' : ''}">
                <div>
                  <strong>${f.hasConflict ? '⚠️ ' : '📄 '}${esc(f.path)}</strong>
                  <div class="muted-tiny">Autores: ${esc((f.touchedBy || []).join(', ') || 'Agente')}</div>
                </div>
                <span class="mini-badge ${f.hasConflict ? 'err' : 'ok'}">${f.hasConflict ? 'CONFLITO' : 'LIMPO'}</span>
              </div>`
            )
            .join('');
          const showIdx = (idx) => {
            const item = files[idx];
            if (item && hunksEl) {
              hunksEl.textContent = item.unifiedDiff || '(Sem diff textual ou arquivo binário)';
            }
          };
          showIdx(0);
          listEl.querySelectorAll('.act-diff-file').forEach((row) => {
            row.onclick = () => showIdx(Number(row.dataset.idx || 0));
          });
        }
      });
    };
  }

  // ENG-11: Deadlock Diagnostic & Auto-Unblock
  const btnDeadlock = document.getElementById('btn-deadlock-check');
  if (btnDeadlock) {
    btnDeadlock.onclick = () => {
      chrome.runtime.sendMessage({ type: 'AU_DEADLOCK_DIAGNOSE', autoResolve: true }, (res) => {
        if (!res || !res.ok) return;
        const hit = (res.reports || []).find((r) => currentRoom && r.roomId === currentRoom.roomId);
        if (hit && hit.deadlockDetected) {
          setStatus(`🩺 Espera circular detectada na Sala #${hit.roomId} — todos os agentes foram destravados!`, false);
          syncLiveState(true);
        } else {
          setStatus('🩺 Diagnóstico concluído: nenhum deadlock circular ativo nesta sala.', false);
        }
      });
    };
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncLiveState(false);
  });

  // Gentle 2.5s sync when tab is visible (0% work when hidden!)
  syncLiveState(true);
  setInterval(() => {
    if (!document.hidden) {
      syncLiveState(false);
    }
  }, 2500);
})();
