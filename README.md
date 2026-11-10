# Lumen

**Copiloto de IA para desktop.** É uma barra flutuante que fica sobre qualquer app: ouve a conversa, lê a tela quando você pede, sugere o que responder, age sobre o texto selecionado e guarda cada sessão com a transcrição revisada e um resumo.

`Electron` · `React 19` · `TypeScript` · macOS · Windows · Linux · v0.3.5

<!-- TODO: adicionar um GIF da barra em uso (docs/demo.gif) -->

---

## Por que existe

Copilotos de IA para reuniões costumam ser pagos, fechados e passar seus dados por um servidor da empresa. O Lumen foi escrito para fazer o mesmo trabalho com três regras:

- **Seus dados ficam no seu computador.** As sessões ficam em JSON local, as chaves de API ficam criptografadas no cofre do sistema e não existe backend nem telemetria.
- **Custo zero possível.** Funciona com Gemini e Groq nos planos grátis, ou 100% local com o Ollama.
- **Falhar de forma visível e recuperável.** Tem limites de tempo, novas tentativas automáticas, provedor reserva e mensagens de erro claras.

Projeto autoral, escrito do zero a partir de uma lista de funcionalidades observadas em copilotos existentes (abordagem *clean room*), sem reaproveitar código, imagens nem textos de terceiros.

## O que ele faz

| Recurso | Como funciona |
|---|---|
| **Barra flutuante** | Transparente, sempre no topo, visível em todas as áreas de trabalho e sobre apps em tela cheia |
| **Perguntar sobre a tela** | Captura a tela onde está o cursor (escondendo a própria barra) e responde em streaming, com Markdown e blocos de código |
| **"O que eu digo agora?"** | Sugere uma resposta curta para falar em voz alta, com base no que acabou de ser dito |
| **Gravação com transcrição** | Separa microfone ("Você") e áudio do sistema ("Outros"); ao parar, refaz a transcrição a partir do áudio completo, identificando quem falou |
| **Ações sobre texto selecionado** | Explicar, resumir, reescrever, corrigir, traduzir e responder em qualquer app, com opção de colar o resultado no lugar |
| **Modos com documentos** | Reuniões, vendas, atendimento e estudo, cada um com instruções próprias e PDFs ou CSVs de contexto |
| **Histórico** | Resumo com decisões e próximos passos, transcrição com nomes editáveis e exportação em Markdown |

## Arquitetura e segurança

```
┌──────────────── renderer (React) ────────────────┐
│ desenha a interface e captura o áudio (APIs Web) │
└──────────────────────┬───────────────────────────┘
                       │  window.lumen (API tipada, contextBridge)
┌──────────────────────▼───────────────────────────┐
│ preload: ponte IPC restrita                      │
└──────────────────────┬───────────────────────────┘
┌──────────────────────▼───────────────────────────┐
│ main (Node.js): chaves, disco, rede, captura,    │
│ chamadas às IAs, transcrição, atalhos globais    │
└──────────────────────────────────────────────────┘
```

- A interface **não acessa rede, disco nem sistema**: tudo passa pela ponte do preload até o processo principal.
- A **Content-Security-Policy** restringe scripts e conexões da interface à própria origem.
- **Chaves de API** são criptografadas com `safeStorage` (Keychain no Mac, DPAPI no Windows, libsecret no Linux).
- A **gravação é atômica** (arquivo temporário e depois renomear), para não corromper dados se o app cair.
- **O que sai do computador:** só o necessário e só para o provedor escolhido pelo usuário. Com o Ollama, as respostas não saem da máquina.

## Decisões técnicas que valem a leitura

- **Dupla transcrição.** A primeira é rápida e ao vivo (Whisper turbo na Groq), em trechos cortados por pausa de fala, para alimentar as sugestões. A segunda é fiel e feita **no próprio computador** a partir do áudio completo: separa as vozes (pyannote + impressão de voz TitaNet), reconhece a mesma pessoa entre as partes da gravação e transcreve com o Whisper turbo, tudo via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) num processo separado. Se falhar, o Whisper na nuvem e depois a versão ao vivo ficam como reserva.
- **Tolerância a falhas nos provedores.** Detecta modelo aposentado (404) e troca para o mais novo, faz até 3 tentativas em 429/5xx e, se o provedor principal continuar fora, usa outro com chave configurada.
- **Ollama pela API nativa** (`/api/chat`), porque só ela aceita `num_ctx`, `keep_alive` e `think`. Há também um orçamento de contexto calculado por memória disponível.
- **Filtro de eco e de alucinação.** Remove falas do microfone que repetem o áudio dos alto-falantes e frases típicas que o Whisper inventa em silêncio.
- **Gravação que não se perde.** Cada segundo de áudio vai direto para o disco, em partes de 5 minutos. Ao parar, a barra fica livre na hora e a revisão roda em segundo plano, parte por parte (Gemini → Whisper → trecho ao vivo), com limite de tempo em toda chamada e "Tentar de novo" só do que faltou. Ao abrir, o app revisa sozinho gravações que ficaram pela metade.
- **Resumo da reunião inteira.** Quando a transcrição não cabe no modelo (ex.: Ollama), o resumo é feito em etapas: anota cada bloco e depois junta. Registro de diagnóstico em `~/Library/Logs/Lumen/main.log`.
- **Sem compilar nada.** O único módulo nativo (sherpa-onnx) vem pré-compilado para macOS, Windows e Linux; não há SQLite nem node-gyp.

## Provedores de IA

| Provedor | Custo | Lê a tela | Uso |
|---|---|---|---|
| Gemini | Grátis com limites | Sim | Respostas, sugestões e resumos |
| No computador (sherpa-onnx) | Local, modelos de ~1,1 GB baixados no app | — | Transcrição final com identificação de quem falou |
| Groq | Grátis com limites | Não | Transcrição ao vivo e reserva rápida |
| Ollama | Local | Com modelos de visão | Uso privado e offline |
| Claude / OpenAI | Pago (chave própria) | Sim | Máxima qualidade |

## Rodar e gerar o app

Requer Node 20+.

```bash
npm install
npm run dev          # desenvolvimento com recarga automática
npm run typecheck    # checagem de tipos (roda antes de todo build)
npm run app          # macOS: build (.dmg em ~/Library/Caches/Lumen-build, fora do iCloud) e instala em /Applications
npm run dist:win     # Windows: instalador NSIS
npm run dist:linux   # Linux: AppImage + .deb
```

No macOS, o build cria uma única vez um certificado autoassinado "Lumen Dev" no Keychain. Assim as permissões de microfone, tela e acessibilidade não se perdem a cada rebuild.

### Atalhos

| Ação | macOS | Windows / Linux |
|---|---|---|
| Mostrar/ocultar a barra | ⌘ \ | Ctrl+\ |
| Perguntar sobre a tela | ⌘ ⇧ ↩ | Ctrl+Shift+Enter |
| O que eu digo agora? | ⌘ ⇧ S | Ctrl+Shift+S |
| Gravar / pausar | ⌘ ⇧ M | Ctrl+Shift+M |
| Ações no texto selecionado | ⌘ ⇧ L | Ctrl+Shift+L |

## Estado atual e próximos passos

Funcional no macOS (Apple Silicon). Os instaladores de Windows e Linux já são gerados, mas ainda precisam de teste em máquinas reais.

- [ ] Testar o instalador e uma gravação completa em Windows 10/11
- [ ] Testar AppImage e .deb em Ubuntu (X11 e Wayland)
- [x] Transcrição final no computador, com identificação de quem falou
- [ ] Transcrição ao vivo também local, para um modo 100% offline
- [ ] Ativar `sandbox: true` nas janelas do Electron
- [ ] Assinatura Developer ID (Mac) e de código (Windows) para distribuir sem avisos

## Uso responsável

Avise as pessoas antes de gravar uma conversa. Em muitos lugares, gravar sem consentimento é ilegal, e em ambientes de trabalho costuma violar políticas internas.

---

Desenvolvido por **Willian Barbosa** · [LinkedIn](https://www.linkedin.com/in/willianbarbosadeandrade)
