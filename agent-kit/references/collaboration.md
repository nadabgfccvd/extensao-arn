# Colaboração — harness exclusivo de equipe

## Um plano, vários responsáveis
O Quadro Único da extensão é a fonte de atribuições e contratos. Seu checkpoint local não substitui nem modifica atribuições de outros agentes.

- `/tmp/au_agent chat sync`: mapa + mensagens novas.
- `/tmp/au_agent chat claim "src/minha-frente/*" "meu escopo"`: reivindique limites antes de editar.
- `/tmp/au_agent chat ask "@[Nome exato]" "pergunta"` e `reply`: diálogo nominal. @AgenteN e @Todos também funcionam. São mensagens públicas na sala, não DMs.
- `chat contract "api/rota" "schema e comportamento" congelado`: combine interfaces.
- `chat ready "arquivos e testes"`: avise prontidão de módulo, sem encerrar a sala sozinho.

As mensagens de agentes têm jitter de 300–750ms e entram na fila central da extensão. Isso não é lock global entre workspaces. O coordenador humano não espera essa fila.

## Ciclo de trabalho
1. Leia mensagens, resolva dependências e escolha um incremento do seu escopo.
2. Implemente e valide, sem esperar uma nova rodada para cada interação: o chat funciona durante o turno.
3. Use tick e timer para receber notificações e consultar relógio real.
4. Salve checkpoint antes da bateria final; `/tmp/au_agent verify TASK -- COMMAND ARGS` observa exit code real e guarda digest, sem despejar logs na sala.
5. Peça revisão: `chat ask "@[Colega]" "Revise agN, revisão R, arquivos/branch X"`.
6. Revisor diferente inspeciona/testa os artefatos reais acessíveis e registra `harness review agN R accept` ou `reject`. Envia a justificativa no chat e o próprio report na resposta final.
7. Todos incluem `report` no fim do turno. Revisão antiga não vale após alteração de checkpoint. Nunca se autorrevise nem aceite sem inspecionar.

Cada agente ativo precisa de ao menos um revisor distinto, não de todos os outros. Dividam revisões em anel ou por especialidade. O líder integra o trabalho de todos, não refaz tudo sozinho. Rejeição/impedimento não deve ser mascarado por aprovação de outro colega.

## Prontidão não é segurança comprovada
O gate verifica sala/slot/epoch, tarefas declaradas, evidências da revisão atual e revisão cruzada. O modelo poderia inventar um relatório: não confunda consistência do protocolo com atestação. A extensão mantém broker de Git, permissões e parada; o kit não recebe PAT nem pode elevar seu acesso.
