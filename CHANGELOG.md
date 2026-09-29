# Mudanças

As mudanças relevantes de cada versão ficam registradas aqui. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [2.0.0] — 2026-09-29

Primeira versão pública.

### Detecção

- Mídia de qualquer site: HLS (`.m3u8`), DASH (`.mpd`) e arquivos diretos que passam pela rede, inclusive dentro de iframes.
- Varredura da página atrás de players embutidos, elementos `<video>` e URLs de mídia escritas no código.
- Leitura de cada manifesto: resoluções, duração, transmissão ao vivo e DRM. Playlists repetidas saem da lista.
- Miniatura de cada item, feita com um quadro do próprio vídeo, e destaque para o que está tocando.
- Quando o `yt-dlp` não conhece o site, tentativa automática pelo melhor item detectado na rede.

### Download

- Qualquer pasta de destino, com regras por site e a opção de perguntar a cada download.
- Qualidade escolhida vendo o tamanho de cada resolução; nome do arquivo editável antes de baixar.
- Áudio no codec original, sem reencodar, ou em MP3.
- Trecho, legendas, SponsorBlock, capa, metadados, capítulos e playlists.
- Cookies do navegador para conteúdo que exige login.
- Fila com downloads simultâneos, retomada e histórico; menu do botão direito e notificações.

### Instalação e diagnóstico

- `install.sh` e `uninstall.sh` para Chrome, Chromium, Brave, Edge, Vivaldi e Arc.
- Diagnóstico na tela de Ajustes: versões de `yt-dlp`, `ffmpeg` e `deno`, o erro exato do navegador quando o host falha e um aviso, com botão de recarga, quando o código em segundo plano está desatualizado.
