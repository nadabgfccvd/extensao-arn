# Arena Ultra — extensão normal + Agent Kit dedicado

Dois componentes complementares para agentes no Arena.ai:

- **Extensão Chromium 4.5.0**: interface, salas, Quadro Único, isolamento, broker GitHub sem PAT no prompt, orquestração e controles de parada.
- **Agent Kit Python 1.0.0**: ferramentas locais, manual sob demanda, chat/timer/checkpoints, verificação e revisão; protocolo 1.

## Instalar a extensão normal

Carregue a pasta `extension/` descompactada na página de extensões do Brave/Edge/Chrome/Opera/Arc, em modo desenvolvedor. Sem npm/build para uso. Consulte [instalação](extension/COMO_INSTALAR.md).

## Publicar e ativar o kit

Leia [PUBLICAR.md](PUBLICAR.md). O arquivo `agent-kit/releases/arena-ultra-agent-1.0.0.pyz` deve ser publicado na branch main com os bytes fornecidos, pois a extensão fixa seu SHA-256. Depois habilite **Agent Kit via GitHub** no Dashboard e inicie novas salas.

A opção vem desligada enquanto a publicação não foi confirmada. O modo nativo funciona sem o kit. Esta entrega não afirma que houve push remoto.

## Por que separar os componentes?

O prompt entrega o objetivo, a identidade e a configuração compacta. Código e manuais ficam no kit, consultados sob demanda. Em uma fixture local de cinco agentes com GitHub, o bootstrap caiu de 53.133 para 2.245 caracteres (95,77%). É uma medição de caracteres dessa configuração, não benchmark de tokens, custo ou qualidade.

A interface nova é `/tmp/au_agent`: `doctor`, `guide`, `tick`, `verify`, `report`, `chat`, `timer`, `github`, `harness`. Os aliases antigos continuam funcionando.

## Documentação

- [Manual do kit](agent-kit/README.md)
- [Pesquisa adicional, arquitetura e limites](extension/AGENT_KIT_RESEARCH.md)
- [Pesquisa anterior sobre harness](extension/HARNESS_RESEARCH.md)
- [Harness e revisão cruzada](extension/HARNESS_GUIDE.md)
- [Contrato de sessão](agent-kit/protocol.schema.json)
- [Changelog](extension/CHANGELOG.md)

## Testes de desenvolvimento

```bash
cd extension && npm run ci
cd ..
python3 -m unittest discover -s agent-kit/tests -v
python3 scripts/check_release.py
```

Node é necessário apenas para desenvolvimento/testes da extensão, não para instalação. O kit usa Python 3.10+ e stdlib, em Linux; bootstrap e upload/download usam curl/bash/sha256sum.

## Limites de confiança

O kit não é uma sandbox, não controla todos os tools internos do Arena e não remove os limites da plataforma. Relatórios e handshake são `agent_reported`, não atestação remota. PAT continua no broker; descritores de sessão contêm outros valores sensíveis e não devem ir ao GitHub. O hash depende de uma extensão/distribuição confiável e não substitui assinatura de autor.

A licença de reutilização ainda deve ser escolhida pelo mantenedor. Não há LICENSE adicionada automaticamente.
