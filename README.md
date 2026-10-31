# Lumen

Copiloto de IA para macOS. Uma barra flutuante fica sobre qualquer app, ouve a conversa (microfone + áudio do sistema), entende a tela quando você pede e age sobre o texto selecionado em outros apps.

## Gerar o app (.dmg) no seu Mac

Requer Node 20+ e Xcode Command Line Tools (`xcode-select --install`).

```bash
cd ~/Projetos/lumen
npm install
npm run dist          # gera dist/Lumen-0.1.0-arm64.dmg e o .app em dist/mac-arm64/
```

Para testar sem empacotar: `npm run dev`. Nesse modo o macOS atribui as permissões ao "Electron" e não ao Lumen, então para testar microfone, tela e acessibilidade use o app gerado por `npm run dist`.

### Assinatura

- Por padrão o build usa **assinatura ad-hoc** (`identity: "-"` no `electron-builder.yml`). Funciona no seu Mac, mas cada rebuild muda a assinatura e o macOS pode pedir as permissões de novo. Se uma permissão "sumir", remova o Lumen da lista em Ajustes do Sistema e adicione de novo.
- Para distribuir, use seu certificado: `CSC_NAME="Developer ID Application: Seu Nome (TEAMID)" npm run dist`. Para notarizar, adicione `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` e ative `notarize: true` no `electron-builder.yml`.


## Instaladores (v0.2.0)

| Sistema | Arquivo | Como instalar |
|---|---|---|
| Windows 10/11 (64 bits) | `Lumen-Setup-0.2.0.exe` | Dê dois cliques. Instala sem pedir senha de administrador, cria atalho na Área de Trabalho e no Menu Iniciar e abre o Lumen. |
| Linux (qualquer distro) | `Lumen-0.2.0-x86_64.AppImage` | `chmod +x Lumen-0.2.0-x86_64.AppImage` e dois cliques. Não precisa instalar. |
| Ubuntu / Debian | `Lumen-0.2.0-amd64.deb` | `sudo apt install ./Lumen-0.2.0-amd64.deb` (já instala o xdotool para o texto selecionado). |
| macOS | `npm run app` no Mac | Gera e instala o `.app` assinado com o certificado "Lumen Dev". |

Para gerar de novo: `npm run dist:win` e `npm run dist:linux` (no Linux, o `.exe` precisa do Wine instalado), `npm run dist` no Mac.

### Primeiro uso em cada sistema
- **Windows**: só o microfone tem permissão (Configurações → Privacidade e segurança → Microfone → "Permitir que aplicativos da área de trabalho acessem o microfone"). Tela e áudio das chamadas funcionam direto. Sem certificado de assinatura, o SmartScreen mostra "O Windows protegeu o computador" na primeira vez: clique em **Mais informações → Executar assim mesmo**.
- **Linux**: microfone e áudio passam pelo PipeWire/PulseAudio. No Wayland, o sistema pede para compartilhar a tela na primeira captura. Para o atalho de texto selecionado, instale `xdotool` (X11) ou `wtype` (Wayland).
- **IA**: o onboarding oferece três caminhos: **Grátis na nuvem** (Gemini + Groq), **No seu computador** (Ollama, com link de download certo para o sistema e download do modelo de dentro do app) ou **Minha chave** (Claude/OpenAI).

### Atalhos no Windows e Linux
Os mesmos do Mac, trocando ⌘ por **Ctrl**: Ctrl+\ (barra), Ctrl+Shift+Enter (perguntar), Ctrl+Shift+S (o que digo?), Ctrl+Shift+M (gravar/pausar), Ctrl+Shift+L (texto selecionado). O ícone do Lumen fica na bandeja, perto do relógio.

## Primeiro uso (macOS)

1. Abra o Lumen. O onboarding pede **Microfone**, **Tela e áudio do sistema**, **Acessibilidade** (opcional) e uma **chave de IA**.
2. A permissão de tela só vale depois de reabrir o app: use o botão "Já ativei, reabrir o Lumen".
3. Para transcrever áudio é preciso uma chave da **OpenAI** (gpt-4o-mini-transcribe) ou da **Groq** (Whisper v3 turbo). As respostas podem vir do **Claude** ou da **OpenAI**.

## Atalhos

| Ação | Atalho |
|---|---|
| Mostrar/ocultar a barra | ⌘ \ |
| Perguntar sobre a tela | ⌘ ⇧ ↩ |
| O que eu digo agora? | ⌘ ⇧ S |
| Iniciar/parar a escuta | ⌘ ⇧ M |
| Ações no texto selecionado | ⌘ ⇧ L |

## Funcionalidades

- **Barra flutuante** sempre visível, arrastável, em todos os Spaces e sobre apps em tela cheia; a janela acompanha o tamanho do conteúdo.
- **Modos** (Geral, Reuniões, Vendas, Programação, Atendimento) com instruções editáveis e **documentos de contexto** (PDF, TXT, MD, CSV, JSON).
- **Escuta ao vivo** do microfone ("Você") e do áudio do sistema ("Outros"), com medidores de nível e cronômetro.
- **Perguntar** com captura da tela; as janelas do Lumen ficam fora da captura.
- **"O que digo?"**: sugere uma resposta pronta com base na transcrição e na tela.
- **Ações no texto selecionado** em qualquer app: explicar, resumir, reescrever, corrigir, traduzir e responder, com **substituir no app** para colar o resultado de volta.
- **Histórico** com busca, renomear, respostas, transcrição, **resumo com próximos passos** e exportação em Markdown.

### Melhorias

- **Dois provedores de IA** (Claude e OpenAI), com troca automática quando falta a chave de um deles.
- **Corte por pausa de fala**: o áudio é dividido nas pausas naturais e trechos de silêncio nem são enviados, o que reduz custo e evita frases inventadas pela transcrição. Também há um filtro de "alucinações" comuns.
- **Sugestão automática** quando alguém faz uma pergunta na conversa (opcional).
- **Título automático** das sessões e **resumo com decisões e próximos passos**.
- **Chaves criptografadas** no Keychain (safeStorage) e **escrita atômica** dos dados.
- Ícone na **barra de menus**, botão para **reabrir depois da permissão** e **sensibilidade do microfone** ajustável.
- Sem dependências nativas para compilar (sem SQLite/node-gyp), então o build é mais simples.

## Estrutura

```
src/main/        processo principal: janelas, IPC, permissões, captura, IA, transcrição, armazenamento
src/preload/     ponte segura (window.lumen)
src/renderer/    React: Bar (barra), Home (início, histórico, modos, configurações), Onboarding
src/shared/      tipos e atalhos compartilhados
```

Os dados ficam em `~/Library/Application Support/Lumen/` (`settings.json`, `modes.json`, `keys.json`, `sessions/*.json`).
