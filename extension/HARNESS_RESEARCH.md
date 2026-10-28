# Pesquisa e decisões — Arena Ultra Harness v4.4.0

Data: 28/10/2026. Escopo aprovado: priorizar profundidade/cobertura, sem janela artificial de 21 minutos. Este relatório não afirma que a pesquisa durou 21 minutos.

## 1. Conclusão executiva

Harness não é apenas um texto dizendo “continue”. É a camada que fornece estado, ferramentas, ciclo de execução, observações, critérios de aceite e recuperação. A separação entre inicialização e trabalho incremental aparece na proposta de agentes de longa duração da Anthropic: um inicializador prepara o ambiente e as sessões seguintes deixam artefatos claros para a próxima sessão. [1](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

A extensão já tinha partes importantes desse sistema: broker de credenciais, isolamento de salas, Quadro Único, barreira entre rodadas, timer, alertas, orçamento e controles de parada. A mudança desta versão acrescenta memória operacional por agente e um gate de conclusão colaborativa. Não substitui essas proteções nem instala outro framework de execução no Arena.

A decisão central foi fazer um harness pequeno e determinístico em JavaScript/Python, sem novas dependências, permissões ou serviços. Não copiamos resultados de benchmarks de fornecedores como se fossem garantias para esta extensão.

## 2. Fontes primárias e o que foi aproveitado

| Fonte | Achado utilizado | Adaptação à extensão |
|---|---|---|
| [1 — Anthropic, Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Inicialização diferente das sessões seguintes; lista de critérios, progresso persistido, testes e entrega incremental | Instalador apenas no início, tarefas locais, checkpoint e comando de retomada |
| [2 — Anthropic, Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Separação entre planejamento, geração e avaliação; custo de coordenação; remover componentes que deixam de agregar valor | Especialistas mantêm seus papéis, mas fazem revisão cruzada; não criar automaticamente um exército novo de agentes |
| [3 — Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Contexto como orçamento de atenção; recuperação sob demanda, notas estruturadas e redução de ruído | Estado no filesystem; continuações limitadas; nenhum dump de logs ou instalador nas rodadas seguintes |
| [4 — Anthropic, How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Delegação exige objetivo, formato de saída, fontes/ferramentas e fronteiras claras; agentes podem duplicar trabalho e gerar coordenação excessiva | Políticas específicas por perfil e uso do Quadro/contratos já existentes, em vez de outro quadro central concorrente |
| [5 — OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) | Um mapa curto funciona melhor que um manual monolítico; conhecimento no repositório; invariantes verificáveis e feedback | Política compacta + comandos locais; gate em código, não apenas recomendação de prompt |
| [6 — LangGraph, Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | Checkpoints por thread e recuperação de execução são distintos de uma simples memória em RAM | Namespace sala/agente, persistência em disco e estado da sala serializável; sem importar LangGraph para MV3 |
| [7 — OWASP, Agentic AI threat modeling](https://cornucopia.owasp.org/edition/companion/AAIA) | Identidade falsa, envenenamento de contexto, agência excessiva e abuso de orçamento exigem validação, privilégio mínimo e circuit breakers | Relatórios tratados como entrada não confiável; identidade vinculada à aba/sala/epoch; nenhuma nova credencial no sandbox |

Leitura realizada: material de longa duração e gestão de ambiente; artigos de contexto e colaboração; partes de arquitetura, simplificação e avaliação do harness de apps; artigo completo de harness engineering da OpenAI; conceitos iniciais de checkpoints e modelo de ameaças. Não foi uma revisão exaustiva da literatura nem um benchmark científico.

## 3. Padrões comparados

### Loop simples de auto-continue

Vantagem: pequeno, rápido de instalar e fácil de observar. Desvantagem: o texto do modelo pode parecer progresso mesmo quando nada verificável mudou. Sozinho, não resolve a troca de contexto ou a conclusão prematura. A proposta de inicialização/artefatos externos trata justamente dessas falhas de continuidade. [1](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Decisão:** preservar o loop existente, acrescentando estado e validação. Não substituir o motor do Arena.

### Planner → executor → avaliador

A separação entre quem gera e quem avalia é útil para reduzir a complacência da autoavaliação, mas tem custo e depende da dificuldade da tarefa/modelo. A própria Anthropic relata simplificar sprints e reconsiderar quando o avaliador é necessário. [2](https://www.anthropic.com/engineering/harness-design-long-running-apps)

**Decisão:** na colaboração, usar revisão de um colega diferente e manter o líder integrador. Em solo, não fingir independência: a verificação continua local e não há gate de revisão por outro agente.

### Contexto externo e progressive disclosure

A estratégia é carregar o que importa no momento, com identificadores e referências leves. Não é mandar toda a memória a cada turno. [3](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) O relato da OpenAI usa um AGENTS.md curto como mapa para documentação detalhada, em vez de manual único. [5](https://openai.com/index/harness-engineering/)

**Decisão:** um primeiro guia mais completo instala a ferramenta; depois o modelo consulta `resume`, o Quadro e a caixa de entrada. O prompt de colaboração continua limitado a 2.000 caracteres, com reserva para preservar a instrução de timer no final.

### Checkpoint e replay

Checkpoint não significa refazer todos os efeitos externos. LangGraph distingue o snapshot da thread de escritas de tarefas já concluídas. [6](https://docs.langchain.com/oss/python/langgraph/checkpointers)

**Decisão:** persistir o progresso local sem reinicializar ao chamar `resume`. Não implementar replay automático de push, PR, upload ou comandos arbitrários. Esses efeitos continuam nos fluxos existentes de integração e reconciliação.

### Quadro central vs. arquivos locais

Delegação vaga faz agentes duplicarem buscas/trabalho; fronteiras e formatos explícitos são importantes. [4](https://www.anthropic.com/engineering/multi-agent-research-system)

**Decisão:** o Quadro Único continua dono de atribuições/contratos. O harness local guarda o andamento e as evidências do próprio agente. A extensão recebe relatórios curtos, sem copiar os workspaces inteiros. Não há lock global entre sandboxes e não se promete exclusão mútua de arquivos apenas com `fcntl` local.

## 4. Arquitetura implementada

### Plano de controle — extensão

`shared/harness-engine.js` contém:

- Políticas para `fixed`, `queue`, `conditional`, `hybrid`, `specialists`, `parallel_leader` e `debate_consensus`.
- Construção do instalador inicial e da instrução curta de continuação.
- Parser de `[HARNESS_REPORT]` com limites e allowlist de campos.
- Validação de sala, slot e bindingEpoch do agente autorizado.
- Checkpoints declarados, últimos 100 eventos e contador de rodadas sem novo relatório/estado.
- Gate adicional de conclusão colaborativa e indicação compacta de recuperação após repetição.

O gate é aplicado no service worker antes de marcar uma sala como concluída. Os critérios de consenso, admissão, bloqueio e isolamento anteriores continuam ativos. A autorização Git não é concedida por um relatório do harness.

### Plano de trabalho — sandbox do agente

`shared/harness-cli.py` é incorporado no primeiro prompt e instalado como ferramenta local:

- `/tmp/au_harness` é o comando; o wrapper também é salvo em `/home/user/au_state/au_harness`.
- O executável Python fica em `/home/user/au_state/harness-cli.py`.
- O estado fica em `/home/user/au_state/harness/<sala>_agN/checkpoint.json`.
- Escritas do checkpoint usam arquivo temporário, fsync e replace atômico.
- Um lock local evita que dois comandos no mesmo workspace escrevam simultaneamente.
- A ferramenta não faz chamadas de rede nem recebe PAT do GitHub.

### Fluxo colaborativo

1. Agentes entram pelos mecanismos de admissão existentes.
2. Cada um declara seus arquivos/contratos no Quadro e cadastra critérios locais.
3. Trabalham em incrementos e interagem pelo chat com menções/alertas existentes.
4. Antes da validação final, salvam próximo passo/checkpoint.
5. Executam validações reais por `verify`, sem marcar sucesso só por escrever “feito”.
6. Publicam slot e revisão no chat e pedem revisão nominal a outro colega.
7. Cada revisor inspeciona/testa a entrega acessível e registra aceite/rejeição para a revisão exata do colega.
8. No fim do turno, incluem o relatório estruturado. O modelo deve copiar o relatório na resposta: a extensão não lê diretamente todos os cards de terminal.
9. O líder integra. A sala só recebe conclusão automática se os gates anteriores e o novo gate forem satisfeitos.

## 5. Adaptação por modo

| Modo | Comportamento customizado | Controle efetivo |
|---|---|---|
| Fixo/contínuo | Uma tarefa delimitada, testes e próximo passo; não reiniciar projeto | Ferramenta local + continuação específica |
| Fila/macros | Seguir a etapa atual e registrar aceite | Fila nativa preservada; registro local. Não foi alterado o dequeue nativo para exigir revisão externa |
| Condicional | Reproduzir erro, correção mínima e regressão | Regras existentes + política e ferramenta de verificação |
| Híbrido | Bloqueios primeiro, depois fila, depois melhorias | Seleção existente preservada + política própria |
| Lançamento solo/swarm independente | Um estado por workspace/agente, sem exigir consenso entre abas não colaborativas | Bootstrap por agente, persistência e testes locais |
| Especialistas | Fronteiras de arquivos, contratos e revisão de outro agente | Quadro existente + gate central |
| Paralelo com líder | Interfaces cedo, dependências explícitas e integração incremental | Gate central e integração anterior |
| Debate/consenso | Alternativas com evidências e decisão registrada; não criar implementações concorrentes completas | Política própria + revisão cruzada + consenso existente |
| Refinamento contínuo | Aplicar o mesmo ciclo de qualidade, sem transformar relatório em sinal de parar | `endless_tokens` permanece sem encerramento por consenso |

Agendamento e macros usam os caminhos de execução existentes; não foi criado um scheduler separado nem novos modos visuais artificiais.

## 6. Gate: o que é verificado de verdade

Para cada agente ativo da sala com harness habilitado:

- Existe relatório no slot/epoch autorizado.
- `complete` é verdadeiro, há critérios e não há blocker declarado.
- Existem evidências de exit code zero da revisão atual, para tarefas distintas.
- Em salas com mais de um agente, existe aceite de outro agente ativo para essa revisão.
- Uma rejeição da mesma revisão impede aceite enquanto não for resolvida.
- Uma alteração de revisão torna o aceite antigo insuficiente.

A revisão cruzada não precisa ser feita por um único QA para todos: qualquer outro agente ativo pode revisar. Isso permite distribuir o trabalho entre N agentes.

**Limite de confiança:** o Python observa o exit code real quando é executado. A extensão recebe o resultado por texto do modelo. Portanto o gate verifica consistência/proveniência operacional do relatório, não atesta criptograficamente que o teste foi executado nem que o comando era um bom teste. Um digest de stdout não prova correção funcional. Testes triviais, relatos falsos e conluio continuam sendo riscos. Não foi criado acesso privilegiado ao filesystem remoto para contornar essa limitação.

## 7. Segurança e custo operacional

Ameaças agentic incluem identidade falsa, comunicação adulterada, envenenamento de memória e consumo excessivo de recursos. O modelo da OWASP recomenda validação, identidades e limites, não confiança cega em texto de agentes. [7](https://cornucopia.owasp.org/edition/companion/AAIA)

Medidas desta implementação:

- Relatórios de outra sala, slot ou epoch são rejeitados.
- Não importar campos arbitrários com spread para o estado central; parser constrói somente campos permitidos.
- Autorrelato não pode elevar RBAC ou desbloquear cofre.
- Sem `eval` de texto do modelo no navegador.
- `verify` executa argv sem shell implícito; isso NÃO é uma sandbox adicional. O agente já pode executar comandos no ambiente do Arena.
- Logs de verificação não são injetados no prompt; apenas digest, exit code e metadados mínimos são reportados.
- Mensagens públicas removem o envelope técnico para não poluir a sala.
- Limite local de 20 critérios por conjunto ativo e 60 revisões; eventos centrais limitados a 100.
- Timer, falta de créditos, decisões humanas obrigatórias e PARAR continuam superiores a qualquer recomendação do harness.
- O harness não espera artificialmente para preencher a duração mínima, nem reinicia timer para mascarar interrupções.

## 8. Validação realizada

`npm run ci`: 28/28 subtestes passando, incluindo os testes anteriores.

Novos casos:

- A33: fechamento prematuro, sala/slot/epoch incorretos, revisão própria e revisão obsoleta.
- A34: execução real do CLI Python, comando com falha, comando bem-sucedido, retomada do JSON, invalidação e rebind.
- A35: políticas dos modos, limite de 2.000 caracteres, timer preservado e remoção de protocolo do chat.
- A36: integração simulada do service worker: finalização recusada sem relatórios; liberada depois de evidência e revisão cruzada.

Não executado: homologação em navegador real autenticado no Arena, carga com 60 abas, teste prolongado de horas, benchmark de qualidade ou teste adversarial completo. Os testes MV3 usam mocks e o CLI roda em Python real no ambiente de desenvolvimento.

## 9. Implantação e compatibilidade

- Novas salas recebem estado de harness se habilitado nas configurações.
- Salas antigas sem esse estado não ganham um gate novo inesperadamente durante uma execução em andamento.
- Ao unir abas, o guia inicial inclui a ferramenta. No autopilot manual solo, o primeiro envio automático instala o harness; os seguintes permanecem curtos.
- Configuração: Dashboard → Auto-Continue → Harness (novas sessões).
- Recarregar extensão e abas e iniciar nova sala é o caminho recomendado para atualizar o CLI.

## 10. Próximos experimentos, não implementados

1. Evidência obtida diretamente de um executor remoto autenticado, em vez de texto do modelo.
2. Revisão de artefatos associada a hash de conteúdo/workspace, não apenas revisão lógica de checkpoint.
3. Medir tarefas concluídas por token, retrabalho por arquivo e tempo até remover bloqueios.
4. Avaliação A/B por perfil, removendo um componente por vez para medir utilidade.
5. Seleção adaptativa do número de revisores e critérios, sem assumir que mais agentes sempre ajudam.
6. Manifesto completo de requisitos central com rastreamento de cobertura; a lista local desta versão não prova cobertura de toda a solicitação do usuário.

Essas são propostas futuras. Não devem ser apresentadas como capacidades já disponíveis na v4.4.0.
