# Segurança

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Use o relato privado do GitHub: [Security → Report a vulnerability](https://github.com/arnaldobatista/tarrafa/security/advisories/new). Só você e o mantenedor enxergam a conversa até a correção sair.

Conte o que acontece, como reproduzir e qual impacto você enxerga. O projeto é mantido no tempo livre, então a resposta pode levar alguns dias.

## Versões com correção

Só a versão mais recente, na branch `main`.

## O que interessa

A Tarrafa tem uma parte com mais poder que uma extensão comum: o host nativo executa o `yt-dlp` e o `ffmpeg` na sua máquina. Por isso interessa principalmente:

- uma página conseguir que o host faça algo além de baixar mídia: injetar opções de linha de comando, gravar fora da pasta escolhida, abrir arquivos ou programas;
- cookies ou cabeçalhos de um site chegando a outro, ou ficando gravados em disco depois do download;
- qualquer coisa que não seja a extensão conseguindo falar com o host.

Falhas do próprio `yt-dlp` ou do `ffmpeg` devem ir para os projetos deles.

## Como a Tarrafa se protege

- O host só aceita a extensão cujo ID está no registro do navegador (`allowed_origins`). A extensão, por sua vez, não aceita mensagens de páginas nem de outras extensões.
- Os processos são criados com lista de argumentos, sem shell. A URL vai sempre depois de `--`; nomes de arquivo perdem `/`, `\`, caracteres de controle e a sintaxe de modelo do `yt-dlp` (`%(`); miniaturas só são geradas para endereços `http` e `https`.
- Os cookies vão para um arquivo temporário com permissão `600`, apagado ao fim de cada download. No log, os valores de `Cookie` e `Authorization` aparecem como `[oculto]`.
- Não há telemetria nem servidor próprio.

O ID da extensão vem da chave **pública** que está no `manifest.json`, e qualquer pasta carregada sem compactação com essa mesma chave recebe o mesmo ID. Carregue só a pasta `extension/` deste repositório.
