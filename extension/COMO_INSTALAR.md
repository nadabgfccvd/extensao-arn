# Arena Ultra v4.5.0 — Guia de Instalação, Time Unido Multi-Agent e Segurança

A **Arena Ultra v4.5.0** é uma extensão Manifest V3 **Zero-Build** (pronta para instalar sem precisar de Node.js ou compilação) feita sob medida para **Brave, Microsoft Edge, Opera / Opera GX, Arc, Vivaldi e Google Chrome**, seguindo integralmente a especificação `SPEC.md` (`v4.0`) + **Protocolo de Time Unido Escalável (`v4.5.0`)** para qualquer quantidade de Agents (`2` a `60+` simultâneos).

> **Diretriz Governante (`SPEC.md §0.0`):** Máxima autonomia com **mínimo humano no loop** — autorização única por tarefa (ou modo automático permanente), zero popups repetitivos durante o fluxo normal, pausa exclusiva em exceções realmente indecidíveis por máquina (`needs_human` / `WAITING_USER`) e botão global **`🛑 PARAR TUDO`** (< 2s) sempre acessível.

---

## Como Instalar em 3 Passos (Menos de 30 Segundos)

1. **Baixe e extraia** o arquivo `arena-ultra-extension.zip` em uma pasta fixa no seu computador (ou use diretamente a pasta `arena-ultra`).
2. Abra a página de extensões do seu navegador:
   - **Brave:** digite `brave://extensions` na barra de endereços
   - **Edge:** digite `edge://extensions`
   - **Opera / Opera GX:** digite `opera://extensions`
   - **Arc / Chrome / Vivaldi:** digite `chrome://extensions`
3. Ative a chave **"Modo do desenvolvedor"** (*Developer mode*), clique em **"Carregar sem compactação"** (*Load unpacked*) e selecione a pasta `arena-ultra` (a pasta que contém o arquivo `manifest.json`).

---

## Destaques da Arquitetura v4.0.0 (`SPEC.md`)

- **Segurança & Cofre Zero-Token (`SEC-01..10`):**
  - Nenhum PAT do GitHub entra em prompts, comandos shell (`askPass` legado removido), logs, diagnósticos ou backups JSON (`SEC-01`, `SEC-03`).
  - Credenciais permanecem exclusivamente em `chrome.storage.session` (memória volátil da sessão, sem fallback silencioso para disco — `ARENA-16`), ou opcionalmente cifradas em disco com **PBKDF2 (100.000 iterações) + AES-256-GCM** mediante senha explícita (`SEC-02`).
  - Repositórios privados usam **Proxy CAS Direto pelo navegador** como padrão (zero upload externo; bundles externos exigem cifra **AES-256-GCM** com magic bytes `AU4E` ≠ `PK` — `SEC-06`, `ARENA-08`).
  - Handshake `postMessage` autenticado por nonce de 2 vias entre mundos (`SEC-07`), assinatura **HMAC-SHA256** por sala com selo `⛔ Fonte externa não verificada` para mensagens não assinadas (`SEC-08`) e permissões mínimas justificadas em `PERMISSIONS.md` (`SEC-09`).
- **Integridade Git & Dados (`DATA-01..05`, `ENG-05`):**
  - Deleções (`sha: null`) e renomeações aplicadas com segurança na Git Trees API **somente** quando o snapshot do Workspace retorna `status === 'complete'` (`DATA-01`, `ARENA-15`).
  - Preservação de permissões executáveis (`100755`) e symlinks (`120000`) (`DATA-02`), filtragem cirúrgica de diretórios de build na raiz + `.gitignore` + `.au-manifest.json` (`DATA-03`), guarda explícita de forjas não-GitHub (`DATA-04`), Projects v2 via GraphQL (`DATA-05`) e backoff exponencial respeitando `Retry-After` / `X-RateLimit-Reset` (`ENG-05`).
- **Isolamento Estrito de Salas & Runtime Arena (`ARENA-01..18`):**
  - **Isolamento determinístico entre salas (`ARENA-18`):** Vínculo aba↔sala exclusivo do Service Worker (`bindingEpoch` monotônico), bloqueio e quarentena de vazamento entre salas, proibição de sequestro por hash de URL ou auto-join remoto, `filebinId` derivado criptograficamente por sala e migração automática de salas legadas (`M1–M5`).
  - `/tmp/au_chat` paralelo (`ThreadPoolExecutor(8)`, estado atômico em `/home/user/au_state` — `ARENA-01`), filtro de blocos `<details>`/raciocínio (`ARENA-02`), guarda de rota SPA (`ARENA-03`), detecção de cards interativos (`ask_user`/voz/imagem/conectores → `WAITING_USER` — `ARENA-04`), reeleição automática de Líder Sintetizador (`leaderEpoch` — `ARENA-05`), injeção real de anexos no Tiptap (`ARENA-09`), matriz verificável de consenso (`ARENA-12`) e reconciliação de operações incertas por `operationId` (`ARENA-17`).
- **Produtividade, Exportação OOXML & Diagnóstico (`PROD-01..14`, `UX-01..06`, `ENG-01..13`):**
  - **Δ Diff Unificado da Sala** com matriz de conflitos (`PROD-01`), **Busca Global** (`PROD-02`), **Agendador Cron** via `chrome.alarms` (`PROD-03`), **Memória Persistente por Repositório** (`PROD-04`), **Promoção 1-Clique de Aba p/ Sala** (`PROD-12`), exportação real em **Word (`.docx` OOXML), Markdown, Resumo Executivo, PDF/HTML A4 e JSON** (`PROD-11`), diagnóstico de Deadlock (`ENG-11`), suporte a **PT-BR / EN / ES** (`UX-01`) e acessibilidade completa (`UX-03`).

### Como Executar a Suíte Automatizada de Testes (Opcional para Desenvolvedores)
```bash
cd arena-ultra
node scripts/verify-extension.js
node --test tests/*.test.js
```


---

## Principais Recursos Incluídos

### 1. Auto-Continue Autônomo no Agent Mode (Até Esgotar Tokens)
- **Envio Contínuo Automático:** Assim que o Agent encerrar uma resposta/turno (confirmado tanto pela stream de rede quanto pela estabilização do DOM para nunca interromper chamadas intermediárias de ferramentas), a extensão envia automaticamente o próximo prompt para ele voltar ao trabalho.
- **3 Modos Combinados:**
  - **Regras Condicionais Inteligentes:** Analisa a última resposta do Agent (ex: erros no terminal, pedidos de confirmação ou etapas pendentes) e responde com o comando ideal.
  - **Fila Sequencial + Loop:** Executa uma lista ordenada de etapas (ou uma **Macro de Workflow**) e, ao terminar a fila, entra automaticamente em loop contínuo.
  - **Prompt Fixo Configurável:** Envia seu comando contínuo personalizado em todos os turnos.
- **🙈 Chat Ao Vivo 100% Limpo — Prompts Automáticos e do Sistema Ocultos por Padrão (`v3.2.2`):** Os prompts gerados pelo modo automático/colaborativo **nunca aparecem nem afogam o Chat Live** (nem a conversa ao vivo dentro do próprio `arena.ai/agent`), exibindo apenas as mensagens reais dos Agents e suas orientações! Você pode alternar a visibilidade quando quiser em 1 clique no botão **`🙈 Prompts Auto`** da barra superior ou nas Configurações.
- **Auto-Retry Automático em Falhas Temporárias do Arena (`Failed to start session` / `Failed to create chat session`):** Quando o servidor/sandbox do Arena falha ao iniciar a sessão ou expira o `trigger-session`, a extensão detecta o erro na rede/UI em tempo real e **reenvia o prompt automaticamente** (e se o container `/agent/<id>` continuar morto após 3 reenvios no Turno 1, arquiva a conversa quebrada e abre uma nova aba `/agent` limpa com o mesmo prompt!).
- **Parada Imediata ao Acabar Tokens & Pausa Inteligente em reCAPTCHA:** Monitora avisos oficiais de esgotamento de cota do Arena (`This session has reached its token usage limit`, `Out of credits for today`, HTTP `402`), interrompe o loop na hora e dispara **alerta sonoro, título piscando, badge vermelho, notificação Desktop e Webhook Discord opcional**. Caso o Arena exiba o modal `"Security Verification"` (`Não sou um robô`), o Autopilot entra em espera laranja e **retoma sozinho** assim que você marcar a caixa.
- **Blindagem contra Compactação, Segundos Planos, Área de Trabalho 2, Tela de Bloqueio e Economia de Memória:** Detecta automaticamente o card `"Esta tarefa foi bem-sucedida?"` (`Continuar trabalhando`), respeita turnos longos de raciocínio/terminal e sessões em compactação (`Conversation compacting`), e mantém os loops vivos mesmo em abas ocultas, janelas em outra Área de Trabalho do Windows (`Win + Ctrl + Setas`), Tela de Bloqueio (`Win + L`) ou após descarte por Muita RAM em Uso (*Memory Saver*).

### 2. Começar Vários Chats no Agent Mode ao Mesmo Tempo (Multi-Agent Launcher)
- **Modo Enxame (Swarm):** Abre `N` abas em `https://arena.ai/agent` com o mesmo prompt em paralelo.
- **Modo Lista de Tarefas:** Cada linha vira uma aba independente no modo Agent trabalhando em paralelo.
- **Modo Matriz de Variáveis:** Combina um template com `{{variavel}}` e uma lista de itens, criando um Agent dedicado para cada item.
- **Auto-Continue Pré-Ativado + Tab Groups:** Já liga o Autopilot em todas as abas criadas e agrupa tudo em um grupo colorido no navegador.

### 3. ⚡ Nova Guia Dedicada "Chat Live" & Modo Colaboração em Tempo Real (4 Dígitos + `/tmp/au_chat`)
- **⚡ Guia Dedicada "Chat Live" (`livechat/livechat.html`):**
  - Clique no botão **`⚡ Chat Live`** na Barra de Prompt do Arena, no Popup, no Drawer `🤝 TempChat` ou na Central para abrir uma **nova guia dedicada da extensão** mostrando em tempo real **todos os Agents do Time conversando entre si** (`0ms` de latência via evento delta incremental e DOM isolado que nunca pesa no navegador).
  - Converse direto com os modelos enquanto eles trabalham: envie mensagens para **todos os Agents** ou **direcione para um `@Agente N` específico**, publique avisos urgentes no `/tmp/au_chat` do terminal deles no meio do turno e dispare automaticamente nos Agents ociosos para responderem na hora!
- **⚡ Conversa em Tempo Real Entre os Modelos (`/tmp/au_chat` Durante o Turno + Streaming Ao Vivo):**
  - Os Agents não precisam mais esperar o fim de um turno longo para se falar! Cada Agent recebe automaticamente o utilitário executável `/tmp/au_chat` (`send`, `read` e `wait`) persistente entre chamadas de terminal para **conversar em tempo real com os colegas e com você no meio da execução**, alinhar contratos/arquitetura ao vivo e sincronizar instantaneamente todas as mensagens `⚡` no Chat Live e na ponte `tempchat.online`.
- **🚫 Modo Recusa de Modelos Thinking, Arquivamento Automático (`···` → `Archive`) & Portão de Admissão no Time (Ativado por Padrão):**
  - Sempre que um modelo exibir os indicadores de raciocínio lento do Arena (`> Thinking...`, `🧠 Thinking...` ou `🧠 Thought for X seconds`), a extensão **clica em `Stop generating` imediatamente**, **abre o menu de 3 pontos (`···`) da conversa na barra lateral do Arena e clica em `Archive` (`Arquivar`) automaticamente para não poluir seu histórico**, e **sorteia um novo chat `https://arena.ai/agent`** até encontrar um modelo rápido que responda direto sem Thinking.
  - **Portão de Admissão em Tempo Real no Time:** Na Sala TempChat e ao unir abas abertas, cada agente entra em **Triagem (`🔍 TRIAGEM`)** e **é promovido em tempo real ao Time Colaborativo (`✅ NO TIME`) assim que responde sem Thinking** — impedindo que modelos recusados poluam o chat da equipe. Pode ser ligado/desligado em 1 clique no botão **`🚫 Sem Thinking: ON`** da Barra de Prompt, Popup, Drawer ou Central.
- **Ponte Ao Vivo com `https://tempchat.online`:** Além do barramento interno instantâneo (imune a bloqueios Cloudflare e compatível com qualquer modelo do Arena), você pode clicar em **"🌐 Ponte tempchat.online"** (ou marcar o espelhamento automático) para abrir/entrar numa sessão real de 4 dígitos no site `tempchat.online` com sincronização bidirecional.
- **3 Dinâmicas de Equipe Selecionáveis:**
  - *Equipe de Especialistas:* Arquiteto Principal + Engenheiro Implementador + Especialista de QA/Segurança + Líder Sintetizador.
  - *Divisão Paralela + Líder:* Divide o escopo em frentes independentes sem retrabalho + Líder Sintetizador consolidador.
  - *Debate & Consenso entre Pares:* Propostas independentes com auditoria cruzada até convergir na melhor solução.
- **Você na Sala como Coordenador em Tempo Real + 2 Modos de Conclusão:** Converse em tempo real na Sala TempChat (pelo Drawer `🤝 TempChat` na aba do Arena ou pela Central) — suas mensagens são publicadas na hora no barramento ao vivo para os Agents lerem via `/tmp/au_chat read` ainda durante o turno atual, além de entrarem no próximo turno! Escolha a qualquer momento entre **Parada Inteligente na Entrega Final Consolidada (`[ENTREGA_FINAL_PRONTA]`)** ou **Refinamento Contínuo até Esgotar os Tokens**.

### 4. Novidades Práticas `v3.4.0` — Quadro Único, Radar Git, Deduplicação, Cofre Zero-Token, SLA & RBAC por Agente
- **📋 Quadro Compartilhado de Atribuições & Contratos com Atualização Única (Zero Duplicatas):**
  - Cada Sala TempChat mantém um **Quadro Único (`sharedBoard`)** atualizado por chave (*upsert-by-key* sem duplicar entradas!), acessível na barra **`📋 Quadro Único & Contratos`** do `Chat Live`, na Central e via comandos `/tmp/au_chat status`, `/tmp/au_chat contract` e `/tmp/au_chat board` no terminal dos Agents (ou tags `[QUADRO_UNICO]` / `[CONTRATO_UNICO]`).
- **🔔 Radar Git Automático de Branches & Pull Requests:**
  - A extensão monitora automaticamente branches e Pull Requests do repositório conectado e **publica avisos imediatos no Chat Live, no Quadro Único e no `/tmp/au_chat` dos Agents** sempre que uma nova branch surge, avança em SHA ou um PR é criado/mesclado/fechado!
- **🧹 Mensagens Deduplicadas Ponta-a-Ponta:**
  - Impressão digital normalizada (`computeMessageFingerprint`) elimina mensagens repetidas entre streaming `⚡`, `/tmp/au_chat send`, resumos `[TEMPCHAT]` de fim de turno e sincronização de prompts — exibindo contador ao vivo de duplicatas bloqueadas.
- **🔐 Cofre de Credenciais / Integração Git SEM Tokens Expostos no Prompt (`vault_broker_zero_token` — Padrão):**
  - O Personal Access Token (PAT) **nunca entra no texto do prompt nem em variáveis visíveis**: permanece isolado no Cofre de sessão da extensão (`chrome.storage.session`), enquanto `/tmp/au_gh` opera via **Broker Autenticado por Nonce por Agente (`agentVaultCap`) + Exportação CAS Workspace** para `overview`, `prs`, `issues`, `actions`, `push` e `pr-ship`!
- **⏱️ Estado Claro & Tempo Limite (SLA) para Integração Final:**
  - Máquina de estados explícita (`Inicializando` → `Implementando` → `Aguardando Pares` → `🎯 Integração Final Pronta!` → `⏰ Tempo Limite Atingido` → `✅ Concluída`) com cronômetro regressivo de SLA, botões **`+10m Prazo`** e **`🎯 Liberar Síntese Final`**, e anúncio automático ao Líder Sintetizador assim que todos os módulos ficam prontos ou o prazo limite chega.
- **🛡️ Indicador de Escopo/Permissões & Duração da Credencial GitHub + TTL de Sessão do Cofre:**
  - Audita em 1 clique o tipo de token (`Classic PAT ghp_`, `Fine-Grained github_pat_`, `OAuth gho_`), escopos reais (`X-OAuth-Scopes`: `repo`, `workflow`, `project`), capacidades efetivas (`Read`, `Push/Branch`, `Pull Requests`, `Actions`), **validade/expiração oficial do GitHub (`GitHub-Authentication-Token-Expiration`)** e **TTL configurável da sessão do Cofre** com botão **`🚫 Revogar Cofre`** instantâneo.
- **👮 Gestão Centralizada de Acesso por Agente (RBAC GitHub):**
  - Controle individual em tempo real no `Chat Live` e na Central para cada agente (`🐙 Push + PR`, `🌿 Só Branch`, `👁️ Somente Leitura` ou `🚫 Acesso Revogado`), com **isolamento de branch** e **rotação imediata da chave de capacidade (`vaultCap`)** ao revogar um agente!

### 5. GitHub Autônomo Zero-Loop: Pull Requests Diretos + Acesso Total às 7 Abas (`v3.3.2`) & Hub de 4 Sites TempFiles
- **Pull Requests Autônomos sem Você no Loop (`v3.2.4`–`v3.3.2`):**
  - Basta clicar em **`🔑 Gerar Token`** (no botão **`🐙 GitHub`** do `arena.ai` ou na Central — já abre o GitHub com os escopos `repo,workflow,project` marcados!), colar o Token PAT e informar o link do repositório (ex.: `https://github.com/nadabgfccvd/My-Path` ou até a barra inteira `[Code](...) - [Issues](...) - [Pull requests](...)`).
  - **CLI Python `/tmp/au_gh` Injetada Automaticamente no Terminal dos Agents:** Elimina 100% dos problemas de `fetch_page` em páginas HTML do GitHub, conectores desconectados do Arena (`list_connector_tools`) e erros de escape JSON em `curl`:
    - `/tmp/au_gh overview` → Resumo completo de **Code + Branches + Issues + Pull Requests + Actions + Commits** em 1 comando;
    - `/tmp/au_gh prs` / `/tmp/au_gh pr-ship "Título" "Descrição"` → Faz `git add -A`, `commit`, `push` na branch de PR e **cria ou atualiza o Pull Request automaticamente** sem pedir aprovação humana;
    - `/tmp/au_gh issues` / `/tmp/au_gh issue-new` / `/tmp/au_gh issue-comment` → Lê, cria e comenta **Issues**;
    - `/tmp/au_gh actions` / `/tmp/au_gh action-jobs <run_id>` → Lê execuções e falhas de CI/CD do **GitHub Actions** (e edita `.github/workflows/*.yml`);
    - `/tmp/au_gh projects` / `/tmp/au_gh wiki` / `/tmp/au_gh insights` → Acessa **Projects, Wiki (`.wiki.git`) e Insights/Pulse** direto pelo terminal!
  - **Rede de Segurança Automática na Extensão + Extração Inteligente de Workspace ZIP & CAS Manifest (`v3.2.5`–`v3.3.2`):** Suporta tanto o endpoint `/download-workspace` quanto a nova arquitetura Content-Addressed (`CAS Manifest` `/api/chat/:id/workspace/latest?includeManifest=true` + `/api/chat/workspace/cas/user/:hash`) do `arena.ai`, com fallback automático para o Workspace ao vivo da aba mesmo se um link `.zip` temporário expirar ou no modo `extension_proxy_push` sem arquivo `.zip`, persistência segura em `chrome.storage.session` (RAM) durante ciclos de hibernação de 30s do Service Worker MV3, deduplicação inteligente de pushes GitHub, replay automático de prompts após reload de sessão estagnada (`Stopped chat response cannot be matched`), e Modo Zen compatível com a árvore `sidebar-wrapper` oficial do `arena.ai`!
- **Hub Inteligente de 4 Sites de Arquivo Temporário (Testados ao Vivo no Sandbox do Arena):**
  - **1. Filebin.net** (bucket compartilhado por sala de 6 dias + listagem JSON automática), **2. Litterbox (Catbox.moe)** (até 200 MB • 1h a 72h), **3. Uguu.se** (até 128 MB) e **4. x0.at** (upload raw minimalista).
  - **Fallback Automático em Cascata (`Filebin → Litterbox → Uguu → x0.at`):** Se qualquer provedor oscilar, tanto os comandos `au_upload` / `au_download` injetados no terminal dos Agents quanto o uploader da extensão tentam automaticamente o próximo host e sincronizam o link `[ARQUIVO_COMPARTILHADO]` na Sala TempChat!

### 5. Execução Simultânea Ultra-Leve (Zero-Lag em Longas Sessões) & Abas Agrupadas
- **Arquitetura Zero-Lag para Longas Horas de Uso Contínuo (`v3.2`):**
  - Leituras `O(1)` livres de *layout reflow* (`textContent` sem `.innerText` nos ticks de background), interceptador `requestAnimationFrame` restrito exclusivamente a milissegundos de comando (`inCommand > 0`), cache em memória e debounce de gravações `chrome.storage.local` (evitando serializações IPC pesadas no navegador), e *short-circuit* instantâneo `0ms` de triagem Thinking após confirmação do modelo limpo.
- **Motor Background Anti-Congelamento + Desbloqueio de Tab Groups Recolhidos:** Combina `Service Worker Heartbeat`, documento `Offscreen` com Web Worker de `1.8s`, porta persistente `runtime.Port`, `MutationObserver` sem throttling, `bgSafeSleep` e **suporte nativo sem piscar abas para Tab Groups recolhidos (`chrome.tabGroups`)**.
- **Mission Control ao Vivo:** Veja status, contagem de loops e tokens de todas as abas abertas, pause/retome todas com 1 clique, envie um comando em massa (*Broadcast*), divida janelas lado a lado (*Split View*) ou baixe o Workspace (`/download-workspace`) de qualquer sessão Agent.

### 6. Produtividade, Prompts, Organização, Analytics & Temas
- **Produtividade & Prompts:** Templates com preenchimento automático de `{{variáveis}}`, menu rápido `/` direto no campo de chat (ou clicando em `/ Prompts`), Macros prontas para Agent Mode e importação/exportação JSON.
- **Zero Atalhos Globais Conflitantes:** Todos os recursos são 100% acessíveis por botões visuais na Barra de Prompt, Drawer Lateral, Popup e Central em Tela Cheia — sem capturar teclas globais do seu navegador.
- **Organização & Exportação:** Auto-Save automático de snapshots a cada turno do Agent, organização em Pastas e Tags, Busca Global no conteúdo completo e exportação em **Markdown (`.md`)**, **PDF / HTML Estilizado** e **JSON**.
- **Estatísticas Agent & Placar Battle:** Painel dedicado às métricas de loops automáticos, lotes disparados, paradas por limite, tempo ativo e rastreador pessoal de votos e notas de modelos no Battle Mode.
- **Presets Visuais em 1 Clique:** *Nativo Arena*, *OLED Pure Black*, *Dracula Pro*, *Nord Frost*, *Cyberpunk Neon* e *Minimal Glass*, além de Modo Zen e controle de largura Widescreen.


## Timer de sessão (v4.5.0)
Novas sessões do lançador recebem o instalador do timer apenas no primeiro prompt. Padrão: 60 minutos; **Dashboard → Auto-Continue → Ciclo mínimo com timer real: 120** permite duas horas. Recarregue a extensão e as abas após atualizar. Sessões antigas sem o instalador precisam ser reiniciadas pelo lançador para receber o timer. A duração é uma instrução verificável, não um bloqueio dos limites do Arena.


## Menções e alertas (v4.5.0)
Use os nomes exatos mostrados no quadro da sala, por exemplo:
`/tmp/au_chat ask "@[Agente 2 • Frontend]" "Pode confirmar o contrato?"`
`/tmp/au_chat reply "@[Agente 1 • Arquiteto]" "Confirmado."`
`/tmp/au_chat inbox` consulta mensagens novas; `sync` também mostra o quadro.
`@Agente2` e `@Todos` continuam válidos. Isso direciona e destaca a mensagem, mas não a torna privada.
Durante o turno, os agentes devem consultar o chat entre etapas ou usar `/tmp/au_timer pulse 18`. O alerta na aba é visual para o usuário; não significa que um modelo em geração leu a mensagem imediatamente. Nenhum prompt extra é enviado por notificação.
Inicie novas sessões pelo lançador para instalar o CLI atualizado.


### Intervalo de mensagens
Mensagens dos agentes entram em fila por sala com delay aleatório de 300 a 750 ms por publicação. Suas mensagens de coordenador não aguardam a fila. O CLI atualizado também aplica jitter no envio; atualize a extensão e lance novas sessões para recebê-lo. O delay não bloqueia agentes de trabalhar simultaneamente.


## Harness customizado (v4.5.0)
1. Extraia o ZIP e recarregue a extensão e as abas.
2. Em Dashboard → Auto-Continue, deixe **Harness** habilitado para novas sessões.
3. Inicie uma nova sala para receber os comandos e o gate de revisão cruzada.
4. Leia `HARNESS_GUIDE.md` para exemplos e `HARNESS_RESEARCH.md` para as fontes e decisões.

Sem instalação de Node/npm. Python roda no workspace do agente. Salas antigas não recebem automaticamente o gate novo no meio da execução. Relatórios são declarados pelos agentes, não uma atestação remota da extensão.


## Agent Kit dedicado (v4.5.0)
A extensão funciona normalmente sem o kit. Depois de publicar o repositório completo com o pacote fixado, ative **Dashboard → Auto-Continue → Agent Kit via GitHub** e inicie novas salas/sessões. Não ative antes de o arquivo estar público: o instalador falha fechado em 404/hash divergente.

Leia `PUBLICAR_AGENT_KIT.md` e `AGENT_KIT_RESEARCH.md`. A versão do agente está no bundle de repositório `extensao-arn-github.zip`, pasta `agent-kit/`. Não é outra extensão de navegador.
