# Recuperação sem reiniciar tudo

- Se /tmp foi limpo, rode `/home/user/au_state/au_agent doctor`. Depois use esse caminho persistente no lugar de /tmp/au_agent; os wrappers dos outros comandos também ficam em /home/user/au_state.
- Código instalado: /home/user/au_agent/1.0.0. Estado: /home/user/au_state/harness/<sala>_agN/checkpoint.json.
- `au_agent harness resume` não apaga tarefas. Não instale outra versão aleatória para tentar corrigir um erro de tarefa.
- Se a extensão informar novo epoch: `au_agent harness bind EPOCH`. Refaça validações/revisões invalidadas; não invente epoch.
- Se o download do GitHub der 404, o pacote ainda não foi publicado no caminho esperado. Pare e informe objetivamente ao coordenador. Não execute main mutável sem hash nem peça PAT para instalar pacote público.
- Se houver divergência SHA-256, não execute o arquivo. Use a versão e hash anunciados pela extensão confiável.
- Se faltar projeto, crie /home/user/repo e trabalhe nele antes de verify/report. Fingerprint não deve acompanhar toda /home/user.
- Se a validação alterar arquivos monitorados, o kit invalida a evidência. Estabilize a saída gerada e rode novamente; builds e dependências nos diretórios ignorados não contam.
- Não repita push, PR, upload ou ação destrutiva só porque não viu resposta. Reconcilie no broker/quadro antes.
