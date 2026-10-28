# Publicar extensão normal + Agent Kit no seu GitHub

Repositório: https://github.com/nadabgfccvd/extensao-arn

## 1. Use o pacote de repositório completo

Extraia `extensao-arn-github.zip`. Sua pasta deve conter:

```text
README.md
PUBLICAR.md
AGENTS.md
extension/manifest.json
extension/shared/agent-kit.js
agent-kit/__main__.py
agent-kit/protocol.schema.json
agent-kit/references/
agent-kit/tools/
agent-kit/releases/arena-ultra-agent-1.0.0.pyz
agent-kit/releases/SHA256SUMS
scripts/check_release.py
```

O ZIP não publica nada sozinho. Envie o CONTEÚDO extraído ao repositório, preservando esses caminhos. Não envie só o arquivo ZIP como se ele fosse uma árvore de código.

## 2. Publique na branch main

Pela interface web do GitHub, use upload de arquivos/pastas. Ou, em um terminal local autenticado, dentro da pasta extraída:

```bash
git init
git branch -M main
git add .
git commit -m "Arena Ultra 4.5.0 + Agent Kit 1.0.0"
git remote add origin https://github.com/nadabgfccvd/extensao-arn.git
git push -u origin main
```

Se já existir histórico, clone o repositório e copie os arquivos para ele antes de commitar. Não use force push nem coloque PAT em URL/comando/chat. Use a autenticação normal do seu Git.

## 3. Confira a distribuição

O arquivo público deve existir exatamente em:

https://raw.githubusercontent.com/nadabgfccvd/extensao-arn/main/agent-kit/releases/arena-ultra-agent-1.0.0.pyz

Na pasta do repositório, rode opcionalmente:

```bash
python3 scripts/check_release.py
```

Esse teste confere SHA-256 fixado na extensão, manifestos internos e correspondência de fonte empacotada. Não exige npm/pip.

**Não regenere ou edite o arquivo 1.0.0 depois de publicar.** Uma atualização exige nova versão, novo pacote e novo pin na extensão. O pacote fornecido já está pronto; não há build para instalação pelo usuário.

## 4. Ative na extensão normal

1. Instale/recarregue a pasta `extension/` ou use o ZIP normal da extensão extraído.
2. Abra Dashboard → Auto-Continue.
3. Marque **Agent Kit via GitHub** depois de confirmar a publicação do arquivo.
4. Mantenha Harness habilitado para o gate de validação/revisão.
5. Inicie uma nova sala ou novo lançamento. Salas antigas mantêm seu modo de distribuição.
6. Em Chat Live, o indicador KIT mostra quantos agentes declararam handshake compatível.

Se der 404, arquivo ausente ou hash divergente, não execute código alternativo sem verificação. Desmarque Agent Kit para iniciar uma nova sessão no modo nativo até corrigir a publicação.

## O que não foi publicado automaticamente

Os arquivos foram preparados e testados localmente. Não houve push para o GitHub nesta conversa. A consulta ao repositório indicou repositório público sem o release esperado; a instalação pela URL final deve ser verificada depois do seu upload.

## Atenção a segredos

Apenas templates, código e exemplos sintéticos pertencem ao GitHub. Nunca publique `au_state/`, `agent-session.json`, capabilities, chaves da sala, vaults, exportações pessoais ou prompts contendo descritores reais.

A licença não foi escolhida automaticamente; selecione e adicione LICENSE se quiser autorizar reutilização pública sob condições específicas.
