#!/usr/bin/env node
// Tarrafa — host nativo.
// Conversa com a extensão pelo protocolo de native messaging e roda yt-dlp/ffmpeg.
// NÃO escreva nada em stdout que não seja mensagem enquadrada: stdout é o canal.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const AQUI = __dirname;

// Dois destinos: se o primeiro falhar (permissão, TCC), o segundo sempre serve.
const LOGS = [
  path.join(os.homedir(), "Library", "Logs", "tarrafa.log"),
  path.join(os.tmpdir(), "tarrafa.log"),
];
let LOG = LOGS[0];

function log(...a) {
  const linha = `[${new Date().toISOString()}] ${a.join(" ")}\n`;
  for (const destino of LOGS) {
    try {
      fs.appendFileSync(destino, linha);
      LOG = destino;
      return;
    } catch { /* tenta o próximo */ }
  }
}

// Sem isto, qualquer exceção mata o processo em silêncio e o Chrome só diz
// "Native host has exited" — sem pista nenhuma de onde foi.
function morrerFalando(origem, err) {
  const detalhe = err && err.stack ? err.stack : String(err);
  log(`FALHA (${origem}):`, detalhe);
  try {
    enviar({ type: "crash", origem, mensagem: detalhe.split("\n")[0] });
  } catch { /* canal já pode estar fechado */ }
  process.exit(1);
}
process.on("uncaughtException", (e) => morrerFalando("uncaughtException", e));
process.on("unhandledRejection", (e) => morrerFalando("unhandledRejection", e));

// ------------------------------------------------------- binários externos

const DIRS = [
  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  "/opt/local/bin", path.join(os.homedir(), ".local/bin"),
];

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(AQUI, "config.json"), "utf8"));
} catch { /* sem config: cai na busca */ }

function acharBin(nome) {
  if (config[nome] && fs.existsSync(config[nome])) return config[nome];
  const extras = (process.env.PATH || "").split(":").filter(Boolean);
  for (const d of [...DIRS, ...extras]) {
    const p = path.join(d, nome);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* segue */ }
  }
  return null;
}

const YTDLP = acharBin("yt-dlp");
const FFMPEG = acharBin("ffmpeg");
// O YouTube assina as URLs de mídia com um desafio em JavaScript. Sem um
// runtime para resolvê-lo, o yt-dlp devolve URLs sem assinatura e o servidor
// responde 403. O deno é o runtime que o yt-dlp habilita por padrão.
const DENO = acharBin("deno");

// O Chrome lança o host com um PATH mínimo (/usr/bin:/bin:...), então o yt-dlp
// não acharia o deno nem nada mais que precise invocar. Damos um PATH completo.
const PATH_COMPLETO = [...new Set([...DIRS, ...(process.env.PATH || "").split(":")])]
  .filter(Boolean).join(":");

const AMBIENTE = { ...process.env, PATH: PATH_COMPLETO };

// --------------------------------------------------- protocolo (enquadramento)

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 4) return;
    const tam = buffer.readUInt32LE(0);
    if (tam === 0 || buffer.length < tam + 4) return;
    const texto = buffer.toString("utf8", 4, tam + 4);
    buffer = buffer.subarray(tam + 4);
    try {
      receber(JSON.parse(texto));
    } catch (e) {
      log("mensagem inválida:", e.message);
    }
  }
});

function enviar(obj) {
  const dados = Buffer.from(JSON.stringify(obj), "utf8");
  const cab = Buffer.alloc(4);
  cab.writeUInt32LE(dados.length, 0);
  try {
    process.stdout.write(cab);
    process.stdout.write(dados);
  } catch (e) {
    log("falha ao escrever:", e.message);
  }
}

// O Chrome pode fechar o canal (service worker dormiu). Não abandonamos
// downloads em andamento: seguimos até terminarem e só então saímos.
process.stdin.on("end", () => {
  log("stdin encerrado; ativos:", ativos.size);
  if (ativos.size === 0) sairLimpo(0);
});

function stdinFechado() {
  return process.stdin.readableEnded === true;
}

function sairLimpo(codigo) {
  for (const f of temporarios) { try { fs.unlinkSync(f); } catch { /* já foi */ } }
  process.exit(codigo);
}

// --------------------------------------------------------------- utilidades

const temporarios = new Set();

// O yt-dlp fala em jargão. Aqui viram frases que dizem o que fazer.
const TRADUCOES = [
  [/No supported JavaScript runtime/i, "falta um runtime JavaScript para o yt-dlp resolver a assinatura do YouTube — instale com: brew install deno"],
  [/unable to obtain file audio codec/i, "esse vídeo não tem faixa de áudio"],
  [/Requested format is not available/i, "esse formato não existe aqui — tente outra qualidade"],
  [/HTTP Error 403|Forbidden/i, "o servidor recusou o acesso (403) — experimente ligar os cookies nos Ajustes"],
  [/HTTP Error 429|Too Many Requests/i, "o site está limitando as requisições (429) — espere alguns minutos e tente de novo"],
  [/HTTP Error 404|Not Found/i, "o link expirou ou não existe mais (404) — recarregue a página e tente de novo"],
  [/Unsupported URL/i, "o yt-dlp não conhece esse site — use um item da lista “Detectado na rede”"],
  [/Sign in to confirm|requires authentication|Private video|members-only|login/i, "esse vídeo exige login — ligue os cookies nos Ajustes"],
  [/age-restricted|confirm your age/i, "esse vídeo tem restrição de idade — ligue os cookies nos Ajustes"],
  [/DRM|is protected/i, "esse vídeo é protegido por DRM e não dá para baixar"],
  [/is not a valid URL|No video formats found/i, "não achei vídeo nesse endereço"],
  [/Connection|timed out|Temporary failure|resolve host/i, "falha de rede ao falar com o servidor"],
  [/No space left/i, "sem espaço em disco na pasta de destino"],
  [/Permission denied/i, "sem permissão de escrita nessa pasta"],
  [/ffmpeg exited with code/i, "o ffmpeg falhou ao processar o arquivo"],
];

function traduzirErro(bruto) {
  if (!bruto) return "";
  for (const [re, texto] of TRADUCOES) if (re.test(bruto)) return texto;
  return bruto;
}

function versao(bin, flag) {
  if (!bin) return null;
  try {
    return execFileSync(bin, [flag], {
      encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], env: AMBIENTE,
    }).split("\n")[0].trim();
  } catch { return null; }
}

// O yt-dlp versiona por data (2026.07.04). Quando um site quebra, quase sempre
// é porque a cópia local envelheceu — vale avisar antes de o usuário penar.
function idadeEmDias(v) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(v || "");
  if (!m) return null;
  const quando = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.floor((Date.now() - quando) / 86400000);
}

// Nome vindo da página: tirar tudo que atrapalha em sistema de arquivos e o
// que o yt-dlp interpretaria como campo de template.
function nomeDeArquivo(bruto) {
  return String(bruto)
    .replace(/%\(/g, "(")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Quem digita "aula.mp4" não quer "aula.mp4.mkv": a extensão é nossa.
    .replace(/\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|ogg|opus|wav|flac|m3u8|mpd)$/i, "")
    .slice(0, 150) || "video";
}

// Com nome escolhido, dois vídeos da mesma página podem pedir o mesmo nome, e o
// --no-overwrites pularia o segundo em silêncio. Numeramos como o navegador faz.
// Arquivo parcial não conta: é o que permite retomar um download interrompido.
function nomeLivre(pasta, base) {
  let existentes;
  try { existentes = fs.readdirSync(pasta); } catch { return base; }
  const PARCIAL = /\.(part|ytdl|temp)$|\.part-Frag|\.f\d+\.[a-z0-9]+$/i;
  const ocupado = (n) => existentes.some((f) => f.startsWith(n + ".") && !PARCIAL.test(f));
  if (!ocupado(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidato = `${base} (${i})`;
    if (!ocupado(candidato)) return candidato;
  }
  return base;
}

function pastaValida(p) {
  if (typeof p !== "string" || !p.startsWith("/")) return null;
  try {
    fs.mkdirSync(p, { recursive: true });
    fs.accessSync(p, fs.constants.W_OK);
    return p;
  } catch { return null; }
}

// Formato Netscape, que é o que o yt-dlp lê. Arquivo com permissão 600 e
// apagado assim que o download termina: são credenciais reais do usuário.
function escreverCookies(id, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const linhas = ["# Netscape HTTP Cookie File", "# Gerado pela Tarrafa", ""];
  for (const c of cookies) {
    if (!c || typeof c.name !== "string" || typeof c.domain !== "string") continue;
    if (/[\t\r\n]/.test(c.name) || /[\t\r\n]/.test(String(c.value ?? ""))) continue;
    const subdominios = c.hostOnly ? "FALSE" : "TRUE";
    const dominio = c.hostOnly ? c.domain : (c.domain.startsWith(".") ? c.domain : "." + c.domain);
    const expira = Math.floor(c.expirationDate || (Date.now() / 1000 + 86400));
    linhas.push([
      dominio, subdominios, c.path || "/",
      c.secure ? "TRUE" : "FALSE", expira, c.name, c.value ?? "",
    ].join("\t"));
  }
  if (linhas.length <= 3) return null;
  const arquivo = path.join(os.tmpdir(), `tarrafa-cookies-${id}.txt`);
  fs.writeFileSync(arquivo, linhas.join("\n") + "\n", { mode: 0o600 });
  temporarios.add(arquivo);
  return arquivo;
}

function apagar(arquivo) {
  if (!arquivo) return;
  try { fs.unlinkSync(arquivo); } catch { /* já foi */ }
  temporarios.delete(arquivo);
}

// ------------------------------------------------ montagem da linha do yt-dlp

// Estes argumentos valem para tudo: sondagem e download.
function argsBase(msg) {
  const args = [];
  if (FFMPEG) args.push("--ffmpeg-location", path.dirname(FFMPEG));
  if (DENO) args.push("--js-runtimes", `deno:${DENO}`);
  // O YouTube devolve 403 na mídia para vários dos seus clientes de player.
  // O "web_embedded" continua entregando a escada completa até 1080p e baixa
  // sem recusa; "default" fica de reserva para vídeo que proíbe incorporação.
  args.push("--extractor-args", "youtube:player_client=web_embedded,default");

  for (const [nome, valor] of Object.entries(msg.cabecalhos || {})) {
    if (/^[A-Za-z-]{1,40}$/.test(nome) && typeof valor === "string" && !/[\r\n]/.test(valor)) {
      if (nome.toLowerCase() === "referer") args.push("--referer", valor);
      else if (nome.toLowerCase() === "user-agent") args.push("--user-agent", valor);
      else args.push("--add-header", `${nome}:${valor}`);
    }
  }
  return args;
}

function seletorFormato(o) {
  if (o.tipo === "audio") return "ba/b";

  const teto = o.altura ? `[height<=${o.altura}]` : "";
  if (o.container === "mp4") {
    // Preferimos H.264 + AAC porque tocam em qualquer lugar; se o site não
    // tiver, caímos no melhor disponível em vez de falhar.
    return `bv*[vcodec^=avc1]${teto}+ba[ext=m4a]/bv*${teto}+ba/b${teto}/b`;
  }
  return `bv*${teto}+ba/b${teto}/b`;
}

function montarArgs(msg, pasta, arquivoCookies, arquivoSaida) {
  const o = msg.opcoes || {};
  const args = [
    "--newline", "--no-mtime", "--no-overwrites", "--trim-filenames", "200",
    // 429 e quedas de CDN são comuns e passageiros; tentar de novo sozinho
    // evita perder um download inteiro por um soluço do servidor.
    "--retries", "5", "--fragment-retries", "5", "--retry-sleep", "3",
  ];

  const ehPlaylist = !!(o.playlist && o.playlist.ativo);
  args.push(ehPlaylist ? "--yes-playlist" : "--no-playlist");

  args.push("-P", pasta);

  if (ehPlaylist) {
    args.push("-o", "%(playlist_title).80B/%(playlist_index)03d - %(title).100B [%(id).40B].%(ext)s");
    if (o.playlist.itens) args.push("--playlist-items", String(o.playlist.itens));
  } else if (msg.nomeBase) {
    // A extensão mandou um nome melhor que o da URL (título da aula, por
    // exemplo). URL de CDN costuma se chamar "playlist.m3u8".
    args.push("-o", `${nomeLivre(pasta, nomeDeArquivo(msg.nomeBase))}.%(ext)s`);
  } else {
    // Numa página o id distingue vídeos homônimos; numa URL crua o extrator
    // genérico usa o nome do arquivo como título E como id, então ele só sujaria.
    args.push("-o", msg.origem === "rede"
      ? "%(title).150B.%(ext)s"
      : "%(title).120B [%(id).40B].%(ext)s");
  }

  if (o.dividirCapitulos) {
    args.push("--split-chapters");
    args.push("-o", "chapter:%(title).80B/%(section_number)03d - %(section_title).80B.%(ext)s");
  }

  args.push("--print-to-file", "after_move:filepath", arquivoSaida);
  args.push(...argsBase(msg));

  if (arquivoCookies) args.push("--cookies", arquivoCookies);

  args.push("-f", seletorFormato(o));

  if (o.tipo === "audio") {
    args.push("-x");
    // Sem --audio-format o yt-dlp só troca o contêiner e mantém o codec
    // original — nada de reencodar e perder qualidade à toa.
    if (o.audioFormato === "mp3") args.push("--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("--merge-output-format", o.container === "mp4" ? "mp4" : "mkv");
  }

  // ---- legendas (só fazem sentido em vídeo)
  const leg = o.legendas || {};
  if (o.tipo !== "audio" && leg.ativo) {
    // Códigos exatos, não "pt.*": o curinga puxava pt, pt-PT e pt-orig —
    // três requisições ao servidor e três faixas idênticas no arquivo.
    const idiomas = (leg.idiomas && leg.idiomas.length ? leg.idiomas : ["pt", "en"])
      .filter((l) => /^[a-zA-Z-]{2,10}$/.test(l))
      .join(",");
    args.push("--sub-langs", idiomas || "pt,en");
    if (leg.automaticas) args.push("--write-auto-subs");
    if (leg.embutir) {
      // Só --embed-subs: pedir --write-subs junto embute E deixa os .vtt
      // largados na pasta.
      args.push("--embed-subs");
    } else {
      args.push("--write-subs", "--convert-subs", "srt");
    }
  }

  // ---- SponsorBlock
  const sb = o.sponsorblock || {};
  if (sb.ativo) {
    const cats = (sb.categorias && sb.categorias.length ? sb.categorias : ["sponsor", "selfpromo"])
      .filter((c) => /^[a-z_]{3,20}$/.test(c)).join(",");
    if (cats) args.push("--sponsorblock-remove", cats);
  }

  // ---- metadados
  const md = o.metadados || {};
  if (md.thumbnail) args.push("--embed-thumbnail");
  if (md.info) args.push("--embed-metadata");
  if (md.capitulos && o.tipo !== "audio") args.push("--embed-chapters");

  // ---- trecho
  const t = o.trecho;
  if (t && (t.inicio || t.fim)) {
    const tempo = (v) => (/^[0-9:.]{1,12}$/.test(v || "") ? v : "");
    const ini = tempo(t.inicio) || "0";
    const fim = tempo(t.fim) || "inf";
    args.push("--download-sections", `*${ini}-${fim}`);
    // Nada de --force-keyframes-at-cuts: ele reencoda (o áudio saía em AC3).
    // Sem ele o corte é cópia de stream — preserva o codec, é muito mais
    // rápido, e na prática erra menos de um segundo.
    // Cortar troca o downloader nativo pelo ffmpeg, que sem estas opções
    // desiste no primeiro soluço da CDN em vez de reconectar.
    args.push("--downloader-args",
      "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -rw_timeout 30000000");
  }

  if (o.liveDoComeco) args.push("--live-from-start");

  args.push("--", msg.url);
  return args;
}

// ------------------------------------------------------------------ sondagem

function sondar(msg) {
  const id = msg.id;
  if (!YTDLP) return enviar({ type: "sonda", id, ok: false, mensagem: "yt-dlp não encontrado" });

  const arquivoCookies = escreverCookies(`sonda-${id}`, msg.cookies);
  const args = ["-J", "--no-warnings", "--no-playlist"];
  if (msg.playlist) { args[2] = "--yes-playlist"; args.push("--flat-playlist"); }
  args.push(...argsBase(msg));
  if (arquivoCookies) args.push("--cookies", arquivoCookies);
  args.push("--", msg.url);

  log("sondando:", msg.url);
  const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"], env: AMBIENTE });
  let saida = "";
  let erro = "";
  const limite = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* já foi */ } }, 90000);

  child.stdout.on("data", (d) => { if (saida.length < 40e6) saida += d; });
  child.stderr.on("data", (d) => { erro += d; });
  child.on("error", (e) => {
    clearTimeout(limite);
    apagar(arquivoCookies);
    enviar({ type: "sonda", id, ok: false, mensagem: e.message });
  });
  child.on("close", () => {
    clearTimeout(limite);
    apagar(arquivoCookies);
    let j;
    try { j = JSON.parse(saida); } catch {
      const linha = (erro.split("\n").find((l) => /^ERROR:/i.test(l)) || "").replace(/^ERROR:\s*/i, "");
      return enviar({ type: "sonda", id, ok: false, mensagem: traduzirErro(linha) || "não consegui ler esse endereço" });
    }
    enviar({ type: "sonda", id, ok: true, dados: resumirSonda(j) });
  });
}

function resumirSonda(j) {
  const formatos = [];
  let temDrm = false;
  for (const f of j.formats || []) {
    if (f.has_drm) temDrm = true;
    if (!f.format_id || f.format_id.startsWith("sb")) continue;
    const temVideo = f.vcodec && f.vcodec !== "none";
    const temAudio = f.acodec && f.acodec !== "none";
    if (!temVideo && !temAudio) continue;
    formatos.push({
      id: f.format_id,
      ext: f.ext,
      altura: f.height || null,
      fps: f.fps || null,
      tamanho: f.filesize || f.filesize_approx || null,
      tbr: f.tbr || null,
      vcodec: temVideo ? String(f.vcodec).split(".")[0] : null,
      acodec: temAudio ? String(f.acodec).split(".")[0] : null,
      nota: f.format_note || "",
    });
  }
  // Uma linha por altura, ficando com a de melhor bitrate: o usuário quer
  // escolher "1080p", não entre seis codecs que dão 1080p.
  const porAltura = new Map();
  for (const f of formatos.filter((x) => x.altura)) {
    const atual = porAltura.get(f.altura);
    const melhor = !atual
      || (f.vcodec === "avc1" && atual.vcodec !== "avc1")
      || (f.vcodec === atual.vcodec && (f.tbr || 0) > (atual.tbr || 0));
    if (melhor) porAltura.set(f.altura, f);
  }

  return {
    titulo: j.title || null,
    canal: j.uploader || j.channel || null,
    duracao: j.duration || null,
    thumbnail: j.thumbnail || null,
    aoVivo: !!j.is_live,
    temDrm,
    ehPlaylist: j._type === "playlist",
    quantosNaPlaylist: Array.isArray(j.entries) ? j.entries.length : 0,
    capitulos: Array.isArray(j.chapters) ? j.chapters.length : 0,
    legendas: Object.keys(j.subtitles || {}).slice(0, 40),
    legendasAuto: Object.keys(j.automatic_captions || {}).slice(0, 40),
    alturas: [...porAltura.values()].sort((a, b) => b.altura - a.altura),
    temAudioSeparado: formatos.some((f) => f.acodec && !f.vcodec),
  };
}

// ------------------------------------------- buscar manifesto e miniatura

// A extensão não consegue mandar Cookie/Referer num fetch() próprio; aqui
// dá. É assim que o manifesto de um CDN fechado chega para ser lido.
async function buscarTexto(msg) {
  const id = msg.id;
  try {
    const resposta = await fetch(msg.url, {
      headers: msg.cabecalhos || {},
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!resposta.ok) {
      return enviar({ type: "texto", id, ok: false, mensagem: `HTTP ${resposta.status}` });
    }
    const tipo = resposta.headers.get("content-type") || "";
    const bruto = await resposta.arrayBuffer();
    // Manifesto é texto e é pequeno; se veio coisa grande, não é o que queremos.
    const corte = Buffer.from(bruto.slice(0, 4 * 1024 * 1024)).toString("utf8");
    enviar({ type: "texto", id, ok: true, texto: corte, contentType: tipo, urlFinal: resposta.url });
  } catch (e) {
    enviar({ type: "texto", id, ok: false, mensagem: e.name === "TimeoutError" ? "tempo esgotado" : e.message });
  }
}

// Um quadro do vídeo vale mais que o nome do arquivo para saber o que é isto.
function miniatura(msg) {
  const id = msg.id;
  if (!FFMPEG) return enviar({ type: "miniatura", id, ok: false });

  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const cab = Object.entries(msg.cabecalhos || {})
    .filter(([n, v]) => /^[A-Za-z-]{1,40}$/.test(n) && typeof v === "string" && !/[\r\n]/.test(v))
    .map(([n, v]) => `${n}: ${v}`).join("\r\n");
  if (cab) args.push("-headers", cab + "\r\n");
  // -ss antes do -i faz o seek acontecer sem decodificar o que vem antes.
  args.push("-ss", String(Math.max(0, Math.min(600, msg.segundo ?? 3))));
  args.push("-i", msg.url, "-frames:v", "1", "-vf", "scale=192:-2", "-f", "image2", "-c:v", "mjpeg", "-");

  const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], env: AMBIENTE });
  const pedacos = [];
  let bytes = 0;
  const limite = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* já foi */ } }, 25000);

  child.stdout.on("data", (d) => {
    if (bytes > 2e6) return;
    pedacos.push(d); bytes += d.length;
  });
  child.stderr.on("data", () => { /* consumir para não travar o pipe */ });
  child.on("error", () => { clearTimeout(limite); enviar({ type: "miniatura", id, ok: false }); });
  child.on("close", (code) => {
    clearTimeout(limite);
    if (code !== 0 || bytes === 0) return enviar({ type: "miniatura", id, ok: false });
    const jpeg = Buffer.concat(pedacos).toString("base64");
    enviar({ type: "miniatura", id, ok: true, jpeg });
  });
}

// ------------------------------------------------------------- downloads

const ativos = new Map(); // id -> { child, arquivoSaida, arquivoCookies }

function receber(msg) {
  switch (msg.type) {
    case "ping":
      return;

    case "info": {
      const ff = versao(FFMPEG, "-version");
      const vy = versao(YTDLP, "--version");
      return enviar({
        type: "info",
        ytdlp: YTDLP,
        ytdlpVersao: vy,
        ytdlpIdadeDias: idadeEmDias(vy),
        ffmpeg: FFMPEG,
        ffmpegVersao: ff ? ff.replace(/^ffmpeg version /, "").split(" ")[0] : null,
        deno: DENO,
        denoVersao: versao(DENO, "--version"),
        home: os.homedir(),
        log: LOG,
        ativos: [...ativos.keys()],
      });
    }

    case "escolherPasta":
      return escolherPasta(msg.id);

    case "abrir":
      return abrir(msg.caminho);

    case "sondar":
      return sondar(msg);

    case "buscar":
      return buscarTexto(msg);

    case "miniatura":
      return miniatura(msg);

    case "cancelar": {
      const a = ativos.get(msg.id);
      if (a) { try { a.child.kill("SIGTERM"); } catch { /* já morreu */ } }
      return;
    }

    case "baixar":
      return baixar(msg);

    default:
      log("comando desconhecido:", msg.type);
  }
}

function escolherPasta(id) {
  const script =
    'try\n' +
    '  set p to POSIX path of (choose folder with prompt "Onde salvar os downloads?")\n' +
    '  return p\n' +
    'on error number -128\n' +
    '  return ""\n' +
    'end try';
  const proc = spawn("/usr/bin/osascript", ["-e", script], { env: AMBIENTE });
  let saida = "";
  proc.stdout.on("data", (d) => (saida += d));
  proc.on("close", () => {
    let p = saida.trim();
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    enviar({ type: "pasta", id, caminho: p || null });
  });
  proc.on("error", (e) => {
    log("osascript falhou:", e.message);
    enviar({ type: "pasta", id, caminho: null });
  });
}

function abrir(caminho) {
  if (!caminho) return;
  const args = fs.existsSync(caminho) && fs.statSync(caminho).isDirectory()
    ? [caminho]
    : ["-R", caminho];
  try { spawn("/usr/bin/open", args, { detached: true, stdio: "ignore", env: AMBIENTE }).unref(); }
  catch (e) { log("open falhou:", e.message); }
}

function baixar(msg) {
  const id = msg.id;

  if (!YTDLP) {
    return enviar({ type: "fim", id, ok: false, mensagem: "yt-dlp não encontrado na máquina" });
  }
  if (!/^https?:\/\//i.test(msg.url || "")) {
    return enviar({ type: "fim", id, ok: false, mensagem: "URL inválida" });
  }

  const pasta = pastaValida(msg.pasta) || path.join(os.homedir(), "Downloads");
  const arquivoSaida = path.join(os.tmpdir(), `tarrafa-${id}.path`);
  temporarios.add(arquivoSaida);

  let arquivoCookies = null;
  try {
    arquivoCookies = escreverCookies(id, msg.cookies);
  } catch (e) {
    log("não consegui escrever os cookies:", e.message);
  }

  const args = montarArgs(msg, pasta, arquivoCookies, arquivoSaida);
  log("yt-dlp", args.map((a) => (/[ "]/.test(a) ? JSON.stringify(a) : a)).join(" "));

  const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"], env: AMBIENTE });
  ativos.set(id, { child, arquivoSaida, arquivoCookies });

  const estado = {
    ultimoErro: null, semRuntimeJs: false, pistaRede: false,
    etapa: null, itemAtual: 0, itensTotal: 0,
  };
  let resto = "";

  child.stdout.on("data", (chunk) => {
    const t = resto + chunk.toString("utf8");
    const linhas = t.split(/\r?\n/);
    resto = linhas.pop();
    for (const l of linhas) analisar(id, l, estado);
  });

  child.stderr.on("data", (chunk) => {
    const t = chunk.toString("utf8");
    for (const l of t.split(/\r?\n/)) {
      if (!l.trim()) continue;
      if (/^ERROR:/i.test(l)) estado.ultimoErro = l.replace(/^ERROR:\s*/i, "").slice(0, 300);
      // O 403 do YouTube costuma ser consequência disto, que aparece antes.
      if (/No supported JavaScript runtime/i.test(l)) estado.semRuntimeJs = true;
      // "ffmpeg exited with code 196" não diz nada; a causa aparece antes,
      // em linhas que não começam com ERROR:.
      if (/timed out|Connection refused|Connection reset|Network is unreachable/i.test(l)) {
        estado.pistaRede = true;
      }
      log("stderr:", l.slice(0, 300));
    }
  });

  child.on("error", (e) => {
    ativos.delete(id);
    apagar(arquivoCookies);
    enviar({ type: "fim", id, ok: false, mensagem: `não consegui executar o yt-dlp: ${e.message}` });
  });

  child.on("close", (code, signal) => {
    ativos.delete(id);
    apagar(arquivoCookies);

    let caminho = null;
    try {
      const t = fs.readFileSync(arquivoSaida, "utf8").trim();
      // Com --split-chapters saem vários; o primeiro serve para revelar no Finder.
      if (t) caminho = t.split("\n").filter(Boolean).pop();
    } catch { /* pode não existir */ }
    apagar(arquivoSaida);

    if (signal === "SIGTERM") {
      enviar({ type: "fim", id, ok: false, cancelado: true, mensagem: "cancelado" });
    } else if (code === 0) {
      enviar({ type: "fim", id, ok: true, caminho, mensagem: "" });
    } else {
      enviar({
        type: "fim", id, ok: false, caminho,
        mensagem: estado.semRuntimeJs
          ? "falta um runtime JavaScript para o yt-dlp resolver a assinatura do YouTube — instale com: brew install deno"
          : estado.pistaRede
            ? "a conexão com o servidor caiu no meio do download — tente de novo"
            : traduzirErro(estado.ultimoErro) || `yt-dlp saiu com código ${code}`,
      });
    }

    if (ativos.size === 0 && stdinFechado()) sairLimpo(0);
  });
}

// O yt-dlp não tem saída estruturada; --newline dá uma linha por atualização.
function analisar(id, linha, estado) {
  if (!linha.trim()) return;

  const prog = linha.match(
    /^\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+\w+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/,
  );
  if (prog) {
    return enviar({
      type: "progresso", id,
      percent: parseFloat(prog[1]),
      total: prog[2],
      velocidade: prog[3] || "",
      eta: prog[4] || "",
      etapa: estado.etapa || undefined,
      item: estado.itensTotal ? { atual: estado.itemAtual, total: estado.itensTotal } : undefined,
    });
  }

  const item = linha.match(/^\[download\] Downloading item (\d+) of (\d+)/);
  if (item) {
    estado.itemAtual = +item[1];
    estado.itensTotal = +item[2];
    return enviar({
      type: "progresso", id,
      item: { atual: +item[1], total: +item[2] },
    });
  }

  const ja = linha.match(/^\[download\] (.+) has already been downloaded/);
  if (ja) {
    return enviar({ type: "progresso", id, percent: 100, etapa: "já estava baixado", caminho: ja[1] });
  }

  const etapas = [
    [/^\[Merger\]/, "juntando áudio e vídeo"],
    [/^\[ExtractAudio\]/, "extraindo áudio"],
    [/^\[EmbedSubtitle\]/, "embutindo legendas"],
    [/^\[Metadata\]/, "gravando metadados"],
    [/^\[ThumbnailsConvertor\]|^\[EmbedThumbnail\]/, "embutindo capa"],
    [/^\[SponsorBlock\]/, "consultando SponsorBlock"],
    [/^\[ModifyChapters\]/, "removendo trechos patrocinados"],
    [/^\[SplitChapters\]/, "dividindo em capítulos"],
    [/^\[VideoConvertor\]|^\[VideoRemuxer\]/, "convertendo"],
    [/^\[download\] Destination:/, "baixando"],
    [/^\[info\] Downloading subtitles/, "baixando legendas"],
    [/^\[hlsnative\]|^\[fragment\]|^\[download\] Downloading \d+ format\(s\)/, "montando segmentos"],
  ];
  for (const [re, texto] of etapas) {
    if (re.test(linha)) {
      if (estado.etapa === texto) return;
      estado.etapa = texto;
      return enviar({ type: "progresso", id, etapa: texto });
    }
  }
}

log("host iniciado",
  "| node", process.version,
  "| cwd", process.cwd(),
  "| argv", JSON.stringify(process.argv.slice(1)),
  "| yt-dlp", YTDLP,
  "| ffmpeg", FFMPEG,
  "| deno", DENO);
