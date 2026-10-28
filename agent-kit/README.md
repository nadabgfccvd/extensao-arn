# Arena Ultra Agent Kit 1.0.0

Versão dedicada ao agente, complementar à extensão Chromium Arena Ultra 4.5.0. CLI Python 3.10+ (Linux), sem pip/npm. Protocolo compartilhado 1, mantendo os comandos e envelopes de chat/harness anteriores.

## Divisão de responsabilidades

| Extensão normal | Kit dedicado |
|---|---|
| Salas, vínculo de abas e epoch | Ferramentas locais configuradas pela sessão |
| Quadro Único e atribuições | Checkpoint do próprio agente |
| Cofre PAT e RBAC | Cliente do broker, sem receber PAT |
| Orquestração/barreira/consenso | Chat durante turno, timer e guias sob demanda |
| Gate de entrega e PARAR | Validação real, fingerprint e report |

Não é uma segunda extensão, SDK de modelo ou servidor MCP. A opção Skill é um índice adicional; não exige suporte automático a Skills no Arena.

## Instalação suportada

A extensão gera um comando com URL do pacote publicado, SHA-256 fixado e descritor de sessão. O arquivo só é executado se o hash corresponder. Não copie descritores reais para GitHub: contêm chave da sala/capability limitada. O PAT continua na extensão.

Exemplo esquemático (NÃO executar com placeholders):

```bash
curl -fsSL 'URL_DO_PACOTE_FIXADO' -o /tmp/arena-ultra-agent.pyz
printf '%s  %s\n' 'SHA256_DA_EXTENSAO' /tmp/arena-ultra-agent.pyz | sha256sum -c -
python3 /tmp/arena-ultra-agent.pyz install --session-b64 'SESSAO_GERADA_PELA_EXTENSAO'
/tmp/au_agent guide start
```

A aplicação real usa `&&` entre download, checagem e execução; qualquer falha impede executar o pacote. Não use `curl | bash`. Repositório previsto: https://github.com/nadabgfccvd/extensao-arn.

A primeira publicação precisa conter `agent-kit/releases/arena-ultra-agent-1.0.0.pyz` com os bytes exatos fornecidos. Até publicá-lo, mantenha **Agent Kit via GitHub** desligado na extensão: o modo nativo continua funcionando.

## Interface

- `au_agent doctor`: handshake e diagnóstico sem segredos.
- `au_agent guide start|collaboration|modes|security|recovery`: manual carregado sob demanda.
- `au_agent tick`: mensagens novas, relógio REAL e resumo do plano.
- `au_agent inbox [offset|ack]`: mensagens completas persistidas, paginadas; ack explícito só após leitura. O tick não descarta a conversa ao encurtar seu resumo.
- `au_agent chat ...`, `timer ...`, `github ...`, `harness ...`: integração compatível.
- `au_agent verify TASK -- comando args`: teste real com invalidação por alteração do workspace.
- `au_agent report`: report do harness compatível com o gate da extensão; invalida evidência se detecta workspace diferente.

Aliases `/tmp/au_chat`, `/tmp/au_timer`, `/tmp/au_gh`, `/tmp/au_harness` continuam disponíveis. Para a validação nova, prefira o comando de alto nível `au_agent verify/report`; usar o alias antigo diretamente não acrescenta o controle de fingerprint.

## Estado e recuperação

Código: `/home/user/au_agent/1.0.0`. Estado: `/home/user/au_state`. Reinstalar preserva o plano; mudança de epoch invalida evidências antigas. O comando persistente fica em `/home/user/au_state/au_agent`.

O fingerprint monitora arquivos regulares dentro de `projectPath` (padrão `/home/user/repo`), com limite 5.000 arquivos/20MB e exclusão de dependências/cache/symlinks. Alterar algo fora desse escopo não é detectado. Isso não substitui testes nem atestação de um executor independente.

## Segurança e limites

Leia `references/security.md`. Sessão 0600 não é criptografia. Relatórios continuam `agent_reported`; o modelo pode mentir, e teste trivial pode passar sem provar funcionalidade. Comandos rodam com permissões do sandbox do Arena, não em uma nova sandbox do kit.

Upload externo é bloqueado quando GitHub está configurado; artefatos privados devem seguir CAS/broker da extensão. Chat do kit descarta mensagens sem assinatura HMAC válida. Nenhuma regra do kit permite ignorar PARAR, limites da plataforma ou cards humanos obrigatórios.

## Desenvolvimento

```bash
python3 -m unittest discover -s tests -v
```

As ferramentas foram extraídas das implementações da extensão 4.4.0 e preservam os formatos existentes; alterações específicas do kit são a rejeição HMAC, a instalação/configuração segura e o harness de alto nível. A suíte da extensão testa os formatos herdados; a suíte deste kit cobre protocolo, paths, estado, fingerprint, epoch, redaction e política de upload.

Não há licença escolhida automaticamente. O mantenedor deve selecionar a licença e adicionar LICENSE antes de divulgar condições de reutilização.
