# Arena Ultra Harness — Guia prático v4.4.0

## Ativação

Dashboard → Auto-Continue → **Harness: checkpoints e validação por agente (novas sessões)**.

Está habilitado por padrão. Recarregue a extensão e as abas e inicie uma nova sala para receber o guia e os comandos atualizados. Salas antigas não são migradas automaticamente para um gate novo no meio do trabalho.

Não é necessário instalar Node, npm, LangChain, SDK de modelo ou servidor. Python é usado dentro do workspace do agente, assim como as ferramentas de chat/timer já existentes. O usuário só extrai o ZIP e carrega a extensão descompactada.

## Comandos do agente

```bash
# Retomar sem reiniciar estado
/tmp/au_harness resume

# Criar critério verificável (máximo de 20 por conjunto local)
/tmp/au_harness task auth-login "Login válido retorna sessão; senha inválida é rejeitada"

# Depois das mudanças, antes da validação final
/tmp/au_harness checkpoint "Login implementado; revisar testes de autorização e integração"

# Executar um teste real associado ao critério
/tmp/au_harness verify auth-login -- python3 -m unittest tests.test_auth

# Outros comandos também são aceitos, sem shell implícito
/tmp/au_harness verify ui-flow -- npm test -- --run

# Registrar / remover impedimento
/tmp/au_harness blocker "Contrato de autenticação ainda não acordado"
/tmp/au_harness blocker ""

# Ver estado
/tmp/au_harness status

# Revisar outro agente: alvo + revisão exata + decisão
/tmp/au_harness review ag2 4 accept
/tmp/au_harness review ag2 4 reject

# Produzir relatório que deve ser copiado intacto na resposta final do turno
/tmp/au_harness report
```

Os nomes acima são exemplos; crie a tarefa `ui-flow` antes de executar seu `verify`. Os critérios e testes precisam refletir os requisitos reais. `echo ok` ou `true` não validam uma funcionalidade.

### Ordem importante

`checkpoint` e `task` mudam a revisão e invalidam as evidências anteriores. Registre o próximo passo ANTES de executar a bateria final. Depois que o colega revisar, alterar novamente a revisão exige nova revisão do colega. Não use `checkpoint` só para simular atividade.

Um comando com exit code diferente de zero marca a tarefa como falha. Um `checkpoint` não apaga o histórico de trabalho, mas o gate exige evidências da revisão atual. A ferramenta guarda o último estado, não uma cópia completa de todo o repositório.

## Conversa e revisão cruzada

```bash
/tmp/au_chat ask "@[Agente 2 • Frontend]" "Meu checkpoint ag1 revisão 4 está pronto; revise o fluxo e os testes."
/tmp/au_chat inbox
/tmp/au_chat sync
/tmp/au_timer check
```

Os nomes devem ser os do quadro da sua sala. `@Agente2` continua válido. Mensagens são públicas na sala, não DMs.

A resposta do revisor deve explicar no chat o que foi inspecionado e quais problemas foram encontrados. O comando `review` registra a decisão, mas não faz a revisão automaticamente. Em seguida o revisor inclui seu próprio `report` no fim do turno para que a extensão receba a decisão.

Não é necessário que todos revisem todos: cada agente precisa de aceite de ao menos um colega ativo distinto, referente à revisão atual. Distribua as revisões em anel ou por especialidade. Não revise a si mesmo.

## Encerramento colaborativo

Para concluir automaticamente em `smart_consensus`, continuam valendo os critérios anteriores da sala, além do novo gate:

1. Relatórios dos agentes ativos correspondem à sala/slot/epoch autorizados.
2. Todos têm critérios locais concluídos e evidências atuais para as tarefas declaradas.
3. Não há blocker declarado.
4. Cada participante tem revisão independente válida e nenhuma rejeição da revisão atual.
5. Líder integrou o trabalho e emitiu o marcador de entrega final.

No modo de refinamento contínuo, completar esses critérios não força a parada. Limites, pausas e PARAR continuam prevalecendo.

## Recuperação

Se o workspace perder `/tmp`, restaure o wrapper e retome:

```bash
cp /home/user/au_state/au_harness /tmp/au_harness
/tmp/au_harness resume
```

Em troca de vínculo/epoch, o próximo prompt informa o valor esperado:

```bash
/tmp/au_harness bind 2
```

Esse exemplo não deve ser copiado arbitrariamente: use o epoch fornecido pela extensão. A mudança invalida testes e revisões locais antigas. Relatórios de vínculos antigos não passam pelo parser central.

Após rodadas sem novo estado/relatório, o harness recomenda recuperação e mudança de abordagem. Ele não executa rollback destrutivo nem repete push/PR automaticamente.

## Solo, fila, regras e híbrido

Em solo, o harness instala memória/ferramenta local e usa a política do modo escolhido. A fila e as regras condicionais continuam sendo selecionadas pelo mecanismo existente. Não foi criado um avaliador independente fictício para uma sessão com apenas um agente.

No autopilot ativado manualmente numa conversa que não passou pelo lançador, o primeiro envio automático precisa instalar o harness; só os envios seguintes recebem o lembrete curto. No lançador, o instalador já vem no primeiro prompt.

## O que não é garantido

- Uma hora ininterrupta de geração ou remoção dos limites do Arena.
- Leitura instantânea de mensagem por um modelo que não consultou o chat.
- Atestação remota ou proteção contra modelo que invente um relatório.
- Que uma verificação com exit code zero cubra todo o pedido do usuário.
- Interceptação/autorização de todas as ferramentas internas do Arena.
- Um filesystem único ou lock global entre os workspaces dos agentes.

O novo harness adiciona disciplina e um gate de consistência, mas o broker, isolamento de salas, política de Git, limites e sandbox existentes continuam sendo as fronteiras de segurança.
