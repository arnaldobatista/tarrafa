// Tarrafa — interface. Quatro telas, um estado, redesenho sob demanda.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const estado = {
  aba: null,
  itens: [],
  naPagina: [],
  tocando: null,
  fila: [],
  ajustes: null,
  tela: "descobrir",
  detalhe: null, // { alvo, sonda, escolha }
};

const emAba = new URLSearchParams(location.search).get("aba") === "1";
if (emAba) document.body.classList.add("emAba");

const falar = (msg) => chrome.runtime.sendMessage(msg);

// ------------------------------------------------------------- utilidades

function segundosParaTempo(s) {
  if (!s || isNaN(s)) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(seg).padStart(2, "0")}`
    : `${m}:${String(seg).padStart(2, "0")}`;
}

function bytesLegivel(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    e.append(f.nodeType ? f : document.createTextNode(String(f)));
  }
  return e;
}

function encurtarCaminho(p) {
  if (!p) return "~/Downloads";
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function alertar(texto, ruim = false) {
  const a = $("#alerta");
  if (!texto) { a.hidden = true; return; }
  a.textContent = texto;
  a.classList.toggle("ruim", ruim);
  a.hidden = false;
}

// ------------------------------------------------------------- navegação

function mostrar(tela) {
  estado.tela = tela;
  $$(".tela").forEach((s) => { s.hidden = s.dataset.tela !== tela; });
  $$(".aba").forEach((b) => {
    // "detalhe" é filha de "descobrir": a aba de cima continua acesa.
    const alvo = tela === "detalhe" ? "descobrir" : tela;
    b.classList.toggle("ativa", b.dataset.tela === alvo);
  });
  document.scrollingElement.scrollTop = 0;
  if (tela === "ajustes") carregarDiagnostico();
}

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest(".aba");
  if (b) mostrar(b.dataset.tela);
});

$("#btAba").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html?aba=1") });
  window.close();
});

$("#btVoltar").addEventListener("click", () => mostrar("descobrir"));

// -------------------------------------------------------------- estado

async function puxarEstado() {
  const r = await falar({ cmd: "estado" });
  if (!r) return;
  estado.aba = r.aba;
  estado.itens = r.itens || [];
  estado.naPagina = r.naPagina || [];
  estado.tocando = r.tocando || null;
  estado.fila = r.fila || [];
  estado.ajustes = r.ajustes;
  desenhar();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.cmd !== "mudou") return;
  // Progresso mexe só na fila. Redesenhar a tela de descoberta a cada tique
  // destruía o botão embaixo do cursor antes do clique completar.
  if (msg.escopo === "fila") atualizarFila();
  else puxarEstado();
});

async function atualizarFila() {
  const r = await falar({ cmd: "fila" });
  if (!r?.fila) return;
  estado.fila = r.fila;
  desenharFila();
  atualizarPino();
}

function atualizarPino() {
  const ativos = estado.fila.filter((d) => d.estado === "baixando" || d.estado === "fila").length;
  const pino = $("#pinoFila");
  pino.hidden = ativos === 0;
  pino.textContent = ativos;
}

function desenhar() {
  desenharDescobrir();
  desenharFila();
  if (!$("#ajPasta").dataset.pronto) montarAjustes();
  atualizarPino();
}

// ---------------------------------------------------------- tela: descobrir

let assinaturaLista = null;

function desenharDescobrir() {
  $("#destinoAtual").textContent = estado.ajustes?.perguntarPasta
    ? "perguntar a cada download"
    : encurtarCaminho(estado.ajustes?.pasta);

  // Cinto de segurança: mesmo que alguém chame isto sem necessidade, não
  // recriamos os cartões se nada que aparece neles mudou.
  const assinatura = JSON.stringify([
    estado.ajustes?.pasta, estado.ajustes?.perguntarPasta,
    estado.aba?.url, estado.aba?.titulo,
    estado.itens.map((i) => [i.url, i.tocando, i.duracao, i.temDrm, i.variantes?.length]),
    estado.naPagina.map((a) => [a.url, a.tocando]),
    estado.tocando?.src,
    estado.fila.filter((d) => d.estado === "fila" || d.estado === "baixando").map((d) => d.url),
  ]);
  if (assinatura === assinaturaLista) return;
  assinaturaLista = assinatura;

  const pag = $("#daPagina");
  pag.replaceChildren();
  if (estado.aba?.url && /^https?:/.test(estado.aba.url)) {
    pag.append(linhaItem({
      nome: estado.aba.titulo || estado.aba.url,
      sub: new URL(estado.aba.url).hostname + " · o yt-dlp resolve o site sozinho",
      rotulo: "Página",
      classe: "pagina",
      destaque: true,
      alvo: {
        url: estado.aba.url, pagina: estado.aba.url, origem: "pagina",
        titulo: estado.aba.titulo, abaId: estado.aba.id,
      },
    }));
  } else {
    pag.append(el("div", { class: "vazio" }, "Abra uma página com vídeo para começar."));
  }

  if (estado.tocando && !estado.naPagina.some((a) => a.tocando === "exato")) {
    const t = estado.tocando;
    const partes = [];
    if (t.largura) partes.push(`${t.largura}×${t.altura}`);
    if (t.duracao) partes.push(segundosParaTempo(t.duracao));
    pag.append(el("div", { class: "nota" },
      `Tem vídeo tocando na tela${partes.length ? ` (${partes.join(", ")})` : ""}. `
      + "Ele usa um fluxo montado em memória, então marquei o item mais provável pelo horário."));
  }

  // Player embutido em iframe é o caso típico de plataforma de curso: o
  // yt-dlp não conhece a página, mas conhece o embed.
  for (const a of estado.naPagina) {
    pag.append(linhaItem({
      nome: a.nome || a.url,
      sub: `${a.assinatura || a.detalhe} · ${a.host}`,
      rotulo: a.rotulo,
      tocando: a.tocando,
      miniavel: a.tipo !== "embed",
      classe: { embed: "pagina", player: "hls", script: "hls", video: "arquivo" }[a.tipo] || "arquivo",
      alvo: {
        url: a.url, pagina: estado.aba?.url,
        origem: a.tipo === "embed" ? "pagina" : "rede",
        titulo: a.tituloSugerido || a.nome, abaId: estado.aba?.id,
      },
    }));
  }

  const rede = $("#daRede");
  rede.replaceChildren();
  $("#qtdRede").textContent = estado.itens.length || "";
  if (!estado.itens.length) {
    rede.append(el("div", { class: "vazio" },
      "Nada detectado ainda. Dê play no vídeo — a mídia aparece assim que começa a passar pela rede."));
  } else {
    for (const it of estado.itens) {
      const ficha = [];
      if (it.variantes?.length) {
        const alturas = it.variantes.filter((v) => v.altura).map((v) => v.altura);
        if (alturas.length) {
          ficha.push(alturas.length > 1
            ? `${Math.min(...alturas)}p–${Math.max(...alturas)}p`
            : `${alturas[0]}p`);
        }
      }
      if (it.duracao) ficha.push(segundosParaTempo(it.duracao));
      if (it.aoVivo) ficha.push("ao vivo");
      if (it.temDrm) ficha.push("DRM");
      if (!ficha.length) ficha.push(it.detalhe);

      rede.append(linhaItem({
        nome: it.nome,
        sub: `${ficha.join(" · ")} · ${it.assinatura || it.host}`,
        rotulo: it.temDrm ? "DRM" : it.rotulo,
        classe: it.temDrm ? "drm" : it.tipo,
        tocando: it.tocando,
        miniavel: !it.temDrm,
        alvo: {
          url: it.url, pagina: estado.aba?.url, origem: "rede",
          titulo: it.tituloSugerido || it.nome, cabecalhos: it.cabecalhos, abaId: estado.aba?.id,
        },
      }));
    }
  }
}

function linhaItem({ nome, sub, rotulo, classe, destaque, alvo, tocando, miniavel }) {
  // Quando é o vídeo da tela, a etiqueta passa a dizer isso — e o rótulo
  // antigo desce para a legenda, que continua mostrando a assinatura.
  const etiqueta = tocando ? (tocando === "exato" ? "Tocando" : "Provável") : rotulo;
  const classeTag = tocando ? `tocandoTag ${tocando}` : (classe || "");
  const legenda = tocando ? `${String(rotulo).toLowerCase()} · ${sub}` : sub;

  const cartao = el("div", {
      class: `item${destaque ? " destaque" : ""}${tocando ? " tocando" : ""}`,
      "data-url": alvo.url,
    },
    el("span", {
      class: `tag ${classeTag}`,
      title: tocando === "exato"
        ? "é este que está tocando na tela"
        : tocando === "provavel"
          ? "provavelmente este — foi a mídia que acabou de passar na rede"
          : "",
    }, tocando ? el("span", { class: `pulso ${tocando}` }) : null, etiqueta),
    el("div", { class: "corpo" },
      el("div", { class: "nome", title: nome }, nome),
      el("div", { class: "sub", title: legenda }, legenda)),
    el("div", { class: "acoes-item" },
      el("button", {
        class: "secundario", title: "Ver qualidades e opções",
        onclick: () => abrirDetalhe(alvo),
      }, "Opções"),
      el("button", {
        class: "primario",
        // Se a lista se refizer (mídia nova chegou), o botão precisa lembrar
        // que este item já foi pedido — senão baixa duas vezes.
        ...(jaPedido(alvo.url) ? { disabled: "" } : {}),
        onclick: async (e) => {
          const bt = e.currentTarget;
          bt.disabled = true;
          const pasta = await pastaDoDownload();
          if (pasta === null) { bt.disabled = false; return; } // cancelou
          await falar({ cmd: "baixar", ...alvo, pasta });
          // Ficar na lista: assim dá para enfileirar vários seguidos.
          bt.textContent = "Na fila";
        },
      }, jaPedido(alvo.url) ? "Na fila" : "Baixar")));

  if (miniavel) cuidarMiniatura(cartao, alvo);
  return cartao;
}

// Um quadro do vídeo diz o que o nome do arquivo não diz. O que já veio fica
// guardado, para o redesenho aplicar na hora em vez de pedir tudo de novo.
const miniaturas = new Map(); // url -> dataURL | null (null = tentou e não deu)
const naFila = new Set();
const filaMiniatura = [];
let miniaturaOcupada = false;

function cuidarMiniatura(cartao, alvo) {
  const guardada = miniaturas.get(alvo.url);
  if (guardada) return trocarPorMiniatura(cartao, guardada);
  if (miniaturas.has(alvo.url) || naFila.has(alvo.url)) return;
  naFila.add(alvo.url);
  filaMiniatura.push(alvo);
  girarMiniaturas();
}

function trocarPorMiniatura(cartao, img) {
  const tag = cartao.querySelector(".tag");
  if (!tag) return;
  // "Tocando"/"Provável" é o que diz qual é o vídeo da tela. A miniatura entra
  // no lugar da etiqueta, mas o destaque continua — por cima dela.
  const selo = tag.classList.contains("tocandoTag")
    ? el("span", { class: `selo${tag.classList.contains("provavel") ? " provavel" : ""}` }, tag.textContent)
    : null;
  tag.replaceWith(el("span", { class: "moldura" },
    el("img", { class: "miniatura", src: img, alt: "" }), selo));
}

async function girarMiniaturas() {
  if (miniaturaOcupada) return;
  miniaturaOcupada = true;
  // Uma por vez: cada miniatura é um ffmpeg, e dez juntos travam a máquina.
  while (filaMiniatura.length) {
    const alvo = filaMiniatura.shift();
    let img = null;
    try {
      const r = await falar({ cmd: "miniatura", url: alvo.url, cabecalhos: alvo.cabecalhos });
      img = r?.img || null;
    } catch { /* miniatura é enfeite: falhar não pode atrapalhar */ }
    miniaturas.set(alvo.url, img);
    naFila.delete(alvo.url);
    // Troca direto no cartão: recriar a lista tiraria o botão do cursor.
    if (img) {
      for (const cartao of $$(".item")) {
        if (cartao.dataset.url === alvo.url) trocarPorMiniatura(cartao, img);
      }
    }
  }
  miniaturaOcupada = false;
}

// Já está na fila ou baixando? Concluído não conta: pode-se querer de novo.
function jaPedido(url) {
  return estado.fila.some(
    (d) => d.url === url && (d.estado === "fila" || d.estado === "baixando"),
  );
}

// Devolve a pasta a usar: undefined = deixa o background decidir (padrão e
// regras por site); null = o usuário desistiu no seletor.
async function pastaDoDownload() {
  if (!estado.ajustes?.perguntarPasta) return undefined;
  const r = await falar({ cmd: "escolherPasta" });
  return r?.caminho || null;
}

// ------------------------------------------------------------ tela: detalhe

async function abrirDetalhe(alvo) {
  estado.detalhe = { alvo, sonda: null, escolha: null };
  mostrar("detalhe");
  const corpo = $("#detalheCorpo");
  corpo.replaceChildren(el("div", { class: "carregando" },
    el("span", { class: "girando" }), "Consultando o site… isso leva alguns segundos."));

  const r = await falar({
    cmd: "sondar", url: alvo.url, pagina: alvo.pagina, cabecalhos: alvo.cabecalhos,
  });

  if (estado.detalhe?.alvo !== alvo) return; // usuário já saiu

  if (!r || r.erro || !r.ok) {
    corpo.replaceChildren(
      el("div", { class: "vazio" }, r?.mensagem || r?.erro || "não consegui ler esse endereço"),
      el("div", { class: "rodape-detalhe" },
        el("button", {
          class: "primario",
          onclick: async () => { await falar({ cmd: "baixar", ...alvo }); mostrar("fila"); },
        }, "Baixar assim mesmo")));
    return;
  }

  estado.detalhe.sonda = r.dados;
  estado.detalhe.escolha = {
    tipo: estado.ajustes.tipo,
    altura: estado.ajustes.altura || 0,
    container: estado.ajustes.container,
    audioFormato: estado.ajustes.audioFormato,
    legendas: { ...estado.ajustes.legendas },
    sponsorblock: { ...estado.ajustes.sponsorblock },
    metadados: { ...estado.ajustes.metadados },
    dividirCapitulos: estado.ajustes.dividirCapitulos,
    liveDoComeco: estado.ajustes.liveDoComeco,
    trecho: { inicio: "", fim: "" },
    playlist: { ativo: false, itens: "" },
    nome: ((alvo.origem === "rede" ? alvo.titulo : r.dados.titulo)
      || r.dados.titulo || alvo.titulo || "").trim(),
    pasta: undefined, // undefined = pasta padrão / regra por site
  };
  estado.detalhe.temPlaylist = /[?&]list=/.test(alvo.url);
  desenharDetalhe();
}

function desenharDetalhe() {
  const { alvo, sonda, escolha } = estado.detalhe;
  const corpo = $("#detalheCorpo");
  const redesenhar = () => desenharDetalhe();

  const abaixo = [];
  if (sonda.canal) abaixo.push(sonda.canal);
  if (sonda.duracao) abaixo.push(segundosParaTempo(sonda.duracao));
  if (sonda.aoVivo) abaixo.push("ao vivo");
  if (sonda.capitulos) abaixo.push(`${sonda.capitulos} capítulos`);

  const filhos = [];

  filhos.push(el("div", { class: "capa" },
    sonda.thumbnail ? el("img", { src: sonda.thumbnail, alt: "" }) : null,
    el("div", { class: "meta" },
      el("div", { class: "titulo" }, sonda.titulo || alvo.titulo || alvo.url),
      el("div", { class: "abaixo" }, abaixo.map((t) => el("span", {}, t))))));

  if (sonda.temDrm) {
    filhos.push(el("div", { class: "alerta ruim" },
      "Este vídeo é protegido por DRM. O download vai falhar — não há como contornar isso."));
  }

  // ---- o que baixar
  filhos.push(el("div", { class: "grupo" },
    el("h2", {}, "O que baixar"),
    el("div", { class: "chips" },
      chip("Vídeo", escolha.tipo === "video", () => { escolha.tipo = "video"; redesenhar(); }),
      chip("Só áudio", escolha.tipo === "audio", () => { escolha.tipo = "audio"; redesenhar(); }))));

  if (escolha.tipo === "video") {
    const linhas = [
      el("button", {
        class: `qualidade${escolha.altura === 0 ? " on" : ""}`,
        onclick: () => { escolha.altura = 0; redesenhar(); },
      }, el("span", {}, el("strong", {}, "Melhor disponível")), el("span", { class: "dir" }, "")),
    ];
    for (const f of sonda.alturas || []) {
      linhas.push(el("button", {
        class: `qualidade${escolha.altura === f.altura ? " on" : ""}`,
        onclick: () => { escolha.altura = f.altura; redesenhar(); },
      },
      el("span", {}, el("strong", {}, `${f.altura}p`), f.fps > 30 ? ` ${f.fps}fps` : "",
        f.vcodec ? el("span", { class: "dir" }, ` · ${f.vcodec}`) : null),
      el("span", { class: "dir" }, f.tamanho ? bytesLegivel(f.tamanho) : "")));
    }
    filhos.push(el("div", { class: "grupo" }, el("h2", {}, "Qualidade"),
      el("div", { class: "qualidades" }, linhas)));

    filhos.push(el("div", { class: "grupo" },
      el("h2", {}, "Contêiner"),
      el("div", { class: "chips" },
        chip("MKV", escolha.container === "mkv", () => { escolha.container = "mkv"; redesenhar(); }),
        chip("MP4", escolha.container === "mp4", () => { escolha.container = "mp4"; redesenhar(); }))));
  } else {
    filhos.push(el("div", { class: "grupo" },
      el("h2", {}, "Formato do áudio"),
      el("div", { class: "chips" },
        chip("Original", escolha.audioFormato === "original", () => { escolha.audioFormato = "original"; redesenhar(); }),
        chip("MP3", escolha.audioFormato === "mp3", () => { escolha.audioFormato = "mp3"; redesenhar(); }))));
  }

  // ---- extras
  const extras = [];
  const idiomas = [...new Set([...(sonda.legendas || []), ...(sonda.legendasAuto || [])])];
  if (escolha.tipo === "video" && idiomas.length) {
    extras.push(interruptor("Baixar legendas", escolha.legendas.ativo, (v) => {
      escolha.legendas.ativo = v; redesenhar();
    }));
    if (escolha.legendas.ativo) {
      extras.push(el("p", { class: "dica" },
        `disponíveis: ${idiomas.slice(0, 12).join(", ")}${idiomas.length > 12 ? "…" : ""}`));
      extras.push(interruptor("Embutir no arquivo", escolha.legendas.embutir, (v) => {
        escolha.legendas.embutir = v; redesenhar();
      }));
    }
  }
  if (sonda.capitulos > 0) {
    extras.push(interruptor("Dividir em arquivos por capítulo", escolha.dividirCapitulos, (v) => {
      escolha.dividirCapitulos = v; redesenhar();
    }));
  }
  extras.push(interruptor("Remover trechos com SponsorBlock", escolha.sponsorblock.ativo, (v) => {
    escolha.sponsorblock.ativo = v; redesenhar();
  }));
  if (sonda.aoVivo) {
    extras.push(interruptor("Gravar desde o início da live", escolha.liveDoComeco, (v) => {
      escolha.liveDoComeco = v; redesenhar();
    }));
  }
  filhos.push(el("div", { class: "grupo" }, el("h2", {}, "Extras"), extras));

  // ---- playlist
  if (estado.detalhe.temPlaylist) {
    const linhas = [interruptor(
      "Baixar a playlist inteira, não só este vídeo",
      escolha.playlist.ativo,
      (v) => { escolha.playlist.ativo = v; redesenhar(); },
    )];
    if (escolha.playlist.ativo) {
      linhas.push(el("div", { class: "campo-linha" },
        el("label", {}, "Quais itens"),
        el("input", {
          type: "text", placeholder: "todos — ex.: 1-10", value: escolha.playlist.itens,
          oninput: (e) => { escolha.playlist.itens = e.target.value.trim(); },
        })));
      linhas.push(el("p", { class: "dica" },
        "Cada vídeo vira um arquivo numerado dentro de uma pasta com o nome da playlist."));
    }
    filhos.push(el("div", { class: "grupo" }, el("h2", {}, "Playlist"), linhas));
  }

  // ---- trecho
  filhos.push(el("div", { class: "grupo" },
    el("h2", {}, "Baixar só um trecho"),
    el("div", { class: "trecho" },
      el("input", {
        type: "text", placeholder: "0:00", value: escolha.trecho.inicio,
        oninput: (e) => { escolha.trecho.inicio = e.target.value.trim(); },
      }),
      el("span", {}, "até"),
      el("input", {
        type: "text", placeholder: "fim", value: escolha.trecho.fim,
        oninput: (e) => { escolha.trecho.fim = e.target.value.trim(); },
      })),
    el("p", { class: "dica" }, "Deixe vazio para o vídeo inteiro. Formato h:mm:ss ou mm:ss.")));

  // ---- nome e destino
  filhos.push(el("div", { class: "grupo" },
    el("h2", {}, "Salvar como"),
    el("input", {
      type: "text", value: escolha.nome, placeholder: "nome do arquivo",
      spellcheck: "false",
      oninput: (e) => { escolha.nome = e.target.value; },
    }),
    el("p", { class: "dica" }, "A extensão põe a extensão certa no fim. Barras e dois-pontos são removidos."),
    el("div", { class: "destino", style: "margin:10px 0 0" },
      el("div", { class: "destino-info" },
        el("span", { class: "rotulo" }, "Salvar em"),
        el("span", { class: "caminho" },
          escolha.pasta ? encurtarCaminho(escolha.pasta)
            : (estado.ajustes?.perguntarPasta ? "vai perguntar" : encurtarCaminho(estado.ajustes?.pasta)))),
      el("button", {
        class: "secundario",
        onclick: async (ev) => {
          // currentTarget só existe durante o disparo do evento; depois do
          // await ele é null. Guardar antes é obrigatório.
          const bt = ev.currentTarget;
          bt.disabled = true;
          const r = await falar({ cmd: "escolherPasta" });
          bt.disabled = false;
          if (r?.caminho) { escolha.pasta = r.caminho; redesenhar(); }
        },
      }, "Mudar"))));

  // ---- rodapé
  filhos.push(el("div", { class: "rodape-detalhe" },
    el("button", {
      class: "primario",
      onclick: async (e) => {
        const bt = e.currentTarget;
        bt.disabled = true;
        const t = escolha.trecho;
        let pasta = escolha.pasta;
        if (pasta === undefined) {
          pasta = await pastaDoDownload();
          if (pasta === null) { bt.disabled = false; return; } // cancelou
        }
        await falar({
          cmd: "baixar", ...alvo,
          pasta,
          nomeBase: escolha.nome.trim() || undefined,
          opcoes: {
            tipo: escolha.tipo,
            container: escolha.container,
            audioFormato: escolha.audioFormato,
            altura: escolha.altura || null,
            legendas: escolha.legendas,
            sponsorblock: escolha.sponsorblock,
            metadados: escolha.metadados,
            dividirCapitulos: escolha.dividirCapitulos,
            liveDoComeco: escolha.liveDoComeco,
            trecho: (t.inicio || t.fim) ? t : null,
            playlist: escolha.playlist.ativo ? escolha.playlist : null,
          },
        });
        mostrar("fila");
      },
    }, "Baixar")));

  corpo.replaceChildren(...filhos);
}

function chip(texto, ligado, aoClicar) {
  return el("button", { class: `chip${ligado ? " on" : ""}`, onclick: aoClicar }, texto);
}

function interruptor(texto, ligado, aoMudar) {
  const inp = el("input", { type: "checkbox", ...(ligado ? { checked: "" } : {}) });
  inp.addEventListener("change", () => aoMudar(inp.checked));
  return el("label", { class: "switch" }, inp, el("span", {}), texto);
}

// --------------------------------------------------------------- tela: fila

function desenharFila() {
  const lista = $("#listaFila");
  lista.replaceChildren();

  const ativos = estado.fila.filter((d) => d.estado === "baixando" || d.estado === "fila").length;
  $("#resumoFila").textContent = ativos
    ? `${ativos} em andamento`
    : `${estado.fila.length} no histórico`;

  if (!estado.fila.length) {
    lista.append(el("div", { class: "vazio" }, "Nenhum download ainda."));
    return;
  }

  const peso = { baixando: 0, fila: 1, interrompido: 2, erro: 3, pronto: 4, cancelado: 5 };
  const ordenada = [...estado.fila].sort(
    (a, b) => (peso[a.estado] ?? 9) - (peso[b.estado] ?? 9) || b.criadoEm - a.criadoEm,
  );

  for (const d of ordenada) lista.append(cartaoDownload(d));
}

function cartaoDownload(d) {
  const rotuloEstado = {
    fila: "na fila", baixando: `${Math.round(d.percent || 0)}%`,
    pronto: "pronto", erro: "falhou", cancelado: "cancelado", interrompido: "interrompido",
  }[d.estado] || d.estado;

  const acoes = [];
  if (d.estado === "baixando" || d.estado === "fila") {
    acoes.push(el("button", {
      class: "texto", onclick: () => falar({ cmd: "cancelar", id: d.id }),
    }, "parar"));
  }
  if (["erro", "cancelado", "interrompido"].includes(d.estado)) {
    acoes.push(el("button", {
      class: "texto", onclick: () => falar({ cmd: "retomar", id: d.id }),
    }, "tentar de novo"));
  }
  if (d.estado === "pronto" && d.caminho) {
    acoes.push(el("button", {
      class: "texto", onclick: () => falar({ cmd: "abrir", caminho: d.caminho }),
    }, "mostrar"));
  }
  if (d.estado !== "baixando") {
    acoes.push(el("button", {
      class: "texto", onclick: () => falar({ cmd: "remover", id: d.id }),
    }, "×"));
  }

  const sub = [];
  if (d.estado === "baixando") {
    if (d.etapa) sub.push(d.etapa);
    if (d.velocidade) sub.push(d.velocidade);
    if (d.eta) sub.push(`faltam ${d.eta}`);
    if (d.item) sub.push(`item ${d.item.atual}/${d.item.total}`);
    if (d.viaRede) sub.push("pelo item detectado na rede");
  } else if (d.estado === "pronto") {
    sub.push(encurtarCaminho(d.caminho) || "concluído");
    if (d.viaRede) sub.push("via item da rede");
  } else if (d.mensagem) {
    sub.push(d.mensagem);
  }

  const semPercent = d.estado === "baixando" && !(d.percent > 0);

  return el("div", { class: `dl ${d.estado}` },
    el("div", { class: "cab" },
      el("div", { class: "nome", title: d.titulo }, d.titulo),
      el("span", { class: "estado" }, rotuloEstado),
      el("div", { class: "acoes" }, acoes)),
    d.estado === "baixando"
      ? el("div", { class: `barra${semPercent ? " indeterminada" : ""}` },
        el("i", { style: `width:${Math.max(0, Math.min(100, d.percent || 0))}%` }))
      : null,
    sub.length ? el("div", { class: "sub" }, sub.join(" · ")) : null);
}

$("#btLimpar").addEventListener("click", () => falar({ cmd: "limparConcluidos" }));

// ------------------------------------------------------------ tela: ajustes

function montarAjustes() {
  const a = estado.ajustes;
  if (!a) return;
  $("#ajPasta").dataset.pronto = "1";
  $("#ajPasta").value = a.pasta || "";

  ligarChips("#ajTipo", a.tipo, (v) => salvar({ tipo: v }, true));
  ligarChips("#ajContainer", a.container, (v) => salvar({ container: v }));
  ligarChips("#ajAudioFormato", a.audioFormato, (v) => salvar({ audioFormato: v }));
  ligarChipsMulti("#ajSbCategorias", a.sponsorblock.categorias,
    (vs) => salvar({ sponsorblock: { categorias: vs } }));

  $("#ajAltura").value = String(a.altura || 0);
  $("#ajSimultaneos").value = String(a.maxSimultaneos);
  $("#ajLegIdiomas").value = (a.legendas.idiomas || []).join(", ");

  const marcar = (sel, valor) => { $(sel).checked = !!valor; };
  marcar("#ajLegAtivo", a.legendas.ativo);
  marcar("#ajLegAuto", a.legendas.automaticas);
  marcar("#ajLegEmbutir", a.legendas.embutir);
  marcar("#ajSbAtivo", a.sponsorblock.ativo);
  marcar("#ajMdThumb", a.metadados.thumbnail);
  marcar("#ajMdInfo", a.metadados.info);
  marcar("#ajMdCap", a.metadados.capitulos);
  marcar("#ajDividir", a.dividirCapitulos);
  marcar("#ajCookies", a.usarCookies);
  marcar("#ajPerguntarPasta", a.perguntarPasta);
  marcar("#ajLive", a.liveDoComeco);
  marcar("#ajNotificar", a.notificar);
  marcar("#ajMenu", a.menuContexto);

  desenharRegras();
  refletirDependencias();
}

function ligarChips(seletor, atual, aoEscolher) {
  const raiz = $(seletor);
  raiz.querySelectorAll(".chip").forEach((c) => {
    c.classList.toggle("on", c.dataset.v === String(atual));
    c.onclick = () => {
      raiz.querySelectorAll(".chip").forEach((o) => o.classList.toggle("on", o === c));
      aoEscolher(c.dataset.v);
    };
  });
}

function ligarChipsMulti(seletor, atuais, aoMudar) {
  const raiz = $(seletor);
  raiz.querySelectorAll(".chip").forEach((c) => {
    c.classList.toggle("on", (atuais || []).includes(c.dataset.v));
    c.onclick = () => {
      c.classList.toggle("on");
      aoMudar([...raiz.querySelectorAll(".chip.on")].map((o) => o.dataset.v));
    };
  });
}

async function salvar(parcial, remontar = false) {
  const r = await falar({ cmd: "ajustes", ajustes: parcial });
  estado.ajustes = r.ajustes;
  desenharDescobrir();
  if (remontar) refletirDependencias();
}

// Vídeo e áudio não compartilham controles; mostrar só o que vale agora.
function refletirDependencias() {
  const ehAudio = estado.ajustes.tipo === "audio";
  $("#linhaContainer").hidden = ehAudio;
  $("#linhaQualidade").hidden = ehAudio;
  $("#linhaAudio").hidden = !ehAudio;
  $("#blocoLegendas").classList.toggle("desativado", !$("#ajLegAtivo").checked);
  $("#ajSbCategorias").classList.toggle("desativado", !$("#ajSbAtivo").checked);
}

// --- ligações dos controles simples
const liga = (sel, ler, chave) => {
  $(sel).addEventListener("change", () => { salvar(chave(ler($(sel)))); refletirDependencias(); });
};
const val = (e) => e.value;
const marc = (e) => e.checked;

liga("#ajAltura", val, (v) => ({ altura: Number(v) }));
liga("#ajSimultaneos", val, (v) => ({ maxSimultaneos: Number(v) }));
liga("#ajLegAtivo", marc, (v) => ({ legendas: { ativo: v } }));
liga("#ajLegAuto", marc, (v) => ({ legendas: { automaticas: v } }));
liga("#ajLegEmbutir", marc, (v) => ({ legendas: { embutir: v } }));
liga("#ajSbAtivo", marc, (v) => ({ sponsorblock: { ativo: v } }));
liga("#ajMdThumb", marc, (v) => ({ metadados: { thumbnail: v } }));
liga("#ajMdInfo", marc, (v) => ({ metadados: { info: v } }));
liga("#ajMdCap", marc, (v) => ({ metadados: { capitulos: v } }));
liga("#ajDividir", marc, (v) => ({ dividirCapitulos: v }));
liga("#ajCookies", marc, (v) => ({ usarCookies: v }));
liga("#ajPerguntarPasta", marc, (v) => ({ perguntarPasta: v }));
liga("#ajLive", marc, (v) => ({ liveDoComeco: v }));
liga("#ajNotificar", marc, (v) => ({ notificar: v }));
liga("#ajMenu", marc, (v) => ({ menuContexto: v }));

$("#ajLegIdiomas").addEventListener("change", (e) => {
  const idiomas = e.target.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  salvar({ legendas: { idiomas } });
});

$("#ajPasta").addEventListener("change", (e) => salvar({ pasta: e.target.value.trim() }));

for (const sel of ["#btPasta", "#btPasta2"]) {
  $(sel).addEventListener("click", async (e) => {
    const bt = e.currentTarget;
    bt.disabled = true;
    const r = await falar({ cmd: "escolherPasta" });
    bt.disabled = false;
    if (r?.caminho) {
      await salvar({ pasta: r.caminho });
      $("#ajPasta").value = r.caminho;
    }
  });
}

// --- regras de pasta por site
function desenharRegras() {
  const raiz = $("#regras");
  raiz.replaceChildren();
  const regras = estado.ajustes.regrasPasta || [];
  for (const [i, r] of regras.entries()) {
    raiz.append(el("div", { class: "linha-campo", style: "margin-bottom:6px" },
      el("input", {
        type: "text", value: r.padrao || "", placeholder: "youtube.com",
        onchange: (e) => trocarRegra(i, { padrao: e.target.value.trim() }),
      }),
      el("input", {
        type: "text", value: encurtarCaminho(r.pasta), placeholder: "~/Videos",
        onchange: (e) => trocarRegra(i, { pasta: e.target.value.trim() }),
      }),
      el("button", {
        class: "texto", title: "remover",
        onclick: () => {
          const novas = [...estado.ajustes.regrasPasta];
          novas.splice(i, 1);
          salvarRegras(novas);
        },
      }, "×")));
  }
}

function trocarRegra(i, parcial) {
  const novas = [...estado.ajustes.regrasPasta];
  novas[i] = { ...novas[i], ...parcial };
  // O host precisa de caminho absoluto; "~" só existe no shell.
  if (novas[i].pasta?.startsWith("~")) {
    novas[i].pasta = novas[i].pasta.replace("~", estado.diagHome || "~");
  }
  salvarRegras(novas);
}

async function salvarRegras(novas) {
  const r = await falar({ cmd: "ajustes", ajustes: { regrasPasta: novas } });
  estado.ajustes = r.ajustes;
  desenharRegras();
}

$("#btAddRegra").addEventListener("click", () => {
  salvarRegras([...(estado.ajustes.regrasPasta || []), { padrao: "", pasta: "" }]);
});

// --- diagnóstico
async function carregarDiagnostico() {
  const d = $("#diag");
  d.textContent = "consultando o host…";
  const r = await falar({ cmd: "info" });
  if (!r || r.erro) {
    d.innerHTML = `<span class="ruim">${r?.erro || "host não respondeu"}</span><br>Rode <b>./install.sh</b> e recarregue a extensão.`;
    alertar("O host nativo não respondeu. Rode ./install.sh no terminal.", true);
    return;
  }
  estado.diagHome = r.home;
  alertar("");

  const linhas = [];
  const item = (rotulo, valor, classe) =>
    `${rotulo}: <span class="${classe || ""}">${valor}</span>`;

  linhas.push(item("yt-dlp", r.ytdlpVersao || "não encontrado", r.ytdlp ? "" : "ruim"));
  if (r.ytdlpIdadeDias != null && r.ytdlpIdadeDias > 45) {
    linhas.push(item("", `essa versão tem ${r.ytdlpIdadeDias} dias — quando um site parar de funcionar, atualize com "brew upgrade yt-dlp"`, "aviso"));
  }
  linhas.push(item("ffmpeg", r.ffmpegVersao || "não encontrado", r.ffmpeg ? "" : "ruim"));
  linhas.push(item("deno", r.denoVersao || "não encontrado — o YouTube vai dar 403", r.deno ? "" : "ruim"));
  linhas.push(item("log", r.log));
  d.innerHTML = linhas.join("<br>");

  if (!r.deno) alertar("Sem o deno o YouTube responde 403. Instale com: brew install deno", true);
  else if (r.ytdlpIdadeDias > 90) alertar(`Seu yt-dlp tem ${r.ytdlpIdadeDias} dias. Vale rodar: brew upgrade yt-dlp`);
}

$("#btDiag").addEventListener("click", carregarDiagnostico);

// ------------------------------------------------------------------ início

puxarEstado();
carregarDiagnostico();
