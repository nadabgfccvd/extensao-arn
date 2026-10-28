# Justificativa de Permissões — Arena Ultra v4.0.0 (`PERMISSIONS.md`)

Este documento descreve de forma auditável cada permissão declarada em `manifest.json` conforme a diretriz de privilégio mínimo (`SEC-09`, `ENG-04`, `ENG-13` do `SPEC.md`).

---

## 1. Permissões de API (`permissions`)

| Permissão | Uso Técnico Exato | Escopo & Mitigação |
|---|---|---|
| `storage` | Persiste preferências não-sensíveis (`au_settings_v1`), biblioteca de prompts, macros, salas Multi-Agent (`au_collab_rooms_v1`), presets e métricas locais; usa `chrome.storage.session` (RAM volátil) para credenciais/tokens de sessão com `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`. | Tokens PAT nunca são salvos em texto claro em `chrome.storage.local` (`SEC-02`). |
| `unlimitedStorage` | Impede perda de histórico local de conversas salvas, snapshots de diff entre rodadas e índice de busca local acima da cota padrão de 10 MB. | Listas possuem limites circulares (ring buffers) para evitar crescimento descontrolado. |
| `tabs` | Coordena abas do Arena.ai lançadas em lote Multi-Agent, monitora encerramento/descarte de abas e vincula estritamente `(tabId, bindingEpoch, chatId)` à sala correspondente (`ARENA-18`). | Usado apenas para abas do Arena.ai, páginas da própria extensão e pontes vinculadas pela extensão. |
| `tabGroups` | Agrupa visualmente lotes de abas Multi-Agent no navegador (com fallback seguro em navegadores sem suporte). | Opcional em tempo de execução via detecção de feature (`chrome.tabGroups`). |
| `alarms` | Mantém o agendador recorrente (`shared/scheduler.js` — `PROD-03`), verificação periódica de SLA de integração e limpeza de estados órfãos no Service Worker MV3. | Opera sem timers ocupados permanentes. |
| `notifications` | Exibe alertas nativos quando uma sala conclui `[ENTREGA_FINAL_PRONTA]`, atinge limite de tokens ou entra em pausa objetiva `needs_human` (`ARENA-11`). | Controlado pelo toggle `desktopNotifications` nas configurações. |
| `scripting` | Garante injeção/recuperação controlada de scripts apenas nas origens permitidas quando abas pré-existentes são reconectadas. | Restrito aos domínios do Arena.ai declarados. |
| `offscreen` | Mantém cadência anti-throttling e reprodução de alerta sonoro em segundo plano sem congelar abas ocultas do Chromium. | Documento local isolado (`offscreen/offscreen.html`) sem acesso externo. |

> **Removido na v4.0.0 (`SEC-09`)**: `"cookies"` foi removido das permissões obrigatórias; `"https://temp.sh/*"` (host descontinuado) também foi removido. Atalhos globais (`commands`) não são registrados para evitar conflitos de teclado no navegador.

---

## 2. Permissões de Host Obrigatórias (`host_permissions`)

Necessárias para operação 100% autônoma em segundo plano no Service Worker sem popups repetitivos a cada rodada (`SPEC.md §0.0`):

- `*://arena.ai/*`, `*://*.arena.ai/*`, `*://lmarena.ai/*`, `*://*.lmarena.ai/*`: Automação do editor Tiptap/ProseMirror, leitura de status de turno, detecção de cards interativos (`WAITING_USER`) e download autenticado do Workspace CAS no contexto da sessão.
- `https://api.github.com/*`, `https://github.com/*`, `https://codeload.github.com/*`, `https://*.githubusercontent.com/*`: Operações Git/PR/Issues/Projects v2 executadas exclusivamente pelo Cofre Broker da extensão (`vault_broker_zero_token`), sem expor PAT no prompt.
- `https://filebin.net/*`, `https://*.filebin.net/*`, `https://storage.filebin.net/*`, `https://litterbox.catbox.moe/*`, `https://litter.catbox.moe/*`, `https://uguu.se/*`, `https://*.uguu.se/*`, `https://x0.at/*`: Transporte do barramento de mensagens assinadas por HMAC-SHA256 (`SEC-08`) e artefatos públicos/cifrados entre containers isolados dos Agents. Repositórios privados usam proxy CAS direto ou cifragem AES-256-GCM (`SEC-06` / `ARENA-08`).
- `https://tempchat.online/*`, `https://*.tempchat.online/*`: Espelhamento opcional de sala externa vinculada explicitamente pela extensão, com selo de verificação de origem (`SEC-08` / `ARENA-18`).

---

## 3. Permissões de Host Opcionais (`optional_host_permissions`)

Solicitadas sob demanda (`chrome.permissions.request`) somente se o usuário configurar integrações externas opcionais:

- `https://discord.com/api/webhooks/*`, `https://discordapp.com/api/webhooks/*`: Notificações via Webhook Discord.
- `https://hooks.slack.com/*`: Notificações via Webhook Slack.
- `https://api.telegram.org/*`: Notificações via Bot Telegram.
