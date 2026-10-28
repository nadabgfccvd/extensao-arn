# v4.5.0 — Extensão normal + Agent Kit dedicado 1.0.0

- Integração opt-in com pacote Python público, versão fixada e SHA-256 validado antes de executar; sem curl|bash.
- Descritor de sessão protocol=1 com allowlist, sem PAT, compatível com o broker e os envelopes anteriores.
- Bootstrap compacto; papel/escopo e objetivo permanecem no prompt, fonte das ferramentas e manual ficam no kit.
- Handshake AU_AGENT_READY vinculado à sala/slot/epoch; Chat Live mostra capacidade declarada KIT x/N.
- Kit: guias sob demanda, tick (chat+timer+estado), inbox completo persistido/paginado, validação real e fingerprint para invalidar evidências após mudança no workspace.
- Aliases antigos preservados. Kit descarta chat sem HMAC válido e bloqueia upload externo com GitHub configurado.
- Modo nativo preservado e padrão, até publicar o pacote no GitHub informado. Não há publicação remota automática nesta entrega.
- A37–A39: 31/31 subtestes da extensão; 8/8 testes Python do kit; smoke do zipapp.
- Medição de fixture com 5 agentes e GitHub: 53.133 → 2.245 caracteres (95,77%); não é benchmark de tokens ou qualidade.
- Pesquisa adicional em AGENT_KIT_RESEARCH.md e roteiro em PUBLICAR_AGENT_KIT.md.

# v4.4.0 — Harness customizado por modo, memória e revisão cruzada

- Novo motor `shared/harness-engine.js` e ferramenta `shared/harness-cli.py`, sem dependências ou permissões novas.
- Políticas para fixo, fila, condicional, híbrido e três perfis colaborativos.
- Bootstrap inicial, retomada, critérios locais, checkpoints atômicos, execução real de validação e relatórios reduzidos.
- Identidade vinculada à sala/slot/epoch e rejeição de revisão própria/obsoleta.
- Gate adicional no service worker: conclusão colaborativa exige evidências declaradas e revisão cruzada, além dos gates de consenso existentes.
- Estado da sala persiste; salas antigas não recebem gate inesperado. Wrapper local persistido para recuperar /tmp.
- Avisos compactos de recuperação após rodadas sem relatório/estado novo; não faz replay automático de efeitos externos.
- Continuações colaborativas continuam limitadas a 2.000 caracteres, preservando timer. Envelope técnico não polui o chat.
- Dashboard permite habilitar para novas sessões; Chat Live mostra estado do gate.
- Pesquisa e limites documentados em HARNESS_RESEARCH.md; comandos em HARNESS_GUIDE.md.
- A33–A36 adicionados; 28/28 subtestes passando. Sem homologação em navegador real autenticado nesta entrega.

IMPORTANTE: resultados locais são enviados pelo modelo e classificados como `agent_reported`; não constituem atestação criptográfica nem cobertura comprovada de todos os requisitos. O harness não intercepta todas as ferramentas internas do Arena.

# v4.3.1 — Espaçamento entre mensagens de agentes

- Publicação central das mensagens dos agentes em FIFO por sala, com espera aleatória de 300–750 ms por mensagem.
- Coordenador humano ignora a fila e publica imediatamente; eventos de sistema não recebem atraso artificial.
- CLI dos agentes aplica jitter de 300–750 ms antes de enviar ao transporte externo. Como os workspaces são independentes, esse jitter reduz colisões, mas a ordenação garantida é na fila central da extensão.
- Teste A32 valida intervalo, FIFO e prioridade humana sem usar esperas reais no teste.

# v4.3.0 — Menções por nome e notificações da sala

- `@[Nome exato do agente]`, `@Nome exato do agente`, `@AgenteN` e `@Todos` reconhecidos; colchetes recomendados para nomes com espaços.
- `/tmp/au_chat ask` e `reply` aceitam esses nomes. Mensagens continuam públicas na sala; não são DMs privadas.
- `/tmp/au_chat inbox` / `notifications`, `sync` e `wait` mostram 🔔 mensagens novas e 🎯 menções diretas. Sem duplicar mensagens já lidas.
- Aviso visual nas abas admitidas da mesma sala, com checagem de bindingEpoch, deduplicação e limitação de frequência. Não injeta prompt nem interrompe geração.
- Agentes aguardando colegas recebem sinal de despertar. Durante geração, o modelo toma conhecimento via ferramenta de chat (não pelo toast da interface).

# v4.2.0 — Continuações curtas e timer real

- Guia completo apenas no primeiro prompt. Continuações limitadas a 2.000 caracteres, sem repetir quadro, briefing, scripts ou instruções Git.
- Timer Python persistente por sala/agente: `start`, `check`, `pulse`; `start` preserva um ciclo ativo e só inicia outro após o anterior vencer.
- Padrão de 60 minutos; configuração `sessionMinTimerMinutes` aceita 120 para duas horas. Relógio real e CAN_FINISH explícito.
- Chat apresenta o tempo restante; ciclos curtos, sem espera de uma hora em um único comando.
- Segurança, botão parar, créditos e limites da plataforma sempre prevalecem. A extensão orienta o modelo; não controla os limites de duração do Arena.

# Changelog — Arena Ultra

Todas as alterações notáveis desta extensão seguem versionamento semântico (`SemVer` — `ENG-04`).

---

## [4.1.0] — 2026-10-28 (Protocolo de Time Unido Escalável `N` Agentes, Barreira de Sincronização & Zero Poluição)

### Colaboração Real de Time Unido para Qualquer Quantidade de Agentes (`2` a `60+` Agents)
- **Bug `#90` (`content/content.js`) — Captura Multi-Bloco Completa do Turno**: Em turnos com múltiplas chamadas de ferramenta (`bash`, `write_file`, `edit_file`, `present_file`), `getLastAssistantText(false, true)` antes retornava apenas o último fragmento `.prose` pós-ferramenta, perdendo blocos `[TEMPCHAT]...[/TEMPCHAT]`, `[CONTRATO_UNICO]` e `@menções` emitidos antes da última ferramenta. Agora agrega cronologicamente todos os blocos de prosa do turno atual após a última mensagem do usuário.
- **Bug `#91` (`background/service-worker.js`) — Barreira de Rodada Sincronizada (`Barrier-Sync`) + Despertar Instantâneo (`wakeWaitingPeersInRoom`)**: Corrigida a dessincronização em que o primeiro colega a terminar destravava os demais antes que os outros `N - 2` agentes concluíssem a mesma rodada (ou estourava timeout curto de `50s`). Na Rodada 1 (*Roda de Alinhamento & Divisão de Papéis*), todos aguardam os colegas ativos concluírem (até `165s`) e recebem wake-up instantâneo (`<200ms`) assim que o time fecha a rodada — garantindo que **100% dos agentes vejam 100% das propostas, contratos e papéis dos colegas juntos**.
- **Bug `#92` & `#93` (`shared/collab-engine.js`) — Fim da Poluição de Prompt & Código Bruto no Chat**:
  - Persistência de `/home/user/au_state/au_chat` na Rodada 1 e substituição da reinjeção repetitiva do script Python (~7.500 caracteres por turno) por um lembrete compacto de 6 linhas nas Rodadas 2+ (`compactReminderOnly`).
  - Sanitizador `sanitizeConciseTeamMessage` remove despejos de blocos de código longos do feed de conversa, mantendo mensagens enxutas, legíveis e focadas em coordenação.
  - Caixa prioritária **`🗣️ DIÁLOGO DIRETO COM VOCÊ (@Menções & Perguntas)`** e **`💬 CONVERSA RECENTE DO TIME`** movidas para o **topo absoluto** do prompt de cada rodada.
- **Protocolo de Time Unido, Auto-Organização & Radar de Sobreposição para Qualquer `N` (`2..60+` Agentes)**:
  - `buildTeamRoles(N, profile)` particiona dinamicamente trilhas complementares sem sobreposição para qualquer número de agentes (`Core & Domínio`, `Frontend & UX`, `Dados & Estado`, `APIs & Integrações`, `Segurança & Confiabilidade`, `Automação & Tooling`, `QA & Contratos` e `Líder Integrador`), com **Pacto Explícito Anti-Competição**.
  - Novos subcomandos `/tmp/au_chat claim`, `/tmp/au_chat ask`, `/tmp/au_chat reply` e `/tmp/au_chat sync`, detector automático de colisão de arquivos (`detectBoardFileOverlaps`), quórum proporcional antes de `[ENTREGA_FINAL_PRONTA]` e botão **`🤝 Alinhar & Dividir Papéis do Time`** em 1 clique no `Chat Live`.

---

## [4.0.0] — 2026-10-28 (Implementação Completa `SPEC.md` v2.3)

### Segurança & Fronteiras (`SEC-01`..`SEC-10`)
- **`SEC-01`**: Modo Zero-Token (`vault_broker_zero_token`) obrigatório por padrão; desativada interpolação legada de PAT em prompts + varredura ativa pré-envio (`scrubSecrets`) e módulo dedicado `shared/cred-broker.js`.
- **`SEC-02`**: Remoção completa de `githubToken` em texto claro de `chrome.storage.local`; persistência padrão em `chrome.storage.session` (RAM volátil) ou opcional cifrada em disco via **WebCrypto AES-256-GCM + PBKDF2 (100.000 iterações)**, `setAccessLevel('TRUSTED_CONTEXTS')` e botão de revelação temporária (10s).
- **`SEC-03`**: `exportAllData()` e `importAllData()` aplicam allowlist estrita de segredos (`secretsOmitted: true`, `schemaVersion: 4`), omitindo PATs e webhooks sensíveis.
- **`SEC-04` & `SEC-05`**: Recomendação de Fine-Grained PAT + link direto de revogação e log circular sanitizado de auditoria de API/escopo (`au_security_audit_log_v1`).
- **`SEC-06` & `ARENA-08`**: Proibido upload em texto claro (`PK`) de repositórios privados para hosts públicos; proxy direto CAS → GitHub API por padrão e cifragem AES-256-GCM (`AUE1`) com chave fora de banda quando aplicável.
- **`SEC-07`**: Handshake criptográfico por sessão + validação de `ev.source === window`, `ev.origin` na allowlist Arena, target `location.origin` e allowlist estrita de comandos entre `page-bridge.js` (MAIN) e `content.js` (ISOLATED).
- **`SEC-08`**: Assinatura e verificação **HMAC-SHA256** por sala em `/tmp/au_chat` + fallback multi-host e selo `⛔ Fonte externa não verificada` para mensagens não assinadas da ponte `tempchat.online`.
- **`SEC-09` & `SEC-10`**: Remoção de `"cookies"` e `"https://temp.sh/*"`, separação de `optional_host_permissions`, `minimum_chrome_version: "116"`, `CSP` explícita e `use_dynamic_url: true`.

### Integridade Git & Dados (`DATA-01`..`DATA-05`, `ARENA-14`, `ARENA-15`, `ARENA-17`, `ENG-05`)
- **`ARENA-15` & `DATA-01`**: Exportador Workspace CAS retorna `{ status: 'complete' | 'partial' | 'failed', omitted, filteredIgnored, counts }`; suporte a deleções (`sha: null`) e renomeações no Git Tree **exclusivamente** quando `status === 'complete'`.
- **`DATA-02`**: Preservação de permissões executáveis (`100755`) e symlinks (`120000`) na Git Trees API e em `/tmp/au_gh`.
- **`DATA-03` & `ARENA-14`**: `extractZipArchive` preserva diretórios aninhados legítimos (`src/build/`), reporta truncamento explícito (`status: 'partial'`) e manifesto `.au-manifest.json`.
- **`DATA-04`**: Detecção honesta de hosts não-GitHub (GitLab, Bitbucket, Gitea) bloqueando chamadas inválidas para `api.github.com`.
- **`DATA-05`**: Migração de GitHub Projects do endpoint REST depreciado para **GitHub Projects v2 (GraphQL)**.
- **`ENG-05` & `ARENA-17`**: Backoff exponencial com jitter em `ghRequest` (`429`, `5xx`, `403` secondary rate limit com `Retry-After`), distinção entre rate-limit e falta de escopo, e reconciliação por `operationId` antes de repetir escritas com timeout.

### Runtime Arena & Isolamento Multi-Sala (`ARENA-01`..`ARENA-18`, `M1`..`M5`)
- **`ARENA-01` & `ARENA-13`**: `/tmp/au_chat` paralelo (`ThreadPoolExecutor(8)`), deadline global de `12s`, paginação das últimas 50 mensagens, persistência incremental atômica (`flock` + `os.replace`) em `/home/user/au_state` e cursor durável `lastSeenSeq`.
- **`ARENA-02`**: Sanitização de blocos `<details>`, `<thought>` e elementos ocultos via clone DOM + `scrubReasoningBlocks` (zero vazamento de raciocínio interno).
- **`ARENA-03` & `ARENA-09`**: Novo `shared/arena-adapter.js` (§9.4) + interceptação de `pushState`/`replaceState`/`popstate` com isolamento completo de estado ao trocar de conversa na sidebar SPA.
- **`ARENA-04`**: Detector `findPendingHumanInteraction` para cards `ask_user`, `add_voice`, `generate_image` (`offer_options`) e conectores, pausando em `WAITING_USER` (`⏸ Aguardando Você`).
- **`ARENA-05` & `ARENA-12`**: Reeleição automática de Líder com `leaderEpoch` monotônico em caso de falha/limite + Matriz de Aceitação verificável (`Consenso N/N` vs `Decisão por Maioria`).
- **`ARENA-06` & `ARENA-07`**: Modo Zen cirúrgico preservando painéis de Workspace/Preview/Artifacts e injeção programática de anexos/imagens no Tiptap via `DataTransfer`.
- **`ARENA-11`**: **Política de Autorização de Tarefa** (execução 100% silenciosa dentro do escopo, pausa objetiva `needs_human` apenas em exceções reais) + Kill Switch global **`🛑 PARAR TUDO`** em 1 clique (`<2s`).
- **`ARENA-16`**: Fim do fallback silencioso de `chrome.storage.session` para `chrome.storage.local` em prompts/tokens voláteis.
- **`ARENA-18` & `M1`–`M5`**: Isolamento estrito entre salas com autoridade exclusiva no Service Worker (`tabId + bindingEpoch + chatId`), fim de auto-registro remoto, `filebinId` derivado com sal por sala, e migração segura de salas legadas com botão `"🔗 Re-vincular Abas"`.

### Produto, UX, Acessibilidade & Engenharia (`PROD-01`..`PROD-12`, `UX-01`..`UX-06`, `ENG-01`..`ENG-13`)
- **`PROD-01`**: Diff unificado (`shared/diff-engine.js`) entre Agents e rodadas + Matriz de Conflitos em tempo real no Chat Live e na Central.
- **`PROD-02` & `ENG-12`**: Índice global de busca cobrindo conversas, salas, contratos, snapshots de código, prompts e logs (`Ctrl/Cmd+K` dentro da Central).
- **`PROD-03`**: Agendador recorrente persistente via `chrome.alarms` (`shared/scheduler.js`) com catch-up pós-suspensão.
- **`PROD-04`, `PROD-05`, `PROD-07`, `PROD-08`, `PROD-11`, `PROD-12`**: Briefing incremental de codebase, Linha do Tempo c/ reabertura em 1 clique, Presets/Replay de Salas, Sistema de Hooks/Plugins isolado (`shared/plugin-runtime.js`), exportadores reais **OOXML `.docx`**, **Obsidian YAML `.md`** e **PDF `@page`**, e promoção em 1 clique de abas abertas para Sala.
- **`UX-01`..`UX-06` & `ENG-01`..`ENG-13`**: Internacionalização `pt-BR`/`en`/`es` (`shared/i18n.js`), semântica ARIA + `:focus-visible` + `prefers-reduced-motion` + tema Alto Contraste, Orçamento de Tokens por sessão, Log de Diagnóstico sanitizado, suíte automatizada `tests/` (`node --test`) cobrindo `A01`–`A24` e `.github/workflows/ci.yml`.

---

## [3.4.0] — 2026-10-28
- Quadro Compartilhado Único de Atribuições & Contratos (`[QUADRO_UNICO]`), Radar Git Automático, Mensagens Deduplicadas, Cofre Broker Git inicial, SLA de Integração Final, Inspetor de Escopo/Expiração PAT e RBAC por Agente.

## [3.0.0 – 3.3.2] — 2026-10
- Salas Colaborativas Multi-Agent em Tempo Real, Chat Live, Recusa Anti-Thinking com Portão de Admissão, Arquivamento Automático, Parse Completo de URLs GitHub e CLI `/tmp/au_gh` de 7 abas.
