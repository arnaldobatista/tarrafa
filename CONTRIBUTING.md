# Contribuindo com a Tarrafa

Obrigado pelo interesse. A Tarrafa é pequena de propósito: uma extensão sem dependências e um host em Node que usa só a biblioteca padrão. As contribuições mais fáceis de aceitar são as que mantêm isso.

## Antes de começar

- **Encontrou um problema?** Abra uma issue com o modelo **Problema**. O diagnóstico da tela Ajustes e as últimas linhas do log resolvem metade dos casos.
- **Um site não baixa?** Teste antes o `yt-dlp` sozinho, no terminal: `yt-dlp "URL"`. Se nem ele baixa, o problema é do `yt-dlp` e o lugar certo é o [repositório dele](https://github.com/yt-dlp/yt-dlp/issues).
- **Mudança grande ou recurso novo?** Abra uma issue antes do pull request para combinar o caminho. Evita trabalho jogado fora dos dois lados.

## Ambiente

Os requisitos são os mesmos do [README](README.md#requisitos): macOS, um navegador Chromium e as ferramentas pelo Homebrew.

```bash
brew install node yt-dlp ffmpeg deno
git clone https://github.com/arnaldobatista/tarrafa.git
cd tarrafa
./install.sh
```

Depois, carregue a pasta `extension/` em `chrome://extensions` (**Modo do desenvolvedor** → **Carregar sem compactação**).

## O ciclo de edição

Cada parte do projeto é recarregada de um jeito:

| Mexeu em | Para a mudança valer |
|---|---|
| `extension/app.html`, `app.css`, `app.js` | feche e abra o painel de novo |
| `extension/background.js` ou `manifest.json` | recarregue a extensão (↻ em `chrome://extensions`) |
| `host/host.js` | rode `./install.sh` — ele copia o host para `~/Library/Application Support/Tarrafa/`, de onde o navegador consegue executá-lo |

Para depurar:

- **Service worker:** em `chrome://extensions`, no cartão da Tarrafa, clique em **service worker** para abrir o DevTools dele.
- **Painel:** botão direito dentro do painel → **Inspecionar**.
- **Host:** `tail -f ~/Library/Logs/tarrafa.log` mostra cada comando do `yt-dlp` com os argumentos exatos.

## Verificações

A integração contínua roda estas verificações em todo pull request. Rode antes na sua máquina:

```bash
node --check host/host.js
node --check extension/background.js
node --input-type=module --check < extension/app.js
bash -n install.sh uninstall.sh navegadores.sh
```

Elas só pegam erro de sintaxe. O teste que importa é no navegador: pelo menos um download de ponta a ponta com o que você mudou.

## Estilo

- **Código, comentários e mensagens em português**, como o resto do projeto.
- Comentários explicam **por quê**, não o quê — principalmente quando a razão é um comportamento do navegador, do macOS ou do `yt-dlp` que ninguém adivinharia lendo o código.
- Nada de dependências novas, nem na extensão nem no host.
- Toda tradução de opção para argumento do `yt-dlp` fica em `montarArgs()`, no `host/host.js`.
- Dado vindo de página nunca vira opção de linha de comando: a URL vai depois de `--`, e nomes de arquivo passam por `nomeDeArquivo()`.
- Indentação de 2 espaços; o `.editorconfig` cuida do resto.

## Pull requests

- Um assunto por pull request.
- Diga o que mudou, por quê e como você testou (site, navegador, versão do `yt-dlp`).
- Mudou algo visível para quem usa? Atualize o `README.md` e o `CHANGELOG.md`.

Ao enviar uma contribuição, você concorda que ela seja distribuída sob a [licença MIT](LICENSE) do projeto.
