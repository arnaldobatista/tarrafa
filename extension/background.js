// Tarrafa — service worker.
// Faz três coisas: fareja mídia na rede, mantém a fila de downloads e conversa
// com o host nativo. Toda decisão de "o que baixar" mora aqui; "como baixar"
// mora no host.

const NOME_HOST = "com.arnaldo.tarrafa";
const MAX_ITENS_POR_ABA = 40;
const MAX_HISTORICO = 120;

// ------------------------------------------------------------------ ajustes

const AJUSTES_PADRAO = {
  pasta: "",
  regrasPasta: [],
  tipo: "video",
  container: "mkv",
  audioFormato: "original",
  altura: 0,
  legendas: { ativo: false, idiomas: ["pt", "en"], automaticas: false, embutir: true },
  sponsorblock: { ativo: false, categorias: ["sponsor", "selfpromo"] },
  metadados: { thumbnail: true, info: true, capitulos: true },
  dividirCapitulos: false,
  liveDoComeco: false,
  usarCookies: true,
  perguntarPasta: false,
  notificar: true,
  menuContexto: true,
  maxSimultaneos: 2,
};

let ajustes = { ...AJUSTES_PADRAO };

async function carregarAjustes() {
  const { ajustes: guardado } = await chrome.storage.local.get("ajustes");
  ajustes = fundir(AJUSTES_PADRAO, guardado || {});
  return ajustes;
}

// Fusão rasa por chave, profunda em objetos: assim um ajuste novo que eu
// adicionar depois não fica indefinido para quem já tem config salva.
function fundir(padrao, salvo) {
  const saida = Array.isArray(padrao) ? [...padrao] : { ...padrao };
  for (const [k, v] of Object.entries(salvo || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && padrao[k] && typeof padrao[k] === "object" && !Array.isArray(padrao[k])) {
      saida[k] = fundir(padrao[k], v);
    } else if (v !== undefined) {
      saida[k] = v;
    }
  }
  return saida;
}

async function salvarAjustes(novos) {
  ajustes = fundir(ajustes, novos);
  await chrome.storage.local.set({ ajustes });
  await montarMenu();
  return ajustes;
}

// ------------------------------------------------------- detecção na rede

const porAba = new Map(); // abaId -> Map(url -> item)

const EXTENSOES = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|ogg|opus|wav|flac)(\?|$)/i;
const TIPOS = /^(video|audio)\//i;

// Muitos CDN servem a playlist sem extensão nenhuma: /playlist, /master,
// /api/playlist/master/… Reconhecer só ".m3u8" deixava esses de fora.
const CAMINHO_PLAYLIST = /\/(playlist|master|manifest|index)(\.[a-z0-9]+)?(\?|$)|\/api\/playlist\/master\//i;

function classificar(url, contentType) {
  const u = url.toLowerCase();
  const hls = { tipo: "hls", rotulo: "HLS", detalhe: "playlist adaptativa" };
  const dash = { tipo: "dash", rotulo: "DASH", detalhe: "manifesto adaptativo" };
  if (u.includes(".m3u8")) return hls;
  if (u.includes(".mpd")) return dash;
  if (contentType && /mpegurl/i.test(contentType)) return hls;
  if (contentType && /dash\+xml|vnd\.mpeg\.dash/i.test(contentType)) return dash;
  // Sem extensão e sem content-type útil: o caminho é a última pista.
  if (CAMINHO_PLAYLIST.test(url) && /hls|stream|video|media/i.test(url)) return hls;
  if (contentType && /^audio\//i.test(contentType)) return { tipo: "audio", rotulo: "Áudio", detalhe: "" };
  if (EXTENSOES.test(url) || (contentType && TIPOS.test(contentType))) {
    return { tipo: "arquivo", rotulo: "Arquivo", detalhe: "" };
  }
  return null;
}

function nomeDaUrl(url) {
  try {
    const p = new URL(url).pathname;
    const n = decodeURIComponent(p.split("/").filter(Boolean).pop() || "");
    return n || new URL(url).hostname;
  } catch { return url.slice(0, 60); }
}

function tamanhoLegivel(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// Guardamos os cabeçalhos que a PÁGINA usou. É o que faz um CDN que exige
// Referer/Cookie aceitar a nossa requisição depois.
const cabecalhosPorRequisicao = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || !d.requestHeaders) return;
    const guardar = {};
    for (const h of d.requestHeaders) {
      if (/^(referer|origin|user-agent|cookie|authorization)$/i.test(h.name) && h.value) {
        guardar[h.name] = h.value;
      }
    }
    if (Object.keys(guardar).length) {
      cabecalhosPorRequisicao.set(d.requestId, guardar);
      if (cabecalhosPorRequisicao.size > 400) {
        const primeira = cabecalhosPorRequisicao.keys().next().value;
        cabecalhosPorRequisicao.delete(primeira);
      }
    }
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object", "main_frame", "sub_frame"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    let contentType = null;
    let contentLength = null;
    for (const h of d.responseHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "content-type") contentType = h.value;
      if (n === "content-length") contentLength = h.value;
    }
    const c = classificar(d.url, contentType);
    if (!c) return;
    // Segmentos individuais não interessam: quem manda é o manifesto.
    if (/\.(ts|m4s|m2ts)(\?|$)/i.test(d.url)) return;
    if (c.tipo === "arquivo" && contentLength && Number(contentLength) < 300000) return;

    const lista = porAba.get(d.tabId) || new Map();
    if (!lista.has(d.url)) {
      lista.set(d.url, {
        url: d.url,
        nome: nomeDaUrl(d.url),
        ...c,
        detalhe: c.detalhe || tamanhoLegivel(contentLength) || new URL(d.url).hostname,
        host: (() => { try { return new URL(d.url).hostname; } catch { return ""; } })(),
        cabecalhos: cabecalhosPorRequisicao.get(d.requestId) || {},
        quando: Date.now(),
      });
      while (lista.size > MAX_ITENS_POR_ABA) lista.delete(lista.keys().next().value);
      porAba.set(d.tabId, lista);
      atualizarBadge(d.tabId);
      avisarPainel();
    }
  },
  // sub_frame é essencial: plataforma de curso embute o player num iframe, e
  // sem esse tipo a mídia de dentro dele passava batida.
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object", "sub_frame"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  porAba.delete(d.tabId);
  cacheVarredura.delete(d.tabId);
  atualizarBadge(d.tabId);
  avisarPainel();
});

chrome.tabs.onRemoved.addListener((id) => {
  porAba.delete(id);
  cacheVarredura.delete(id);
});

function atualizarBadge(abaId) {
  const n = porAba.get(abaId)?.size || 0;
  chrome.action.setBadgeText({ tabId: abaId, text: n ? String(n) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#1d9c8f" }).catch(() => {});
}

// ---------------------------------------------------------- miniaturas

const cacheMiniatura = new Map(); // url -> dataURL | null (null = já tentou e falhou)

async function pegarMiniatura(url, cabecalhos, segundo) {
  if (cacheMiniatura.has(url)) return cacheMiniatura.get(url);
  const id = crypto.randomUUID();
  const r = await perguntar({ type: "miniatura", id, url, cabecalhos, segundo }, "miniatura", 35000);
  const valor = r?.ok && r.jpeg ? `data:image/jpeg;base64,${r.jpeg}` : null;
  cacheMiniatura.set(url, valor);
  if (cacheMiniatura.size > 120) cacheMiniatura.delete(cacheMiniatura.keys().next().value);
  return valor;
}

// ------------------------------------------------ enriquecer e desduplicar

// Só quando o painel abre: durante a navegação não vale buscar manifesto de
// tudo que passa. O resultado fica guardado no próprio item.
async function enriquecerManifestos(itens) {
  const pendentes = itens
    .filter((it) => (it.tipo === "hls" || it.tipo === "dash") && !it.lido)
    .slice(0, 8);

  await Promise.all(pendentes.map(async (it) => {
    it.lido = true; // não tentar de novo em cada abertura do painel
    const id = crypto.randomUUID();
    const r = await perguntar({
      type: "buscar", id, url: it.url, cabecalhos: it.cabecalhos || {},
    }, "texto", 20000);
    if (!r?.ok || !r.texto) { it.manifestoFalhou = true; return; }
    const info = it.tipo === "hls" ? lerHLS(r.texto, it.url) : lerDASH(r.texto);
    if (!info) { it.naoEhManifesto = true; return; }
    Object.assign(it, {
      ehMestre: info.ehMestre, temDrm: info.temDrm, aoVivo: info.aoVivo,
      duracao: info.duracao, variantes: info.variantes, filhos: info.filhos,
    });
  }));
}

// Uma playlist mestre já contém as filhas; listar as duas é ruído. As filhas
// que o mestre referencia somem da lista, e o que parecia manifesto mas não era
// também.
function desduplicar(itens) {
  const doMestre = new Set();
  for (const it of itens) {
    if (it.ehMestre) for (const f of it.filhos || []) doMestre.add(f);
  }
  return itens.filter((it) => {
    if (it.naoEhManifesto) return false;          // parecia manifesto e não era
    if (doMestre.has(it.url)) return false;        // já está dentro de um mestre
    return true;
  });
}

// ------------------------------------------------ leitura de manifestos

// Classificar pela URL só diz "parece HLS". Ler o manifesto diz o que É:
// se é mestre, que resoluções tem, quanto dura, se é ao vivo, se tem DRM —
// e quais playlists filhas ele já contém (para não listá-las de novo).

const DRM_HLS = /widevine|playready|fairplay|com\.apple\.streamingkeydelivery/i;
const DRM_DASH = /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95|94ce86fb-07ff-4f43-adb8-93d2fa968ca2/i;

function atributosHLS(linha) {
  const saida = {};
  for (const m of linha.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    saida[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return saida;
}

function lerHLS(texto, base) {
  if (!/^\s*#EXTM3U/.test(texto)) return null;
  const linhas = texto.split(/\r?\n/);
  const variantes = [];
  const filhos = [];
  let duracao = 0;
  let aoVivo = true;
  let temDrm = false;
  let ehMestre = false;
  let segmentos = 0;

  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      ehMestre = true;
      const a = atributosHLS(l.slice(18));
      let uri = "";
      while (i + 1 < linhas.length && (!uri || uri.startsWith("#"))) uri = linhas[++i].trim();
      const [larg, alt] = (a.RESOLUTION || "").split("x").map(Number);
      let abs = null;
      try { abs = new URL(uri, base).href; } catch { /* uri estranha */ }
      if (abs) filhos.push(abs);
      variantes.push({
        url: abs, altura: alt || null, largura: larg || null,
        banda: Number(a.BANDWIDTH) || null, codecs: a.CODECS || null,
      });
    } else if (l.startsWith("#EXTINF:")) {
      duracao += parseFloat(l.slice(8)) || 0;
      segmentos++;
    } else if (l.startsWith("#EXT-X-ENDLIST")) {
      aoVivo = false;
    } else if (l.startsWith("#EXT-X-KEY") || l.startsWith("#EXT-X-SESSION-KEY")) {
      if (DRM_HLS.test(l)) temDrm = true;
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = atributosHLS(l.slice(13));
      if (a.URI) { try { filhos.push(new URL(a.URI, base).href); } catch { /* ignora */ } }
    }
  }
  if (!ehMestre && segmentos === 0) return null; // não é playlist de verdade
  return {
    formato: "hls", ehMestre, temDrm,
    aoVivo: ehMestre ? false : aoVivo,
    duracao: ehMestre ? null : Math.round(duracao) || null,
    variantes: variantes.sort((a, b) => (b.altura || 0) - (a.altura || 0)),
    filhos,
  };
}

function duracaoISO(v) {
  const m = /^P(?:.*?T)?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(v || "");
  if (!m) return null;
  return Math.round((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) || null;
}

function lerDASH(texto) {
  if (!/<MPD[\s>]/i.test(texto)) return null;
  const variantes = [];
  for (const m of texto.matchAll(/<Representation\b[^>]*>/gi)) {
    const tag = m[0];
    const num = (nome) => {
      const r = new RegExp(nome + '="(\\d+)"', "i").exec(tag);
      return r ? Number(r[1]) : null;
    };
    const alt = num("height");
    if (!alt) continue;
    variantes.push({ url: null, altura: alt, largura: num("width"), banda: num("bandwidth"), codecs: null });
  }
  const dur = /mediaPresentationDuration="([^"]+)"/i.exec(texto);
  return {
    formato: "dash",
    ehMestre: true,
    temDrm: DRM_DASH.test(texto) || /<ContentProtection/i.test(texto),
    aoVivo: /type="dynamic"/i.test(texto),
    duracao: dur ? duracaoISO(dur[1]) : null,
    variantes: variantes.sort((a, b) => (b.altura || 0) - (a.altura || 0)),
    filhos: [],
  };
}

// ------------------------------------------------------- regras por site

// O yt-dlp tem 1752 extratores e cobre quase tudo que é grande. Esta lista é
// só para onde ele é cego — sobretudo plataforma de curso, que serve HLS de
// um CDN próprio com URL sem nome nenhum.
const REGRAS_SITE = [
  { nome: "Panda Video", host: /(^|\.)pandavideo\.(com\.br|io)$/i, prioridade: 0 },
  { nome: "Hotmart", host: /(^|\.)hotmart\.com$/i, prioridade: 0 },
  { nome: "ConverteAI", host: /(^|\.)converteai\.net$/i, prioridade: 0 },
  { nome: "Vturb", host: /(^|\.)vturb\.com(\.br)?$/i, prioridade: 0 },
  { nome: "Vimeo", host: /(^|\.)vimeo\.com$/i, prioridade: 1 },
  { nome: "Canva", host: /(^|\.)canva\.com$/i, prioridade: 1 },
  { nome: "YouTube", host: /(^|\.)(youtube\.com|youtu\.be)$/i, prioridade: 1 },
];

function regraPara(url) {
  try {
    const host = new URL(url).hostname;
    return REGRAS_SITE.find((r) => r.host.test(host)) || null;
  } catch { return null; }
}

// URL de CDN de curso não tem nome útil ("playlist.m3u8"). O nome bom é o
// título da aula, que está na página.
function nomeUtil(url) {
  const n = nomeDaUrl(url);
  return !/^(playlist|master|index|manifest|video|stream)\b/i.test(n) && n.length > 4;
}

// "(48) Título - YouTube": o número é o contador de notificações da aba.
function limparTituloAba(t) {
  return (t || "").replace(/^\(\d+\)\s*/, "").trim();
}

function semExtensao(nome) {
  return nome.replace(/\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|ogg|opus|wav|flac|m3u8|mpd)$/i, "");
}

// Nome que o item leva para a fila e para o arquivo. URL de CDN costuma se
// chamar "master.m3u8" — aí o título da aba diz muito mais. Mas quando a URL
// tem nome de verdade ("aula-03-grafos.mp4"), ele distingue melhor: o título
// da aba seria o mesmo para todos os vídeos da página.
function tituloSugerido(x, tituloAba) {
  if (x.tipo === "embed") return x.nome || tituloAba || nomeDaUrl(x.url);
  if (nomeUtil(x.url)) return semExtensao(nomeDaUrl(x.url));
  return tituloAba || x.nome || nomeDaUrl(x.url);
}

// ------------------------------------------------- o que a página mostra

// O yt-dlp costuma não conhecer a página de um curso, mas conhece muito bem
// o player embutido nela. Varremos todos os frames: o href de cada frame
// filho É a URL do embed, e é ela que interessa.
function scriptDeVarredura() {
  // Roda no contexto da página, em todos os frames. Precisa ser autocontida:
  // o Chrome serializa esta função e nada de fora vem junto.
  const achados = [];
  const vistos = new Set();
  const titulo = document.title || location.hostname;

  const LIXO = /doubleclick|googlesyndication|googletagmanager|google-analytics|recaptcha|facebook\.com\/(plugins|tr)|hotjar|intercom|zendesk|disqus|onesignal/i;
  const SEGMENTO = /\.(ts|m4s|m2ts|key|vtt|srt|jpg|png|webp)(\?|$)/i;

  function add(tipo, url, nome, detalhe) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    if (url.length > 2000 || vistos.has(url)) return;
    vistos.add(url);
    achados.push({ tipo, url, nome: nome || titulo, detalhe: detalhe || "" });
  }

  // ---------------------------------------------------------------- 1. frames
  if (window.top !== window && /^https?:/.test(location.href)) {
    add("embed", location.href, titulo, "player embutido nesta página");
  }
  for (const f of document.querySelectorAll("iframe[src]")) {
    const url = f.src;
    if (!/^https?:/.test(url) || LIXO.test(url)) continue;
    const r = f.getBoundingClientRect();
    if (r.width && r.width < 180) continue; // pixel de rastreio, não player
    add("embed", url, f.title || titulo, "player embutido nesta página");
  }

  // ------------------------------------------------------ 2. elementos <video>
  // Qual está tocando: não pausado, já andou, e é o maior visível na tela.
  // Numa timeline como a do Instagram, vários existem ao mesmo tempo.
  let tocando = null;
  let melhorArea = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const visivel = r.bottom > 0 && r.top < innerHeight && r.width > 0;
    const area = visivel ? r.width * r.height : 0;
    if (!v.paused && v.currentTime > 0 && area > melhorArea) {
      melhorArea = area;
      tocando = {
        src: v.currentSrc || v.src || "",
        poster: v.poster || "",
        duracao: isFinite(v.duration) ? Math.round(v.duration) : null,
        largura: v.videoWidth || null,
        altura: v.videoHeight || null,
      };
    }
  }

  const fontes = new Set();
  for (const v of document.querySelectorAll("video")) {
    for (const s of [v.currentSrc, v.src]) if (s) fontes.add(s);
    for (const el of v.querySelectorAll("source[src]")) fontes.add(el.src);
  }
  // <video> dentro de shadow DOM some do querySelectorAll comum.
  for (const host of document.querySelectorAll("*")) {
    if (!host.shadowRoot) continue;
    for (const v of host.shadowRoot.querySelectorAll("video, source")) {
      for (const s of [v.currentSrc, v.src]) if (s) fontes.add(s);
    }
  }
  for (const url of fontes) {
    // blob: é MediaSource montado em memória; não dá para baixar pela URL.
    add("video", url, titulo, "elemento <video> da página");
  }

  // -------------------------------------------------- 3. players em variáveis
  try {
    const w = window;
    // hls.js guarda a playlist que carregou
    for (const chave of ["hls", "hlsPlayer", "player", "videoPlayer"]) {
      const p = w[chave];
      if (p && typeof p === "object" && typeof p.url === "string") {
        add("player", p.url, titulo, `URL lida do player (${chave})`);
      }
    }
    if (typeof w.jwplayer === "function") {
      const j = w.jwplayer();
      const lista = j && typeof j.getPlaylist === "function" ? j.getPlaylist() : null;
      for (const item of lista || []) {
        for (const f of item.sources || []) add("player", f.file, item.title || titulo, "JW Player");
        add("player", item.file, item.title || titulo, "JW Player");
      }
    }
    if (w.videojs && typeof w.videojs.getAllPlayers === "function") {
      for (const p of w.videojs.getAllPlayers()) {
        for (const f of (typeof p.currentSources === "function" ? p.currentSources() : [])) {
          add("player", f.src, titulo, "video.js");
        }
      }
    }
  } catch { /* variável de player que não gostou de ser lida */ }

  // ---------------------------------------- 4. varredura do texto da página
  // A URL da mídia quase sempre está escrita num <script> ou num JSON
  // embutido, mesmo antes de o vídeo tocar.
  const MIDIA = /https?:\/\/[^\s"'<>\\)]+\.(?:m3u8|mpd|mp4|webm|m4a|mp3|flv)(?:\?[^\s"'<>\\)]*)?/gi;
  let orcamento = 3_000_000; // não varrer páginas gigantes sem limite
  const pedacos = [];
  for (const sc of document.querySelectorAll("script")) {
    const t = sc.textContent;
    if (!t || t.length > 800_000) continue;
    pedacos.push(t);
    orcamento -= t.length;
    if (orcamento < 0) break;
  }
  if (orcamento > 0) {
    const html = document.documentElement.innerHTML;
    if (html.length < orcamento) pedacos.push(html);
  }
  for (const bruto of pedacos) {
    // JSON escapa as barras; sem desfazer isso, a regex não casa nada.
    const texto = bruto.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
    for (const achado of texto.match(MIDIA) || []) {
      const url = achado.replace(/[),;'"]+$/, "");
      if (SEGMENTO.test(url)) continue; // é fragmento, não a playlist
      const ext = (url.split("?")[0].match(/\.([a-z0-9]+)$/i) || [])[1] || "";
      add("script", url, titulo, `${ext.toUpperCase()} encontrado no código da página`);
    }
  }

  return { achados: achados.slice(0, 40), tocando };
}

// O painel pede o estado a cada atualização de progresso; sem cache isso
// viraria um executeScript por tick, em todos os frames.
const cacheVarredura = new Map(); // abaId -> { url, quando, achados }
const VALIDADE_VARREDURA = 8000;

async function varrerPagina(abaId, urlAtual) {
  if (!abaId) return [];
  const guardado = cacheVarredura.get(abaId);
  if (guardado && guardado.url === urlAtual && Date.now() - guardado.quando < VALIDADE_VARREDURA) {
    return guardado.achados;
  }
  const achados = await varrerDeVerdade(abaId);
  cacheVarredura.set(abaId, { url: urlAtual, quando: Date.now(), achados });
  return achados;
}

async function varrerDeVerdade(abaId) {
  try {
    const resultados = await chrome.scripting.executeScript({
      target: { tabId: abaId, allFrames: true },
      func: scriptDeVarredura,
    });
    const vistos = new Set();
    const saida = [];
    let tocando = null;
    for (const r of resultados) {
      const pacote = r.result || {};
      if (pacote.tocando && !tocando) tocando = pacote.tocando;
      for (const a of pacote.achados || []) {
        if (vistos.has(a.url)) continue;
        vistos.add(a.url);
        let host = "";
        try { host = new URL(a.url).hostname; } catch { /* ignora */ }
        const regra = regraPara(a.url);
        saida.push({
          ...a,
          host,
          assinatura: assinaturaDaUrl(a.url),
          regra: regra?.nome || null,
          prioridade: regra?.prioridade ?? (a.tipo === "embed" ? 2 : 3),
          rotulo: regra?.nome || (a.tipo === "embed" ? "Embed" : a.tipo === "script" ? "No código" : "Vídeo"),
        });
      }
    }
    // Quando o src do <video> é http, dá para casar exatamente.
    if (tocando?.src && /^https?:/.test(tocando.src)) {
      const alvo = saida.find((a) => a.url === tocando.src);
      if (alvo) { alvo.tocando = "exato"; }
    }

    // Site conhecido primeiro; manifesto antes de arquivo solto.
    const pesoTipo = { embed: 0, player: 1, script: 2, video: 3 };
    saida.sort((a, b) =>
      (b.tocando ? 1 : 0) - (a.tocando ? 1 : 0)
      || (a.prioridade - b.prioridade)
      || ((pesoTipo[a.tipo] ?? 9) - (pesoTipo[b.tipo] ?? 9)));
    return { achados: saida, tocando };
  } catch (e) {
    // chrome://, PDF, página sem permissão: não é erro que valha alarme.
    console.debug("Tarrafa: não deu para varrer a página", e?.message);
    return { achados: [], tocando: null };
  }
}

// Quatro "MP4 encontrado no código" idênticos não ajudam ninguém a escolher.
// Isto dá a cada um uma marca curta e estável, tirada da própria URL.
function assinaturaDaUrl(url) {
  try {
    const u = new URL(url);
    const partes = u.pathname.split("/").filter(Boolean);
    const ultimo = partes.pop() || u.hostname;
    const penultimo = partes.pop() || "";
    const caminho = (penultimo ? `${penultimo}/` : "") + ultimo;
    return caminho.length > 38 ? "…" + caminho.slice(-37) : caminho;
  } catch { return ""; }
}

// ------------------------------------------------------------- host nativo

let porta = null;
let respostasPendentes = new Map(); // id -> resolve
let keepalive = null;

function conectar() {
  if (porta) return porta;
  porta = chrome.runtime.connectNative(NOME_HOST);

  porta.onMessage.addListener((msg) => {
    if (msg.type === "progresso") return aoProgredir(msg);
    if (msg.type === "fim") return aoTerminar(msg);
    if (msg.type === "crash") return aoCrashar(msg);
    // info / pasta / sonda: respostas de pergunta única
    const chave = msg.id ? `${msg.type}:${msg.id}` : msg.type;
    const resolver = respostasPendentes.get(chave) || respostasPendentes.get(msg.type);
    if (resolver) {
      respostasPendentes.delete(chave);
      respostasPendentes.delete(msg.type);
      resolver(msg);
    }
  });

  porta.onDisconnect.addListener(() => {
    const erro = chrome.runtime.lastError?.message || "conexão com o host encerrada";
    porta = null;
    pararKeepalive();
    for (const [, resolver] of respostasPendentes) resolver({ erro });
    respostasPendentes.clear();
    // Downloads que estavam correndo viram "interrompido": o host morreu ou o
    // Chrome derrubou o canal. Ficam retomáveis, não somem.
    let mexeu = false;
    for (const d of fila.values()) {
      if (d.estado === "baixando" || d.estado === "fila") {
        d.estado = "interrompido";
        d.mensagem = erro;
        mexeu = true;
      }
    }
    if (mexeu) { persistirFila(); avisarPainel(); }
  });

  return porta;
}

function mandar(msg) {
  try {
    conectar().postMessage(msg);
    return true;
  } catch (e) {
    console.warn("Tarrafa: falha ao falar com o host", e);
    return false;
  }
}

// Pedidos sem id (como "info") usam a mesma chave. Antes, um segundo pedido
// igual sobrescrevia a espera do primeiro, que "estourava o tempo" 20s depois e
// mostrava erro com o host funcionando. Agora os dois esperam a mesma resposta.
const emVoo = new Map(); // chave -> promessa em andamento

function perguntar(msg, tipoResposta, ms = 120000) {
  const chave = msg.id ? `${tipoResposta}:${msg.id}` : tipoResposta;
  if (emVoo.has(chave)) return emVoo.get(chave);
  const promessa = new Promise((resolve) => {
    let timer;
    const meu = (r) => { clearTimeout(timer); resolve(r); };
    timer = setTimeout(() => {
      // Só remove a própria espera, nunca a de um pedido mais novo.
      if (respostasPendentes.get(chave) === meu) respostasPendentes.delete(chave);
      resolve({ erro: "o host não respondeu a tempo" });
    }, ms);
    respostasPendentes.set(chave, meu);
    if (!mandar(msg)) {
      clearTimeout(timer);
      respostasPendentes.delete(chave);
      resolve({ erro: "não consegui abrir a conexão com o host" });
    }
  });
  emVoo.set(chave, promessa);
  promessa.finally(() => emVoo.delete(chave));
  return promessa;
}

// Enquanto houver download, o canal precisa continuar vivo: um service worker
// ocioso é encerrado em ~30s e levaria a porta junto.
function cuidarKeepalive() {
  const ativo = [...fila.values()].some((d) => d.estado === "baixando" || d.estado === "fila");
  if (ativo && !keepalive) {
    keepalive = setInterval(() => mandar({ type: "ping" }), 20000);
  } else if (!ativo && keepalive) {
    pararKeepalive();
  }
}

function pararKeepalive() {
  if (keepalive) { clearInterval(keepalive); keepalive = null; }
}

// ------------------------------------------------------------------- fila

const fila = new Map(); // id -> item
let persistirAgendado = null;

async function carregarFila() {
  const { fila: salva } = await chrome.storage.local.get("fila");
  for (const item of salva || []) {
    // Nada podia estar correndo: o service worker acabou de subir.
    if (item.estado === "baixando" || item.estado === "fila") {
      item.estado = "interrompido";
      item.mensagem = item.mensagem || "interrompido quando o navegador fechou";
    }
    fila.set(item.id, item);
  }
}

function persistirFila() {
  if (persistirAgendado) return;
  persistirAgendado = setTimeout(() => {
    persistirAgendado = null;
    const lista = [...fila.values()]
      .sort((a, b) => b.criadoEm - a.criadoEm)
      .slice(0, MAX_HISTORICO);
    chrome.storage.local.set({ fila: lista }).catch(() => {});
  }, 400);
}

// O progresso muda só a fila. Avisar "mudou tudo" fazia o painel recriar a
// lista de mídia duas vezes por segundo — o que piscava e, pior, destruía o
// botão embaixo do cursor antes do clique completar.
function avisarPainel(escopo = "tudo") {
  chrome.runtime.sendMessage({ cmd: "mudou", escopo }).catch(() => {});
}

function aoProgredir(msg) {
  const d = fila.get(msg.id);
  if (!d) return;
  d.estado = "baixando";
  if (msg.percent !== undefined) d.percent = msg.percent;
  if (msg.velocidade !== undefined) d.velocidade = msg.velocidade;
  if (msg.eta !== undefined) d.eta = msg.eta;
  if (msg.etapa) d.etapa = msg.etapa;
  if (msg.item) d.item = msg.item;
  avisarPainel("fila");
}

function aoTerminar(msg) {
  const d = fila.get(msg.id);
  if (!d) return;
  d.terminadoEm = Date.now();
  d.caminho = msg.caminho || d.caminho;
  if (msg.ok) {
    d.estado = "pronto";
    d.percent = 100;
    d.mensagem = msg.mensagem || "";
    notificar(`Baixado: ${d.titulo}`, d.caminho || "");
  } else if (msg.cancelado) {
    d.estado = "cancelado";
    d.mensagem = "cancelado";
  } else if (tentarPelaRede(d, msg.mensagem)) {
    // Já reenfileirado com o item detectado na rede; o card conta a história.
    d.estado = "fila";
    d.mensagem = "";
  } else {
    d.estado = "erro";
    d.mensagem = msg.mensagem || "falhou";
    notificar(`Falhou: ${d.titulo}`, d.mensagem);
  }
  persistirFila();
  avisarPainel();
  puxarProximo();
  cuidarKeepalive();
}

// Quando o yt-dlp não conhece o site, a mídia que passou pela rede quase
// sempre resolve. Em vez de mandar o usuário fazer isso na mão, fazemos por
// ele — uma vez só, para não entrar em laço.
function tentarPelaRede(d, mensagem) {
  if (d.origem !== "pagina" || d.jaTentouRede) return false;
  if (!/não conhece esse site|não achei vídeo|Unsupported URL/i.test(mensagem || "")) return false;

  const candidato = melhorDaAba(d.abaId);
  if (!candidato) return false;

  d.jaTentouRede = true;
  d.viaRede = true;
  d.url = candidato.url;
  d.origem = "rede";
  d.cabecalhos = candidato.cabecalhos || {};
  d.percent = 0;
  d.etapa = "tentando pelo item detectado na rede";
  puxarProximo();
  return true;
}

// Manifesto ganha de arquivo solto; entre arquivos, o maior.
function melhorDaAba(abaId) {
  const itens = [...(porAba.get(abaId)?.values() || [])];
  if (!itens.length) return null;
  const peso = { hls: 0, dash: 1, arquivo: 2, audio: 3 };
  return itens.sort((a, b) => (peso[a.tipo] ?? 9) - (peso[b.tipo] ?? 9))[0];
}

function aoCrashar(msg) {
  for (const d of fila.values()) {
    if (d.estado === "baixando" || d.estado === "fila") {
      d.estado = "erro";
      d.mensagem = msg.mensagem;
    }
  }
  persistirFila();
  avisarPainel();
}

function notificar(titulo, corpo) {
  if (!ajustes.notificar) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: titulo.slice(0, 80),
    message: (corpo || "").slice(0, 200),
  }).catch(() => {});
}

function quantosCorrendo() {
  return [...fila.values()].filter((d) => d.estado === "baixando").length;
}

function puxarProximo() {
  const limite = Math.max(1, Number(ajustes.maxSimultaneos) || 1);
  while (quantosCorrendo() < limite) {
    const proximo = [...fila.values()]
      .filter((d) => d.estado === "fila")
      .sort((a, b) => a.criadoEm - b.criadoEm)[0];
    if (!proximo) return;
    dispararDownload(proximo);
  }
}

async function dispararDownload(d) {
  d.estado = "baixando";
  d.etapa = "preparando";
  avisarPainel();
  cuidarKeepalive();

  const cookies = ajustes.usarCookies ? await colherCookies(d.pagina || d.url) : [];

  const ok = mandar({
    type: "baixar",
    id: d.id,
    url: d.url,
    // O nome que o usuário digitou ganha de tudo. Sem ele, o arquivo de um
    // CDN de curso sairia chamado "playlist".
    nomeBase: d.nomeBase
      || (d.origem === "rede" && !nomeUtil(d.url) ? d.titulo : undefined),
    pagina: d.pagina,
    origem: d.origem,
    pasta: d.pasta,
    cabecalhos: d.cabecalhos || {},
    cookies,
    opcoes: d.opcoes,
  });

  if (!ok) {
    d.estado = "erro";
    d.mensagem = "não consegui falar com o host — rode ./install.sh";
    persistirFila();
    avisarPainel();
  }
}

// ------------------------------------------------------------------ cookies

function dominioBase(hostname) {
  const p = hostname.split(".");
  if (p.length <= 2) return hostname;
  // Casos tipo "co.uk" ficam de fora; para o que a extensão faz, basta.
  return p.slice(-2).join(".");
}

async function colherCookies(url) {
  try {
    const base = dominioBase(new URL(url).hostname);
    const dominios = new Set([base]);
    // O YouTube autentica com cookie do google.com; sem ele, vídeo restrito
    // continua fora de alcance mesmo estando logado.
    if (/youtube\.com|youtu\.be/.test(base)) dominios.add("google.com");
    const tudo = [];
    for (const d of dominios) {
      const cs = await chrome.cookies.getAll({ domain: d });
      tudo.push(...cs);
    }
    return tudo.map((c) => ({
      domain: c.domain, hostOnly: c.hostOnly, path: c.path,
      secure: c.secure, expirationDate: c.expirationDate,
      name: c.name, value: c.value,
    }));
  } catch (e) {
    console.warn("Tarrafa: não consegui ler os cookies", e);
    return [];
  }
}

// ------------------------------------------------------- pasta de destino

function pastaPara(url) {
  try {
    const host = new URL(url).hostname;
    for (const r of ajustes.regrasPasta || []) {
      if (r.padrao && r.pasta && host.includes(r.padrao.trim())) return r.pasta;
    }
  } catch { /* url estranha: cai no padrão */ }
  return ajustes.pasta || "";
}

// ---------------------------------------------------------- enfileirar

function opcoesDeAjustes(extra = {}) {
  return {
    tipo: ajustes.tipo,
    container: ajustes.container,
    audioFormato: ajustes.audioFormato,
    altura: ajustes.altura || null,
    legendas: { ...ajustes.legendas },
    sponsorblock: { ...ajustes.sponsorblock },
    metadados: { ...ajustes.metadados },
    dividirCapitulos: ajustes.dividirCapitulos,
    liveDoComeco: ajustes.liveDoComeco,
    trecho: null,
    playlist: null,
    ...extra,
  };
}

function enfileirar({ url, pagina, origem, titulo, cabecalhos, opcoes, pasta, abaId, nomeBase }) {
  const id = crypto.randomUUID();
  const item = {
    id,
    abaId: abaId ?? null,
    nomeBase: nomeBase || null,
    url,
    pagina: pagina || url,
    origem: origem || "pagina",
    titulo: titulo || nomeDaUrl(url),
    pasta: pasta || pastaPara(pagina || url),
    cabecalhos: cabecalhos || {},
    opcoes: opcoes || opcoesDeAjustes(),
    estado: "fila",
    percent: 0,
    velocidade: "",
    eta: "",
    etapa: "",
    mensagem: "",
    caminho: null,
    criadoEm: Date.now(),
  };
  fila.set(id, item);
  persistirFila();
  avisarPainel();
  puxarProximo();
  cuidarKeepalive();
  return item;
}

// -------------------------------------------------------- menu de contexto

// montarMenu() é chamado da inicialização, do onInstalled e de todo ajuste
// salvo. Sem serializar, duas chamadas passam pelo removeAll() e as duas
// tentam criar os mesmos ids — "Cannot create item with duplicate id".
let filaMenu = Promise.resolve();
let menuLigado = null; // null = ainda não sabemos o que existe no navegador

function montarMenu() {
  filaMenu = filaMenu
    .then(async () => {
      const querido = !!ajustes.menuContexto;
      // Depois da primeira montagem, só mexe se a preferência mudou.
      if (menuLigado === querido) return;
      await chrome.contextMenus.removeAll();
      if (querido) {
        criarItem("baixar-midia", "Baixar com a Tarrafa");
        criarItem("baixar-audio", "Baixar só o áudio");
      }
      menuLigado = querido;
    })
    .catch((e) => console.warn("Tarrafa: falha ao montar o menu", e));
  return filaMenu;
}

function criarItem(id, title) {
  // O callback existe só para consumir o lastError; sem ele o Chrome loga
  // "Unchecked runtime.lastError" no console.
  chrome.contextMenus.create(
    { id, title, contexts: ["video", "audio", "link", "page"] },
    () => void chrome.runtime.lastError,
  );
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await carregarAjustes();
  const alvo = info.srcUrl || info.linkUrl || info.pageUrl || tab?.url;
  if (!alvo) return;
  const soAudio = info.menuItemId === "baixar-audio";
  enfileirar({
    url: alvo,
    pagina: info.pageUrl || tab?.url || alvo,
    origem: info.srcUrl || info.linkUrl ? "rede" : "pagina",
    titulo: tab?.title || nomeDaUrl(alvo),
    opcoes: opcoesDeAjustes(soAudio ? { tipo: "audio" } : {}),
  });
});

// --------------------------------------------------------- ponte com a UI

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  (async () => {
    await carregarAjustes();

    switch (msg.cmd) {
      case "estado": {
        const aba = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const brutos = [...(porAba.get(aba?.id)?.values() || [])].reverse();
        await enriquecerManifestos(brutos);
        const itens = desduplicar(brutos);
        const varredura = aba && /^https?:/.test(aba.url || "")
          ? await varrerPagina(aba.id, aba.url)
          : { achados: [], tocando: null };
        const naPagina = varredura.achados;

        // O Instagram (e todo player com MSE) toca de uma URL blob:, que não
        // dá para casar com nada. Nesse caso a pista boa é o tempo: a mídia
        // que acabou de passar na rede é a que está tocando.
        const casouExato = naPagina.some((a) => a.tocando === "exato");
        if (varredura.tocando && !casouExato && itens.length) {
          const recente = itens.reduce((a, b) => (b.quando > a.quando ? b : a));
          if (Date.now() - recente.quando < 5 * 60 * 1000) recente.tocando = "provavel";
        }
        for (const it of itens) {
          it.assinatura = it.assinatura || assinaturaDaUrl(it.url);
        }
        const tituloAba = limparTituloAba(aba?.title);
        for (const x of [...itens, ...naPagina]) x.tituloSugerido = tituloSugerido(x, tituloAba);

        return responder({
          aba: aba ? { id: aba.id, url: aba.url, titulo: tituloAba || aba.title } : null,
          itens,
          naPagina,
          tocando: varredura.tocando,
          fila: [...fila.values()].sort((a, b) => b.criadoEm - a.criadoEm),
          ajustes,
        });
      }

      case "fila":
        // Barato de propósito: chamado a cada tique de progresso.
        return responder({ fila: [...fila.values()].sort((a, b) => b.criadoEm - a.criadoEm) });

      case "ajustes":
        return responder({ ajustes: await salvarAjustes(msg.ajustes) });

      case "baixar":
        return responder({ item: enfileirar(msg) });

      case "sondar": {
        const id = crypto.randomUUID();
        const cookies = ajustes.usarCookies ? await colherCookies(msg.pagina || msg.url) : [];
        const r = await perguntar({
          type: "sondar", id, url: msg.url, cookies,
          cabecalhos: msg.cabecalhos || {}, playlist: !!msg.playlist,
        }, "sonda");
        return responder(r);
      }

      case "cancelar": {
        const d = fila.get(msg.id);
        if (d && d.estado === "fila") {
          d.estado = "cancelado";
          d.mensagem = "cancelado";
          persistirFila();
          avisarPainel();
          puxarProximo();
        } else {
          mandar({ type: "cancelar", id: msg.id });
        }
        return responder({ ok: true });
      }

      case "retomar": {
        const d = fila.get(msg.id);
        if (d) {
          d.estado = "fila";
          d.mensagem = "";
          d.percent = 0;
          d.criadoEm = Date.now();
          persistirFila();
          avisarPainel();
          puxarProximo();
          cuidarKeepalive();
        }
        return responder({ ok: true });
      }

      case "remover":
        fila.delete(msg.id);
        persistirFila();
        avisarPainel();
        return responder({ ok: true });

      case "limparConcluidos":
        for (const [id, d] of fila) {
          if (["pronto", "erro", "cancelado"].includes(d.estado)) fila.delete(id);
        }
        persistirFila();
        avisarPainel();
        return responder({ ok: true });

      case "abrir":
        mandar({ type: "abrir", caminho: msg.caminho });
        return responder({ ok: true });

      case "escolherPasta": {
        const id = crypto.randomUUID();
        const r = await perguntar({ type: "escolherPasta", id }, "pasta", 180000);
        return responder(r);
      }

      case "miniatura": {
        const img = await pegarMiniatura(msg.url, msg.cabecalhos || {}, msg.segundo);
        return responder({ img });
      }

      case "info":
        return responder(await perguntar({ type: "info" }, "info", 20000));

      case "codigo":
        return responder({ codigo: (await chrome.storage.local.get("codigoDoSW")).codigoDoSW || null });

      default:
        return responder({ erro: "comando desconhecido" });
    }
  })();
  return true; // resposta assíncrona
});

// ------------------------------------------------------------- inicialização

// O Chrome guarda o service worker quando ele é instalado e não relê o
// background.js quando o arquivo muda. As telas, ao contrário, leem do disco a
// cada abertura. Resultado: interface nova conversando com código velho até
// alguém recarregar a extensão (foi assim que um service worker de antes da
// troca de nome ficou pedindo um host que não existia mais). Na instalação,
// guardamos a impressão digital do arquivo que virou este service worker; a
// interface compara com o que está no disco e oferece a recarga.
async function impressaoDoCodigo() {
  const texto = await (await fetch(chrome.runtime.getURL("background.js"), { cache: "no-store" })).text();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

self.addEventListener("install", (e) => {
  // Nunca rejeita: instalação que falha deixa a extensão sem service worker.
  e.waitUntil(impressaoDoCodigo()
    .then((codigo) => chrome.storage.local.set({ codigoDoSW: codigo }))
    .catch(() => {}));
});

chrome.runtime.onInstalled.addListener(async () => {
  await carregarAjustes();
  await montarMenu();
});

chrome.tabs.onActivated.addListener(({ tabId }) => atualizarBadge(tabId));

(async () => {
  await carregarAjustes();
  await carregarFila();
  await montarMenu();
})();
