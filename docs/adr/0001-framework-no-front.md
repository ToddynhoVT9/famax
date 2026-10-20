# ADR 0001 — Framework no front-end

- **Status:** proposto (avaliação, nada implementado)
- **Data:** 2026-10-20
- **Contexto do pedido:** prompt 14, parte A5

## Contexto

O front é um MPA do Vite com TypeScript sem framework: 16 páginas HTML, cada
uma com um script que monta o DOM à mão. São cerca de 11,5 mil linhas em
`client/script/`. A interface é desenhada de dois jeitos:

- `document.createElement` + `textContent`, o padrão nos módulos novos
  (diálogos, skeletons, chat);
- templates em string com `innerHTML` (39 usos), protegidos por `escapeHtml`
  (56 chamadas) e, no markdown, por DOMPurify.

O que já existe e funciona: layout compartilhado (`shared/layout.ts`), cliente
da API tipado (`shared/api-endpoints.ts`) com os tipos de `shared/api-types.d.ts`,
tempo real por SSE, focus trap, temas por variáveis CSS. Cada página carrega
só o seu script; não há estado global além do cache do `/me`.

As dores que motivam a pergunta:

1. **Atualização manual do DOM.** Ex.: o post do feed (`post-thread.ts`, ~1000
   linhas) troca contadores, reações e estados de botão um por um; um campo
   novo exige mexer em vários pontos.
2. **Segurança dependente de disciplina.** Cada `innerHTML` precisa lembrar do
   `escapeHtml`. Um esquecimento vira XSS (já aconteceu, ver o comentário no
   topo de `post-thread.ts`).
3. **Componentes sem fronteira.** Modais e listas repetem o mesmo esqueleto
   (abrir, prender foco, fechar, devolver foco) com variações pequenas.

## Opções

| | Preact (+ signals) | Svelte 5 | Lit |
| --- | --- | --- | --- |
| Tamanho (runtime) | ~4 kB | ~0 kB de runtime fixo; código compilado por componente | ~6 kB |
| Modelo | JSX, componentes função, VDOM | compilador, `.svelte`, runes | Web Components, templates com tagged literals |
| Escape por padrão | sim (JSX) | sim | sim (`html```) |
| Migração por ilha (uma parte da página por vez) | fácil: `render()` num nó | fácil: `mount()` num nó | fácil: um custom element por vez |
| Ferramental | plugin oficial do Vite; TS nativo no JSX | plugin oficial do Vite; TS com `svelte-check` | nenhum plugin; TS com decorators |
| Curva para quem mantém hoje | baixa (é JS/TS + JSX) | média (sintaxe própria) | média (Shadow DOM, ciclo de vida de custom elements) |
| Encaixe com o CSS atual (global, por página) | direto | direto (CSS escopado opcional) | atrito: Shadow DOM isola o CSS global e os tokens precisam atravessar |

## Prós de migrar

- Escape por padrão em todo template: some a classe de bug "esqueceu o escapeHtml".
- Estado → interface declarativo: o post, o chat e as notificações deixam de
  sincronizar o DOM à mão.
- Componentes reaproveitáveis com fronteira clara (modal, lista paginada,
  botão de reação), testáveis isolados.

## Contras de migrar

- **Custo alto, ganho de usuário zero.** Reescrever ~11 mil linhas funcionando
  e testadas não muda nada visível; o risco de regressão é real (acessibilidade
  do prompt 13, tempo real do prompt 11).
- Mais uma dependência e um passo de compilação para manter atualizados.
- A base atual não está em crise: o cliente tipado, os tipos compartilhados e
  os módulos `shared/` já resolveram boa parte da repetição.
- O MPA continua sendo MPA; um framework não traz roteamento nem SSR aqui sem
  uma mudança de arquitetura maior (e desnecessária).

## Recomendação

**Não migrar o front inteiro agora.** Se a interface continuar crescendo,
adotar **Preact** de forma incremental, por ilhas, começando pelas telas com
mais estado:

1. o widget de chat (`shared/chat-widget.ts`, o maior módulo e o mais reativo);
2. o post com reações e comentários (`shared/post-thread.ts`);
3. o sininho de notificações.

Preact porque é o menor salto a partir do código atual (TS + JSX, sem sintaxe
nova nem Shadow DOM), convive com o CSS global e os tokens sem atrito, e pode
ser montado num nó de uma página sem tocar nas outras. Lit perde pelo
isolamento do Shadow DOM contra o CSS global; Svelte é uma boa opção técnica,
mas pede uma sintaxe e um checador próprios para um ganho parecido.

Critério para reabrir a decisão: uma tela nova grande (ex.: painel de
moderação completo) ou bugs recorrentes de sincronização de DOM nas telas
citadas.

## Consequências se aprovado

- `@preact/preset-vite` no `vite.config.ts`; `jsx: "react-jsx"` e
  `jsxImportSource: "preact"` no `tsconfig.client.json`.
- Regra nova: componente novo e interativo nasce em Preact; código existente
  só migra quando for reescrito por outro motivo.
- O cliente da API (`api.*`) e os tipos de `shared/api-types.d.ts` continuam
  os mesmos; os componentes os consomem direto.
