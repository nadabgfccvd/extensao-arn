---
name: arena-ultra-agent
description: Operar como agente do Arena Ultra usando chat de equipe, menções diretas, timer real, checkpoints, validação e revisão cruzada. Usar quando a extensão atribuir uma sala ou um papel ao agente.
compatibility: Python 3.10+ em Linux, bash/curl para instalação e wrappers; rede para chat e GitHub. Sem dependências pip. Requer sessão gerada pela extensão normal.
metadata:
  version: "1.0.0"
  protocol: "1"
---

# Arena Ultra Agent

Não carregue todo o manual. Rode `/tmp/au_agent doctor`, depois `/tmp/au_agent guide start` uma vez.

Ciclo: `/tmp/au_agent tick` → incremento no seu escopo → `harness checkpoint` → `verify` → revisão cruzada → `report`.

Guias sob demanda pelo CLI: `guide collaboration`, `guide modes`, `guide security`, `guide recovery`.

O comando consulta arquivos locais de referências; não traz todos os textos ao contexto a cada turno. Navegadores/modelos não necessariamente descobrem Skills automaticamente: a instalação explícita pelo prompt continua sendo o caminho suportado.

Regras invariantes: time unido, Quadro Único, PAT só no broker, não forjar evidências, relógio real em vez de estimativa, segurança e PARAR acima do timer. Copie o report na resposta final para a extensão recebê-lo.
