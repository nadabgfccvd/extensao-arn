# Pesquisa adicional e arquitetura dual — Arena Ultra 4.5.0 / Agent Kit 1.0.0

Pesquisa: 28/10/2026. Esta nota complementa HARNESS_RESEARCH.md da versão 4.4.0. Formato aprovado pelo usuário: kit/CLI Python dedicado no workspace, mantendo extensão normal como coordenador. Repositório indicado: https://github.com/nadabgfccvd/extensao-arn.

## O problema desta rodada

O harness anterior movia o estado para arquivos, mas ainda enviava código das ferramentas e um manual grande no primeiro prompt. A nova versão separa distribuição de código de configuração de sessão. O objetivo não é tirar controles da extensão: é compartilhar um contrato pequeno e deixar o agente carregar só os detalhes necessários.

## Fontes adicionais consultadas

1. [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): descreve ferramentas como arquivos/código descobertos sob demanda, processamento local de resultados e persistência de habilidades. O artigo também ressalta que executar código exige sandbox e limites. Adotamos a descoberta por filesystem; NÃO implementamos MCP nem inferimos os números do artigo como resultados do Arena Ultra.
2. [Anthropic — Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): recomenda índice curto, referências específicas e execução de scripts sem carregar todo o fonte no contexto. Aplicamos a divisão em guias pequenos.
3. [Agent Skills — Specification](https://agentskills.io/specification): define SKILL.md, frontmatter com nome/descrição, recursos opcionais e progressive disclosure. O kit inclui um índice compatível com esse formato; não presume que o Arena vai descobrir ou ativar Skills automaticamente.
4. [MCP — Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices): descreve confused deputy, proibição de token passthrough e minimização de escopos. Usamos os princípios para preservar o broker e separar credenciais; nosso protocolo não é uma implementação OAuth/MCP.
5. [MCP — Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): separa audiência/recurso das credenciais e exige validação de tokens. O kit não recebe PAT e não cria um servidor que repassa token a jusante. Capabilities da sala continuam limitadas pelos controles já existentes da extensão.

A base de longa duração, avaliação independente, checkpoints e orçamento de contexto está descrita com mais fontes no relatório anterior.

## Alternativas avaliadas

| Abordagem | Benefícios | Problemas aqui | Decisão |
|---|---|---|---|
| Segunda extensão Chromium no ambiente do agente | Interface familiar | Agente trabalha em sandbox/terminal, não controla necessariamente um Chromium onde instalar outra extensão; duplicaria autoridade | Não usar |
| Colar todos os scripts no primeiro prompt | Sem publicação prévia | Muito texto, fonte repetido por agente, difícil versionamento | Manter apenas como modo nativo compatível, não como distribuição do kit |
| Servidor MCP próprio | Ferramentas estruturadas quando o cliente suporta | Exigiria suporte/configuração adicionais no Arena e nova superfície de autenticação/rede | Não implementar nesta versão |
| Git clone de main e executar instalador | Comando curto | Código mutável, sem verificação independente do repositório | Não executar sem pin de integridade |
| Pacote zipapp Python fixado, com SHA-256 no código da extensão | Instalação curta, sem pip, distribuição de código separada de sessão | Requer publicar arquivo exato, internet na instalação e extensão confiável | Escolhido |
| Skill + referências locais | Baixo contexto e portabilidade | Descoberta depende do cliente | Índice adicional, com instalação explícita suportada |

## Arquitetura implementada

### Extensão normal — plano de controle

- Continua dona de salas, identidade de abas, bindingEpoch e admissão.
- Continua guardando PAT e aplicando RBAC no broker.
- Continua coordenando Quadro Único, rodadas/barreira, fila de mensagens, orçamento, consenso e PARAR.
- Gera o descritor protocol=1 com allowlist: sala, slot, papel, epoch, configuração do chat/timer, repositório/branch e capability limitada.
- Não serializa o PAT no descritor, nem mesmo se estiver presente no objeto de configuração de Git usado internamente.
- Anuncia URL, versão 1.0.0 e SHA-256 exato do pacote.
- Observa o handshake AU_AGENT_READY e o HARNESS_REPORT, validando sala/slot/epoch. O handshake é declarado pelo agente, não uma prova remota de instalação.

### Agent Kit — plano de trabalho

- Instala os scripts configurados e fornece `/tmp/au_agent` e um caminho persistente equivalente.
- `doctor`: metadados seguros e handshake; não despeja configuração sensível.
- `guide`: consulta apenas um arquivo de referência permitido; não aceita caminho arbitrário.
- `tick`: mensagens novas, relógio real e resumo pequeno de próximo passo/bloqueio. O conteúdo completo fica em buffer local paginado por `inbox`, sem descarte silencioso ao resumir. Leitura/ack explícitos controlam a retenção; ao atingir o limite preventivo, o tick não consome novas mensagens até liberar o buffer.
- `verify`: executa validação real do harness existente, com observação de fingerprint do projeto.
- `report`: invalida evidências se o fingerprint atual não corresponde ao salvo e produz envelope compatível.
- Mantém aliases au_chat/au_timer/au_gh/au_harness para não quebrar instruções e sessões existentes.

### Compatibilidade e distribuição

| Componente | Versão | Contrato |
|---|---|---|
| Extensão normal | 4.5.0 | Protocolo Agent Kit 1; pacote esperado 1.0.0 |
| Agent Kit | 1.0.0 | Chat e HARNESS_REPORT herdados, mais AU_AGENT_READY |
| Modo nativo | Preservado | Funciona sem publicação do kit |

A instalação GitHub é opt-in e vem desligada enquanto a publicação não está confirmada. Novas salas recebem a decisão; não se altera o método de distribuição no meio de uma sala ativa. Atualizações futuras devem publicar outra versão e atualizar o pin, não substituir silenciosamente bytes da versão 1.0.0.

## Harness exclusivo do kit

O ciclo do kit é: estado do time → incremento delimitado → checkpoint → validação → fingerprint → revisão cruzada → relatório.

A camada nova de fingerprint percorre arquivos regulares dentro de projectPath, em ordem determinística; exclui dependências, caches e symlinks; limita a 5.000 arquivos/20MB. Alterações antes de verify/report invalidam evidências anteriores. Se a própria verificação modificar arquivos monitorados, a evidência é invalidada e o agente recebe aviso para estabilizar e revalidar.

Isso melhora a ligação entre um teste e a versão local do trabalho, mas NÃO é atestação de workspace remoto. Não acompanha arquivos excluídos, symlinks ou caminhos fora de projectPath. O modelo ainda pode editar os scripts/arquivos locais ou inventar um relatório. A extensão mantém a classificação agent_reported_not_attested.

O planejamento, a atribuição de arquivos e os contratos continuam no quadro central: não foi criado outro árbitro concorrente no kit. Em colaboração, os gates existentes de revisão distinta e revisão atual continuam funcionando. Em solo/fixo/fila/condicional/híbrido, o kit consulta a política correspondente, sem simular revisão independente onde não há colega.

## Segurança da cadeia de distribuição

1. O prompt baixa um arquivo público para disco.
2. sha256sum confere o hash fornecido pela extensão confiável.
3. Somente após sucesso o Python executa a instalação.
4. O zipapp valida sua lista de arquivos e extrai apenas caminhos permitidos.
5. A sessão é validada antes de gravar ferramentas: protocolo, identidade, tipos, path do projeto e allowlist de campos.
6. Dados sensíveis da sessão são salvos com modo 0600; não são publicados no repositório nem enviados como um manifesto público no Filebin.

SHA-256 não é assinatura do autor. Se a própria distribuição da extensão for comprometida, o atacante pode trocar código e hash. A lista interna FILES.json não autentica sozinha o entrypoint do zipapp: a conferência externa é indispensável antes da primeira execução.

O descritor em base64 não é criptografia. Ele contém HMAC/capability de sala, que já eram necessários para os comandos do agente. Não deve ser copiado a logs, chat público ou commits. Campos de PAT são recusados; o kit não procura PAT em ambiente/arquivo askpass para contornar o broker.

A versão do kit descarta mensagem de chat sem HMAC válido. Upload externo fica bloqueado quando GitHub está configurado; o fluxo privado deve continuar usando CAS/broker. Um shell dentro do sandbox continua tendo suas permissões normais: este kit não cria uma nova barreira de sistema operacional.

## Medição de contexto

Fixture local reproduzível: mesmo objetivo, cinco agentes, especialistas, GitHub e chat configurados com chave/capability sintéticas.

- Prompt nativo: **53.133 caracteres**.
- Prompt com Agent Kit: **2.245 caracteres**.
- Redução: **95,77% em caracteres**.

Métrica: comprimento de string JavaScript. Não é contagem de tokens de um modelo específico, medição de latência, qualidade ou teste estatístico. O resultado muda com o tamanho do objetivo e a configuração. O objetivo do usuário não é cortado para atingir uma meta artificial.

O texto detalhado ainda entra no contexto quando o agente consulta um guia, mas não é repetido automaticamente em cada prompt nem contém o fonte inteiro das ferramentas.

## Validação

- Suíte da extensão: 31/31 subtestes, incluindo os 28 anteriores.
- Kit: 8/8 testes Python (sessão/protocolo, path, redaction, fingerprint, reinstalação por epoch, aliases/política de upload, HMAC/menções e rebind).
- Smoke test do zipapp real: instalação em diretório isolado, doctor e tick executados.
- Handshake e bootstrap de sala com kit testados com mocks de Chrome.
- Integridade do pacote e referências do manifest conferidas.

Não executado: download do kit da URL final publicada (repositório estava vazio na consulta), autenticação no Arena, operação conjunta de muitas abas por horas, publicação no GitHub ou benchmark de qualidade. Uma prova de execução local não deve ser confundida com homologação completa do produto em produção.

## Publicação sem quebrar usuários

O bundle de repositório contém extension/, agent-kit/ e agent-kit/releases/arena-ultra-agent-1.0.0.pyz. É preciso publicar esses arquivos na branch main. Não basta subir apenas o ZIP da extensão ou um ZIP contendo o bundle inteiro.

Depois de publicar, habilite Agent Kit via GitHub no Dashboard e inicie novas sessões. Se houver 404 ou SHA divergente, o agente deve parar a instalação e informar o problema, não executar código alternativo sem hash. O modo nativo continua disponível e é o fallback operacional escolhido pelo usuário.
