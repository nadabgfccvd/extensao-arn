# Desenvolvimento do Arena Ultra

Leia README.md e apenas a referência relevante. Este arquivo é um mapa, não um manual monolítico.

## Invariantes

- Extensão MV3 zero-build, sem código remoto executado no navegador e sem novas permissões desnecessárias.
- PAT apenas no broker: nunca gravar em prompt, código do kit, storage.local ou repositório.
- Sala/slot/bindingEpoch são autoridade da extensão, não do texto de agentes.
- Kit e extensão compartilham protocol 1. Relatórios são declarados, não atestação.
- Não quebrar aliases au_chat/au_timer/au_gh/au_harness nem envelopes existentes.
- Mudanças de release exigem nova versão/pin; nunca substituir silenciosamente pacote publicado.
- Segurança, créditos, cards humanos obrigatórios e PARAR prevalecem.
- Manter bootstrap compacto: código e manual detalhado em arquivos, não em prompts repetidos.

## Localização

- extension/shared/agent-kit.js: distribuição fixada, sessão e handshake.
- extension/shared/harness-engine.js: parser/gate de relatórios.
- extension/background/service-worker.js: autoridade de sala e integração.
- agent-kit/__main__.py: instalação, descoberta, tick e fingerprint.
- agent-kit/tools/: clientes compatíveis de chat/timer/Git/harness.
- agent-kit/references/: guias carregados sob demanda.
- extension/AGENT_KIT_RESEARCH.md: fontes, decisões e limites.

## Verificação

Execute as três verificações do README antes de entregar. Não apresente testes mockados como homologação em navegador autenticado. Não publique au_state, descritores de sessões reais, vaults ou exports pessoais.
