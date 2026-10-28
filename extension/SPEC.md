# SPEC.md — Arena Ultra Extension v3.3.1 → v4.0

> **Escopo deste documento:** inventário completo e acionável de **tudo que falta** na extensão Arena Ultra (`arena-ultra-extension.zip`, `manifest_version: 3`, `version: 3.3.1`), **com foco explícito no que NÃO é GitHub** — produto, UX, confiabilidade, segurança, acessibilidade, internacionalização, observabilidade, testes, release e integrações adjacentes.
>
> **Método:** auditoria estática dirigida dos 22.155 LOC / 27 arquivos do pacote (manifest, service worker, content scripts, shared engine, dashboard, popup, livechat, offscreen, tempchat-bridge) + leitura do guia `COMO_INSTALAR.md`. **Sem** execução em navegador, sem pen-test, sem verificação de serviços externos. Cada afirmação abaixo carrega **evidência `arquivo:linha`**.
>
> **Taxonomia de confiança (fechado, aceita pelo consensus da Sala #1685):**
> - `[FALHA CONFIRMADA]` — defeito reproduzível por leitura estática do código.
> - `[RISCO CONDICIONAL]` — fronteira de confiança fraca; explorabilidade depende de condição externa a validar em teste.
> - `[MELHORIA]` — capacidade ausente que agrega valor de produto; não é defeito.
>
> **Taxonomia de prioridade:** `P0` segurança/correção de dados · `P1` produto/UX ausente · `P2` engenharia/qualidade · `P3` opcional/roadmap.
>
> **Formato de cada item:** `ID · Título · [Confiança] · P? · Evidência → Impacto → Solução → Arquivos tocados → Esforço → Critério de aceite`.

---

## 0. Sumário executivo — o "textão" do que falta

A extensão Arena Ultra é **extremamente funcional em superfície**: 22 mil linhas entregam Mission Control, lançador multi-agente (swarm/lista/matriz), sala TempChat com 3 dinâmicas de equipe, Chat Live dedicado, ponte com `tempchat.online`, hub de 4 hosts de arquivos temporários, GitHub autônomo com CLI `/tmp/au_gh` injetada no terminal, anti-Thinking com re-roll, badge/notificações/som, 9 seções de dashboard, 4 temas visuais + Zen + widescreen, snapshots automáticos, exportação MD/PDF/JSON, backup/restauração e estatísticas/Battle Mode. **Nada disso precisa ser reescrito.**

### 0.0 A diretiva que governa este SPEC

> *"Quero que essa extensão funcione com o mínimo necessário de humano no loop — fiz ela para automatizar, não ficar decidindo várias coisas."* — Coordenador, 28/10/2026

Essa diretiva **não é um item de backlog; é o critério de aceitação de todo o resto**. Ela muda o desenho de três coisas:

1. **A autonomia permanece o padrão.** Nenhuma operação normal (enviar prompt, commitar, fazer push, abrir PR, fazer upload, comentar issue) passa a pedir confirmação. As regras condicionais `rule_auto_confirm` e `rule_auto_pr_github` (`shared/defaults.js`) já existem e continuam — o que falta é **delimitar** essa autonomia, não reduzi-la.
2. **O humano no loop vira uma única autorização por tarefa** (`ARENA-11`), com escopo, destinos, ações e limites explícitos — e depois **silêncio operacional**. Uma tarefa授權, o agente trabalha sozinho até terminar.
3. **A pausa humana é a exceção, e ela é rare:** só nos casos em que a máquina **não pode** decidir — CAPTCHA/desafio, credencial expirada ou revogada, destino fora do escopo autorizado, conflito real de merge, estado incerto do envio, risco de perda de dados e orçamento estourado. Nesses casos, o sistema **pausa e notifica com uma pergunta objetiva**, em vez de falhar ou travar.

> **Consequência prática:** os itens deste SPEC que sugerem "aprovação pontual" foram **rebaixados** para opt-in/informativo. O único controle que precisa estar sempre à mão é **"PARAR TUDO"** (1 clique no popup).

### 0.1 Onde está concentrado o que falta

O que falta está concentrado em **seis eixos**:

| Eixo | Diagnóstico | Itens |
|---|---|---|
| **1. Segredo do GitHub vaza para fora da extensão** | O PAT é gravado em **texto claro no prompt do agente**, no `askPass`, no backup JSON e no `storage.local` | SEC-01…SEC-05 |
| **2. Transitório frágil** | Upload de repo privado sem criptografia em host público; deleções de arquivo nunca commitadas; snapshot de 600 arquivos truncado | SEC-06, DATA-01, DATA-02 |
| **3. Confiança de fronteira por `postMessage` sem `origin`** | Bridge MAIN↔ISO e tempchat-bridge aceitam comandos por marcador, sem validar origem | SEC-07, SEC-08 |
| **4. Produto ausente (não-GitHub)** | Sem **diff unificado**, sem **busca global semântica**, sem **agenda/cron**, sem **recuperação de sessão**, sem **plugin**, sem **MCP**, sem **billing**, sem **i18n**, sem **a11y real**, sem **observabilidade** | PROD-01…PROD-16 |
| **5. Qualidade de engenharia** | **Zero testes**, zero CI, zero lint, zero changelog, zero telemetria de erro, sem `update_url`, sem onboarding, sem tratamento de `429`/`Retry-After` | ENG-01…ENG-13 |
| **6. O protocolo TempChat é frágil e o runtime do Arena é estado-mutável** | `au_chat` degrada em loop de timeout; monólogo interno vaza para o bucket; SPA não reseta estado; Autopilot atropela cards interativos; consenso trava se o líder cair; snapshot CAS truncado é tratado como completo; falta política de autorização que escope a autonomia | ARENA-01…ARENA-18 |
| **7. Salas não são isoladas entre si** | Um agente de uma sala publica e consome mensagens em outra; qualquer aba pode ser promovida a agente de sala arbitrária; o bucket compartilhado amplifica o cross-talk | **ARENA-18** |

> **Correção de contagem (v2.1):** `ENG-11` foi **removido** e absorvido por `ARENA-12` (mesmo escopo: protocolo de convergência verificável + matriz de aceitação). `ARENA-11` foi **promovido a P0** e reescrito como **Política de Autorização por Tarefa**, por ser o requisito central do produto.

**Contagem total: 74 itens catalogados** — **17 P0**, **25 P1**, **20 P2**, **12 P3** (4 detalhados em tabela + 8 no roadmap de §7).

> **Nota de contagem (v2.2):** o antigo `ARENA-10` foi **absorvido por `ARENA-17`** (resultado incerto é o mesmo defeito em dois escopos: envio ao Arena e escrita remota). `ENG-11` foi absorvido por `ARENA-12`. Os IDs absorvidos ficam vago de propósito, para preservar a rastreabilidade com as versões anteriores deste documento.

### 0.1 Bloco novo (v2.0) — o que a auditoria do runtime do Arena revelou

A v2.0 incorpora uma rodada de auditoria focada na **engenharia interna do protocolo TempChat e na compatibilidade real com o arena.ai**, autorizada explicitamente pelo Coordenador. Ela revelou **6 defeitos estruturais confirmados por leitura de código** que não são GitHub e que comprometem o coração do produto — a sala multi-agente:

| # | Defeito | Evidência | Consequência |
|---|---|---|---|
| **A** | `do_read()` do `/tmp/au_chat` faz `urlopen` **sequencial** com `timeout=10s` por arquivo e **só grava `SEEN` no final** | `shared/collab-engine.js:290-299` | Com acúmulo de mensagens ou host lento, o `bash` do Arena estoura o timeout de 30 s **sem persistir `SEEN`** → releitura infinita e **loop de timeout** (presenciado ao vivo nesta Sala #1685) |
| **B** | `getLastAssistantText()` usa `el.textContent` | `content/content.js:1406` | `textContent` inclui blocos `<details>`/reasoning **ocultos** → o **monólogo interno** do modelo entra na Sala e é publicado no bucket |
| **C** | **Zero** handlers de `pushState`/`replaceState`/`popstate`/`locationchange` | `content/content.js` (busca em todo o arquivo) | Navegação SPA (trocar de chat na sidebar) **não reseta o runtime** → `collabRoomId`, `githubRepo`, `githubBranch`, `promptQueue` e `loopsCount` **vazam do chat A para o chat B** |
| **D** | Só o **painel de revisão de tarefa** é detectado | `content/content.js:570-687` (`findTaskReviewPanel`) | `ask_user`, `add_voice`, `generate_image` (offer_options) e **Conectores** (Notion/Slack/GitHub) **não são detectados** → o Autopilot dispara "Continue" e **atropela a escolha humana** |
| **E** | Zen Mode aplica `aside { display:none !important }` **global** | `content/themes.js:33-40` | Esconde **painéis legítimos do Arena** (Workspace/Preview/Artifacts), não só a sidebar da extensão |
| **F** | Nenhum mecanismo de **eleição de líder** — apenas `isSynthesizer` estático | `background/service-worker.js` (só atribuição de papel) | Se a aba do sintetizador cair (`token_stopped`/`refused_stopped`), o modo `smart_consensus` **trava eternamente** sem líder |

Além disso, **zero injeção de anexos/imagens** (`DataTransfer`) no composer Tiptap, e o proxy zero-loop real do Arena (CAS `/api/chat/:id/workspace/latest`) **não é usado** — o código sobe o repo privado em texto puro ao Filebin.

> **Nota de rigor (aceita por todos os agentes):** em (B), (C) e (D), o **fato de código** está confirmado (uso de `textContent`, ausência de handler, ausência de detecção), mas o **impacto observável** precisa de reprodução E2E. O item descreve a falha de código como `[FALHA CONFIRMADA]` e o impacto como *a reproduzir* — conforme a matriz de homologação `A15–A18` (§6.3).

**Sequência de entrega recomendada (Sprints):**
- **Sprint 0 (P0, ~5 dias):** `ARENA-01…ARENA-08`, SEC-01…SEC-08, DATA-01, DATA-02 → elimina vazamento de credencial, corrupção de repositório, monólogo interno na Sala e travamento do consenso.
- **Sprint 1 (P1 Produto, ~5 dias):** PROD-01 (diff), PROD-02 (busca), PROD-05 (recuperação), PROD-08 (plugins), ENG-01 (testes) como rede de segurança.
- **Sprint 2 (P1 Produto, ~5 dias):** PROD-03 (agenda), PROD-04 (memória), PROD-11 (exportadores), PROD-12 (livechat→sala), i18n + a11y.
- **Sprint 3 (P2 Engenharia):** CI/CD, lint, changelog, telemetria local, documente o manifest, adapter de compatibilidade Arena.
- **Sprint 4 (P3 Roadmap):** MCP, billing/licença, sync entre perfis, WebRTC, providers extras.

---

## 1. Estado atual — o que JÁ existe (não redesenhar)

| Módulo | Arquivo | LOC | Responsabilidade |
|---|---|---|---|
| Manifest | `manifest.json` | 137 | MV3, 3 content scripts, 25 host_permissions |
| Service Worker | `background/service-worker.js` | 4301 | Estado de abas, loops, salas, GitHub, broadcast, anti-Thinking, badges |
| Content principal | `content/content.js` | 5916 | Toolbar, Drawer, TempChat UI, auto-continue, temas, atalhos `/` |
| Page Bridge (MAIN world) | `content/page-bridge.js` | 1810 | Intercepta `fetch`/XHR, observa 402/429, IPC cross-world |
| TempChat Bridge | `content/tempchat-bridge.js` | 336 | DOM→Content em `tempchat.online` |
| Collab Engine | `shared/collab-engine.js` | 1212 | Papéis de time, prompts de agente, CLI `/tmp/au_gh`, `/tmp/au_chat` |
| Integrations | `shared/integrations.js` | 1331 | GitHub REST (7 abas), hub 4 hosts, extração de repo |
| Storage | `shared/storage.js` | 595 | 6 chaves: settings/prompts/macros/folders/chats/metrics + export/import |
| Defaults | `shared/defaults.js` | 643 | Settings, regras condicionais, macros, prompts, 4 temas |
| Dashboard | `dashboard/*` | 913+2176+408 | Central em tela cheia, 9 seções |
| LiveChat | `livechat/*` | 196+716+697 | Guia dedicada, feed ao vivo, roster, artefatos |
| Popup | `popup/*` | 124+344+297 | Acesso rápido, Mission Control, lançamento rápido |
| Offscreen | `offscreen/*` | 38 | Documento offscreen + Web Worker de 1.8s (anti-congelamento) |

**Verificações de qualidade já aprovadas (não mexer):** `innerHTML` é usado 66× mas **sempre com `escapeHtml()`/`esc()`** (`content/content.js:3330`, `dashboard/dashboard.js:12`) — não há XSS de存储 confirmado; zero `eval()`/`new Function`; `scrubSecrets()` (`shared/integrations.js:7-18`) mascara PATs em 4 formatos; `content.js` usa Shadow DOM para isolar a UI do Arena.

---

## 2. P0 — Segurança e integridade de dados

### SEC-01 · PAT do GitHub exposto em texto claro no prompt do agente · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/collab-engine.js:725-760` — no modo `direct_agent_git`, o token é interpolado literalmente no prompt via `JSON.stringify(pat)` dentro do heredoc do `/tmp/au_git_askpass.sh`:
  ```
  'case "$1" in *Username*) echo "x-access-token" ;; *) echo ' + JSON.stringify(pat) + ' ;; esac',
  ```
- **Impacto:** o PAT viaja para o **provedor de LLM do Arena.ai**, para o histórico do chat, para o snapshot do workspace, para logs de `fetch`/proxy do navegador e para o `console` do agente. Um PAT `repo` concede escrita total em todos os repositórios privados do usuário. É o **único achado com severidade de comprometimento total de conta**.
- **Impacto (aclarado):** é uma **falha de confidencialidade confirmada por código**. Não se comprovou vazamento específico para terceiro — o dano é a exposição do segredo ao provedor de LLM, ao histórico e aos logs.
- **Solução (revisada — ver nota de viabilidade):** (a) **eliminar a interpolação do token no prompt**; o agente passa a receber **apenas** a referência a um *broker de credenciais* que vive **dentro da extensão**; (b) o broker aplica o header `Authorization` server-side, na chamada à API do GitHub — o token **nunca** sai do processo do navegador; (c) o canal entre o agente (no sandbox do Arena) e o broker é o **canal já existente** (`chrome.runtime` / a CLI `/tmp/au_gh` que já roda no sandbox) — **não** se propõe socket TCP/Unix no service worker (ver nota abaixo); (d) fallback compatível: materializar o `askPass` lendo de um **segredo opaco de sessão** (não do token em si), com permissão `600`; (e) marcar o campo `askPass` como segredo na spec de prompt e passar por `scrubSecrets()` **antes** do envio, não depois; (f) **migração**: desativar o modo inseguro legado e forçar **reautorização** com menor privilégio; orientar o usuário a **revogar/rotacionar** os tokens usados no modo antigo.
  > **⚠️ Nota de viabilidade (correção do Ag1, adotada):** um **service worker MV3 não cria servidor TCP/Unix**, e o `localhost` do container do sandbox é **distinto** do `localhost` do navegador. Portanto "broker em `127.0.0.1:<porta>`` **não funciona como descrito**. O broker só é viável se houver um **canal real** sandbox→extensão. **Pré-requisito:** protótipo que **prove** a conectividade e a correlação de requisições; se o protótipo falhar, o caminho honesto é o **proxy no navegador** (`extension_proxy_push`), já existente — com o token **nunca** indo ao prompt. **Não prometer zero-loop sem canal operacional comprovado.**
- **Arquivos tocados:** `shared/collab-engine.js`, `shared/integrations.js`, `background/service-worker.js` (novo módulo `shared/cred-broker.js`), `shared/defaults.js`, UI de configuração, documentação.
- **Esforço:** 2 dias **+ protótipo de conectividade** (sem prazo garantido — a estimativa depende do resultado do protótipo).
- **Critério de aceite:** com **token-sentinela sintético** (`TEST_SECRET_DO_NOT_USE_123456`), nenhum prompt, comando gerado, log, exportação, URL ou conteúdo de sala contém o valor; a migração mantém o modo inseguro **desligado**.

### SEC-02 · PAT persistido em texto claro em `chrome.storage.local` · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/defaults.js:453` (`githubToken: ''`) → `shared/storage.js:129-135` (`saveSettings` → `rawSet`) grava em `chrome.storage.local`; `dashboard/dashboard.js:999` reexibe o valor em `gh-token-input` e `:1117` grava de volta; `content/content.js:4258` também reexibe.
  > **Correção de precisão (do Ag1, adotada):** os campos em `dashboard/dashboard.html:228` e `:406` **são** `type="password"`. Isso **mascara a apresentação**, mas **não protege** o valor contra inspeção do perfil, armazenamento em disco ou exportação. O defeito é o **armazenamento em texto claro**, não o tipo do campo.
- **Impacto:** qualquer **backup/sync do perfil do Chrome**, inspeção do perfil do navegador, screenshot de tela, ou uso de uma máquina compartilhada expõe o PAT. `chrome.storage.local` **não é** um cofre criptográfico. Risco adicional: a **sincronização do perfil** pode levar o token a outros dispositivos sem que o usuário perceba.
- **Solução:** (a) mover o PAT para `chrome.storage.session` (memória do navegador, some ao fechar) como padrão, com "lembrar por sessão" opcional; (b) **nunca** persistir em `storage.local` — se o usuário optar por persistir, exigir **consentimento explícito** e cifrar com chave **derivada de senha do usuário** (WebCrypto AES-GCM), explicando que a chave vive no mesmo perfil e portanto **não** protege contra perfil comprometido; (c) **toggle de revelação** com timeout de 10 s e limpeza do clipboard; (d) `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` nas chaves sensíveis; (e) **auditoria de escopo**: o mesmo PAT serve para push e leitura — considerar escopos distintos.
- **Arquivos tocados:** `shared/storage.js`, `shared/defaults.js`, `dashboard/dashboard.html`, `dashboard/dashboard.js`, `content/content.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** `chrome.storage.local` nunca contém substruto `ghp_`/`github_pat_`; o campo da Central é `type="password"` com toggle.

### SEC-03 · `exportAllData()` vaza segredos no backup JSON · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/storage.js:513-537` retorna `settings` **integral**, e `settings` contém `githubToken` e `webhookUrl` (`shared/defaults.js:453,474`).
- **Impacto:** o botão "Backup Completo" grava um JSON com o PAT e a URL de webhook em texto claro no disco do usuário; o arquivo é自由的 compartilhado com suporte sem sanitização.
- **Solução:** `exportAllData()` deve passar por um **allowlist** de chaves exportáveis (`exportableSettingsKeys`), removendo `githubToken`, `webhookUrl` e qualquer segredo; exibir aviso "segredos omitidos" na UI; `importAllData()` deve **ignorar** chaves de segredo recebidas (aceitar apenas do storage de sessão).
- **Arquivos tocados:** `shared/storage.js`, `dashboard/dashboard.js`.
- **Esforço:** 0,5 dia.
- **Critério de aceite:** o JSON exportado não contém `githubToken`, `webhookUrl` nem strings casando com `/(ghp_|github_pat_)/`.

### SEC-04 · Ausência de aviso de escopo e de revogação do PAT · `[MELHORIA]` · P1
- **Evidência:** `shared/integrations.js:454` abre `https://github.com/settings/tokens/new?scopes=repo,workflow,project&description=...` — **escopos amplos** (`repo` = todos os repositórios privados), sem nenhum aviso na UI.
- **Impacto:** o usuário concede acesso global sem saber; um PAT vazado impacta toda a conta, não um repositório.
- **Solução:** (a) adicionar na Central um **checklist de consentimento** com o escopo exato que será concedido; (b) oferecer **Fine-Grained PAT** com escopo por repositório como opção recomendada; (c) botão "Validar token" já existente (`verifyToken`) casado com **aviso de revogação** (`gh auth revoke` / página de tokens) e **alerta de expiração**.
- **Arquivos tocados:** `dashboard/dashboard.html`, `dashboard/dashboard.js`, `shared/integrations.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** o fluxo de PAT exibe escopo, botão de revogação e link para a política de tokens antes de salvar.

### SEC-05 · Ausência de rotação/auditoria de uso de token · `[MELHORIA]` · P2
- **Evidência:** nenhuma referência a `Authorization` em log, nenhum contador de requisições por token, nenhum log de repositório acessado.
- **Impacto:** impossível detectar uso indevido; impossível auditar o que o agente fez com a credencial.
- **Solução:** log sanitizado de **operações de API** (endpoint + repo + timestamp, **sem** token) em um anel local `chrome.storage.local` com retenção de 30 dias, visível na aba "Segurança".
- **Arquivos tocados:** `shared/integrations.js`, `background/service-worker.js`, `dashboard/*`.
- **Esforço:** 1 dia.
- **Critério de aceite:** a Central lista as últimas 100 operações GitHub com timestamp, e o token nunca aparece no log.

### SEC-06 · Snapshot de repositório privado enviado sem criptografia a host público · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/collab-engine.js:685-696` (modo `extension_proxy_push`) instrui o agente a compactar `/home/user/repo` e enviar via `/tmp/au_upload` (Filebin/Litterbox/Uguu/x0.at) — **todos públicos e não autenticados**. `background/service-worker.js:868-890` (`stageRepoSnapshotForProxyIfNeeded`) faz o mesmo upload pelo service worker. Nenhuma criptografia em nenhum dos dois caminhos.
- **Impacto:** código-fonte privado de qualquer repositório fica **publicamente acessível por URL** em um bucket sem expiração (Filebin) ou com TTL de 1–72 h (Litterbox). combined com SEC-01, o PAT e o código circulam no mesmo ecossistema de terceiros.
- **Solução:** (a) **AES-256-GCM** sobre o ZIP antes do upload, com chave de 256 bits derivada via **PBKDF2/HKDF** de uma **senha do usuário** (nunca enviada ao mesmo host — exibida/confirmada no popup); (b) o download mostra "arquivo cifrado — informe a senha para decifrar localmente"; (c) **proibir por padrão** o upload de repositórios privados para hosts não confiáveis — exigir opt-in explícito por sala; (d) preferir `extension_proxy_push` (o token fica no navegador) sobre `direct_agent_git` sempre que o repo for privado.
- **Arquivos tocados:** `shared/collab-engine.js`, `shared/integrations.js`, `background/service-worker.js`, `content/content.js` (upload UI).
- **Esforço:** 2 dias.
- **Critério de aceite:** nenhum ZIP de repo privado sai para Filebin/Litterbox/Uguu/x0.at sem cifrar; o teste verifica magic bytes ≠ `PK` no host público.

### SEC-07 · `postMessage` cross-world sem validação de `origin`/`source` · `[RISCO CONDICIONAL]` · P0
- **Evidência:** `content/page-bridge.js:42-54` (`postToContentScript` usa target `'*'`) e o listener `content/page-bridge.js:1420-1436` aceita `msg.__au_ipc_v2__ && msg.dir === 'iso->main'` **sem** checar `ev.origin`, `ev.source` nem `ev.isTrusted`. O par simétrico está em `content/content.js:205-212`.
- **Impacto:** qualquer script rodando no contexto MAIN de `arena.ai` (inclusive de uma extensão de terceiro com acesso à aba, ou XSS no site) pode **forjar** `au-bridge-command` para a bridge — o que inclui injetar prompts no chat do Arena, disparar submit e forçar `Stop generating`. Explorabilidade depende de condição externa, por isso `[RISCO CONDICIONAL]`, mas a **falha de fronteira de confiança é confirmada** e o custo de corrigir é baixo.
- **Solução:** (a) **nonce aleatório por documento** gerado no MAIN world e handshake de 2 vias antes de aceitar qualquer comando; (b) validar `ev.origin` contra a origem efetiva da aba (`location.origin` + allowlist `arena.ai`, `*.arena.ai`, `lmarena.ai`); (c) validar `ev.source === window`; (d) **tipar cada comando** com lista de permissões (`submit_prompt`, `stop`, `archive`, `sleep`) — o `handleBridgeCommand` não deve aceitar ação arbitrária; (e) trocar o alvo `'*'` por `location.origin`.
- **Arquivos tocados:** `content/page-bridge.js`, `content/content.js`, `shared/defaults.js` (allowlist de origens).
- **Esforço:** 1,5 dia.
- **Critério de aceite:** um script injetado na página que envie `postMessage` com `__au_ipc_v2__` **sem nonce válido** é ignorado; teste automatizado cobre o caso.

### SEC-08 · `tempchat.online` bridge sem verificação de origem nem de conteúdo · `[RISCO CONDICIONAL]` · P0
- **Evidência:** `content/tempchat-bridge.js` lê a DOM do site e a reemite para a extensão; não há verificação de que a mensagem veio de um usuário legítimo da sala além da forma do DOM.
- **Impacto:** conteúdo de terceiro na página pode ser injetado como mensagem de agente no barramento interno e influence o time multi-agente (**prompt injection via sala**). Ag4 documentou que `/tmp/au_chat` é um **SPOF único no Filebin sem fallback nem assinatura HMAC**.
- **Solução:** (a) **HMAC-SHA256** de cada mensagem com chave derivada da sala, verificada na ponta receptora (integridade + autenticidade da origem dentro da sala); (b) fallback de transporte (Filebin → Litterbox → Uguu → x0.at) já usado no upload de arquivos, **reutilizado** para o chat; (c) **permit-list de comandos** no parser do `/tmp/au_chat` (o arquivo atual faz `sys.argv[1] == 'send'`); (d) marcação visual de mensagens externas no Chat Live (⛔ "fonte externa não verificada") para que o humano não confunda com mensagem de agente.
- **Arquivos tocados:** `content/tempchat-bridge.js`, `shared/collab-engine.js`, `background/service-worker.js`, `livechat/livechat.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** mensagem sem HMAC válido é rejeitada e rotulada; a queda do Filebin não interrompe a sala.

### SEC-09 · Permissões amplas não justificadas e sem `optional_host_permissions` · `[MELHORIA]` · P1
- **Evidência:** `manifest.json` declara `permissions: [..., "cookies"]` e **25** `host_permissions` incluindo `https://discord.com/api/webhooks/*`, `https://api.telegram.org/*`, `https://hooks.slack.com/*`, `https://*.filebin.net/*`, `https://x0.at/*`.
- **Impacto:** a extensão pode ler cookies de todos esses domínios e falar com todos eles; a flagship da Chrome Web Store ("read and change all your data on all websites") penaliza a distribuição. Nenhuma dessas permissões é solicitada condicionalmente.
- **Solução:** migrar webhooks de Slack/Discord/Telegram e hosts de arquivo para `optional_host_permissions` solicitados **no momento do uso** (`chrome.permissions.request`); remover `cookies` se não houver uso comprovado (não há uso no ZIP); declarar `optional_permissions: ["notifications", "clipboardWrite"]`.
- **Arquivos tocados:** `manifest.json`, `dashboard/dashboard.js`, `shared/integrations.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** o manifest base pede apenas `storage, unlimitedStorage, tabs, tabGroups, alarms, scripting, offscreen`; hosts externos são opcionais e solicitados no uso.

### SEC-10 · Ausência de CSP explícita e de `web_accessible_resources` mínimo · `[MELHORIA]` · P2
- **Evidência:** `manifest.json` não declara `content_security_policy` (o MV3 aplica um padrão, mas não endurecido) e expõe `content/page-bridge.js`, `dashboard/dashboard.html`, `icons/*` em `web_accessible_resources` sem `use_dynamic_url`.
- **Impacto:** hardening marginal; `use_dynamic_url` reduz a chance de fingerprinting do recurso.
- **Solução:** declarar `content_security_policy.extension_pages` com `script-src 'self'; object-src 'self'` e adicionar `use_dynamic_url: true` nos `web_accessible_resources`.
- **Arquivos tocados:** `manifest.json`.
- **Esforço:** 2 h.
- **Critério de aceite:** a extensão carrega sem erro de CSP e `chrome://extensions` mostra CSP customizada.

---

## 3. P0/P1 — Integridade de dados (GitHub-adjacente, mas com efeito destrutivo)

### DATA-01 · Arquivos deletados e renomeados **nunca** são commitados · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/integrations.js:1016-1046` — ao montar a tree, cada item é criado apenas para arquivos **enviados** (`path`, `mode: '100644'`, `sha` do blob) e a tree usa `base_tree` (`integrations.js:1042`) **sem** emitir entradas de exclusão. A API do GitHub só remove um path da tree quando o item traz `sha: null`.
- **Impacto:** **qualquer** arquivo removido no workspace permanece no repositório remoto. Em um fluxo de "extrair workspace → commitar", isso significa: segredos removidos do código (`.env` com credencial), código morto e arquivos gigantes **permanecem no histórico público do PR**. É corrupção silenciosa do repositório do usuário.
- **Solução:** (a) montar a lista completa de paths do repositório base (`GET /repos/{o}/{r}/git/trees/{base}?recursive=1`) e emitir `{ path, mode: '100644', type: 'blob', sha: null }` para cada path **ausente** no payload; (b) detectar renome com `similarity` da API de commits e emitir `status: 'renamed'`; (c) adicionar **modo `replaceEntireTree`** já existente no código (`opts.replaceEntireTree`) como padrão seguro para os fluxos de extração de workspace; (d) **validar pós-commit** que a tree resultante tem exatamente o conjunto de paths esperado.
- **Arquivos tocados:** `shared/integrations.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** teste que commita um arquivo e o apaga → o arquivo **desaparece** do repositório após o commit; teste de renome → histórico mostra `renamed`.

### DATA-02 · `mode` fixo em `100644` quebra executáveis e symlinks · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/integrations.js:1030` — `mode: '100644'` hardcoded para todo blob.
- **Impacto:** scripts com `chmod +x` (`scripts/*.sh`, `bin/*`, hooks) perdem o bit de execução ao serem commitados pela extensão → o PR quebra o CI. Symlinks viram arquivos de texto com o caminho literal.
- **Solução:** derivar o modo do filesystem (`fs.stat().mode` → `100755` para executável, `120000` para symlink com `content` = destino do link) e enviar `content` do symlink como blob do texto alvo.
- **Arquivos tocados:** `shared/integrations.js`, `shared/collab-engine.js` (CLI `au_gh` que gera os arquivos).
- **Esforço:** 1 dia.
- **Critério de aceite:** `scripts/build.sh` committado mantém `100755`; symlink preservado.

### DATA-03 · Extração de ZIP trunca silenciosamente em 600 arquivos e bloqueia pastas legítimas · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `shared/integrations.js:399` bloqueia subpastas `build`/`target` **em qualquer nível** e `:488` corta silenciosamente em 600 arquivos.
- **Impacto:** um projeto com `src/build/` legítimo perde essa pasta; projetos grandes perdem arquivos **sem aviso**, gerando PR incompleto epulando.
- **Solução:** (a) elevar o teto e reportar o corte explicitamente (`{ truncated: true, dropped: n }` exibido na Central e no commit); (b) bloquear `build`/`target` **apenas** na raiz ou após detecção de artefato (peso/heurística), não em qualquer nível; (c) adicionar **`.gitignore`-awareness**: usar as regras do próprio repo para decidir o que excluir.
- **Arquivos tocados:** `shared/integrations.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** o usuário vê um aviso quando há truncamento; `src/build/` é preservado.

### DATA-04 · `parseGitRepoSpec` aceita GitLab/Bitbucket/Gitea, mas o push é hardcoded `api.github.com` · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `shared/integrations.js:551` aceita provedores não-GitHub; `shared/integrations.js:631` (`ghRequest`) e toda a CLI `/tmp/au_gh` usam `https://api.github.com` fixo.
- **Impacto:** o usuário cola um link de GitLab, a extensão "aceita" e depois falha silenciosamente no push com erro confuso de autenticação. É uma **promessa quebrada** na UX.
- **Solução:** (a) criar uma **camada de abstração de forge** (`ForgeAdapter`) com implementações `github`, `gitlab`, `bitbucket`, `gitea` — ou, no mínimo, **detectar o host e emitir aviso explícito "host X não suportado; apenas GitHub"** e bloquear a ação; (b) o `ForgeAdapter` resolve base URL, modelo de branch, API de PR e modelo de token por provedor.
- **Arquivos tocados:** `shared/integrations.js`, `shared/collab-engine.js`, `dashboard/dashboard.js`.
- **Esforço:** 1 dia para o aviso honesto; 6 dias para 4 forges completas.
- **Critério de aceite:** link de GitLab produz aviso claro e não tenta push quebrado.

### DATA-05 · GitHub Projects v2 acessado por REST depreciado · `[FALHA CONFIRMADA]` · P2
- **Evidência:** `shared/collab-engine.js:~590` usa `/projects` (REST clássico, removido do GitHub em 2024-09-01) e `~490` — `/tmp/au_gh projects` chama a API REST.
- **Impacto:** o comando retorna erro 404/410 confuso; o recurso "Projects" announcementado no guia **não funciona**.
- **Solução:** migrar para **GraphQL** (`query { repository { projectsV2(first:20){ nodes { id title } } } }`) com fallback que exiba aviso claro se a API não estiver disponível no plano.
- **Arquivos tocados:** `shared/collab-engine.js` (CLI `au_gh`), `shared/integrations.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** `/tmp/au_gh projects` lista projetos ou mensagem explícita de depreciação.

---

## 4. P1 — Produto ausente (o coração do "não só GitHub")

### PROD-01 · **Diff unificado entre agents e entre rodadas** — a feature nº1 que falta · `[MELHORIA]` · P1
- **Evidência:** o Chat Live (`livechat/livechat.js`) e a Central mostram apenas **texto** das mensagens; `dashboard/dashboard.js:559-562` renderiza `esc(m.text)` num `<div>`. Não existe visualização de diferenças de código entre agentes.
- **Impacto:** em uma sala com 7 agentes, **não há como ver o que mudou** no workspace entre a entrega do Agente 1 e a do Agente 3, nem detectar contradição entre duas implementações. É exatamente o que um "relator de consenso" precisa — e é o que o GitHub faz, mas **sem GitHub não existe nada equivalente**.
- **Solução:** (a) painel **"Δ Diff da Sala"** na Central e no LiveChat; (b) para cada agente que entrega, capturar o snapshot do workspace e calcular diff **unificado** contra o snapshot anterior da sala (`diff` por arquivo, com hunk context); (c) **matriz de conflito**: quando dois agents editaram o mesmo arquivo, destacar o conflito em vermelho e abrir um painel de resolução lado a lado; (d) diff semântico opcional (resumo por bloco em vez de linha); (e) botão "Aplicar diff ao workspace da aba".
- **Arquivos tocados:** `dashboard/dashboard.html` + `dashboard/dashboard.js`, `livechat/livechat.html` + `livechat/livechat.js`, `background/service-worker.js` (orquestração), `shared/collab-engine.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** com 2 agents em uma sala, a Central mostra o diff unificado e destaca conflito no mesmo arquivo.

### PROD-02 · Busca global semântica em todo o conteúdo · `[MELHORIA]` · P1
- **Evidência:** `shared/storage.js` guarda `au_saved_chats_v1` e o dashboard tem "Busca Global" — mas a busca é **literal** (`includes`) sobre o texto salvo; não há busca no **conteúdo dos workspaces**, nem nos **logs de sessão**, nem nas **mensagens de sala**, nem indexação incremental.
- **Impacto:** em um workspace de 3.000 arquivos, recuperar uma decisão tomada há 2 horas é inviável. Falta o "buscar em tudo".
- **Solução:** (a) índice invertido local (`chrome.storage` + `IndexedDB` com worker dedicado) sobre: mensagens de sala, snapshots de workspace, logs de sessão, prompts/macros, PRs; (b) **busca por conteúdo de arquivo** comRespect a `.gitignore`; (c) **busca semântica local**: embeddings leves (ex.: `transformers.js`/MiniLM quantizado, ~20 MB) rodando no **offscreen worker** já existente, com fallback por keyword quando o modelo não está disponível; (d) filtros por tipo, data, agente, sala e status; (e) atalho `Ctrl/Cmd+K` **dentro da extensão** (não global — respeita a preferência documentada de não capturar teclas do navegador).
- **Arquivos tocados:** `shared/storage.js`, `dashboard/dashboard.html` + `.js`, `offscreen/offscreen-worker.js`, novo `shared/search-index.js`.
- **Esforço:** 4 dias (2,5 sem embeddings).
- **Critério de aceite:** digitar um termo encontra ocorrências em mensagens de sala, arquivos do workspace e logs, com highlight e salto à origem.

### PROD-03 · Agenda / automação recorrente (cron) · `[MELHORIA]` · P1
- **Evidência:** `manifest.json` declara `alarms`, mas não há UI nem lógica de agendamento — `alarms` é usado apenas para anti-throttle (`'au_anti_throttle_alarm'`, `background/service-worker.js`).
- **Impacto:** falta o caso de uso "todo dia às 8h, rode este lint nos meus 3 repositórios e me avise no Telegram".
- **Solução:** (a) aba "Agenda" na Central com **cron editor** (expressão de 5 campos), fuso horário, destino da notificação e **retry**; (b) tipos de tarefa: `lançar multi-agent`, `broadcast de prompt`, `snapshot de workspace`, `push/PR`, `relatório de CI`, `cleanup de salas antigas`; (c) **persistência via `chrome.alarms`** (nunca `setTimeout`); (d) **catch-up** de alarms perdidos após o navegador dormir (usar `when` em vez de `periodInMinutes`); (e) histórico de execuções com log e re-execução manual.
- **Arquivos tocados:** `manifest.json` (perm. `alarms` já existe), `dashboard/dashboard.html` + `.js`, `background/service-worker.js`, novo `shared/scheduler.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** agenda sobrevive ao fechamento do navegador e executa no horário com o SO dormindo, com log visível.

### PROD-04 · Camada de memória persistente do workspace (índice de codebase) · `[MELHORIA]` · P1
- **Evidência:** cada agente reconstrói o understanding do repositório do zero (`/tmp/au_gh overview` + `ls`); não há cache persistente de símbolos, dependências, convenções ou decisões.
- **Impacto:** com 7 agents, o custo de token para "entender o repo" é multiplicado por 7 e não é compartilhado.
- **Solução:** (a) **índice do workspace por sala**: árvore de arquivos + resumo de cada módulo + **grafo de dependências** + dicionário de símbolos (via parser leve, não regex); (b) cache no `chrome.storage.local` com invalidação por hash de conteúdo; (c) **"briefing de contexto"** gerado uma vez e injetado nos prompts dos agentes seguintes, com orçamento de tokens configurável; (d) registrar **decisões** (arquivo `decisions.md` da sala) para o agente N+1 saber o que já foi decidido.
- **Arquivos tocados:** `shared/collab-engine.js`, `background/service-worker.js`, `shared/storage.js`.
- **Esforço:** 4 dias.
- **Critério de aceite:** o 2º agent recebe o briefing do 1º em vez de reexplorar; o cache invalida quando um arquivo muda.

### PROD-05 · Recuperação de sessão e histórico de abas · `[MELHORIA]` · P1
- **Evidência:** `background/service-worker.js` mantém `PENDING_JOBS`, `PENDING_ARCHIVE_IDS` (`:9`) e `au_volatile_worker_v1` (sessão); mas **não há lista de sessões concluídas** consultável — o histórico (`au_saved_chats_v1`) só recebe o que o autosave gravou, e **não há como reabrir/continuar** uma conversa antiga.
- **Impacto:** fechar a aba perde o contexto; o autosave salva o **texto**, mas não permite **retomar** a sessão no Arena.
- **Solução:** (a) **timeline de sessões** (start/stop, duração, tokens, loops, sala, workspace) na Central; (b) **reabrir sessão**: navegar para a URL original da conversa do Arena e **re-injetar** o auto-continue; (c) **restaurar sessão após crash** do navegador: snapshot do estado em `chrome.storage.session` reidratado no `onStartup`; (d) **exportar/importar sessão** (mensagens + estado + anexos) em `.json` portável.
- **Arquivos tocados:** `background/service-worker.js`, `dashboard/dashboard.html` + `.js`, `shared/storage.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** uma sessão encerrada aparece na timeline e pode ser reaberta com auto-continue ativo.

### PROD-06 · Comparação / benchmark de modelos com custo real · `[MELHORIA]` · P2
- **Evidência:** `dashboard/dashboard.html` tem "Placar Pessoal Battle Mode & Notas de Modelos" (`an-battle-summary`, `an-model-note`) — é **voto manual**, sem métrica objetiva.
- **Impacto:** o usuário não sabe qual modelo entrega melhor no *seu* fluxo, só qual ele prefere.
- **Solução:** (a) métricas automáticas por execução: **tempo até o primeiro token**, **tokens totais**, **nº de loops até conclusão**, **taxa de erro/captcha**, **nº de correções manuais**; (b) correlacionar com a nota manual; (c) **tabela comparativa** por tarefa e por modelo; (d) exportar CSV.
- **Arquivos tocados:** `shared/storage.js` (métricas), `background/service-worker.js`, `dashboard/dashboard.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** a Central exibe uma tabela modelo × métrica com dados reais das execuções.

### PROD-07 · Galeria de templates de sala e fluxo (replay) · `[MELHORIA]` · P2
- **Evidência:** `shared/defaults.js` tem `DEFAULT_WORKFLOW_MACROS` (4 macros fixas) e `DEFAULT_PROMPTS`; não há **coleção do usuário** para salas multi-agente.
- **Impacto:** todo novo fluxo multi-agente é redigitado do zero.
- **Solução:** **preset de sala** = { perfil de time, nº de agentes, task base, branch mode, stop mode, hosts de arquivo, refs de regras } + **replay**: reexecutar uma sala com o mesmo template e comparar os resultados.
- **Arquivos tocados:** `shared/defaults.js`, `dashboard/dashboard.html` + `.js`, `shared/storage.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** presets do usuário persistem, são duplicáveis e exportáveis.

### PROD-08 · Sistema de plugins / pontos de extensão · `[MELHORIA]` · P1
- **Evidência:** nenhuma infração de extensão além dos 4 macros fixos e 4 temas; `shared/defaults.js` é **código compilado**, não dado.
- **Impacto:** cada nova capacidade exige **fork da extensão**; a comunidade não consegue contribuir.
- **Solução:** (a) registro de **gatilhos** (`on_agent_message`, `on_stop`, `on_room_created`, `on_pr_opened`, `on_file_uploaded`) e **ações** (`send_prompt`, `notify`, `upload_file`, `push_commit`, `open_pr`, `run_macro`); (b) **manifesto de plugin** em JSON declarando gatilhos, permissões e versão; (c) sandbox de plugin (Web Worker isolado, sem acesso a `chrome.*` além de uma **API de宿主** mediada); (d) **mercado/galeria local** de plugins com instalador; (e) construtor visual de fluxo na Central (encadear gatilho → condição → ação).
- **Arquivos tocados:** novo `shared/plugin-runtime.js`, `shared/hooks.js`, `dashboard/*`, `manifest.json` (opcional: `content_security_policy` para `wasm-unsafe-eval` apenas se necessário).
- **Esforço:** 8 dias (MVP 4 dias).
- **Critério de aceite:** um plugin de exemplo (ex.: "notificar no Telegram quando a sala concluir") instala, ativa e executa sem alterar o código da extensão.

### PROD-09 · Integração MCP (Model Context Protocol) · `[MELHORIA]` · P3
- **Evidência:** o guia **proíbe** explicitamente `list_connector_tools("github")` (`shared/defaults.js`, regra `rule_auto_pr_github`) — a extensão **substitui** conectores por CLI própria; não há servidor MCP.
- **Impacto:** o ecossistema MCP é o padrão emergente para agentes; a extensão não fala com ele.
- **Solução:** (a) cliente MCP **stdio local** (spawn de binário local, ou conexão SSE/HTTP para servidores MCP remotos); (b) expor os recursos da extensão (`listar salas`, `ler workspace`, `abrir PR`) como **tools MCP** para agentes externos (Claude Desktop, Cursor); (c) bridging dos conectores do Arena (`list_connector_tools`) como **fallback explícito** quando a CLI própria não cobre o caso — hoje a regra a proíbe.
- **Arquivos tocados:** novo `shared/mcp-client.js`, `shared/collab-engine.js` (regra `rule_auto_pr_github` revisada), `background/service-worker.js`.
- **Esforço:** 5 dias.
- **Critério de aceite:** um servidor MCP local é detectado e suas tools ficam disponíveis ao agente; a extensão também é腿ível como servidor MCP.

### PROD-10 · Camada de billing / licenciamento e telemetria de produto · `[MELHORIA]` · P3
- **Evidência:** nenhuma no ZIP. Para distribuição na Chrome Web Store com recursos pagos, falta o primitivo.
- **Impacto:** sem licença, não há como monetizar; sem telemetria, não há como saber o que já trava.
- **Solução:** (a) **licença local** (JWT assinado + verificação de assinatura Ed25519 **offline**, sem chamadas de rede obrigatórias) com features por plano; (b) **telemetría opt-in** agregada e **anonimizada** (contadores, sem conteúdo, sem prompts, sem tokens) com tela de consentimento e botão "limpar"; (c) auto-desativação de recursos premium emSO expirado (o "modo gratuito" nunca quebra o agente).
- **Arquivos tocados:** `shared/licensing.js`, `shared/telemetry.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 6 dias.
- **Critério de aceite:** a extensão opera em modo gratuito sem bloqueio; a telemetria nunca é ativada sem consentimento explícito.

### PROD-11 · Exportadores reais (Notion, Obsidian, PDF/A, DOCX) · `[MELHORIA]` · P1
- **Evidência:** `shared/storage.js:495-513` gera HTML imprimível (botão "Salvar como PDF / Imprimir") e Markdown/JSON; **não há** exportador nativo para Notion/Obsidian/DOCX, e o "PDF" depende do `window.print()` do navegador (layout do navegador, não do documento).
- **Impacto:** a entrega final consolidada de uma sala é o ativo mais valioso do produto — e ele só sai como texto.
- **Solução:** (a) **exportador PDF real** (sem `window.print`): gerar HTML com `@page`, `@font-face` inline e CSS de impressão, então imprimir via `chrome.offscreen`/`window.print` de uma aba de impressão dedicada ou via `chrome.scripting` — ou rasterizar em offscreen; (b) **DOCX** real (OOXML) a partir de uma tabela de conteúdo/snapshot; (c) **Markdown com front-matter** (YAML de metadados: sala, agentes, duração, PRs, arquivos) → **compatível Obsidian**; (d) **Notion**: exportar `.md` para import ou via API com token do usuário; (e) **"Resumo Executivo" automático** da sala (o próprio relator de consenso já produz esse texto — capturá-lo como artefato de primeira classe).
- **Arquivos tocados:** `shared/storage.js`, `shared/exporters/` (novo), `dashboard/dashboard.js`.
- **Esforço:** 4 dias.
- **Critério de aceite:** a entrega final exporta para `.pdf` real, `.docx`, `.md` com front-matter e `.json`, todos verificados como válidos.

### PROD-12 · "Transformar Chat Live em Sala" e vice-versa · `[MELHORIA]` · P1
- **Evidência:** `livechat/livechat.html` tem `btn-unite-open`, `btn-cancel-unite`, `unite-gh-repo`, `unite-profile`, `unite-task` (unir abas existentes à sala) e `btn-new-batch`; mas não há o **caminho inverso** documentado nem implementado de forma óbvia: criar uma sala **a partir** de uma sessão já em andamento no LiveChat.
- **Impacto:** o usuário que já está trabalhando com 4 abas abertas precisa montar a sala do zero — a fricção está exatamente no momento de maior valor.
- **Solução:** botão **"＋ Transformar em Sala"** no LiveChat e no Drawer: cria a sala com as abas abertas como membros, adota o histórico existente, e mantém a continuidade de branch/token/estado.
- **Arquivos tocados:** `livechat/livechat.html` + `.js`, `content/content.js`, `background/service-worker.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** 3 abas abertas → 1 clique → sala com 3 agentes, histórico preservado e porta do TempChat disponível.

### PROD-13 · Central de **Ajuda / Documentação in-app** e tour · `[MELHORIA]` · P2
- **Evidência:** nenhum conteúdo de ajuda na extensão; o `COMO_INSTALAR.md` está fora do pacote e é um documento longo de marketing sem índice de tarefas.
- **Impacto:** a extensão tem 9 seções, 3 superfícies (toolbar, drawer, popup) e 4 guias (TempChat, LiveChat, Central, Dashboard) — descoberta é o gargalo.
- **Solução:** (a) **tour de primeira execução** (3 passos: lançar um agent, abrir a sala, conectar o GitHub) com `chrome.storage` para não repetir; (b) **ajuda contextual**: `?` ao lado de cada seção → painel curto em pt-BR; (c) **busca dentro da ajuda**; (d) **atalhos imprimíveis**; (e) link "Reportar problema" que pré-preenche um diagnóstico **sem** PAT e sem conteúdo de prompt (redigido).
- **Arquivos tocados:** `dashboard/dashboard.html` + `.js`, `content/content.js`, `popup/popup.html`.
- **Esforço:** 2 dias.
- **Critério de aceite:** primeiro uso mostra o tour uma única vez; cada seção da Central tem ajuda inline.

### PROD-14 · Detecção deapters e vulnerabilidades no workspace · `[MELHORIA]` · P2
- **Evidência:** nenhuma análise estática do workspace; `au_gh` cobre apenas o **repositório GitHub** (`overview/prs/issues/actions/wiki/insights`), não o código local.
- **Impacto:** o agente pode "entregar" com dependência vulnerável ou build quebrado sem o usuário saber — especialmente em fluxo autônomo (zero-loop), onde **não há humano no loop para pegar**.
- **Solução:** (a) **gate de qualidade pré-PR**: quando `autoCreatePR` está ligado, rodar automaticamente `npm audit --audit-level=high` / `pip-audit` / `cargo audit` (se detectado) e **bloquear o PR** com relatório, salvo opt-in explícito; (b) **smoke test** do build (`npm test` / `pytest` rápido) com timeout; (c) resumo do gate no corpo do PR e no Chat Live; (d) bypass manual auditedado.
- **Arquivos tocados:** `shared/collab-engine.js` (CLI `au_gh`), `background/service-worker.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** um PR com dependência vulnerável é bloqueado por padrão e o motivo aparece no Chat Live e no PR.

### PROD-15 · Sincronização entre perfis e dispositivos · `[MELHORIA]` · P3
- **Evidência:** todo o estado é **local** (`chrome.storage.local`); sem `storage.sync`, sem conta, sem canal.
- **Impacto:** instalar em outro computador exige reexportar/importar o backup manualmente.
- **Solução:** (a) **export/import estruturado** já existe (`exportAllData`) — evoluir para incluir salas, presets e métricas, com **import seletivo** e detecção de conflito; (b) opcionalmente, `chrome.storage.sync` para preferências pequenas (com `sync` quota); (c) **sem backend próprio** — o modelo é local-first e exportável.
- **Arquivos tocados:** `shared/storage.js`, `dashboard/dashboard.js`.
- **Esforço:** 1,5 dia (sem `sync`), 4 dias (com).
- **Critério de aceite:** o backup inclui salas e presets; a importação é seletiva e não sobrescreve sem confirmação.

### PROD-16 · Múltiplos provedores de arquivo adicionais (S3/GCS, Cloudflare R2, WebDAV, Google Drive) · `[MELHORIA]` · P3
- **Evidência:** `shared/integrations.js:5` — `PROVIDER_ORDER = ['filebin', 'litterbox', 'uguu', 'x0at']`; `detectProviderFromUrl` (`:63`) ainda reconhece `temp.sh` (host não declarado no manifest e não implementado).
- **Impacto:** os 4 hosts atuais são públicos, sem garantia de disponibilidade e com TTL — inadequados para artefatos de trabalho reais e para uso corporativo.
- **Solução:** (a) **provedor próprio (S3-compatível / R2 / WebDAV / Drive)** com credencial do usuário, bucket privado e URL assinada; (b) **política de retenção** por sala com expiração automática; (c) **fallback automático** já existente (`tempFileAutoFallback`) estendido; (d) implementar ou remover `temp.sh` do detector (hoje é um caminho morto).
- **Arquivos tocados:** `shared/integrations.js`, `dashboard/dashboard.html` + `.js`, `manifest.json` (host opcional).
- **Esforço:** 4 dias.
- **Critério de aceite:** um bucket privado S3/R2 pode ser configurado e usado como provedor primário; `temp.sh` deixa de ser um caminho morto.

---

## 4.5 P0/P1 — ARENA: defeitos do protocolo TempChat e compatibilidade com o arena.ai

> Bloco introduzido na v2.0 após a rodada de auditoria de runtime autorizada pelo Coordenador. Todos os itens abaixo são **não-GitHub** e atingem o **coração** do produto (a sala multi-agente).
>
> **Na v2.1, `ARENA-11` foi promovido a P0 e reescrito** como *Política de Autorização por Tarefa* — o requisito central do produto (ver §0.0). `ARENA-12` (protocolo de convergência) absorveu o antigo `ENG-11`.

### ARENA-01 · `/tmp/au_chat` degrada em loop de timeout infinito sob acúmulo de mensagens · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/collab-engine.js:290-299` — `do_read()` percorre a lista de arquivos do bucket **sequencialmente**, abrindo uma `urlopen` por arquivo com `timeout=10`; o conjunto `seen` **só é gravado em disco ao final** (`with open(SEEN, "w")` após o laço).
- **Impacto:** o gatilho exato depende de latência/falha de host, **não** do número de mensagens isoladamente (verificação de rigor do Ag1). Mas a estrutura é determinística: se o `bash` do Arena (timeout de 30 s) for interrompido **antes** do `with open(SEEN, "w")`, o `SEEN` **não é persistido** → na próxima chamada todos os arquivos são relidos → **loop de timeout**. Presenciado ao vivo nesta Sala #1685 (a tool de chat injetada pelo próprio produto passou por esse ciclo). Combinado com o item ARENA-02 (monólogo interno no bucket), o volume de arquivos cresce rápido.
- **Solução (com as restrições do Ag1, adotadas):** (a) **fetch paralelo** com `concurrent.futures.ThreadPoolExecutor` em vez de sequencial — **com limite de concorrência explícito** (8 workers) e **deadline global** (orçamento total da chamada, ex.: 15 s), de modo que a soma das esperas nunca ultrapasse o timeout do `bash` do Arena; (b) **gravação incremental** do `SEEN` a cada arquivo processado, com escrita **atômica** (`tmp` + `os.replace`) — nunca sobrescrever o `SEEN` com um estado parcial; (c) **não marcar como lida** uma mensagem cujo download **falhou**: o registro de "visto" só é gravado para mensagens **extraídas com sucesso**; falhas entram em uma fila de retentativa com contador; (d) **timeout global** com saída graciosa — ler o que já deu, persistir, e retornar o que foi obtido; (e) **paginação/limite** de mensagens por leitura (ex.: as 50 mais recentes) para não varrer o bucket inteiro; (f) **fallback de transporte** (Filebin → Litterbox → Uguu → x0.at), já existente no uploader de arquivos, reutilizado no chat; (g) **estado durável e seguro**: gravado fora do `/tmp` (que é volátil quando o sandbox hiberna) em `/home/user/au_state`, com escrita atômica e **lock** para evitar corrida entre dois agentes lendo a mesma sala; *ressalva: a persistência e o tempo de vida do sandbox variam por serviço, portanto o estado em disco é **melhor esforço**, não garantia*; (h) **validação do fix**: o Ag2 reproduziu o timeout sequencial **ao vivo** nesta Sala — mas **não** é uma verificação independente do resultado do fix; a correção só é considerada validada quando o teste automatizado (§9.2) reproduzir o cenário com N mensagens e falhar **antes** / passar **depois**.

> **Registro de evidência (para transparência):** o timeout sequencial do `au_chat` foi **observado ao vivo** pelo Ag2 durante esta Sala, com correção proposta usando `ThreadPoolExecutor`. Essa observação **não** foi verificada de forma independente pelo Ag1. O SPEC a trata como **observação de equipe**, e a validação do fix fica como **tarefa de teste** — não como premissa.
- **Arquivos tocados:** `shared/collab-engine.js` (gerador da CLI), `background/service-worker.js` (estado do lado da extensão).
- **Esforço:** 1,5 dia.
- **Critério de aceite:** com 200 mensagens no bucket e host lento, `au_chat read` retorna em <8 s, persiste `SEEN` incrementalmente e **nunca** entra em ciclo de timeout.

### ARENA-02 · Monólogo interno do modelo (`<details>`/reasoning) vaza para a Sala e para o bucket público · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `content/content.js:1406` — `const txt = (fastNoLayout ? (el.textContent || '') : (el.innerText || el.textContent || '')).trim();`. `textContent` inclui o conteúdo de elementos **ocultos** (incluindo `<details>` de raciocínio), enquanto `innerText` respeita `display:none`. O resultado alimenta `shared/collab-engine.js:893` (fallback de compartilhamento) e é publicado no bucket por `background/service-worker.js:1168`.
- **Impacto:** conteúdo que o usuário Considerou privado (raciocínio interno, blocos recolhidos) é **transmitido a um host público** e exibido na Sala como se fosse resposta do agente. É um vazamento de privacidade com consequence de segurança (o `<thought>` pode conter raciocínio sobre credenciais).
- **Solução:** (a) preferir **sempre** `innerText` (ou clonar o nó e remover `details`, `script`, `style`, `[hidden]`, `[aria-hidden="true"]`, `.sr-only` **antes** de extrair); (b) adicionar um **filtro de scrub de `<thought>`** no ponto de publicação (`scrubSecrets` já existe — estender para blocos de raciocínio); (c) **preview de publicação** na Central antes de espelhar na Sala ("12 mensagens serão compartilhadas, 3 contêm blocos ocultos"); (d) teste com fixture sintética contendo `<details>` e sentinelas (matriz `A17`).
- **Arquivos tocados:** `content/content.js`, `shared/collab-engine.js`, `background/service-worker.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** uma fixture com `<details>` e sentinela não envia a sentinela para o bucket nem para o feed da Sala.

### ARENA-03 · Navegação SPA do Arena não reseta o estado do runtime — vaza contexto entre conversas · `[FALHA CONFIRMADA]` · P0
- **Evidência:** busca em `content/content.js` por `pushState`/`replaceState`/`popstate`/`locationchange` → **0 ocorrências**; não há `resetRuntime()`.
- **Impacto:** clicar em outro chat na sidebar do Arena (navegação client-side, sem reload) mantém `collabRoomId`, `githubRepo`, `githubBranch`, `promptQueue`, `loopsCount` e `status` do chat **A** no chat **B**. Efeito: o Autopilot pode enviar prompt no chat errado; a entrega pode ser publicada na sala errada; contadores ficam corrompidos.
- **Solução:** (a) **patch de `history.pushState`/`replaceState`** no `document_start` (o `page-bridge.js` já roda em `document_start` no mundo MAIN — é o lugar certo) emitindo um evento `au-route-change`; (b) **listener de `popstate`**; (c) `resetRuntimeForNewConversation()` que zera estado **derivado da conversa** (sala, repo, branch, fila, contadores, status, `lastAttemptedPrompt`) **preservando** preferências do usuário (settings, temas, auto-continue global); (d) **identidade da conversa**: `getConversationIdentity()` → `{conversationId, url}` (Ag1) e **rejeitar** envio quando a identidade mudou desde o enfileiramento (evita enviar o prompt A na conversa B); (e) matriz `A02` e `A16`.
- **Arquivos tocados:** `content/page-bridge.js` (patch de history), `content/content.js` (reset + guarda de identidade), `background/service-worker.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** trocar de conversa na sidebar zera o estado derivado; nenhuma mensagem é enviada para a conversa errada (matriz `A02`/`A16` verde).

### ARENA-04 · Autopilot não detecta cards interativos do Agent Mode e atropela a escolha humana · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `content/content.js:570-687` — `findTaskReviewPanel()` detecta **apenas** o painel de revisão de tarefa ("Esta tarefa foi bem-sucedida?"). Não há detecção de `ask_user` (pergunta com opções), `add_voice` (seleção de voz) nem `generate_image` com `offer_options` (escolha de imagem), nem dos **Conectores** (Notion/Slack/GitHub) do Arena.
- **Impacto:** quando o agente **pausa esperando o humano**, o botão `Stop` some, o stream zera e o tick do Autopilot dispara "Continue" — **responde sozinho**, escolhendo por conta do usuário ou cancelando o card. Em fluxo zero-loop isso significa: o modelo pede aprovação de imagem e o sistema **aprova sozinho**. É o pior modo de falha para um produto que promete autonomia.
- **Solução:** (a) **detector de estado de espera humana** — `findPendingHumanInteraction()` que recognize, por estrutura (não por texto solto), os cards de `ask_user`, voz, imagem e conectores; (b) **estado `WAITING_USER`** no motor: enquanto houver card pendente, o Autopilot **não envia** e o status mostra "⏸ aguardando você" na toolbar e no Chat Live; (c) **auto-resposta opcional** por card, com **allowlist explícita** (ex.: "responder automaticamente apenas em `ask_user` de múltipla escolha quando a opção for明示amente 'continuar'") — nunca para voz/imagem por padrão; (d) **reconciliação** do turno após a escolha (matriz `A15`); (e) matrizes `A04`, `A12`.
- **Arquivos tocados:** `content/content.js`, `background/service-worker.js` (estados), `livechat/livechat.js` (exibição).
- **Esforço:** 2 dias.
- **Critério de aceite:** com um card `ask_user` pendente, o Autopilot **não** envia "Continue"; após a escolha do usuário, o turno retoma sem duplicar envio.

### ARENA-05 · Eleição de líder ausente — `smart_consensus` trava se o sintetizador cair · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `background/service-worker.js` atribui `isSynthesizer` **estaticamente** por papel (linhas 437, 1137, 1230, 1527, 1892, 2712) e **não existe** nenhum mecanismo de re-eleição; `shared/collab-engine.js:100+` define `stopMode: 'smart_consensus' | 'endless_tokens'`.
- **Impacto:** o último agente da sala é o **único** que produz a síntese final. Se a aba dele cair por `token_stopped`, `refused_stopped` (recusado por Thinking) ou erro, a sala fica **sem líder** → o modo `smart_consensus` **trava eternamente** esperando uma entrega que nunca virá. Com 7 agentes e re-roll automático, a probabilidade não é desprezível.
- **Solução:** (a) **monitor de saúde do líder** no service worker: se o agente sintetizador estiver em `token_stopped`/`refused_stopped`/`error` por >N s, **re-eleição** entre os agentes vivos (preferindo o de maior `agentIndex` com estado `idle`/`generating`); (b) **re-prompt do novo líder** com o contexto acumulado da Sala (`buildInitialAgentPrompt` reexecutado com `isSynthesizer: true` + histórico de mensagens da sala); (c) **aviso explícito** na Sala: "🔁 Líder trocado: Agente 7 → Agente 5"; (d) **modo degradado explícito**: se nenhum agente puder liderar, a sala passa a `needs_human` com ação "Reunir entrega final" — nunca trava em silêncio; (e) no `endless_tokens`, o líder também é re-eleitado.
- **Arquivos tocados:** `background/service-worker.js`, `shared/collab-engine.js`, `livechat/livechat.js`, `dashboard/dashboard.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** derrubar a aba do sintetizador re-eleita o líder e a sala conclui; sem líder possível, a sala sinaliza `needs_human` em vez de travar.

### ARENA-06 · Zen Mode esconde painéis legítimos do Arena (efeito colateral global) · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `content/themes.js:33-40` — o CSS do Zen Mode injeta `aside, nav[aria-label*="sidebar" i], [data-sidebar="sidebar"], [data-sidebar="rail"], [class*="sidebar" i]:not([id^="arena-ultra"]) { display: none !important; }`.
- **Impacto:** no Arena, `aside` também é usado por painéis **de conteúdo** (Workspace, Preview, Artifacts, painéis de arquivos). O Zen Mode **apaga a interface do site**, não só a sidebar — o usuário perde acesso a recursos que não tinha pedido para esconder.
- **Solução:** (a) **escopo restrito**: em vez de `aside`, ocultar apenas a sidebar **do Arena** por seletor específico verificado (`[data-testid="sidebar"]` ou similar, com **fixture**), nunca `aside` global; (b) **lista de exclusão** explícita (`[id^="arena-ultra"]`, `.workspace`, `[data-workspace]`, `.preview`, `[data-artifacts]`); (c) **lista de toggles** por painel no lugar do "Zen" binário; (d) aviso visual "Zen ocultou N painéis" com botão "desfazer"; (e) teste de regressão comparando a contagem de `aside`/`nav` visíveis antes/depois.
- **Arquivos tocados:** `content/themes.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** com Zen ativo, os painéis de Workspace/Preview do Arena continuam visíveis; apenas a sidebar alvo é ocultada.

### ARENA-07 · Sem injeção de anexos/imagens no composer Tiptap · `[MELHORIA]` · P1
- **Evidência:** busca em `content/content.js` por `DataTransfer` → **0 ocorrências**; o envio de prompt usa apenas inserção de texto (`:536-557`, seletores TipTap/ProseMirror).
- **Impacto:** o fluxo "analise este screenshot / este design / este log" — **central** para o uso de modelos multimodais — é impossível de automatizar. Multi-agente não pode comparar imagens.
- **Solução:** (a) **injeção programática de arquivo** no composer via `DataTransfer` + `input[type=file]` sintético ou **Clipboard API** (`navigator.clipboard.write` com `ClipboardItem` de imagem); (b) **origem do arquivo**: do workspace local, de um upload da Sala, ou de um URL (com consentimento e SSRF-check); (c) **fluxo de múltiplos anexos** com legenda por arquivo; (d) **visibilidade**: o Chat Live mostra as miniaturas enviadas; (e) matriz `A03`.
- **Arquivos tocados:** `content/content.js`, `content/page-bridge.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** o Autopilot consegue anexar uma imagem do workspace ao prompt e ela aparece no Arena.

### ARENA-08 · Proxy zero-loop real do Arena (CAS) não é usado — repo privado sobe em texto puro ao Filebin · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `shared/collab-engine.js:685-696` (modo `extension_proxy_push`) instrui o agente a `zip -r /tmp/entrega.zip` e enviar via `/tmp/au_upload` (Filebin/Litterbox/Uguu/x0.at — **públicos**). O guia descreve o endpoint CAS do Arena (`/api/chat/:id/workspace/latest?includeManifest=true` + `/api/chat/workspace/cas/user/:hash`), mas o **código do proxy não o usa** — o `background/service-worker.js` faz upload direto ao provedor externo.
- **Impacto:** o arquivo do proxy (o repositório inteiro) **não tem criptografia** e fica num bucket público. Somado ao SEC-01 (PAT no prompt) e ao SEC-06 (sem AES), o fluxo zero-loop atual expõe **código privado + credencial + chave de push** fora do navegador.
- **Solução:** (a) **usar a CAS do Arena**: o service worker busca o workspace **autenticado na sessão do Arena** e faz o commit/push **no próprio navegador**, sem intermediário público; (b) **manter** o caminho por provedor externo **apenas** para repositórios **públicos**, e **sempre cifrado** (AES-256-GCM) quando privado; (c) **chave fora do canal**: a senha de cifrado é exibida/confirmada no popup e **nunca** vai ao mesmo bucket; (d) **escolha explícita do usuário** por sala: "repositório privado → proxy direto no navegador (recomendado)" vs "upload cifrado"; (e) **auditoria**: registrar qual caminho foi usado em cada push.
- **Arquivos tocados:** `background/service-worker.js`, `shared/collab-engine.js`, `shared/integrations.js`.
- **Esforço:** 2,5 dias.
- **Critério de aceite:** um repo privado **não** é enviado a nenhum host externo no fluxo padrão; o teste verifica ausência de bytes `PK` em Filebin/Litterbox/Uguu/x0.at.

### ARENA-09 · Compatibilidade com o Arena depende de seletores não versionados — falta camada de adaptador e detecção de capacidade · `[MELHORIA]` · P1
- **Evidência:** `content/content.js:536-557` (seletores do editor), `:798+` (botão de parada), `:1414+` (CAPTCHA), `background/service-worker.js:1439,1717,2402` (`https://arena.ai/agent`), `:960,3925` (`/download-workspace`). Não existe **nenhuma** camada de abstração, nem `detectCapabilities()`, nem teste de regressão de seletores.
- **Impacto:** qualquer mudança de DOM do Arena **quebra a extensão silenciosamente** — e a automação é o produto. Não há como saber "o Arena mudou, a extensão está degradada" antes de o usuário perder horas de trabalho.
- **Solução:** (a) **camada `arena-adapter`** com o contrato proposto pelo Ag1: `detectCapabilities()` → `{version, capabilities, evidence}` (aceitando `UNKNOWN` como válido), `getConversationIdentity()` → `{conversationId?, tabId, url}`, `observeGeneration()` → `IDLE|SUBMITTING|GENERATING|WAITING_USER|COMPLETED|ERROR|UNKNOWN`, `preparePrompt()`, `submitPrompt(operationId)` → `accepted|unknown|rejected`, `stopGeneration()`, `getWorkspaceCapabilities()`, `downloadWorkspace()`; (b) **degradação granular**: se um seletor quebrar, desativar **só** a capacidade afetada (não a extensão inteira) e exibir "interface não reconhecida" + relatório sanitizado; (c) **fixtures sintéticas** das variantes de editor/estado, **sem** copiar conversas reais; (d) **smoke test** com conta de teste autorizada a cada release e após mudanças percebidas na interface; (e) **nunca** baixar/executar código remoto para contornar revisão de extensão.
- **Arquivos tocados:** novo `shared/arena-adapter.js`, `content/content.js`, `content/page-bridge.js`, `background/service-worker.js`, `tests/fixtures/arena/*`.
- **Esforço:** 5 dias (adapter + 4 fixtures + smoke).
- **Critério de aceite:** a matriz de homologação `A01`–`A14` (§6.3) roda como suíte automatizada; um seletor quebrado degrada só a capacidade afetada.

### ARENA-11 · Política de Autorização por Tarefa — o requisito central do produto: autonomia máxima com humano no loop mínimo · `[MELHORIA]` · P0
> **Diretiva do Coordenador (28/10/2026):** *"Quero que essa extensão funcione com o mínimo necessário de humano no loop — fiz ela para automatizar, não ficar decidindo várias coisas."*
> Este item é a **pedra angular** do SPEC. Todo o resto é acessório a ele. **Não existe, em nenhum fluxo normal, confirmação por operação.**

- **Evidência:** `shared/defaults.js` — `refuseThinkingMaxRetries: 15` é o único teto; `githubAutoCreatePR: true` e as regras condicionais (`rule_auto_pr_github`, `rule_auto_confirm`) **não têm** orçamento de ações, nem teto de custo, nem escopo declarado, nem registro de autorização. Hoje a autonomia é **implícita** (ligada/desligada por flags) em vez de **explícita e delimitada** — o usuário não tem como saber o que autorizou.
- **Impacto (do lado bom):** a extensão já é autônoma; o que falta é **delimitar** e **provar** essa autonomia, para que ela possa crescer sem risco e sem que o usuário precise decidir nada repetidamente.
- **Solução — modelo de autorização única, por tarefa:**
  1. **Uma** tela de autorização ao criar a tarefa/sala (não por operação). Ela declara: **repositório/destino**, **destinos de upload**, **ações habilitadas** (push, PR, upload,-issue, comment, webhook), **orçamento** (loops, commits, PRs, uploads, tempo) e **destinos de notificação**. Um botão: **"Autorizar e rodar"**.
  2. **Dentro do escopo autorizado, o sistema é 100% automático.** Envios ao Arena, commits, push, abertura de PR, uploads e merges autorizados **não perguntam nada**.
  3. **A pausa humana é a exceção, nunca a regra.** O sistema **pausa e notifica** (em vez de bloquear) apenas em: **CAPTCHA/desafio** (que exige o humano de qualquer forma), **credencial expirada/revogada**, **destino fora do escopo autorizado**, **conflito real de merge ou estado incerto** (ARENA-10), **risco de perda de dados** (ex.: deleção em massa — DATA-01) e **orçamento estourado**. Em todos esses casos, a sala entra em `needs_human` com **uma** pergunta objetiva e ações pré-calculadas ("Aplicar 3 deleções? [Sim/Não]").
  4. **"PARAR TUDO"** — kill switch global de 1 clique no popup e no Chat Live; interrompe todos os agentes em <2 s, com opção de retomar. É o único controle que o usuário precisa ter à mão.
  5. **"PAUSAR"** por sala — pausa cirúrgica, sem encerrar a tarefa.
  6. **Registro de autorização**: cada ação executada é registrada com o escopo que a autorizou; o painel mostra "autorizado por: Tarefa #42 (12/10/2026)" — auditoria, não interrupção.
  7. **Revogabilidade**: a política pode ser revogada a qualquer momento; revogar **para** ações futuras, sem perder o trabalho já feito.
  8. **Modo automático total** — para quem já confia: `autorizar tudo (permanente)` com os limites padrão, sem telas intermediárias.
- **Arquivos tocados:** `shared/defaults.js`, `background/service-worker.js` (motor de política + `needs_human`), `dashboard/dashboard.html` + `.js` (tela de autorização + painel de escopo), `popup/popup.html` (PARAR TUDO), `livechat/livechat.js` (exibição do escopo e das pausas).
- **Esforço:** 3 dias.
- **Critério de aceite:** com uma tarefa autorizada, uma cadeia de 20 operações (prompt → código → commit → push → PR → upload → merge) executa **sem nenhuma** confirmação intermediária; uma operação fora do escopo **pausa e notifica** em vez de falhar; "PARAR TUDO" interrompe todos os agentes em <2 s.

### ARENA-12 · O `stopMode: 'smart_consensus'` não tem critério de parada verificável nem matriz de aceitação · `[MELHORIA]` · P1
- **Evidência:** `shared/collab-engine.js:100+` define os 3 perfis de time e `stopMode` (`smart_consensus` / `endless_tokens`); o critério é essencialmente "o último agente parou" + o marcador `[ENTREGA_FINAL_PRONTA]`.
- **Impacto:** não há garantia de convergência real — é comum o último agente parar sem que os demais tenha aceitado, e não há como auditar a decisão. Combinado com ARENA-05 (sem eleição), o modo pode travar **ou** encerrar prematuramente.
- **Solução:** (a) **protocolo de convergência explícito**: rodadas numeradas; cada agente registra `posição`, `objeções`, `aceita/recusa` e uma **hash de convergência**; (b) o relator só declara **consenso** quando N−1 agentes **aceitaram** explicitamente; caso contrário declara **"decisão por maioria"** — **nunca** "consenso" indevidamente; (c) **matriz de aceitação** visível na Central (✅/❌ por agente por proposição); (d) registro das **proposições** e da decisão final; (e) **métricas de consenso**: rodadas, objeções, convergência.
- **Arquivos tocados:** `shared/collab-engine.js`, `background/service-worker.js`, `dashboard/dashboard.html` + `.js`, `livechat/livechat.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** a Central exibe a matriz de aceitação e distingue "consenso" de "decisão por maioria".

### ARENA-13 · Estado do canal TempChat não sobrevive ao fim do turno nem ao reinício do service worker · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `shared/collab-engine.js` — o `SEEN` do `au_chat` fica em `/tmp` (volátil); o service worker usa `chrome.storage.session` (`background/service-worker.js:18`), que **não sobrevive** ao fechamento do navegador; `PERSISTED_COLLAB_KEY` (`background/service-worker.js:353`) persiste as salas, mas o **ponteiro de mensagens lidas** (`SEEN`) é local do sandbox.
- **Impacto:** ao retomar a tarefa no dia seguinte, o agente **relê** mensagens já processadas (duplicidade) ou perde o contexto da conversa intermediária.
- **Solução:** (a) persistir o cursor de leitura (`lastSeenSeq`, `lastSeenFile`) **no lado da extensão** (`chrome.storage.local`, por sala) e sincronizá-lo com o `SEEN` do sandbox; (b) **reconciliação por `seq`** — a sala já numera mensagens (`room.seq`), então o cursor é um inteiro, não um nome de arquivo; (c) **bootstrap da sessão**: ao retomar, o agente recebe um **resumo** do que já foi dito, não o histórico bruto; (d) `chrome.storage.session` para estado volátil e `chrome.storage.local` para o cursor durável.
- **Arquivos tocados:** `shared/collab-engine.js`, `background/service-worker.js`, `shared/storage.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** retomar uma sala no dia seguinte não duplica mensagens nem perde o contexto.

### ARENA-14 · Ausência de **limite de tamanho** e de **estado parcial** no upload e na extração de workspace · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `shared/integrations.js` faz upload sem teto de tamanho declarado; a extração de ZIP corta em 600 arquivos **silenciosamente** (`integrations.js:488`, ver DATA-03); não há estado **parcial** — ou tudo foi enviado, ou falhou.
- **Impacto:** com um workspace grande (>400 arquivos, arquivo >15 MiB, total >35 MiB), o upload falha ou trunca sem o usuário saber, e a entrega sai incompleta — que é pior que falhar.
- **Solução:** (a) **tetos explícitos e visíveis** (nº de arquivos, tamanho por arquivo, total) com **erro claro**; (b) **estado parcial**: o upload reporta `{ uploaded, skipped, failed }` e a UI mostra o que não foi; (c) **manifesto de conteúdo**: um `.au-manifest.json` listando o que foi enviado, com hash de cada arquivo — permite verificar a integridade e detectar o que faltou; (d) **streaming** do upload (chunked) para não estourar memória em arquivos grandes; (e) **retry por arquivo**, não do pacote inteiro.
- **Arquivos tocados:** `shared/integrations.js`, `shared/collab-engine.js`, `dashboard/dashboard.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** um workspace acima dos limites retorna erro ou estado parcial **explícito**, nunca sucesso completo silencioso.

---

## 5. P1/P2 — UX, Acessibilidade e Internacionalização

### ARENA-15 · Exportador CAS do Arena retorna `ok: true` mesmo com conteúdo **omitido** · `[FALHA CONFIRMADA]` · P0
- **Evidência:** `content/page-bridge.js:1181-1208` — o coletor tem `MAX_FILES = 400`, `MAX_BYTES = 35 * 1024 * 1024` e limite por arquivo de `15 * 1024 * 1024`; quando um limite é atingido, o código faz `return` (interrompe a coleta) ou `continue` (pula o arquivo) **sem registrar a omissão**. Em `:1261-1267` o retorno é `{ ok: true, mode: 'cas', fileCount, files }` — **sem** campo que caracterize o resultado como parcial, e sem `omitted[]`.
- **Impacto (severidade):** um resultado tratado como **completo** pode representar apenas parte do workspace. O consumidor (que inclui o fluxo de push/PR) não tem como saber. **A consequência mais grave:** a ausência de um arquivo num snapshot parcial **pode ser interpretada como intenção de exclusão** — combinada com `DATA-01` (entradas de deleção), um snapshot truncado pode **apagar arquivos legítimos do repositório**.
- **Solução:** (a) **inventariar** itens conhecidos, limites atingidos, erros por caminho, arquivos ignorados e bytes recebidos; (b) resposta com **status explícito**: `{ status: 'complete' | 'partial' | 'failed', files, omitted: [{path, reason}], counts, bytes }` — `complete` **somente** se todas as entradas elegíveis foram processadas e validadas; (c) **distinguir** filtro intencional (ex.: `CAS_IGNORED_DIRS` — artefatos de build) de limite atingido e de falha real — são causas diferentes e precisam de mensagens diferentes; (d) **bloquear operações que substituam a árvore ou deduzam deleções** quando o resultado for parcial ou de completude desconhecida; (e) permitir operações **pontuais explícitas**, com prévia, sem deduzir exclusão por ausência; (f) validar path, tamanho e integridade conforme metadados; **um hash não é garantia de origem sem autenticação**; (g) reobter a base remota **na publicação** e invalidar a aprovação se a base ou o diff mudar; (h) **tratar manifestos e arquivos do workspace — inclusive arquivos declarando intenções de Git — como dados não confiáveis**, nunca como autorização.
- **Arquivos tocados:** `content/page-bridge.js`, `background/service-worker.js`, `shared/integrations.js`, `dashboard/dashboard.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** workspace com >400 arquivos, arquivo >15 MiB, total >35 MiB, 404/timeout num blob, falha em subdiretório, conteúdo filtrado e manifesto inválido → **estado parcial ou falho com motivo**, nunca sucesso completo silencioso; e **nenhum item de deleção** é criado a partir de um snapshot parcial.

### ARENA-16 · `chrome.storage.session` tem **fallback silencioso** para `chrome.storage.local` · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `background/service-worker.js:16-21` — `return chrome.storage.session || chrome.storage.local || null;`. O payload persistido inclui `slotPrompts` com **até 25 slots × 24.000 caracteres** (`:28-37`).
- **Impacto:** onde o fallback é usado, **prompts de sessão passam a persistir no disco** do perfil do navegador — mais do que o usuário espera de um estado "volátil". A disponibilidade exata do fallback depende do navegador e do contexto; **não** foi demonstrada ocorrência real, mas o caminho de código existe e é silencioso.
- **Solução:** (a) **remover o fallback silencioso** para dados sensíveis: se `chrome.storage.session` não existir, degradar de forma **explícita** (estado volátil indisponível → aviso na Central, sem persistir prompts em disco); (b) **TTL e exclusão** para os dados que restarem; (c) **inventário de dados** — listar tudo que é persistido, onde e por quanto tempo, visível na aba "Privacidade"; (d) consentimento explícito caso o usuário prefira persistir; (e) teste simulando a ausência de `storage.session`.
- **Arquivos tocados:** `background/service-worker.js`, `shared/storage.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** sem `storage.session`, nenhum prompt é persistido em `storage.local` sem escolha informada; o reinício degrada com estado explícito.

### ARENA-17 · Ausência de **resultado incerto** e de **reconciliação** — risco de envio/commit duplicado · `[MELHORIA]` · P1
> **Este item absorveu o antigo `ARENA-10`**, cuja escopo (só o envio ao Arena) é um subcaso deste.
- **Evidência:** `shared/integrations.js:622-668` (`ghRequest`) faz `fetch` **sem** `retry`, sem `Retry-After` e sem semântica de resultado incerto; `content/content.js:2298-2402` tem heurísticas de conclusão e lógica de arquivamento/reabertura **sem estado `unknown`**.
- **Impacto:** timeout, recarga do SW ou navegação durante o envio deixam o estado ambíguo. A decisão ingênua (reenviar) **duplica a mensagem ou o commit**; a alternativa (não reenviar) **perde o trabalho**. Em modo autônomo, duplicar um push ou abrir um PR duplicado é dano real.
- **Solução:** (a) **máquina de estados** com `operationId` e resultado `accepted | unknown | rejected`, aplicada a **todo** comando com efeito remoto (enviar prompt, commitar, fazer push, abrir PR, subir arquivo); (b) **reconciliação antes de repetir** — consultar o estado remoto (última mensagem da conversa, ref do PR, commit presente na branch, objeto no bucket) em vez de reenviar; (c) **reconciliação automática primeiro** — sempre tentar resolver o estado consultando o remoto antes de qualquer decisão; a **confirmação humana só é exigida se o estado for irrecuperável** (não há como distinguir duplicado de perdido) — é um dos poucos casos de pausa humana **justificada**; (d) **preservar rascunhos** e nunca arquivar sem confirmação; (e) **timeout após escrita** é sempre `unknown`, nunca `failed`; (f) **idempotência**: quando o backend permitir, incluir `operationId` no commit/PR para detectar reenvio.
- **Arquivos tocados:** `shared/integrations.js`, `content/content.js`, `background/service-worker.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** após um timeout de envio, o motor reconcilia e **não** duplica a mensagem nem o PR sem confirmação.

### ARENA-18 · Vazamento entre salas — um agente de uma sala publica e consome mensagens em outra · `[FALHA CONFIRMADA]` · P0
> **Pedido explícito do Coordenador (28/10/2026):** *"adiciona que os agents de outra sala podem vazar em outra sala — um mandou na outra sala isso"*.
> **Separação exigida pelo Ag1, adotada:** o que segue é **CONFIRMADO POR CÓDIGO** (três caminhos de escrita/leitura sem escopo de sala). A **causa raiz exata do incidente observado em tela pelo Coordenador** ainda **não está isolada** — pode ser este vazamento, navegação SPA (ARENA-03), mapeamento de `sender` ou fonte externa. O item fecha os três caminhos; a investigação do incidente permanece aberta como tarefa de teste (matriz `A19`–`A24`).

- **Caminho 1 — escrita arbitrária em qualquer sala (tempchat bridge).** `content/tempchat-bridge.js:29-30` lê `linkedRoomId` do **hash da URL** (`#au_room=1234`), que é **100% controlável** por quem abre a página; `content/tempchat-bridge.js:240-248` envia `AU_TEMPCHAT_INBOUND_MSG` com esse `roomId`; `background/service-worker.js:3403-3428` faz `COLLAB_ROOMS.get(rId)` **sem validar vínculo** entre a aba e a sala, e injeta a mensagem na sala como `senderType: 'external'` — e ainda a **publica no bucket Filebin daquela sala** (`pushRealtimeMessageToBin`, `:3421`). → **Qualquer aba tempchat.online pode escrever em qualquer sala de 4 dígitos e no bucket dela.**
- **Caminho 2 — turno roteado para a sala errada.** `content/content.js:2674-2682` envia `AU_COLLAB_TURN_COMPLETED` com `payload.roomId = runtime.collabRoomId`; `background/service-worker.js:1101` faz `const roomId = payload.roomId || (st && st.collabRoomId) || ''` — **o payload tem precedência sobre o vínculo real da aba**. Como `runtime.collabRoomId` **não é resetado na navegação SPA** (ARENA-03, confirmado: zero `pushState`/`popstate` no arquivo), uma aba que saiu da sala A e entrou na B **continua reportando a sala A**, e o turno é processado e publicado **na sala A** — exatamente "um mandou na outra sala".
- **Caminho 3 — auto-cadastro como agente em sala alheia.** `background/service-worker.js:1126-1151` — se não houver agente para o `tabId` na sala resolvida, o service worker **cria um agente novo** (`room.agents.push(agent)`), com `lastSeenSeq` quase no topo da sala e **`admittedToTeam`/`screeningStatus`** calculados pela política da sala. O `tabId` não precisa ter jamais pertencido àquela sala. → **Qualquer aba pode serPromotionada a agente de uma sala arbitrária**, recebendo o fluxo de mensagens daquela sala e disparando push/PR em nome dela (`:1232-1294`).
- **Impacto:** quebra de isolamento entre sessões de trabalho distintas. Consequências: **conteúdo de uma sala** (que pode incluir código, trechos de repositório, mensagens de outro cliente) aparece em outra; um agente entra na fila de outra sala e pode **disparar push/PR na branch errada**; contadores, matrizes de aceitação e a síntese final ficam **corrompidos**; e a poluição **persiste** no bucket, então o vazamento se propaga mesmo depois de desconectar a aba.
- **Solução — escopo de sala em TODO comando, com vínculo verificado no service worker:**
  1. **O service worker é a única autoridade de vínculo.** Nenhum `roomId` vindo do content script ou da página é aceito como destino. O destino é resolvido por `TAB_STATES.get(senderTabId).collabRoomId` **e** validado contra `room.agents` (a aba já é membro?). Payload só pode **estrear** um vínculo, nunca redirecionar um existente.
  2. **Vínculo por `tabId` + `epoch`.** Cada vínculo sala↔aba recebe um `epoch` monotônico, incrementado a cada re-ligação. Comandos carregam o `epoch`; se divergir do atual, o comando é **rejeitado** (`stale_binding`). Isso mata a corrida entre navegações.
  3. **Sem auto-cadastro remoto.** `handleCollabTurnCompleted` **não** cria agente em uma sala onde a aba não foi registrada explicitamente. Para participar, a aba precisa ter sido **admitida** pela criação da sala ou por "unir abas" explícito — e, quando for admitida, recebe o `epoch`.
  4. **Escopo obrigatório do `payload`.** `roomId`, `chatId` (conversa), `turnId` e `epoch` passam a ser validados **em conjunto**: mensagem de uma conversa não pode ser gravada em outra sala, nem em outro turno.
  5. **HMAC por sala** (SEC-08) aplicado também ao payload — assim, mesmo que a UI seja forjada, a assinatura não bate.
  6. **Dedupe por sala.** `room.seq` já numera; o dedupe passa a ser por `(roomId, seq)` e nunca global — evita que uma mensagem válida da sala A seja "consumida" ao marcar na B.
  7. **Criptografia de bucket por sala.** Cada sala usa um `filebinId` **derivado da sala e de uma chave por sala** — duas salas nunca compartilham o bucket, e o roteamento por bucket deixa de ser fonte de cross-talk.
  8. **Auditoria visível:** o Chat Live mostra, para cada mensagem, a **sala de origem** e a **aba de origem**; mensagens rejeitadas por escopo aparecem num log sanitizado (sem conteúdo).
- **Arquivos tocados:** `background/service-worker.js` (`handleCollabTurnCompleted`, `AU_TEMPCHAT_INBOUND_MSG`, `AU_TEMPCHAT_CODE_DETECTED`, auto-cadastro), `content/content.js` (enviar `epoch` e `chatId`), `content/tempchat-bridge.js` (não aceitar `roomId` do hash), `shared/collab-engine.js` (epoch + HMAC), `livechat/livechat.js` (exibir origem), `dashboard/dashboard.js` (log de escopo).
- **Esforço:** 4 dias.
- **Critério de aceite (matriz `A19`–`A24`):** com **duas salas simultâneas** A e B, mensagens **únicas** por sala, agentes com **o mesmo índice** nas duas, a mesma aba tentando migrar de sala, atraso de rede/replay, navegação SPA, reinício do service worker e troca de bucket — **ZERO** mensagens, arquivos ou ações de A são aceitos em B. A migração de sala ocorre **somente por ação autorizada**, com a fila antiga isolada. Testes de **tentativa de forja** (payload com `roomId` alheio, `epoch` desatualizado, HMAC inválido) **rejeitam** de forma segura. **Não há confirmação por mensagem** — a validação é silenciosa e automática.

### UX-01 · Internacionalização: tudo está fixo em pt-BR · `[MELHORIA]` · P1
- **Evidência:** `grep -rn "chrome.i18n"` → **0 ocorrências** em 22.155 linhas; todo o texto está hardcoded em pt-BR (`dashboard/dashboard.html`, `content/content.js`, `livechat/livechat.html`, `popup/popup.html`). O `<html lang="pt-BR">` está correto, mas não há camada de tradução.
- **Impacto:** o usuário não-brasileiro fica com uma extensão em outro idioma; e **toda** alteração de texto exige editar 4 arquivos + CSS.
- **Solução:** (a) extrair **todas** as strings para `shared/i18n.js` com catálogo `{ 'pt-BR': {...}, 'en': {...}, 'es': {...} }` e **detecção automática** do idioma do navegador + seletor na Central; (b) **interpolação** nomeada (`{count}`, `{name}`) — já existe o padrão `{{variavel}}` nos prompts, reaproveitar; (c) `chrome.i18n` para metadados do manifest (nome/descrição) quando houver revisão na Chrome Web Store; (d) **teste** que falha se uma string nova não existir em todos os catálogos.
- **Arquivos tocados:** novo `shared/i18n.js`, `content/content.js`, `dashboard/dashboard.html` + `.js`, `livechat/*`, `popup/*`, `manifest.json`.
- **Esforço:** 5 dias (extração pura ~3 + 2 catálogos).
- **Critério de aceite:** trocar o idioma na Central reflete em todas as superfícies em <200 ms; o teste de paridade de catálogo roda no CI.

### UX-02 · Acessibilidade: sem `aria-*`, sem navegação por teclado, sem foco visível · `[MELHORIA]` · P1
- **Evidência:** `grep -c "aria-" dashboard/dashboard.html` → **0**. O `<input>` de token na Central é campo de texto comum; só existe `.input:focus` (`dashboard/dashboard.css:234`) — **sem `:focus-visible`**. A navegação da Central é por `<button class="nav-item">` (`:21-29`), sem `role="tablist"`/`aria-selected`; os painéis são `<div>` sem `role="tabpanel"`.
- **Impacto:** navegação 100% por teclado e leitor de tela é comprometida; o produto já anuncia "Zero Atalhos Globais" — a acessibilidade é a **consequência direta** dessa escolha e precisa de um caminho alternativo que não capture teclas do navegador.
- **Solução:** (a) **semântica** primeiro: `<nav>`, `<main>`, `<section aria-labelledby>`, `role="tablist"/"tab"/"tabpanel"` na Central, `role="log"` + `aria-live="polite"` no feed do LiveChat (leitor de tela anuncia mensagens novas sem interromper); (b) **`:focus-visible`** com anel de foco de 2 px em todo componente (toolbar, drawer, popup, Central, LiveChat); (c) **navegação por teclado dentro da extensão**: setas/PageUp/PageDown/Escape/Tab em componentes customizados (a página do Arena tem widgets próprios); (d) `aria-label` em todos os botões só-ícone (hoje vários usam apenas `title`); (e) **teste axe-core** no CI contra dashboard/livechat/popup com tolerância zero para violações críticas; (f) respeitar `prefers-reduced-motion` e `prefers-color-scheme` (hoje há 4 temas manuais, mas **nenhum** automático).
- **Arquivos tocados:** `dashboard/dashboard.html` + `.css`, `livechat/livechat.html` + `.css`, `popup/popup.html` + `.css`, `content/content.js` (toolbar/drawer em Shadow DOM).
- **Esforço:** 4 dias.
- **Critério de aceite:** axe-core sem violações críticas; toda a Central é operável só por teclado; o feed anuncia novas mensagens por leitor de tela.

### UX-03 · Nenhuma preferência de **reduced motion** / alto contraste / tema do sistema · `[MELHORIA]` · P2
- **Evidência:** `shared/defaults.js:296` define 4 temas (`native`, `oled`, `dracula`, `nord`, `cyberpunk`); `DEFAULT_SETTINGS.activeTheme` é **manual**; não há `prefers-color-scheme`, `prefers-reduced-motion` nem `forced-colors`.
- **Impacto:** em dark mode do sistema com tema `native` (claro), há contraste insuficiente; animações de "loop ativo" podem incomodar.
- **Solução:** (a) **modo automático**: `native` passa a seguir o SO (`color-scheme: light dark`); (b) `prefers-reduced-motion` desliga as animações de status; (c) `forced-colors: active` respeitado (Windows High Contrast); (d) tema "Alto contraste" dedicado.
- **Arquivos tocados:** `shared/defaults.js`, `content/themes.js`, `dashboard/dashboard.css`, `livechat/livechat.css`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** com dark mode do SO e `activeTheme: native`, a UI é legível; `reduced-motion` elimina animações.

### UX-04 · Estados vazios e de erro pouco，运用 · `[MELHORIA]` · P2
- **Evidência:** `popup/popup.js:84` tem um estado vazio para "nenhuma aba do Arena aberta"; no LiveChat e na Central, o tratamento de erro é genérico. A taxa de `catch (_) {}` silencioso é de **108 ocorrências** e `console.error`/`console.warn` = **0** em todo o pacote.
- **Impacto:** falha silenciosa é o pior tipo de falha para automação — o usuário não sabe que algo quebrou.
- **Solução:** (a) **padrão de erro**: todo `catch` que engole passa a registrar no **log local** (ring buffer, `chrome.storage.session`) com nível e contexto, e a UI mostra toast "ocorreu um erro" com ID de correlação; (b) **states vazios** em todas as listas (Dashboard/LiveChat/Prompts/Macros/Histórico) com CTA; (c) **retry** nos pontos de falha; (d) **modo diagnóstico** (exportar log em `.txt` para o suporte, **sem** segredos).
- **Arquivos tocados:** `shared/storage.js` (ring buffer), `background/service-worker.js`, `dashboard/dashboard.js`, `livechat/livechat.js`, `popup/popup.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** nenhuma falha engolida sem registro; o usuário consegue exportar um diagnóstico redigido.

### UX-05 · Mini-mapa e **busca dentro da conversa do Arena** · `[MELHORIA]` · P2
- **Evidência:** o Drawer (`content/content.js`) e a Central listam sessões e mensagens, mas não há **âncoras/links profundos** para uma mensagem específica no histórico do Arena.
- **Impacto:** encontrar "aquela mensagem onde o Agente 2 mudou de estratégia" exige rolagem manual.
- **Solução:** (a) índice local de mensagens com `convId` + offset; (b) no hover, gerar link para a mensagem no Arena (se a URL suportar âncora) ou **scrollIntoView** no DOM; (c) "pular para a mensagem" no Chat Live.
- **Arquivos tocados:** `content/content.js`, `livechat/livechat.js`, `shared/storage.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** clicar em uma mensagem do histórico rola até ela no Arena.

### UX-06 · Painel de **custos e orçamento** · `[MELHORIA]` · P2
- **Evidência:** `an-tokens` existe no dashboard e `estimateTokens` (`shared/storage.js:397`) faz contagem aproximada de caracteres — **não há** contagem real de tokens, nem custo, nem orçamento.
- **Impacto:** o produto atua sobre limite de créditos; o usuário precisa saber quanto já gastou.
- **Solução:** (a) estimador melhor (heurística por idioma + tokenizer aproximativo de 4 chars/token, ou `tiktoken`-like em WASM se viável); (b) **orçamento por sessão/sala** com alerta e **pausa automática** ao atingir o teto (integrando-se ao `autoContinue`); (c) painel de custo por modelo (com a tabela de preços atualizada — a manutenção é umaSvg tarefa explícita); (d)模式的 "orçamento zero" para impedir spend acidental.
- **Arquivos tocados:** `shared/storage.js`, `dashboard/dashboard.html` + `.js`, `background/service-worker.js`.
- **Esforço:** 3 dias.
- **Critério de aceite:** o painel mostra tokens/custo por sessão e o auto-continue pausa ao atingir o orçamento definido.

---

## 6. P2 — Engenharia, qualidade e release

### ENG-01 · **Zero testes automatizados** · `[FALHA CONFIRMADA]` · P1
- **Evidência:** o ZIP não contém `package.json`, `*.test.js`, `*.spec.js`, `jest.config`, `vitest.config`, `playwright.config` — **nenhuma** infraestrutura de teste em 22.155 LOC.
- **Impacto:** qualquer refactor do motor de salas ou do `pushFilesCommit` pode quebrar silenciosamente. É o que torna todos os itens P0 desta spec arriscados de corrigir.
- **Solução:** (a) **testes unitários** (Vitest) para a lógica pura: `collab-engine.js` (buildTeamRoles, computeAgentBranchName, buildInitialAgentPrompt, scrubSecrets), `integrations.js` (parseGitRepoSpec, extractGithubRepoFromText, sanitizeFilename, tree-builder), `storage.js` (migrations de `settingsVersion` — hoje v2/v3/v4 escrevidas à mão, **precisam de teste de regressão**); (b) **testes de integração** com `fetch`/`chrome` mockados (commitar, deletar arquivo, criar PR, migrar settings); (c) **testes E2E** (Playwright) do fluxo crítico: lançar 1 agent → pedir algo → abrir sala → receber entrega final → exportar; (d) **golden tests** dos prompts gerados (snapshot) — mudar o prompt do agente é mudança de comportamento e deve exigir update explícito do golden; (e) meta: **≥70% de cobertura** em `shared/` e `background/`.
- **Arquivos tocados:** novo `package.json`, `tests/unit/*`, `tests/e2e/*`, `vitest.config.js`, `playwright.config.ts`.
- **Esforço:** 6 dias (MVP 3 dias).
- **Critério de aceite:** `npm test` roda no CI; a cobertura de `shared/` e `background/` é ≥70%; golden tests travam mudanças não intencionais de prompt.

### ENG-02 · Zero CI/CD · `[FALHA CONFIRMADA]` · P1
- **Evidência:** não há `.github/workflows/`, `package.json`, `Makefile` ou script de build — o ZIP é publicado manualmente.
- **Impacto:** releases manuais podem quebrar a extensão (MV3 é sensível: um erro de sintaxe no SW **derruba toda a extensão**).
- **Solução:** (a) pipeline GitHub Actions: `lint` → `test` → `build` (zip determinístico) → `package` (versão do manifest injetada) → `publish` (Chrome Web Store via `chrome-webstore-upload-cli`, com `--auto-publish` só em `main`); (b) **smoke test pós-publish**: abrir a extensão num Chrome headless e verificar que o SW sobe e o popup responde; (c) **versionamento automático** (semver a partir de commits) com changelog gerado; (d) **artifact do ZIP** disponível para download; (e) **matriz de browsers** (Chrome/Edge/Brave) no smoke.
- **Arquivos tocados:** novo `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `scripts/build.mjs`, `CHANGELOG.md`.
- **Esforço:** 3 dias.
- **Critério de aceite:** um tag de versão gera ZIP + publicação automática + changelog.

### ENG-03 · Zero lint / formatação / análise estática · `[FALHA CONFIRMADA]` · P2
- **Evidência:** sem `eslint`, `prettier`, `typescript`/`jsconfig`, sem `editorconfig`. O código mistura `var`/`const`, funções de 200+ linhas e duplicação de helpers (`escapeHtml` existe em `content/content.js:3330` e `esc` em `dashboard/dashboard.js:12` — mesma lógica, dois arquivos).
- **Impacto:** erros de tipo escapam; refactors custam caro; divergência entre superfícies.
- **Solução:** (a) **ESLint** (`flat config`) com `eslint:recommended` + regras de `no-undef` para globals de extensão (`chrome`, `AU_*`); (b) **Prettier**; (c) `jsconfig.json` com `checkJs` (sem migração para TS agora); (d) **extrair o core para módulos ES** compartilhados (`shared/dom-utils.js` com `escapeHtml` único) — reduz duplicação e inconsistência; (e) `no-console` liberado **apenas** no logger central.
- **Arquivos tocados:** novo `.eslintrc`/`.eslint.config.js`, `.prettierrc`, `jsconfig.json`, `shared/dom-utils.js`.
- **Esforço:** 2,5 dias.
- **Critério de aceite:** `npm run lint` falha o CI em qualquer erro; `escapeHtml` existe em **um** lugar.

### ENG-04 · `manifest.json` sem documentação e com `minimum_chrome_version` ausente · `[MELHORIA]` · P2
- **Evidência:** `manifest.json` não declara `minimum_chrome_version`, `content_security_policy`, `commands`, `side_panel`, `declarative_net_request`; `offscreen` e `tabGroups` exigem versões específicas.
- **Impacto:** usuários em Chrome antigo veem erros inexplicáveis; o reviewer da Web Store sempre pergunta sobre as permissões.
- **Solução:** (a) declarar `minimum_chrome_version: "116"` (offscreen); (b) **documentar cada permissão** num `PERMISSIONS.md` com justificativa e o custo de cada uma (isso é literalmente o que a Chrome Web Store exige); (c) `CSP` explícita; (d) `commands` para abrir Central/LiveChat (atalhos da extensão — **não globais**, respeitando a decisão de produto); (e) `side_panel` para a Central como barra lateral nativa (Chrome 114+).
- **Arquivos tocados:** `manifest.json`, novo `PERMISSIONS.md`.
- **Esforço:** 1 dia.
- **Critério de aceite:** o manifest declara versão mínima, CSP e permissões documentadas.

### ENG-05 · Ausência de **rate limiting / backoff exponencial** nas chamadas à API do GitHub · `[FALHA CONFIRMADA]` · P1
- **Evidência:** `shared/integrations.js:622-668` (`ghRequest`) faz `fetch` **sem** `retry`, sem respeito a `Retry-After` e sem tratamento do header `X-RateLimit-Remaining`; o limite secundário é apenas **comentado** (`integrations.js:1013` — "concurrency-limited in batches of 6"). O `403` cai no genérico "verifique o escopo do token".
- **Impacto:** em push de workspace grande (dezenas de blobs), um `403` de limite secundário **aborta a entrega** sem retry, com mensagem que **induz o usuário a erro** ("verifique as permissões do token") — orientação errada que faz o usuário revogar/recriar tokens desnecessariamente.
- **Solução:** (a) **retry com backoff exponencial + jitter** para 403/429/5xx e `ETIMEDOUT`; (b) respeitar `Retry-After` e `X-RateLimit-Reset`; (c) **distinguir** "rate limit" de "escopo insuficiente" na mensagem (ler `x-oauth-scopes` e o corpo `documentation_url`); (d) **orçamento de API**: contador diário por token com teto configurável e alerta; (e) **condensação de fila** para commits grandes; (f) botão "Repetir última operação" no Chat Live.
- **Arquivos tocados:** `shared/integrations.js`, `shared/collab-engine.js` (CLI `au_gh`), `dashboard/dashboard.js`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** um 403 de rate limit é automaticamente reexecutado com backoff e a mensagem final é correta.

### ENG-06 · Ausência de **versionamento de esquema** para salas, prompts e macros · `[MELHORIA]` · P2
- **Evidência:** `shared/storage.js:70-128` só migra `settings` (`settingsVersion` 2→3→4, escrito à mão). `au_collab_rooms_v1` (`background/service-worker.js:353`), `au_prompts_v1`, `au_macros_v1`, `au_folders_v1` **não têm** versão nem migração. O backup exporta `version` da extensão mas **não** um `schemaVersion` dos dados.
- **Impacto:** uma mudança de formato em `v4.0` quebra as salas salvas do usuário **sem que ele perceba** (falha silenciosa).
- **Solução:** (a) `schemaVersion` por chave (`au_collab_rooms_v2`, `au_prompts_v2`, ...) com **função de migração por versão** (`migrateX(v)`), testada com fixtures de versões antigas; (b) **migração idempotente e defensiva** (nunca lançar); (c) no import de backup, **detectar** a versão do backup e avisar quando for antigo; (d) `backup.json` com `schemaVersion` + `extensionVersion`.
- **Arquivos tocados:** `shared/storage.js`, `background/service-worker.js`, `dashboard/dashboard.js`.
- **Esforço:** 2 dias.
- **Critério de aceite:** um backup de `v3.3.1` importa corretamente em `v4.0` sem perda, com aviso exibido.

### ENG-07 · Ausência de **observabilidade** (métricas de saúde,heartbeat, detecção de deadlock) · `[MELHORIA]` · P2
- **Evidência:** o background tem `heartbeatTimer` (`service-worker.js:80`) e `au_anti_throttle_alarm`, mas **não há** medição de taxa de sucesso/falha de loop, nem de "sala travada", nem contadores de erro por operação — as `DEFAULT_METRICS` (`shared/defaults.js:494+`) contam apenas *loops enviados*, *lotes*, *paradas por token*.
- **Impacto:** não há como saber se a extensão está funcionando bem; quando falha, o usuário só percebe que "parou de funcionar".
- **Solução:** (a) métricas de **saúde**: loops tentados vs concluídos, taxa de falha por motivo (captcha/402/429/erro de rede/timeout), tempo médio de收敛 (convergência) por sala, taxa de sucesso de push/PR; (b) **detector de sala travada** (nenhuma mensagem por N minutos com status `generating`) → notificação + ação "reiniciar sala"; (c) **heartbeat visível** na Central ("última sincronização: há 3 s") — o produto já exibe "zero-lag", então expor a verdade é parte da promessa; (d) **modo de diagnóstico** (ENG/UX-04).
- **Arquivos tocados:** `shared/storage.js`, `background/service-worker.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 2,5 dias.
- **Critério de aceite:** a Central mostra taxa de sucesso de loops e detecte/reporta salas travadas.

### ENG-08 · Sem **onboarding** de primeira execução · `[MELHORIA]` · P2
- **Evidência:** `background/service-worker.js:4273` (`onInstalled`) apenas carrega settings e injeta scripts — **não há** wizard, nem tela de boas-vindas, nem `setUninstallURL`.
- **Impacto:** a extensão é instalada e o usuário não descobre o fluxo principal (lançar agent → sala → GitHub).
- **Solução:** (a) wizard de 3 passos na primeira execução (abrir Agent / abrir Sala / conectar GitHub opcional) com **tour**; (b) `chrome.runtime.setUninstallURL` com uma página de feedback **anonimizada** (sem prompts, sem tokens); (c) **detecção de capacidade**: se `chrome.offscreen` faltar, avisar que o anti-congelamento está degradado.
- **Arquivos tocados:** `background/service-worker.js`, `dashboard/dashboard.html` + `.js`, `popup/popup.html`.
- **Esforço:** 1,5 dia.
- **Critério de aceite:** a primeira execução mostra o tour uma vez; desinstalar abre a página de feedback.

### ENG-09 · Ausência de **atualização automática** e de verificação de versão · `[MELHORIA]` · P2
- **Evidência:** `manifest.json` **não** tem `update_url`; nenhuma referência a `chrome.runtime.requestUpdateCheck` ou comparação de versão.
- **Impacto:** usuários ficam em versões antigas com bugs já corrigidos (o guide já evolved de `v3.2` a `v3.3.1`).
- **Solução:** (a) `update_url` apontando para o endpoint oficial do Chrome Web Store; (b) **verificação de versão** no `onInstalled` e no popup, com aviso "nova versão disponível" e link; (c) **notificação de breaking change** quando a extensão sobe de uma versão com schema incompatível (ENG-06).
- **Arquivos tocados:** `manifest.json`, `background/service-worker.js`, `popup/popup.js`.
- **Esforço:** 0,5 dia.
- **Critério de aceite:** a extensão detecta e informa nova versão disponível.

### ENG-10 · Prompt de agente **monolítico** e não versionado · `[MELHORIA]` · P2
- **Evidência:** `shared/collab-engine.js:800+` (`buildInitialAgentPrompt`) monta **um** prompt gigante concatenando papéis, regras, instruções de GitHub e CLI — todas em string. Não há **template versionado**, nem **blocos condicionais** reutilizáveis, nem forma de o usuário **editar** o prompt do agente.
- **Impacto:** mudar uma instrução exige editar strings dentro de template literals; não há como personalizar o agente por **usuário**; e não há golden test (ENG-01) que proteja o comportamento.
- **Solução:** (a) **prompt como dado**: blocos nomeados (`{roster}`, `{github}`, `{chat_rules}`, `{consensus_rules}`, `{delivery}`) versionados (`promptTemplateVersion`); (b) **editor de prompt por sala/perfil** na Central, com preview e diff; (c) **variáveis** `{{...}}` já suportadas pelos prompts de usuário — estender aos blocos do agente; (d) **golden tests** por versão de template; (e) **modo "consenso"** com protocolo explícito: rodadas, contagem de convergência, formato da síntese, critério de parada — hoje implícito no texto.
- **Arquivos tocados:** `shared/collab-engine.js`, `shared/defaults.js`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 4 dias.
- **Critério de aceite:** o prompt do agente é editável por sala na Central, versionado e coberto por golden test.

### ENG-13 · Alegações de marketing não verificáveis no guia e no manifest · `[MELHORIA]` · P2
- **Evidência:** `manifest.json` — `description` cita "Acesso Total a Code, Issues, PRs, Actions, Projects, Wiki e Insights"; o `COMO_INSTALAR.md` anuncia "**0ms** de latência", "**Zero-Loop**", "**Acesso Total**" e "sem piscar abas".
- **Impacto:** (a) "0ms" é **falsificável** — o chat do bucket tem latência de rede de dezenas a centenas de ms; (b) "Acesso Total" inclui Projects via API REST **depreciada** (DATA-05) — a alegação não se sustenta; (c) na Chrome Web Store, alegações não verificáveis geram **rejeição** e desgastam a credibilidade; (d) o usuário que descobrir a divergência perde confiança no resto.
- **Solução:** (a) **revisar as alegações** — substituir por definições verificáveis: "latência típica de X s (medida)", "sem intervenção humana no fluxo normal de push/PR, com limites configuráveis (ARENA-11)", "acesso a Code, Issues, PRs, Actions, Wiki e Insights" (removendo Projects até o GraphQL — DATA-05); (b) **painel de status** com o estado real de cada recurso (o que funciona, o que está degradado, o que requer configuração); (c) **"resource matrix"** na Central: recurso → funciona? → requer o quê?; (d) jamais declarar "ilimitado", "total" ou "instantâneo" sem definição e medição.
- **Arquivos tocados:** `manifest.json`, `COMO_INSTALAR.md`, `dashboard/dashboard.html` + `.js`.
- **Esforço:** 1 dia.
- **Critério de aceite:** nenhuma alegação quantitativa permanece no guia sem definição e medição; a Central tem uma matriz de status de recursos.

### ENG-12 · Ausência de **busca incremental** nos diretórios monitorados · `[MELHORIA]` · P2
- **Evidência:** a extensão depende de `MutationObserver` no DOM do Arena e de polling de rede; não há índice incremental de workspace (PROD-04) nem invalidação por hash.
- **Impacto:** varredura completa do workspace a cada entrega é cara com projetos grandes.
- **Solução:** hashing incremental por `mtime+size` com cache por sala; reaproveitar o índice de PROD-04.
- **Arquivos tocados:** `shared/storage.js`, `background/service-worker.js`.
- **Esforço:** 1,5 dia (item coberto por PROD-04).
- **Critério de aceite:** a segunda indexação de um workspace sem mudanças é >10× mais rápida.

---

## 7. P3 — Roadmap (opcional, com dependência de decisão de produto)

| ID | Item | Por quê | Esforço |
|---|---|---|---|
| `P3-01` | **Cliente/servidor MCP** (`PROD-09`) | Interoperabilidade com o ecossistema de agentes | 5 d |
| `P3-02` | **Licença local + telemetria opt-in** (`PROD-10`) | Monetização e conhecimento de uso (sem coleta de conteúdo) | 6 d |
| `P3-03` | **Sync entre perfis/dispositivos** (`PROD-15`) | Continuidade entre máquinas | 1,5–4 d |
| `P3-04` | **Provedores de arquivo privados** (S3/R2/WebDAV/Drive) (`PROD-16`) | Os 4 hosts atuais são públicos e efêmeros | 4 d |
| `P3-05` | **WebRTC/P2P** para o barramento de sala | Latência real e resiliência sem Filebin | 8 d |
| `P3-06` | **Multi-perfil de workspace** (vários repos na mesma sala) | Salas que tocam 2+ repos | 5 d |
| `P3-07` | **Extensões para outros sites** (Claude, ChatGPT, Cursor) | O motor de automação é genérico; só Arena está integrado | 10 d |
| `P3-08` | **Sandbox de preview de código** (iframe isolado + CSP) | Renderizar artefatos com segurança | 3 d |

---

## 7.5 Migração segura das salas legadas (exigida pelo Ag1)

> Contexto: `ARENA-18` introduz escopo estrito de sala. Salas **criadas antes** da correção podem ter agentes registrados em vínculos que o novo modelo considera inválidos. A correção **não pode** quebrar a automação em andamento.

| Etapa | Ação | Risco | Safeguard |
|---|---|---|---|
| **M1 — Detecção** | Ao carregar `au_collab_rooms_v1`, classificar cada sala em: `legacy_unbound` (agente sem vínculo válido), `legacy_bound` (vínculo ok), `orphan` (agente cuja aba não existe mais) | Nenhum (leitura) | Registro de um **snapshot** das salas antes de qualquer escrita |
| **M2 — Modo tolerante** | Salas `legacy_unbound` continuam operando com o escopo antigo, **porém**: o `payload.roomId` passa a ser **validado contra a lista de salas conhecidas do mesmo `filebinId`** — impede escrita em salas **estranhas**, mas preserva a operação dentro do grupo histórico | Baixo | Janela de transição **configurável** (padrão: 14 dias) e aviso visível na Central: "Sala em modo de compatibilidade" |
| **M3 — Re-vinculação** | Oferecer na Central uma ação de 1 clique: **"Re-vincular abas desta sala"** — relê as abas abertas, casa `tabId` ↔ sala por `chatId`/URL e emite `epoch` novo | Baixo | Re-vinculação é **explícita** (ação do usuário), nunca automática |
| **M4 — Migração forçada** | Após a janela de transição, salas `legacy_unbound` passam a exigir re-vinculação; se ninguém re-vincula, a sala é marcada `needs_human` com **explicação** — **nunca** é apagada nem fica travada | Médio | O conteúdo da sala (mensagens, arquivos, PRs) é **preservado**; apenas o **canal** muda |
| **M5 — Limpeza** | `orphan` (agentes de abas fechadas) são removidos do roster **após** a entrega final, ou marcados `closed` — sem apagar histórico | Baixo | Contagem de órfãos exibida antes da limpeza, com botão de reverter |

**Regras inegociáveis da migração:**
1. **Nenhum dado de sala é apagado** — nem mensagens, nem arquivos compartilhados, nem PRs, nem histórico.
2. **A automação em andamento não é interrompida** durante M2/M3.
3. **Toda re-vinculação é explícita** e auditável; nada muda de sala por inferência.
4. **O escopo estrito nunca é aplicado retroativamente** a um agente que já estava na sala — a menos que a re-vinculação seja confirmada.

## 8. Matriz de rastreabilidade — lacuna × superfície do produto

| Superfície | Security | Data | Produto | UX/A11y | Engenharia |
|---|---|---|---|---|---|
| **manifest.json** | SEC-09, SEC-10, ENG-04 | — | — | — | ENG-04 |
| **background/service-worker.js** | SEC-01, SEC-05, SEC-06, SEC-07, **ARENA-08**, ARENA-13, **ARENA-15**, **ARENA-16**, **ARENA-18** | DATA-01 | PROD-03, PROD-05, **ARENA-05**, **ARENA-11**, ARENA-12 | UX-06 | ENG-06, ENG-07, ENG-08, ENG-09 |
| **shared/collab-engine.js** | **SEC-01**, SEC-06, SEC-08, **ARENA-01**, **ARENA-02**, ARENA-13 | DATA-02, DATA-05 | PROD-04, ENG-10, **ARENA-10**, ARENA-12 | — | ENG-01 |
| **shared/integrations.js** | SEC-02, SEC-03, SEC-05 | **DATA-01**, **DATA-02**, DATA-03, DATA-04 | PROD-14, PROD-16 | — | ENG-05, ARENA-14, **ARENA-17** |
| **shared/storage.js** | SEC-02, SEC-03 | — | PROD-02, PROD-07, PROD-15 | — | ENG-01, ENG-06 |
| **content/content.js** | SEC-02, SEC-07, **ARENA-02**, **ARENA-03**, **ARENA-04**, **ARENA-18** | — | PROD-12, UX-05, ARENA-07 | UX-02, UX-03 | ENG-03 |
| **content/page-bridge.js** | **SEC-07**, ARENA-03 | — | ARENA-07, ARENA-09, **ARENA-15** | — | ENG-01 |
| **content/tempchat-bridge.js** | **SEC-08**, **ARENA-18** | — | — | — | ENG-01 |
| **content/themes.js** | — | — | — | **ARENA-06**, UX-03 | — |
| **dashboard/** | SEC-04, SEC-09 | — | **PROD-01**, PROD-02, PROD-03, PROD-05, PROD-11, **ARENA-11**, ARENA-12 | **UX-01**, **UX-02**, UX-04 | ENG-01, ENG-02, ENG-07 |
| **livechat/** | SEC-08 | — | PROD-01, PROD-12, ARENA-05, ARENA-11, ARENA-12 | UX-01, UX-02 | ENG-01 |
| **popup/** | — | — | PROD-13, **ARENA-11** (PARAR TUDO) | UX-01, UX-02 | ENG-01 |
| **offscreen/** | — | — | PROD-02 (embeddings) | — | ENG-12 |
| *(novo)* `shared/cred-broker.js` | SEC-01, SEC-02 | — | — | — | ENG-03 |
| *(novo)* `shared/arena-adapter.js` | ARENA-09 | — | ARENA-09, ARENA-10 | — | ENG-01 |
| *(novo)* `shared/plugin-runtime.js` | — | — | **PROD-08** | — | ENG-03 |
| *(novo)* `shared/scheduler.js` | — | — | **PROD-03** | — | ENG-01 |
| *(novo)* `tests/**` + `.github/workflows/**` | — | — | — | — | **ENG-01, ENG-02** |
| *(novo)* `tests/fixtures/arena/**` | ARENA-09 | — | ARENA-09 | — | ENG-01 |

---

## 9. Definição de Pronto (DoD) por item — template

Todo item implementado **deve** satisfazer:

1. **Teste** — unitário ou E2E cobrindo o comportamento (incluindo o caso de borda citado no critério de aceite).
2. **Lint limpo** — `npm run lint` sem erros.
3. **Sem regressão de comportamento** — os golden tests de prompt (ENG-10) passam sem alteração não intencional.
4. **Métrica de sucesso observável** — se o item promete redução (ex.: "sem PAT no prompt"), existe um teste **automático** que falha se a promessa for quebrada.
5. **Documentação** — o item aparece no `CHANGELOG.md` e, se for usuário-visível, no tour/ajuda (PROD-13).
6. **Permissões** — se o item exigir nova permissão, ela é `optional` e solicitada no momento do uso (SEC-09).
7. **Não-registro de segredo** — nenhum teste, log, snapshot ou fixture contém PAT, cookie ou conteúdo de conversa real. Fixtures são sintéticas.
8. **Compatibilidade Arena** — se o item toca o runtime do Arena, a matriz `A01`–`A18` (§6.3) permanece **verde**; itens que não tocam declaram isso explicitamente.

### 9.1 Itens do DoD originados no plano de compatibilidade Arena (A15–A18)

| ID | Cenário | Critério de aceite |
|---|---|---|
| **A15** | **Interação humana pendente** — fixtures com pergunta de múltipla escolha, seleção de voz e seleção de imagens; fim de streaming com um desses controles pendente | O Autopilot entra em `WAITING_USER`, **não** envia "Continue" e **não** escolhe pelo usuário; após a escolha, reconcilia o turno antes de retomar. `findTaskReviewPanel` (`content/content.js:570-687`) detecta o painel de revisão de tarefa — **não** demonstra cobertura dos demais cards. Existência e impacto da lacuna a reproduzir (→ ARENA-04). |
| **A16** | **Troca SPA de conversa** — iniciar tarefa na conversa A, navegar à B pela interface **sem reload** | Fila, contadores, identidade, sala e destino de publicação **não** passam a atuar em B; voltar à A restaura apenas os dados de A. Hipótese até teste reproduzível (→ ARENA-03). |
| **A17** | **Conteúdo oculto/privado** — fixture com blocos ocultos e ferramentas, com sentinelas sintéticas | O conteúdo capturado por exportação e pelo TempChat **não** inclui texto privado/oculto. Teste preventivo; **não** afirma vazamento real sem seguir o fluxo completo (→ ARENA-02). |
| **A18** | **Recuperação automática** — heurísticas de `content/content.js:2298-2402`, timeout com resultado incerto | Rascunhos preservados, sem duplicação de envio, confirmação exigida para arquivamento; decisão segura em resultado incerto (→ ARENA-10). |

### 9.1b Matriz de isolamento entre salas (`A19`–`A24`) — nova, a partir do incidente relatado pelo Coordenador

> **Contexto:** o Coordenador reportou **duplicação concreta entre salas em tela**. O código confirma **três** caminhos de escrita/leitura sem escopo de sala (`ARENA-18`), mas a **causa exata do incidente observado** ainda precisa ser isolada por teste. Esta matriz existe para **fechar a investigação**, não apenas para provar o que já sabemos.

| ID | Cenário | Resultado esperado |
|---|---|---|
| **A19** | Duas salas **A** e **B** simultâneas, cada uma com mensagens **únicas** e agentes com o **mesmo índice** (`Agente 1` em ambas) | **ZERO** mensagens, arquivos ou ações de A aparecem em B. O mapeamento `sender` distingue por sala, não por índice |
| **A20** | Uma aba membro de A **tenta** reportar turno com `roomId = B` no payload | Rejeitado de forma segura (`scope_violation`); registrado em log sanitizado; **nenhum** conteúdo de B é retornado |
| **A21** | Mesma aba **migrando** de A para B (sem reload) | A migração ocorre **somente por ação autorizada**; a fila antiga fica **isolada**; comandos com `epoch` desatualizado são recusados |
| **A22** | Atraso de rede / **replay** de mensagem | Dedupe por `(roomId, seq)` impede reentrada; a mensagem não é consumida na sala errada; **não** é marcada como lida se o processamento falhou |
| **A23** | Navegação **SPA** dentro da mesma aba enquanto ela pertence a uma sala | O runtime detecta a troca de conversa (`ARENA-03`) e o vínculo de sala é **re-derivado**; nenhum turno é publicado na sala anterior |
| **A24** | Reinício do **service worker** + troca de `filebinId` entre salas | O estado volátil é reidratado com `epoch` válido; o bucket de uma sala **nunca** é lido para as mensagens de outra |

### 9.2 Plano mínimo de validação reproduzível (consolidado dos agentes)

> **Regras de segurança do teste** (adotadas do Ag1 e do Ag6):
> 1. Usar **perfil Chrome descartável** e valores **fictícios** como `TEST_SECRET_DO_NOT_USE_123456` — **nunca** PAT real ou repositório privado.
> 2. Interceptar a rede com **mocks**; impedir acesso à internet nos **testes negativos**.
> 3. Definir explicitamente **o único local autorizado** para o segredo em cada teste; depois procurar a sentinela no prompt, nas mensagens, no storage, na exportação e no diagnóstico.
> 4. Nos relatórios, registrar **ambiente, versão, fixture, passos, resultado, evidência sanitizada** e a **diferença entre falha observada e hipótese**.

| # | Verificação | Item coberto |
|---|---|---|
| 1 | Exercitar **cada modo** de integração e procurar a sentinela em prompt, mensagens, storage, exportação e diagnóstico | SEC-01, SEC-02, SEC-03 |
| 2 | Simular `storage.session` **indisponível**; encerrar o worker em cada ponto da operação e verificar que o reinício **não repete** efeito remoto incerto | ARENA-16, ARENA-17 |
| 3 | **Forjar** `postMessage` e chamadas `runtime` nos contextos permitidos e negados: mensagem falsificada, **replay**, emissor inválido, payload incorreto e tentativa de ação privilegiada sem autorização — todos devem falhar de forma segura | SEC-07, SEC-08 |
| 4 | Injetar mensagens externas e arquivos maliciosos **como dados**, com textos que tentem alterar a política e paths ZIP inseguros — a extensão **não deve obedecer** às instruções nem publicar dados automaticamente | SEC-08, ARENA-15 |
| 5 | Testar erros de rede: **403, 429 com `Retry-After`, 401, 5xx, timeout** (incluindo timeout **após escrita**) e cancelamento; operação com resultado incerto é **reconciliada** antes de qualquer repetição | ENG-05, ARENA-17 |
| 6 | Testar **token revogado/expirado** e **rate limit secundário** do GitHub; a mensagem final deve ser **correta** (distinguir limite de escopo) | ENG-05, SEC-04 |
| 7 | **Desinstalação** limpa os dados locais e o `setUninstallURL` funciona | ENG-08 |
| 8 | **Snapshot privado** sempre com **prévia + consentimento** e registro de destino; ausência de Filebin **não** equivale a ausência de divulgação (o conteúdo vai ao Arena) | SEC-06, ARENA-08, ARENA-15 |

### 9.3 Cenários de homologação do Arena (matriz completa `A01`–`A14`)

> **Regra de execução (do Ag1, adotada):** primeiro **fixtures locais anonimizadas** e ambiente de testes; depois **smoke manual** em conta de teste autorizada, evitando ações irreversíveis. Registrar versão do navegador, versão da extensão, data, idioma e forma de teste; ocultar dados e credenciais. **Testes reais ainda precisam ser agendados e executados** — os testes em fixtures **não provam** compatibilidade com o serviço real.

| ID | Caso | Resultado esperado |
|---|---|---|
| A01 | Instalar em Chromium compatível, abrir `arena.ai/agent` e chat suportado | Barra da extensão aparece **uma vez**; UI do Arena continua operável; capacidades reconhecidas são exibidas |
| A02 | Navegar em SPA, atualizar e voltar, abrir duas abas | Estado e listeners pertencem à aba/conversa corretas; sem duplicar injeção, botões ou envio |
| A03 | TipTap/ProseMirror, textarea e elementos ocultos | Apenas o editor **ativo** recebe o prompt correto; rascunho existente não é substituído sem aviso |
| A04 | Enviar prompt manual e automático em sessão de teste | **Uma única** submissão observável por operação; estado vai para geração ou desconhecido conforme evidência |
| A05 | Streaming demorado, resposta vazia, stop manual | Não detectar término prematuramente; **nunca** reenviar por simples ausência de texto |
| A06 | Login expirado, CAPTCHA, limite, 429 temporário, offline, 5xx | Pausar e explicar o estado; desafio fica a cargo do usuário; retentativas limitadas e só quando seguro |
| A07 | Mudar modelo ou conversa, alternar abas/grupos recolhidos | Identidade e capacidade refletidas **sem enviar mensagem à conversa errada**; não pressupor throttling garantido |
| A08 | Encerrar o service worker e recarregar em `SUBMITTING` e `GENERATING` | Reconciliar com a página; resultado incerto requer confirmação, **não** reenvio cego |
| A09 | Multiagente com número pequeno de abas de teste | Cada participante mantém papel/aba/estado; pausa global impede novos envios; ausências e divergências reais são mostradas |
| A10 | Mudança de DOM, seletor removido, duplicado ou ambíguo | Desabilitar **somente** a capacidade afetada; preservar rascunho; mostrar diagnóstico; **sem** clicar alvo aleatório |
| A11 | Baixar workspace permitido, rota ausente ou estrutura nova | Conteúdo e origem conferidos; limites de tamanho/extração; erro compreensível e alternativa manual |
| A12 | Modelo exibe indicador "Thinking" | Sem arquivamento/parada por padrão; se a opção estiver ativa, confirmação antes de ação destrutiva; o indicador **não** prova identidade, qualidade ou custo |
| A13 | Tema, zoom 200%, teclado e leitor de tela | Elementos da extensão não encobrem controles críticos do Arena; foco e estados acessíveis, sem atalhos conflitantes |
| A14 | Bridge com mensagens falsificadas e conteúdo externo hostil | Dados da página **não autorizam** ação privilegiada; ausência de vazamento de token; erro seguro e auditável |

### 9.4 Contrato do adaptador Arena (proposto pelo Ag1, adotado)

- `detectCapabilities(document, url) → {version, capabilities, evidence}` — **não** declarar versão do Arena quando não for verificável; `UNKNOWN` é um valor válido.
- `getConversationIdentity() → {conversationId?, tabId, url}` — **não** inferir identidade de chat a partir de uma aba nova ou de um título.
- `observeGeneration() → {state, evidence, observedAt}` — `IDLE | SUBMITTING | GENERATING | WAITING_USER | COMPLETED | ERROR | UNKNOWN`; quando ambíguo, **aguardar o usuário**.
- `preparePrompt(text) → preview` — validar tamanho e editor alvo, preservar rascunho anterior, permitir cancelamento.
- `submitPrompt(operationId) → {accepted|unknown|rejected}` — conferir página/conversa/editor ativo imediatamente antes do envio; `operationId` serve à **reconciliação local**, não garante deduplicação no servidor.
- `stopGeneration()` — parar somente a geração identificada na aba pretendida; pausa da extensão e botão nativo do site são **estados distintos**.
- `getWorkspaceCapabilities()` / `downloadWorkspace()` — detectar disponibilidade; **não** prometer exportação quando indisponível; nunca reenviar arquivos a terceiro sem consentimento.
- **O bridge do mundo MAIN é não confiável**: nenhum segredo nele; mensagens de página **nunca** constituem autorização de acesso ou escrita; esquema, contexto de emissão e política são verificados no service worker; a integração fica **desativada na aba** quando o recurso estiver desligado.

---

## 10. Plano de release sugerido

| Versão | Conteúdo | Esforço |
|---|---|---|
| **v3.4.0 — "Trust & Autonomy"** | **ARENA-11 (Política de Autorização)**, **ARENA-18 (Isolamento de Salas)**, ARENA-01, ARENA-02, ARENA-03, ARENA-04, ARENA-05, ARENA-08, **ARENA-15**, **ARENA-16**, **ARENA-17**, SEC-01, SEC-02, SEC-03, SEC-06, SEC-07, SEC-08, SEC-09, DATA-01, DATA-02, DATA-03, DATA-04, ENG-05, ENG-01 (MVP), ENG-13 | ~25 d |
| **v3.5.0 — "Product"** | PROD-01, PROD-02, PROD-05, PROD-07, PROD-11, PROD-12, PROD-13, PROD-14, UX-01, UX-02, ENG-08, ENG-09, **ARENA-06, ARENA-07, ARENA-13, ARENA-14** | ~34 d |
| **v4.0.0 — "Platform"** | PROD-03, PROD-04, PROD-08, **ARENA-09, ARENA-10, ARENA-12**, ENG-10, ENG-02, ENG-03, ENG-06, ENG-07, UX-03, UX-04, UX-05, UX-06 | ~36 d |
| **v4.1.0 — "Ecosystem"** | PROD-09, PROD-10, PROD-15, PROD-16, P3-05…P3-08 | ~40 d |

---

## 11. Riscos de execução

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Migrar o PAT para fora do prompt (SEC-01) quebra o fluxo `/tmp/au_gh` dos agentes | Alta | Alto | Manter o `au_gh` **como fachada** que fala com o broker; o contrato do comando não muda |
| Cifrar o snapshot (SEC-06) torna o upload inútil para o agente que precisa do ZIP | Média | Alto | Cifrar apenas quando o repo for privado **e** entregar a chave por canal separado (fora do bucket) |
| `pushFilesCommit` com `sha: null` pode apagar arquivos legítimos se a extração do workspace for incompleta | Média | **Crítico** | Emitir `sha:null` **apenas** para paths confirmados no base tree e ausentes no payload **validado**; dry-run + diff antes de aplicar |
| Refatorar `collab-engine` quebra o prompt gerado (efeito no comportamento dos agentes) | Média | Alto | Golden tests (ENG-01) **antes** de qualquer refactor do prompt |
| A correção de deleção expõe segredos que estavam "ocultos" no repo | Alta | Médio | Avisar explicitamente na UI: "arquivos removidos serão deletados no repositório" + diff pré-commit |
| Extensão cresce rápido →declarações da Web Store e manutenção | Média | Médio | Manter o core enxuto; sistema de plugins (PROD-08) para capacidades novas |
| Checklist de a11y e i18n consome tempo sem retorno visível imediato | Média | Baixo | Tratar como **débito técnico** com quota fixa (ex.: 10% do tempo por sprint) |
| `ARENA-04` (pausar em card interativo) pode **reduzir a autonomia** e frustrar quem quer zero-loop | Média | Médio | Manter a detecção **ativa por padrão**, mas oferecer auto-resposta **allowlisted** para `ask_user` de múltipla escolha; documentar claramente |
| `ARENA-09` (adapter) exige reescrever partes do runtime e pode introduzir regressão | Alta | Alto | Introduzir o adapter **ao redor** do código existente (fachada), sem reescrita; golden tests + matriz `A01`–`A14` verde a cada passo |
| `ARENA-08` (CAS do Arena) depende de **rota não documentada** do Arena | Média | Alto | Tratar a rota como **dependência sujeita a mudança**, não como contrato; manter o upload cifrado como alternativa e falhar com mensagem clara |
| `ARENA-05` (re-eleição) pode gerar **sínteses duplicadas** se o líder antigo voltar | Média | Médio | Marcar a sala com `leaderEpoch` monotônico; apenas um líder é válido por época |
| Persistência em `/home/user/au_state` pode não sobreviver à hibernação do sandbox | Alta | Médio | Reconhecer explicitamente como *melhor esforço*; o estado crítico permanece no `chrome.storage.session` (navegador) |
| Corrigir o vazamento de `<thought>` pode **remover informação útil** do fluxo multi-agente | Média | Baixo | Tornar o filtro configurável e **mostrar** o que foi filtrado (contador por mensagem) |
| **ARENA-18**: escopo estrito pode **interromper** o fluxo de salas legadas que dependem do auto-cadastro | Alta | Médio | **Migração controlada**: salas antigas mantêm o auto-cadastro **apenas** quando a aba já está no mesmo bucket; escopo novo é opt-in por sala e com log |
| A validação por `epoch` pode **descartar** comandos legítimos em transições válidas | Média | Médio | `epoch` só é incrementado em **re-ligação explícita**; o valor antigo é aceito por uma janela curta de carência |

---

## 12. Como este SPEC foi construído (transparência metodológica)

- **Auditoria estática** dos 27 arquivos do ZIP, com grep dirigido por padrão de defeito (segredos, `postMessage`, `innerHTML`, `catch` silencioso, `aria-*`, `i18n`, `fetch` hosts, `manifest`, `pushState`, `DataTransfer`).
- **Rodada 2 (v2.0):** auditoria de runtime focada no protocolo TempChat e na compatibilidade com o arena.ai, autorizada pelo Coordenador, com **verificação direta no código** de cada achado proposto pelos agentes (Ag2 e Ag4 trouxeram 15 achados; **todos os que passaram pela verificação de código foram confirmados**; os que dependiam de comportamento foram rebaixados a "impacto a reproduzir em E2E").
- **Confronto cruzado entre agentes** da Sala #1685 via TempChat: um achado só entrou no documento **após** confirmação de ao menos um segundo agente (regra do consenso) — foi assim que o achado "não existe storage de salas" foi **corrigido** (existe em `background/service-worker.js:353`), que as afirmações absolutas foram rebaixadas a `[RISCO CONDICIONAL]`/`[MELHORIA]`, e que o gatilho ">25 mensagens" foi corrigido para "depende de latência/falha de host".
- **Correções de rigor incorporadas:** (a) `/home/user/.arena` **não** é usada como persistência — o SPEC usa `/home/user/au_state` com escrita atômica, reconhecendo que a persistência/tempo do sandbox variam por serviço; (b) `origin`/`source`/`MessageChannel` **não** autenticam JS hostil da própria página — os itens correspondentes são `[RISCO CONDICIONAL]` e exigem PoC; (c) **zero-loop é preservado como opção autorizada**, com limites, pausa e supervisão configuráveis — a aprovação pontual incide sobre **publicação/upload/ações externas sensíveis**, não sobre cada envio normal ao Arena; (d) alegações de marketing ("0 ms", "Acesso Total") foram treatmentadas como item (ENG-13).
- **Sem** execução em navegador, sem pen-test, sem verificação de serviços externos: os itens marcados `[RISCO CONDICIONAL]` **exigem teste exploratório** antes de virar "vulnerabilidade".
- **Princípio adotado:** *ausência de evidência ≠ ausência de funcionalidade*. Recomendações sem lastro no código foram rebaixadas como `P3` ou descartadas (ex.: PWA, WebRTC, MFA, audit-log imutável e API REST interna foram **rebaixados** de "faltas" a "roadmap", por serem decisões de produto e não defeitos).

---

*Documento gerado pela Sala TempChat #1685 — Agente 7 (Relator de Consenso), com contribuições verificadas dos Agentes 1–6.*

***Versão 2.3 — CONSENSO FINAL.*** Inclui:
- o bloco de compatibilidade com o arena.ai (`ARENA-01`…`ARENA-18`);
- a matriz de homologação `A01`–`A18` + a matriz de isolamento entre salas `A19`–`A24`;
- o plano de validação reproduzível (§9.2);
- a **Política de Autorização por Tarefa** (`ARENA-11`), que incorpora a diretiva do Coordenador sobre humano-no-loop mínimo;
- o **vazamento entre salas** (`ARENA-18`), P0, com três caminhos confirmados em código;
- a **migração segura das salas legadas** (§7.5);
- a revisão de alegações de marketing (`ENG-13`).
