/* Prontuário da Princesa — adaptador do Google Drive (modo celular).
   Define window.claude (modo "drive"): dados no IndexedDB (offline primeiro)
   e sincronização com uma pasta no Google Drive do usuário.
   Script clássico, sem dependências. Carregar depois de config.js e antes do app. */
(function () {
  "use strict";

  const G = typeof window !== "undefined" ? window : globalThis;

  // ---------------------------------------------------------------------------
  // Configuração
  // ---------------------------------------------------------------------------
  const CFG = G.PRONTUARIO_CONFIG && typeof G.PRONTUARIO_CONFIG === "object" ? G.PRONTUARIO_CONFIG : {};
  const TESTE = CFG.teste === true;
  const CLIENT_ID = typeof CFG.clientId === "string" ? CFG.clientId.trim() : "";
  const CONFIGURADO = !!CLIENT_ID && !CLIENT_ID.includes("COLE_AQUI");
  const API = String(CFG.apiBase || "https://www.googleapis.com").replace(/\/+$/, "");
  const AUTH_URL = String(CFG.authUrl || "https://accounts.google.com/o/oauth2/v2/auth");
  const GIS_SRC = CFG.gisSrc === undefined ? "https://accounts.google.com/gsi/client" : (CFG.gisSrc || null);
  const NOME_PASTA = String(CFG.nomePasta || "Prontuário da Princesa");
  const ATRASO_SYNC = Number(CFG.atrasoSyncMs) > 0 ? Number(CFG.atrasoSyncMs) : 1500;
  const BASE_ESPERA = TESTE ? 5 : 1000; // base do backoff exponencial
  const PRAZO_REDE = Number(CFG.prazoRedeMs) > 0 ? Number(CFG.prazoRedeMs) : 30000; // prazo por chamada
  const prazoPara = (bytes) => PRAZO_REDE + (Number(bytes) || 0) / 40; // + ~40 KB/s para corpos grandes

  const ESCOPO = "https://www.googleapis.com/auth/drive.file";
  const PASTA_MIME = "application/vnd.google-apps.folder";
  const COLECOES = ["exames", "vacinas", "remedios", "lembretes", "pesos", "config"];
  const LIMITE_MULTIPART = 5 * 1024 * 1024;
  const MAX_ANEXO = 20 * 1024 * 1024;
  const ID_OK = /^[A-Za-z0-9_-]{8,128}$/;
  const ALFA_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const ALFA_ID = ALFA_NUM + "_-";
  const TIPOS_OK = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
  const EXT_TIPO = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
  const TIPO_EXT = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
  const CHAVE = {
    token: "prontuario.token", conta: "prontuario.conta", nome: "prontuario.nome",
    metodo: "prontuario.metodo", state: "prontuario.state", dispositivo: "prontuario.dispositivo"
  };
  const CHAVES_META = ["ultimoPull", "ultimaSync", "md5", "pastas", "anexos", "lixeira", "ignorados"];

  // Mensagens curtas para o usuário
  const MSG = {
    offline: "Sem internet agora. Vou sincronizar quando a conexão voltar.",
    cota: "Seu Google Drive está sem espaço. Libere espaço para continuar guardando.",
    sem_permissao: "O Google Drive não deixou o app mexer nos arquivos. Conecte de novo.",
    drive: "O Google Drive teve um problema. Vou tentar de novo daqui a pouco.",
    apiDesativada: "A Google Drive API não está ativada no Google Cloud (LEIA-ME, Parte 1, passo 3). Se acabou de ativar, espere alguns minutos e toque em Tentar de novo.",
    login: "Seu acesso ao Google Drive expirou. Toque em Sincronizar para entrar de novo.",
    loginFalhou: "Não consegui entrar no Google. Tente de novo.",
    loginNoSafari: "O login do Google voltou aqui no Safari, e não no app da tela de início. Feche esta aba e abra pelo ícone Princesa. Lá, em Ficha → Google Drive → Como entrar no Google, escolha \"Janela\". (Para usar aqui no Safari mesmo, toque em Tentar de novo.)",
    gisCarregando: "O login do Google ainda está carregando. Toque de novo em instantes (ou escolha \"Redirecionar\" em Ficha → Google Drive).",
    loginNegado: "Você não permitiu o acesso ao Google Drive.",
    escopo: "O Google não deu acesso ao Drive. Tente de novo e permita o acesso aos arquivos.",
    local: "Não consegui guardar no aparelho. Tente de novo."
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  const agora = () => Date.now();
  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const chaveDoc = (col, id) => col + "/" + id;

  function erro(code, mensagem, extra) {
    const e = { code, message: mensagem || code, mensagem: mensagem || code };
    return extra ? Object.assign(e, extra) : e;
  }

  // Texto aleatório com o alfabeto dado (crypto quando houver)
  function aleatorio(n, alfabeto) {
    let s = "";
    const c = G.crypto;
    if (c && typeof c.getRandomValues === "function") {
      const buf = new Uint32Array(n);
      c.getRandomValues(buf);
      for (let i = 0; i < n; i++) s += alfabeto[buf[i] % alfabeto.length];
    } else {
      for (let i = 0; i < n; i++) s += alfabeto[Math.floor(Math.random() * alfabeto.length)];
    }
    return s;
  }
  const novoIdDoc = () => aleatorio(20, ALFA_NUM);
  const novoIdAnexo = () => aleatorio(22, ALFA_ID);

  // Cópia profunda de dados JSON
  const copia = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

  // localStorage sem nunca lançar erro
  const ls = {
    ler(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } },
    lerJson(k) { try { const v = this.ler(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    gravar(k, v) { try { G.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } catch (e) { /* sem espaço ou bloqueado */ } },
    apagar(k) { try { G.localStorage.removeItem(k); } catch (e) { /* ok */ } }
  };

  function avisarConsole(...a) { try { G.console && G.console.warn && G.console.warn("[drive]", ...a); } catch (e) { /* ok */ } }

  // Id deste aparelho (desempate do "último vence")
  const DISPOSITIVO = (function () {
    let d = ls.ler(CHAVE.dispositivo);
    if (!d) { d = aleatorio(12, ALFA_NUM); ls.gravar(CHAVE.dispositivo, d); }
    return d;
  })();
  const ABA = aleatorio(10, ALFA_NUM);

  // ---------------------------------------------------------------------------
  // Estado em memória
  // ---------------------------------------------------------------------------
  const docs = new Map();       // "col/id" -> registro {col,id,dados,atualizado,apagado,dispositivo,sujo}
  const filaEnvio = new Set();  // ids de anexos ainda não enviados
  // ignorados: ids de arquivos do Drive que não dá para usar (estragados que não deu para renomear)
  const meta = { ultimoPull: null, ultimaSync: null, md5: {}, pastas: {}, anexos: {}, lixeira: [], ignorados: [] };
  let token = lerToken();
  let metodo = lerMetodo();
  let erroAtual = null;
  let sincronizando = false;
  let precisaPerfil = false;
  let ultimaTentativa = 0;
  let mapaFresco = false;       // mapa de anexos já atualizado nesta sincronização
  let mapaConferido = false;    // mapa de anexos conferido nesta sessão
  let pastasMudaram = false;    // as pastas foram procuradas de novo (lixeira, apagadas...)
  let pastasConferidas = false; // pastas em cache comparadas com as mais antigas do Drive nesta sessão
  const anexosNaLixeira = new Map(); // aid -> arquivo do Drive que está na lixeira
  const faltas = new Map();     // aid -> quando não foi achado no Drive (evita listar de novo)
  let prontoPromessa = null;    // carga inicial do IndexedDB
  let relogio = null, agendado = null, canal = null;

  // Promessa resolvida quando a primeira sincronização termina (bem ou mal)
  let resolverPrimeiroPull;
  const primeiroPull = new Promise((ok) => { resolverPrimeiroPull = ok; });

  // ---------------------------------------------------------------------------
  // Armazém local: IndexedDB, ou memória se não houver
  // ---------------------------------------------------------------------------
  const LOJAS = ["docs", "blobs", "meta"];
  const armazem = { tipo: "indexeddb", db: null, memoria: null };

  function abrirIndexedDB() {
    return new Promise((ok, falha) => {
      let pedido;
      try { pedido = G.indexedDB.open("prontuario-drive", 1); } catch (e) { falha(e); return; }
      const limite = setTimeout(() => falha(new Error("IndexedDB demorou demais")), 5000);
      pedido.onupgradeneeded = () => {
        const db = pedido.result;
        for (const n of LOJAS) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n);
      };
      pedido.onsuccess = () => { clearTimeout(limite); ok(pedido.result); };
      pedido.onerror = () => { clearTimeout(limite); falha(pedido.error || new Error("IndexedDB")); };
    });
  }

  // Conexão fechada pelo navegador (iOS ao voltar do segundo plano): esquece e reabre depois
  function prepararDb(db) {
    const esquecer = () => { if (armazem.db === db) armazem.db = null; };
    db.onversionchange = () => { try { db.close(); } catch (e) { /* ok */ } esquecer(); };
    db.onclose = esquecer;
    return db;
  }

  let reabrindo = null;
  function reabrirIndexedDB() {
    if (!reabrindo) {
      reabrindo = abrirIndexedDB().then((db) => { armazem.db = prepararDb(db); })
        .finally(() => { reabrindo = null; });
    }
    return reabrindo;
  }

  async function abrirArmazem() {
    if (G.indexedDB) {
      // tenta duas vezes (às vezes a primeira abertura trava no iOS)
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
          armazem.db = prepararDb(await abrirIndexedDB());
          return;
        } catch (e) {
          if (tentativa === 2) avisarConsole("IndexedDB indisponível, usando memória", e);
        }
      }
    }
    usarMemoria();
  }

  function usarMemoria() {
    armazem.tipo = "memoria";
    armazem.db = null;
    armazem.memoria = { docs: new Map(), blobs: new Map(), meta: new Map() };
  }

  // Loja em memória com a mesma cara de um objectStore
  function lojaMemoria(mapa) {
    const pedido = (v) => ({ result: v });
    return {
      get: (k) => pedido(mapa.get(k)),
      getAll: () => pedido(Array.from(mapa.values())),
      put: (v, k) => { mapa.set(k, v); return pedido(k); },
      delete: (k) => { mapa.delete(k); return pedido(undefined); }
    };
  }

  // fn recebe a loja e devolve um pedido, uma lista de pedidos ou nada.
  // A transação é criada na hora: isso mantém a ordem das escritas.
  function operar(loja, modo, fn) {
    if (armazem.memoria) {
      try { return Promise.resolve(lerResultado(fn(lojaMemoria(armazem.memoria[loja])))); }
      catch (e) { return Promise.reject(e); }
    }
    // Conexão perdida: reabre uma vez e repete
    return operarIdb(loja, modo, fn).catch((e) => {
      if (!conexaoPerdida(e)) throw e;
      return reabrirIndexedDB().then(() => operarIdb(loja, modo, fn));
    });
  }

  function conexaoPerdida(e) {
    const nome = e && e.name;
    return nome === "InvalidStateError" || nome === "UnknownError" || nome === "SemConexao" ||
      /connection|closing|closed/i.test(String((e && e.message) || ""));
  }

  function operarIdb(loja, modo, fn) {
    if (!armazem.db) {
      const e = new Error("sem conexão com o IndexedDB");
      e.name = "SemConexao";
      return Promise.reject(e);
    }
    return new Promise((ok, falha) => {
      try {
        const tx = armazem.db.transaction(loja, modo);
        const r = fn(tx.objectStore(loja));
        tx.oncomplete = () => { try { ok(lerResultado(r)); } catch (e) { falha(e); } };
        tx.onerror = () => falha(tx.error || new Error("IndexedDB"));
        tx.onabort = () => falha(tx.error || new Error("IndexedDB abortou"));
      } catch (e) { falha(e); }
    });
  }

  function lerResultado(r) {
    if (Array.isArray(r)) return r.map((x) => (x ? x.result : undefined));
    return r && typeof r === "object" && "result" in r ? r.result : undefined;
  }

  function gravarDocs(recs) {
    if (!recs.length) return Promise.resolve();
    return operar("docs", "readwrite", (s) => { for (const r of recs) s.put(r, chaveDoc(r.col, r.id)); });
  }

  function salvarMeta(...chaves) {
    const valores = chaves.map((k) => [k, copia(meta[k])]);
    return operar("meta", "readwrite", (s) => { for (const [k, v] of valores) s.put(v, k); });
  }

  // Lixeira de anexos: lê e grava na mesma transação (outra aba pode ter mexido)
  async function mexerLixeira(tirar, por) {
    const aplicar = (lista) => {
      let l = Array.isArray(lista) ? lista.slice() : [];
      if (tirar) l = l.filter((x) => x !== tirar);
      if (por && !l.includes(por)) l.push(por);
      return l;
    };
    if (armazem.memoria) { meta.lixeira = aplicar(meta.lixeira); return; }
    let nova = null;
    try {
      await operar("meta", "readwrite", (s) => {
        const r = s.get("lixeira");
        r.onsuccess = () => { nova = aplicar(r.result); s.put(nova, "lixeira"); };
      });
    } catch (e) { nova = null; }
    meta.lixeira = nova || aplicar(meta.lixeira);
  }

  // ---------------------------------------------------------------------------
  // Regras de versão ("último vence", com desempate pelo aparelho)
  // ---------------------------------------------------------------------------
  function ganha(a, b) {
    if (a.atualizado !== b.atualizado) return a.atualizado > b.atualizado;
    return String(a.dispositivo || "") > String(b.dispositivo || "");
  }
  const mesmaVersao = (a, b) => a.atualizado === b.atualizado && String(a.dispositivo || "") === String(b.dispositivo || "");
  function mudouVisivel(a, b) {
    if (!a) return !b.apagado;
    if (!!a.apagado !== !!b.apagado) return true;
    return !a.apagado && JSON.stringify(a.dados) !== JSON.stringify(b.dados);
  }

  // Lê o IndexedDB e junta com a memória sem nunca voltar versão
  async function recarregarDoArmazem(comBlobs) {
    const [lista, valores] = await Promise.all([
      operar("docs", "readonly", (s) => s.getAll()),
      operar("meta", "readonly", (s) => CHAVES_META.map((k) => s.get(k)))
    ]);
    const mudaram = new Set();
    for (const r of lista || []) {
      if (!r || typeof r.col !== "string" || r.id == null) continue;
      const chave = chaveDoc(r.col, r.id), atual = docs.get(chave);
      if (!atual || ganha(r, atual)) {
        if (mudouVisivel(atual, r)) mudaram.add(r.col);
        docs.set(chave, r);
      } else if (mesmaVersao(r, atual) && atual.sujo && !r.sujo) {
        docs.set(chave, r); // outra aba já enviou esta versão
      }
    }
    aplicarMeta(valores || []);
    if (comBlobs) {
      // a fila é refeita a partir do armazém (outra aba pode ter enviado)
      const blobs = await operar("blobs", "readonly", (s) => s.getAll());
      filaEnvio.clear();
      for (const b of blobs || []) if (b && b.id && !b.enviado) filaEnvio.add(b.id);
    }
    return mudaram;
  }

  function aplicarMeta(valores) {
    const v = {};
    CHAVES_META.forEach((k, i) => { v[k] = valores[i]; });
    const maior = (a, b) => (typeof b === "number" && (a == null || b > a) ? b : a);
    meta.ultimoPull = maior(meta.ultimoPull, v.ultimoPull);
    meta.ultimaSync = maior(meta.ultimaSync, v.ultimaSync);
    if (v.md5 && typeof v.md5 === "object") meta.md5 = Object.assign({}, v.md5);
    if (v.pastas && v.pastas.raiz) meta.pastas = Object.assign({}, v.pastas);
    if (v.anexos && typeof v.anexos === "object") meta.anexos = Object.assign({}, meta.anexos, v.anexos);
    if (Array.isArray(v.lixeira)) meta.lixeira = v.lixeira.slice(); // o armazém manda (mexerLixeira)
    if (Array.isArray(v.ignorados)) meta.ignorados = Array.from(new Set(meta.ignorados.concat(v.ignorados)));
  }

  // ---------------------------------------------------------------------------
  // Fotos (snapshots) e ouvintes
  // ---------------------------------------------------------------------------
  const ouvintesCol = new Map(); // col -> Set
  const ouvintesDoc = new Map(); // "col/id" -> Set

  function docsDaColecao(col) {
    const lista = [];
    for (const r of docs.values()) if (r.col === col) lista.push(r);
    lista.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return lista;
  }

  function fotoColecao(col) {
    const recs = docsDaColecao(col);
    const vivos = recs.filter((r) => !r.apagado).map((r) => {
      const dados = r.dados;
      return { id: r.id, exists: true, data: () => copia(dados), get: (campo) => copia(dados ? dados[campo] : undefined) };
    });
    return {
      docs: vivos, size: vivos.length, empty: vivos.length === 0,
      forEach: (fn) => vivos.forEach(fn),
      docChanges: () => [],
      metadata: { fromCache: false, hasPendingWrites: recs.some((r) => r.sujo) }
    };
  }

  function fotoDoc(col, id) {
    const r = docs.get(chaveDoc(col, id));
    const existe = !!r && !r.apagado;
    const dados = existe ? r.dados : undefined;
    return {
      exists: existe, id,
      data: () => (existe ? copia(dados) : undefined),
      get: (campo) => (existe && dados ? copia(dados[campo]) : undefined),
      metadata: { fromCache: false, hasPendingWrites: !!(r && r.sujo) }
    };
  }

  // Primeira emissão: depois da carga local. Num aparelho novo com login,
  // espera a primeira sincronização (até 8 s) para não piscar o "crie a ficha".
  let esperaInicial = null;
  function esperarInicio() {
    if (!esperaInicial) {
      esperaInicial = prontoPromessa.then(() => {
        if (!(CONFIGURADO && tokenValido() && meta.ultimoPull == null)) return;
        return new Promise((ok) => {
          const t = setTimeout(ok, 8000);
          primeiroPull.then(() => { clearTimeout(t); ok(); });
        });
      });
    }
    return esperaInicial;
  }

  function entregar(o, foto) {
    try { o.next(foto); } catch (e) { avisarConsole("erro no ouvinte", e); }
  }

  function assinar(mapa, chave, next, error, fazerFoto) {
    const o = {
      next: typeof next === "function" ? next : (next && typeof next.next === "function" ? next.next.bind(next) : () => {}),
      error: typeof error === "function" ? error : (next && typeof next.error === "function" ? next.error.bind(next) : null),
      ativo: true, iniciado: false, fazerFoto
    };
    let set = mapa.get(chave);
    if (!set) { set = new Set(); mapa.set(chave, set); }
    set.add(o);
    esperarInicio().then(() => {
      if (o.ativo && !o.iniciado) { o.iniciado = true; entregar(o, fazerFoto()); }
    });
    return () => { o.ativo = false; set.delete(o); };
  }

  // Reemite para todos os ouvintes da coleção (e dos docs dela)
  function emitirColecao(col) {
    const s = ouvintesCol.get(col);
    if (s) for (const o of Array.from(s)) if (o.ativo && o.iniciado) entregar(o, o.fazerFoto());
    for (const [chave, set] of ouvintesDoc) {
      if (!chave.startsWith(col + "/")) continue;
      for (const o of Array.from(set)) if (o.ativo && o.iniciado) entregar(o, o.fazerFoto());
    }
  }

  // ---------------------------------------------------------------------------
  // db (parecido com o Firestore, só o que o app usa)
  // ---------------------------------------------------------------------------
  async function escreverLocal(col, id, dados, apagado) {
    await prontoPromessa;
    const chave = chaveDoc(col, id);
    const antes = docs.get(chave);
    const rec = {
      col, id, dados: apagado ? null : dados,
      atualizado: Math.max(agora(), ((antes && antes.atualizado) || 0) + 1),
      apagado: !!apagado, dispositivo: DISPOSITIVO, sujo: 1
    };
    // Gravado antes do primeiro pull e sem base vinda do Drive: no 1º merge a versão do Drive vence
    if (meta.ultimoPull == null && (!antes || antes.semBase)) rec.semBase = 1;
    docs.set(chave, rec); // memória primeiro (fica atômico em relação à sincronização)
    try {
      await operar("docs", "readwrite", (s) => s.put(rec, chave));
    } catch (e) {
      if (docs.get(chave) === rec) { if (antes) docs.set(chave, antes); else docs.delete(chave); }
      throw erro("unavailable", MSG.local);
    }
    emitirColecao(col);
    avisarAbas([col], false);
    atualizarEstado();
    agendarSync();
  }

  function gravarDoc(col, id, obj) {
    let dados;
    try { dados = copia(obj === undefined ? {} : obj); } catch (e) { return Promise.reject(erro("unavailable", MSG.local)); }
    if (dados === null || typeof dados !== "object") dados = {};
    return escreverLocal(col, id, dados, false);
  }

  function refDoc(col, id) {
    return {
      id, path: col + "/" + id,
      set: (obj) => gravarDoc(col, id, obj),
      delete: () => escreverLocal(col, id, null, true),
      get: async () => { await prontoPromessa; return fotoDoc(col, id); },
      onSnapshot: (next, error) => assinar(ouvintesDoc, chaveDoc(col, id), next, error, () => fotoDoc(col, id))
    };
  }

  function refColecao(col) {
    col = String(col);
    return {
      id: col, path: col,
      doc: (id) => refDoc(col, id === undefined || id === null || id === "" ? novoIdDoc() : String(id)),
      get: async () => { await prontoPromessa; return fotoColecao(col); },
      onSnapshot: (next, error) => assinar(ouvintesCol, col, next, error, () => fotoColecao(col))
    };
  }

  const db = {
    collection: refColecao,
    doc(caminho) {
      const partes = String(caminho).split("/").filter(Boolean);
      return refColecao(partes[0] || "config").doc(partes.slice(1).join("_") || undefined);
    }
  };

  // ---------------------------------------------------------------------------
  // assets (anexos: PDFs e fotos)
  // ---------------------------------------------------------------------------
  function tipoDoArquivo(arquivo, opcoes) {
    let t = String((opcoes && opcoes.type) || (arquivo && arquivo.type) || "").toLowerCase().split(";")[0].trim();
    if (t === "image/jpg" || t === "image/pjpeg") t = "image/jpeg";
    if (!t || t === "application/octet-stream") {
      const m = /\.([a-z0-9]+)$/i.exec((arquivo && arquivo.name) || "");
      t = m ? EXT_TIPO[m[1].toLowerCase()] || "" : "";
    }
    return TIPOS_OK.includes(t) ? t : null;
  }

  async function enviarAnexo(arquivo, opcoes) {
    if (!arquivo || typeof arquivo.size !== "number") throw erro("unsupported_type", "Arquivo inválido.");
    const tipo = tipoDoArquivo(arquivo, opcoes);
    if (!tipo) throw erro("unsupported_type", "Esse tipo de arquivo não é aceito.");
    if (!arquivo.size || arquivo.size > MAX_ANEXO) throw erro("too_large", "O arquivo precisa ter até 20 MB.");
    await prontoPromessa;
    const id = novoIdAnexo();
    const blob = arquivo.type === tipo ? arquivo : new Blob([arquivo], { type: tipo });
    const rec = { id, blob, tipo, nome: String(arquivo.name || "").slice(0, 200), tamanho: arquivo.size, enviado: 0 };
    try { await operar("blobs", "readwrite", (s) => s.put(rec, id)); }
    catch (e) { throw erro("store_unavailable", MSG.local); }
    filaEnvio.add(id);
    atualizarEstado();
    avisarAbas([], true);
    agendarSync();
    return { id, url: "", sizeBytes: arquivo.size, contentType: tipo };
  }

  async function apagarAnexo(id) {
    id = String(id || "");
    if (!ID_OK.test(id)) return { deleted: false };
    await prontoPromessa;
    liberarUrl(id);
    const nuncaEnviado = filaEnvio.has(id) && !meta.anexos[id];
    filaEnvio.delete(id);
    try { await operar("blobs", "readwrite", (s) => s.delete(id)); } catch (e) { /* segue */ }
    // Se já foi para o Drive (ou pode estar indo), manda para a lixeira na próxima sincronização
    if (!nuncaEnviado && !meta.lixeira.includes(id)) await mexerLixeira(null, id);
    atualizarEstado();
    avisarAbas([], true);
    agendarSync();
    return { deleted: true };
  }

  async function listarAnexos() {
    await prontoPromessa;
    let bytes = 0, files = 0;
    try {
      const lista = await operar("blobs", "readonly", (s) => s.getAll());
      for (const b of lista || []) { if (b) { files++; bytes += Number(b.tamanho) || 0; } }
    } catch (e) { /* sem números */ }
    return { assets: [], usage: { bytes, files, maxBytes: 0 } };
  }

  const comTipo = (blob, tipo) => (tipo && blob.type !== tipo ? new Blob([blob], { type: tipo }) : blob);

  // Bytes do anexo: do aparelho, ou baixa do Drive e guarda
  async function pegarBlob(id) {
    id = String(id || "");
    if (!ID_OK.test(id)) throw erro("fetch", "Arquivo não encontrado.");
    await prontoPromessa;
    let rec = null;
    try { rec = await operar("blobs", "readonly", (s) => s.get(id)); } catch (e) { /* tenta o Drive */ }
    if (rec && rec.blob) return comTipo(rec.blob, rec.tipo);
    if (!CONFIGURADO || !tokenValido()) throw erro("fetch", "Este arquivo ainda não está neste aparelho. Conecte o Google Drive.");
    try {
      let resp = null;
      for (let volta = 0; volta < 2 && !resp; volta++) {
        if (!meta.anexos[id] || volta > 0) {
          // não achou há pouco: não lista tudo de novo a cada miniatura
          const quando = faltas.get(id);
          if (quando && agora() - quando < 60000) break;
          await atualizarMapaAnexos();
        }
        const driveId = meta.anexos[id];
        if (!driveId) { faltas.set(id, agora()); break; }
        try {
          resp = await api("GET", "files/" + encodeURIComponent(driveId), { query: { alt: "media" }, resposta: "blob", prazo: prazoPara(MAX_ANEXO) });
        } catch (e) {
          if (e.code !== "nao_encontrado") throw e;
          if (meta.anexos[id] === driveId) { const resto = Object.assign({}, meta.anexos); delete resto[id]; meta.anexos = resto; }
        }
      }
      if (!resp) throw erro("fetch", "Este arquivo ainda não chegou ao Google Drive. Se ele foi adicionado em outro aparelho, abra o app nesse aparelho e toque em Sincronizar; depois tente de novo.");
      faltas.delete(id);
      const bruto = resp.blob;
      const tipo = String(resp.tipo || bruto.type || "").split(";")[0].trim() || "application/octet-stream";
      const blob = comTipo(bruto, tipo);
      try {
        await operar("blobs", "readwrite", (s) => s.put({ id, blob, tipo, nome: "", tamanho: blob.size, enviado: 1 }, id));
      } catch (e) { /* só não fica guardado */ }
      return blob;
    } catch (e) {
      if (e && e.code === "fetch") throw e; // já tem a mensagem certa
      throw erro("fetch", e && e.code === "offline" ? MSG.offline
        : e && (e.code === "login" || e.code === "sem_token") ? "Seu acesso ao Google Drive expirou. Toque em Sincronizar com o Google Drive e abra o arquivo de novo."
        : "Não consegui baixar o arquivo do Drive. Tente de novo daqui a pouco.");
    }
  }

  // URL de objeto por anexo (memorizada)
  const urls = new Map();
  function urlDoBlob(id) {
    id = String(id || "");
    let p = urls.get(id);
    if (!p) {
      p = pegarBlob(id).then((b) => URL.createObjectURL(b));
      urls.set(id, p);
      p.catch(() => { if (urls.get(id) === p) urls.delete(id); });
    }
    return p;
  }
  function liberarUrl(id) {
    const p = urls.get(id);
    if (!p) return;
    urls.delete(id);
    p.then((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ok */ } }, () => {});
  }

  // ---------------------------------------------------------------------------
  // downloads (compartilhar no celular, link no computador)
  // ---------------------------------------------------------------------------
  function tipoPorNome(nome) {
    const ext = (/\.([a-z0-9]+)$/i.exec(nome || "") || [])[1];
    const mapa = { json: "application/json", csv: "text/csv;charset=utf-8", zip: "application/zip", txt: "text/plain;charset=utf-8" };
    return (ext && (mapa[ext.toLowerCase()] || EXT_TIPO[ext.toLowerCase()])) || "application/octet-stream";
  }

  // Compartilhar só no iPhone/iPad, onde o <a download> não funciona bem (no app da tela
  // de início). Android e computador (mesmo instalado ou com tela de toque) baixam com link.
  function ehIOS() {
    const n = G.navigator || {};
    const ua = String(n.userAgent || ""), plat = String(n.platform || "");
    if (/iPad|iPhone|iPod/.test(ua) || /iPad|iPhone|iPod/.test(plat)) return true;
    return (plat === "MacIntel" || /Macintosh/.test(ua)) && n.maxTouchPoints > 1; // iPadOS se diz Mac
  }

  // Aberto pelo ícone da tela de início (app instalado)?
  function instalado() {
    try {
      if (G.navigator && G.navigator.standalone === true) return true;
      return !!(typeof G.matchMedia === "function" && G.matchMedia("(display-mode: standalone)").matches);
    } catch (e) { return false; }
  }

  async function entregarArquivo(nome, dados) {
    nome = String(nome || "arquivo");
    let arquivo;
    try {
      const ehBlob = typeof Blob !== "undefined" && dados instanceof Blob;
      const tipo = ehBlob && dados.type ? dados.type : tipoPorNome(nome);
      arquivo = new File([dados === undefined || dados === null ? "" : dados], nome, { type: tipo });
    } catch (e) { throw erro("request_unknown", "Não consegui preparar o arquivo."); }
    const nav = G.navigator || {};
    let podeCompartilhar = false;
    try {
      podeCompartilhar = typeof nav.share === "function" && typeof nav.canShare === "function" &&
        ehIOS() && nav.canShare({ files: [arquivo] });
    } catch (e) { podeCompartilhar = false; }
    if (podeCompartilhar) {
      try {
        await nav.share({ files: [arquivo], title: nome });
        return { status: "shared" };
      } catch (e) {
        if (e && e.name === "AbortError") throw erro("declined", "Cancelado.");
        if (e && e.name === "NotAllowedError") return folhaCompartilhar(arquivo, nome); // sem gesto: pede um toque
        throw erro("request_unknown", "Não consegui compartilhar o arquivo.");
      }
    }
    try { baixarComLink(arquivo, nome); return { status: "saved" }; }
    catch (e) { throw erro("request_unknown", "Não consegui salvar o arquivo."); }
  }

  function baixarComLink(arquivo, nome) {
    const doc = G.document;
    const url = URL.createObjectURL(arquivo);
    const a = doc.createElement("a");
    a.href = url;
    a.download = nome;
    a.rel = "noopener";
    a.style.display = "none";
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (e) { /* ok */ }
      try { URL.revokeObjectURL(url); } catch (e) { /* ok */ }
    }, 10000);
  }

  function el(tag, classe, texto) {
    const e = G.document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function garantirEstiloFolha() {
    const doc = G.document;
    if (doc.getElementById && doc.getElementById("pf-estilo")) return;
    const st = doc.createElement("style");
    st.id = "pf-estilo";
    st.textContent =
      ".pf-fundo{position:fixed;inset:0;z-index:90;background:var(--scrim,rgba(30,20,40,.5));display:flex;align-items:flex-end;justify-content:center}" +
      ".pf-folha{box-sizing:border-box;width:100%;max-width:520px;background:var(--card,#fff);color:var(--ink,#221a2b);border-radius:20px 20px 0 0;" +
      "padding:20px max(20px,env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px));font:inherit;box-shadow:0 -10px 30px rgba(0,0,0,.18)}" +
      ".pf-titulo{margin:0 0 4px;font-weight:700;font-size:17px}" +
      ".pf-nome{margin:0 0 14px;opacity:.75;font-size:13px;word-break:break-word}" +
      ".pf-botao{display:block;width:100%;min-height:48px;margin-top:8px;border:0;border-radius:14px;font:inherit;font-size:15px;font-weight:600;cursor:pointer}" +
      ".pf-prim{background:var(--accent,#8A3FB5);color:var(--on-accent,#fff)}" +
      ".pf-sec{background:transparent;color:var(--ink,#221a2b)}" +
      "@media (min-width:600px){.pf-fundo{align-items:center}.pf-folha{border-radius:20px}}";
    (doc.head || doc.documentElement).appendChild(st);
  }

  // Folha "Seu arquivo está pronto": o toque no botão dá um gesto novo ao share
  function folhaCompartilhar(arquivo, nome) {
    return new Promise((ok, falha) => {
      const doc = G.document;
      if (!doc || !doc.body) { falha(erro("request_unknown", "Não consegui compartilhar o arquivo.")); return; }
      garantirEstiloFolha();
      const fundo = el("div", "pf-fundo");
      fundo.setAttribute("role", "dialog");
      fundo.setAttribute("aria-modal", "true");
      fundo.setAttribute("aria-label", "Seu arquivo está pronto");
      const folha = el("div", "pf-folha");
      const bSalvar = el("button", "pf-botao pf-prim", "Salvar ou compartilhar");
      const bCancelar = el("button", "pf-botao pf-sec", "Cancelar");
      bSalvar.type = "button"; bCancelar.type = "button";
      bSalvar.setAttribute("data-acao", "compartilhar");
      bCancelar.setAttribute("data-acao", "cancelar");
      folha.appendChild(el("p", "pf-titulo", "Seu arquivo está pronto"));
      folha.appendChild(el("p", "pf-nome", nome));
      folha.appendChild(bSalvar);
      folha.appendChild(bCancelar);
      fundo.appendChild(folha);

      let fim = false;
      const fechar = () => {
        fim = true;
        try { fundo.remove(); } catch (e) { /* ok */ }
        try { doc.removeEventListener("keydown", tecla); } catch (e) { /* ok */ }
      };
      const desistir = () => { if (fim) return; fechar(); falha(erro("declined", "Cancelado.")); };
      const tecla = (ev) => { if (ev && ev.key === "Escape") desistir(); };

      bSalvar.addEventListener("click", () => {
        if (fim) return;
        let p;
        try { p = G.navigator.share({ files: [arquivo], title: nome }); } catch (e) { p = Promise.reject(e); }
        bSalvar.disabled = true;
        Promise.resolve(p).then(() => { fechar(); ok({ status: "shared" }); }, (e) => {
          fechar();
          if (e && e.name === "AbortError") { falha(erro("declined", "Cancelado.")); return; }
          try { baixarComLink(arquivo, nome); ok({ status: "saved" }); }
          catch (e2) { falha(erro("request_unknown", "Não consegui compartilhar o arquivo.")); }
        });
      });
      bCancelar.addEventListener("click", desistir);
      fundo.addEventListener("click", (ev) => { if (ev && ev.target === fundo) desistir(); });
      try { doc.addEventListener("keydown", tecla); } catch (e) { /* ok */ }
      doc.body.appendChild(fundo);
      try { bSalvar.focus(); } catch (e) { /* ok */ }
    });
  }

  // ---------------------------------------------------------------------------
  // Login no Google (token só em memória do navegador: localStorage)
  // ---------------------------------------------------------------------------
  function lerToken() {
    const t = ls.lerJson(CHAVE.token);
    return t && typeof t.access_token === "string" && typeof t.expira === "number" ? t : null;
  }
  function lerMetodo() {
    const m = ls.ler(CHAVE.metodo);
    if (!GIS_SRC) return "redirecionar";
    return m === "janela" || m === "redirecionar" ? m : "janela";
  }
  // Considera vencido 2 min antes
  const tokenValido = () => !!token && token.expira - 120000 > agora();
  const escopoOk = (s) => String(s || "").split(/[\s,]+/).includes(ESCOPO);

  function guardarToken(acesso, expiraEmSeg, escopo) {
    const seg = Number(expiraEmSeg) > 0 ? Number(expiraEmSeg) : 3600;
    token = { access_token: acesso, expira: agora() + seg * 1000, scope: escopo || ESCOPO };
    ls.gravar(CHAVE.token, token);
  }
  function descartarToken() { token = null; ls.apagar(CHAVE.token); }

  // Volta do login por redirecionamento: lê o #access_token antes do app rodar
  function lerRetornoLogin() {
    const loc = G.location;
    if (!loc || typeof loc.hash !== "string" || loc.hash.length < 2) return;
    let p;
    try { p = new URLSearchParams(loc.hash.slice(1)); } catch (e) { return; }
    const acesso = p.get("access_token"), falhou = p.get("error");
    if (!acesso && !falhou) return;
    const esperado = ls.ler(CHAVE.state), recebido = p.get("state");
    if (acesso) {
      if (token && token.access_token === acesso) {
        // chegou de novo (iOS): já guardado
      } else if (!esperado || recebido !== esperado) {
        // iPhone: o login saiu do app da tela de início e voltou no Safari (outro armazenamento)
        erroAtual = erro("login", !esperado && ehIOS() && !instalado() ? MSG.loginNoSafari : MSG.loginFalhou);
      } else if (!escopoOk(p.get("scope"))) {
        erroAtual = erro("login", MSG.escopo);
      } else {
        guardarToken(acesso, p.get("expires_in"), p.get("scope"));
        precisaPerfil = true;
        erroAtual = null;
      }
    } else {
      erroAtual = erro("login", falhou === "access_denied" ? MSG.loginNegado : MSG.loginFalhou);
    }
    limparHash(loc);
  }

  function limparHash(loc) {
    try { G.history.replaceState(G.history.state, "", loc.pathname + loc.search); }
    catch (e) { try { loc.hash = ""; } catch (e2) { /* ok */ } }
  }

  function carregarGis() {
    try {
      if (!CONFIGURADO || !GIS_SRC || metodo !== "janela" || !G.document) return;
      if (G.google && G.google.accounts && G.google.accounts.oauth2) return;
      if (G.document.getElementById && G.document.getElementById("pf-gis")) return;
      const s = G.document.createElement("script");
      s.id = "pf-gis";
      s.src = GIS_SRC;
      s.async = true;
      // não carregou (abriu sem internet): tira o elemento para tentar de novo depois
      s.onerror = () => { try { s.remove(); } catch (e) { /* ok */ } };
      (G.document.head || G.document.documentElement).appendChild(s);
    } catch (e) { /* sem GIS: usa redirecionamento */ }
  }

  // Precisa ser chamado direto no clique (a janela do Google precisa do gesto)
  function conectar() {
    if (!CONFIGURADO) return Promise.reject(erro("nao_configurado", "Falta configurar o acesso ao Google."));
    const oauth2 = G.google && G.google.accounts && G.google.accounts.oauth2;
    if (metodo === "janela" && oauth2 && typeof oauth2.initTokenClient === "function") return conectarJanela(oauth2);
    if (metodo === "janela" && GIS_SRC) {
      carregarGis();
      // iPhone instalado: redirecionar pode jogar o login para o Safari; espera o GIS
      if (ehIOS() && instalado()) return Promise.reject(erro("login", MSG.gisCarregando));
    }
    return conectarRedirecionando();
  }

  function conectarJanela(oauth2) {
    return new Promise((ok, falha) => {
      const conta = ls.ler(CHAVE.conta);
      const config = {
        client_id: CLIENT_ID,
        scope: ESCOPO,
        prompt: conta ? "" : "consent",
        callback: (resp) => {
          if (!resp || resp.error || !resp.access_token) { falha(erro("login", MSG.loginFalhou)); return; }
          if (!escopoOk(resp.scope)) { erroAtual = erro("login", MSG.escopo); atualizarEstado(); falha(erroAtual); return; }
          guardarToken(resp.access_token, resp.expires_in, resp.scope);
          precisaPerfil = true;
          erroAtual = null;
          atualizarEstado();
          buscarPerfil().catch(() => {}).then(() => { sincronizar(); ok(); });
        },
        error_callback: (e) => {
          const tipo = e && e.type;
          if (tipo === "popup_failed_to_open") {
            // janela bloqueada: passa a usar redirecionamento
            definirMetodo("redirecionar");
            conectarRedirecionando().then(ok, falha);
          } else if (tipo === "popup_closed") {
            falha(erro("cancelado", "Login cancelado."));
          } else {
            falha(erro("login", MSG.loginFalhou));
          }
        }
      };
      if (conta) config.login_hint = conta;
      try {
        oauth2.initTokenClient(config).requestAccessToken();
      } catch (e) {
        conectarRedirecionando().then(ok, falha);
      }
    });
  }

  function conectarRedirecionando() {
    const loc = G.location;
    const state = aleatorio(24, ALFA_NUM);
    ls.gravar(CHAVE.state, state);
    const conta = ls.ler(CHAVE.conta);
    const p = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: loc.origin + loc.pathname,
      response_type: "token",
      scope: ESCOPO,
      include_granted_scopes: "true",
      state
    });
    if (conta) p.set("login_hint", conta);
    else p.set("prompt", "consent"); // só na primeira vez
    const url = AUTH_URL + (AUTH_URL.includes("?") ? "&" : "?") + p.toString();
    try { loc.assign(url); } catch (e) { return Promise.reject(erro("login", MSG.loginFalhou)); }
    return Promise.resolve();
  }

  async function buscarPerfil() {
    const r = await api("GET", "about", { query: { fields: "user(emailAddress,displayName)" } });
    const u = (r && r.user) || {};
    if (u.emailAddress) ls.gravar(CHAVE.conta, String(u.emailAddress));
    if (u.displayName) ls.gravar(CHAVE.nome, String(u.displayName));
    precisaPerfil = false;
    ls.apagar(CHAVE.state); // o token já foi usado
    atualizarEstado();
  }

  // Só esquece o login neste aparelho. Não revoga no Google: o revoke tira a
  // autorização do app em todos os aparelhos e pode fazer o drive.file perder o
  // acesso aos arquivos antigos. O token vence sozinho em menos de 1 h.
  // (Para tirar o acesso de vez: myaccount.google.com/permissions.)
  async function desconectar() {
    descartarToken();
    ls.apagar(CHAVE.conta);
    ls.apagar(CHAVE.nome);
    ls.apagar(CHAVE.state);
    // esquece o que é da conta; os dados locais ficam
    meta.pastas = {}; meta.md5 = {}; meta.anexos = {}; meta.ultimoPull = null; meta.ignorados = [];
    mapaConferido = false; pastasConferidas = false; faltas.clear(); anexosNaLixeira.clear();
    salvarMeta("pastas", "md5", "anexos", "ultimoPull", "ignorados").catch(() => {});
    erroAtual = null;
    atualizarEstado();
  }

  function definirMetodo(m) {
    if (m !== "janela" && m !== "redirecionar") return;
    if (m === "janela" && !GIS_SRC) return; // sem GIS configurado
    metodo = m;
    ls.gravar(CHAVE.metodo, m);
    carregarGis();
    atualizarEstado();
  }

  // Perdeu o login (401): para tudo e pede login
  function aoPerderLogin() {
    descartarToken();
    erroAtual = erro("login", MSG.login);
    atualizarEstado();
  }

  // ---------------------------------------------------------------------------
  // Chamadas à API do Drive (com backoff para erros temporários)
  // ---------------------------------------------------------------------------
  function montarQuery(q) {
    if (!q) return "";
    const p = new URLSearchParams();
    for (const k of Object.keys(q)) {
      const v = q[k];
      if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    }
    const s = p.toString();
    return s ? "?" + s : "";
  }

  async function lerErro(resp) {
    try {
      const j = JSON.parse(await resp.text());
      const e = (j && j.error) || {};
      const motivo = (Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || e.status || "";
      return { motivo: String(motivo), mensagem: String(e.message || "") };
    } catch (e) { return { motivo: "", mensagem: "" }; }
  }

  async function lerJson(resp) {
    const t = await resp.text();
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  // Roda fn(signal) com prazo: estourou -> aborta e vira "offline" (rede travada)
  async function comPrazo(prazo, fn) {
    const ctl = typeof G.AbortController === "function" ? new G.AbortController() : null;
    let relogioPrazo = null;
    const estouro = new Promise((_, falha) => {
      relogioPrazo = setTimeout(() => {
        try { if (ctl) ctl.abort(); } catch (e) { /* ok */ }
        falha(erro("offline", MSG.offline));
      }, prazo);
    });
    try { return await Promise.race([fn(ctl ? ctl.signal : undefined), estouro]); }
    finally { clearTimeout(relogioPrazo); }
  }

  const tamanhoCorpo = (c) => (c && typeof c.size === "number" ? c.size : typeof c === "string" ? c.length : 0);

  // op: {query, json, corpo, cabecalhos, upload, url, prazo, resposta: "json"|"texto"|"blob"|"bruta"}
  async function api(metodoHttp, caminho, op) {
    op = op || {};
    for (let tentativa = 1; ; tentativa++) {
      if (!token) throw erro("sem_token", "Sem login.");
      const url = op.url || (API + (op.upload ? "/upload/drive/v3/" : "/drive/v3/") + caminho + montarQuery(op.query));
      const cab = Object.assign({ Authorization: "Bearer " + token.access_token }, op.cabecalhos || {});
      let corpo = op.corpo;
      if (op.json !== undefined) { corpo = JSON.stringify(op.json); cab["Content-Type"] = "application/json; charset=UTF-8"; }
      const prazo = op.prazo || prazoPara(tamanhoCorpo(corpo));
      // pedido e leitura do corpo dentro do prazo
      const r = await comPrazo(prazo, async (signal) => {
        let resp;
        try {
          resp = await G.fetch(url, { method: metodoHttp, headers: cab, body: corpo, signal });
        } catch (e) {
          throw erro("offline", MSG.offline);
        }
        if (!resp.ok) return { resp, info: await lerErro(resp) };
        try {
          if (op.resposta === "bruta") return { valor: resp };
          if (op.resposta === "texto") return { valor: await resp.text() };
          if (op.resposta === "blob") return { valor: { blob: await resp.blob(), tipo: resp.headers.get("content-type") || "" } };
          return { valor: await lerJson(resp) };
        } catch (e) { throw erro("offline", MSG.offline); }
      });
      if (!r.resp) return r.valor;
      const resp = r.resp, info = r.info;
      const st = resp.status;
      if (st === 401) { aoPerderLogin(); throw erro("login", MSG.login); }
      if (st === 404) throw erro("nao_encontrado", "Arquivo não encontrado no Drive.", { status: 404 });
      // drive.file: arquivo criado por outro client id -> o app não enxerga; trata como sumido
      if (st === 403 && info.motivo === "appNotAuthorizedToFile") throw erro("nao_encontrado", "Arquivo não encontrado no Drive.", { status: 403 });
      if (st === 403 && info.motivo === "storageQuotaExceeded") throw erro("cota", MSG.cota);
      const temporario = st === 429 || st >= 500 ||
        (st === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/.test(info.motivo));
      if (temporario && tentativa < 3) {
        await esperar(BASE_ESPERA * Math.pow(2, tentativa) + Math.random() * BASE_ESPERA);
        continue;
      }
      // a Google Drive API não foi ativada no projeto (ou ainda não liberou)
      if (st === 403 && /accessNotConfigured|SERVICE_DISABLED|API has not been used in project/.test(String(info.motivo || "") + " " + String(info.mensagem || ""))) {
        throw erro("drive", MSG.apiDesativada, { status: 403, detalhe: info.mensagem });
      }
      if (st === 403) throw erro("sem_permissao", MSG.sem_permissao, { detalhe: info.mensagem });
      throw erro("drive", MSG.drive, { status: st, detalhe: info.mensagem });
    }
  }

  async function listarTudo(q, campos) {
    const saida = [];
    let pagina;
    do {
      const r = await api("GET", "files", {
        query: { q, fields: "nextPageToken,files(" + campos + ")", pageSize: "1000", pageToken: pagina, spaces: "drive" }
      });
      if (r && Array.isArray(r.files)) saida.push(...r.files);
      pagina = r && r.nextPageToken;
    } while (pagina);
    return saida;
  }

  // Cria um arquivo com bytes: multipart até 5 MB, resumable acima
  async function criarArquivo(info, blob) {
    const metadados = { name: info.nome, mimeType: info.tipo, parents: info.pais, appProperties: info.props };
    try {
      if (blob.size <= LIMITE_MULTIPART) {
        const f = "prontuario_" + aleatorio(16, ALFA_NUM);
        const corpo = new Blob([
          "--" + f + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadados) +
          "\r\n--" + f + "\r\nContent-Type: " + info.tipo + "\r\n\r\n",
          blob,
          "\r\n--" + f + "--"
        ]);
        return await api("POST", "files", {
          upload: true, query: { uploadType: "multipart", fields: "id,md5Checksum" },
          corpo, cabecalhos: { "Content-Type": "multipart/related; boundary=" + f }
        });
      }
      const inicio = await api("POST", "files", {
        upload: true, query: { uploadType: "resumable", fields: "id,md5Checksum" }, json: metadados,
        cabecalhos: { "X-Upload-Content-Type": info.tipo, "X-Upload-Content-Length": String(blob.size) },
        resposta: "bruta"
      });
      const sessao = inicio.headers.get("location");
      if (!sessao) throw erro("drive", "O Google Drive não aceitou o envio do arquivo.");
      return await api("PUT", null, { url: sessao, corpo: blob, cabecalhos: { "Content-Type": info.tipo } });
    } catch (e) {
      if (e && e.code === "nao_encontrado") {
        // a pasta sumiu: procura de novo na próxima sincronização
        meta.pastas = {};
        pastasConferidas = false;
        salvarMeta("pastas").catch(() => {});
        throw erro("drive", "A pasta do app no Drive sumiu. Vou criar de novo.");
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Pastas no Drive
  // ---------------------------------------------------------------------------
  const porIdade = (a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Uma busca de pastas por vez (sincronização e backup juntos não duplicam pastas)
  let buscandoPastas = null;
  function garantirPastas() {
    if (!buscandoPastas) buscandoPastas = garantirPastasAgora().finally(() => { buscandoPastas = null; });
    return buscandoPastas;
  }

  // A pasta existe e não está na lixeira? (lixeira da raiz também marca as filhas)
  async function pastaViva(id) {
    if (!id) return false;
    try {
      const f = await api("GET", "files/" + encodeURIComponent(id), { query: { fields: "id,trashed" } });
      return !!f && !f.trashed;
    } catch (e) {
      if (e.code === "nao_encontrado") return false;
      throw e;
    }
  }

  // Confere "dados" e "anexos" (uma de cada vez: um 401 para na primeira).
  // "backups" é conferida só no salvarArquivo.
  async function garantirPastasAgora() {
    const p = meta.pastas || {};
    if (p.raiz && p.dados && p.anexos && p.backups && await pastaViva(p.dados) && await pastaViva(p.anexos)) {
      if (!pastasConferidas) return conferirPastas(p);
      return p;
    }
    return procurarPastas();
  }

  const PASTAS_Q = "mimeType='" + PASTA_MIME + "' and appProperties has {key='app' and value='prontuario'} and trashed=false";
  const papelDe = (f) => (f.appProperties && f.appProperties.papel) || "";

  // Uma vez por sessão, com o cache válido: passa para as pastas mais antigas (as que
  // um aparelho novo escolheria). Só lê: nunca cria pasta a partir desta busca (o
  // índice do Drive pode estar atrasado); se faltar alguma, fica com o cache.
  async function conferirPastas(p) {
    const todas = await listarTudo(PASTAS_Q, "id,name,parents,appProperties,createdTime");
    pastasConferidas = true;
    const r = todas.filter((f) => papelDe(f) === "raiz").sort(porIdade)[0];
    if (!r) return p;
    const novo = { raiz: r.id };
    for (const nome of ["dados", "anexos", "backups"]) {
      const achada = todas.filter((f) => papelDe(f) === nome && (f.parents || []).includes(r.id)).sort(porIdade)[0];
      if (!achada) return p;
      novo[nome] = achada.id;
    }
    if (["raiz", "dados", "anexos", "backups"].every((k) => novo[k] === p[k])) return p;
    meta.pastas = novo;
    pastasMudaram = true; // confere o mapa de anexos
    await salvarMeta("pastas");
    return novo;
  }

  async function procurarPastas() {
    const todas = await listarTudo(PASTAS_Q, "id,name,parents,appProperties,createdTime");
    const papel = papelDe;
    const raizes = todas.filter((f) => papel(f) === "raiz").sort(porIdade);
    const raiz = raizes.length ? raizes[0].id : (await criarPasta(NOME_PASTA, null, "raiz")).id;
    const novo = { raiz };
    for (const nome of ["dados", "anexos", "backups"]) {
      const achada = todas.filter((f) => papel(f) === nome && (f.parents || []).includes(raiz)).sort(porIdade)[0];
      novo[nome] = achada ? achada.id : (await criarPasta(nome, raiz, nome)).id;
    }
    meta.pastas = novo;
    pastasMudaram = true; // confere o mapa de anexos (podem estar na lixeira)
    await salvarMeta("pastas");
    return novo;
  }

  async function criarPasta(nome, pai, papel) {
    const r = await api("POST", "files", {
      query: { fields: "id,createdTime" },
      json: { name: nome, mimeType: PASTA_MIME, parents: pai ? [pai] : undefined, appProperties: { app: "prontuario", papel } }
    });
    if (!r || !r.id) throw erro("drive", "Não consegui criar a pasta no Drive.");
    return r;
  }

  // ---------------------------------------------------------------------------
  // Sincronização das coleções (um JSON por coleção, mescla por documento)
  // ---------------------------------------------------------------------------
  // Em qualquer pasta do app (não só na "dados" deste aparelho): aparelhos que ficaram
  // com pastas diferentes (raiz restaurada da lixeira, pasta movida, duas primeiras
  // conexões juntas) acabam usando o mesmo arquivo, o mais antigo de cada coleção.
  // Só os JSON de coleção têm appProperties.col (anexos têm aid, backups papel=backup).
  async function listarArquivosDados() {
    const lista = await listarTudo("appProperties has {key='app' and value='prontuario'} and trashed=false", "id,name,md5Checksum,appProperties,createdTime,mimeType");
    const porCol = {};
    for (const f of lista) {
      const ap = f.appProperties || {};
      if (ap.papel === "estragado" || meta.ignorados.includes(f.id) || f.mimeType === PASTA_MIME) continue;
      const col = ap.col;
      if (!col) continue;
      (porCol[col] = porCol[col] || []).push(f);
    }
    for (const c of Object.keys(porCol)) porCol[c].sort(porIdade);
    return porCol;
  }

  // Aceita qualquer id não vazio: o mesmo conjunto que db.collection().doc(id) aceita ao gravar
  function docRemotoValido(id, r) {
    if (typeof id !== "string" || !id || !r || typeof r !== "object" || !Number.isFinite(r.atualizado)) return false;
    return !!r.apagado || (!!r.dados && typeof r.dados === "object");
  }

  // Junta os docs remotos na memória. ehPrincipal: o arquivo oficial da coleção
  // (docs locais ausentes dele ficam "sujos" e são enviados de novo).
  async function mesclarRemoto(col, remotos, ehPrincipal) {
    const gravar = [];
    const vistos = new Set();
    let visivel = false;
    for (const id of Object.keys(remotos || {})) {
      const r = remotos[id];
      if (!docRemotoValido(id, r)) continue;
      vistos.add(id);
      const chave = chaveDoc(col, id), local = docs.get(chave);
      const remoto = {
        col, id, dados: r.apagado ? null : r.dados, atualizado: r.atualizado,
        apagado: !!r.apagado, dispositivo: String(r.dispositivo || ""), sujo: ehPrincipal ? 0 : 1
      };
      // semBase: o aparelho escreveu sem nunca ter baixado do Drive; o Drive vence
      if (!local || local.semBase || ganha(remoto, local)) {
        if (mudouVisivel(local, remoto)) visivel = true;
        docs.set(chave, remoto);
        gravar.push(remoto);
      } else if (mesmaVersao(local, remoto)) {
        if (ehPrincipal && local.sujo) { const limpo = Object.assign({}, local, { sujo: 0 }); docs.set(chave, limpo); gravar.push(limpo); }
      } else if (!local.sujo) {
        // o local é mais novo que o do Drive: precisa subir
        const s = Object.assign({}, local, { sujo: 1 }); docs.set(chave, s); gravar.push(s);
      }
    }
    if (ehPrincipal) {
      for (const local of docsDaColecao(col)) {
        if (vistos.has(local.id) || local.sujo) continue;
        // sumiu do Drive (corrida perdida): envia de novo
        const s = Object.assign({}, local, { sujo: 1 });
        docs.set(chaveDoc(col, local.id), s);
        gravar.push(s);
      }
    }
    await gravarDocs(gravar);
    return visivel;
  }

  async function baixarColecao(col, arquivo) {
    let texto;
    try {
      texto = await api("GET", "files/" + encodeURIComponent(arquivo.id), { query: { alt: "media" }, resposta: "texto" });
    } catch (e) {
      if (e.code === "nao_encontrado") return null;
      throw e;
    }
    let obj = null;
    try { obj = JSON.parse(texto); } catch (e) { obj = null; }
    if (!obj || typeof obj !== "object" || !obj.docs || typeof obj.docs !== "object") {
      await marcarEstragado(col, arquivo);
      return null;
    }
    return obj;
  }

  // Arquivo ilegível: renomeia (fica guardado para conferir) e recria
  async function marcarEstragado(col, arquivo) {
    const dia = new Date(agora()).toISOString().slice(0, 10);
    try {
      await api("PATCH", "files/" + encodeURIComponent(arquivo.id), {
        query: { fields: "id" },
        json: { name: col + " (estragado " + dia + ").json", appProperties: { col: null, papel: "estragado" } }
      });
    } catch (e) {
      if (e.code === "login" || e.code === "offline") throw e;
      // não deu para renomear: deixa de usar este arquivo (senão vira o principal de novo)
      if (!meta.ignorados.includes(arquivo.id)) {
        meta.ignorados = meta.ignorados.concat([arquivo.id]);
        await salvarMeta("ignorados").catch(() => {});
      }
    }
  }

  function montarArquivo(col) {
    const saida = { app: "prontuario", schema: 1, col, docs: Object.create(null) }; // sem protótipo: qualquer id vira chave
    const versoes = [];
    for (const r of docsDaColecao(col)) {
      saida.docs[r.id] = { atualizado: r.atualizado, apagado: !!r.apagado, dispositivo: r.dispositivo, dados: r.apagado ? null : r.dados };
      versoes.push(r);
    }
    return { texto: JSON.stringify(saida), versoes };
  }

  // Limpa "sujo" só dos docs que não mudaram durante o envio
  async function limparSujos(versoes) {
    const gravar = [];
    for (const v of versoes) {
      const chave = chaveDoc(v.col, v.id), atual = docs.get(chave);
      if (atual && atual.sujo && mesmaVersao(atual, v)) {
        const limpo = Object.assign({}, atual, { sujo: 0 });
        docs.set(chave, limpo);
        gravar.push(limpo);
      }
    }
    await gravarDocs(gravar);
  }

  const temSujos = (col) => docsDaColecao(col).some((r) => r.sujo);

  // Depois do primeiro pull completo, o que foi gravado antes passa a valer normalmente.
  // Com col: só daquela coleção (já foi mesclada com o Drive e enviada).
  async function limparSemBase(col) {
    const gravar = [];
    for (const [chave, r] of docs) {
      if (!r.semBase || (col && r.col !== col)) continue;
      const limpo = Object.assign({}, r);
      delete limpo.semBase;
      docs.set(chave, limpo);
      gravar.push(limpo);
    }
    await gravarDocs(gravar);
  }

  async function sincronizarColecao(col, lista, dadosId) {
    let principal = lista[0] || null;
    const extras = lista.slice(1);
    let mudou = false;

    // 1) Baixa se o arquivo do Drive mudou (ou se há gravações ainda sem base do Drive)
    if (principal && (principal.md5Checksum !== meta.md5[col] || docsDaColecao(col).some((r) => r.semBase))) {
      const r = await baixarColecao(col, principal);
      if (r) { mudou = (await mesclarRemoto(col, r.docs, true)) || mudou; meta.md5[col] = principal.md5Checksum; }
      else principal = null;
    }
    if (!principal) mudou = (await mesclarRemoto(col, {}, true)) || mudou;

    // 2) Arquivos duplicados (dois aparelhos criaram juntos): junta tudo
    for (const x of extras) {
      const r = await baixarColecao(col, x);
      if (r) mudou = (await mesclarRemoto(col, r.docs, false)) || mudou;
    }
    if (mudou) emitirColecao(col);

    // 3) Envia se houver mudanças locais
    if (temSujos(col)) {
      if (principal) {
        // confere de novo logo antes de gravar
        let atual = null;
        try {
          atual = await api("GET", "files/" + encodeURIComponent(principal.id), { query: { fields: "id,md5Checksum,trashed" } });
        } catch (e) { if (e.code !== "nao_encontrado") throw e; }
        if (!atual || atual.trashed) {
          principal = null;
          if (await mesclarRemoto(col, {}, true)) emitirColecao(col);
        } else if (atual.md5Checksum !== meta.md5[col]) {
          const r = await baixarColecao(col, principal);
          if (r) {
            if (await mesclarRemoto(col, r.docs, true)) emitirColecao(col);
            meta.md5[col] = atual.md5Checksum;
          } else {
            principal = null;
          }
        }
      }
      const { texto, versoes } = montarArquivo(col);
      let resp;
      if (principal) {
        resp = await api("PATCH", "files/" + encodeURIComponent(principal.id), {
          upload: true, query: { uploadType: "media", fields: "id,md5Checksum" },
          corpo: texto, cabecalhos: { "Content-Type": "application/json; charset=UTF-8" }
        });
      } else {
        resp = await criarArquivo(
          { nome: col + ".json", tipo: "application/json", pais: [dadosId], props: { app: "prontuario", col } },
          new Blob([texto], { type: "application/json" })
        );
      }
      meta.md5[col] = (resp && resp.md5Checksum) || null;
      await salvarMeta("md5");
      await limparSujos(versoes);
    } else {
      await salvarMeta("md5");
    }

    // a coleção já foi mesclada com o Drive (e enviada): o que foi gravado antes passa a
    // valer normalmente, mesmo que outra coleção falhe nesta rodada
    await limparSemBase(col);

    // 4) Duplicados vão para a lixeira (o principal já tem tudo)
    if (!temSujos(col)) {
      for (const x of extras) {
        try { await api("PATCH", "files/" + encodeURIComponent(x.id), { query: { fields: "id" }, json: { trashed: true } }); }
        catch (e) { if (e.code !== "nao_encontrado") throw e; }
      }
    }
    return mudou;
  }

  // ---------------------------------------------------------------------------
  // Anexos: fila de envio e lixeira
  // ---------------------------------------------------------------------------
  // Uma listagem por vez, compartilhada (várias miniaturas não listam juntas)
  let mapaEmCurso = null;
  function atualizarMapaAnexos() {
    if (!mapaEmCurso) mapaEmCurso = atualizarMapaAgora().finally(() => { mapaEmCurso = null; });
    return mapaEmCurso;
  }

  // Junta a busca ao mapa que já existe. A busca inclui a lixeira (anexos lá ficam
  // anotados para a sincronização decidir). A busca do Drive pode atrasar: quem sumiu
  // dela é conferido pelo id (404 sai do mapa).
  async function atualizarMapaAgora() {
    const lista = await listarTudo("appProperties has {key='app' and value='prontuario'}", "id,appProperties,trashed,parents");
    const achados = {}, lixo = {};
    for (const f of lista) {
      const aid = f.appProperties && f.appProperties.aid;
      if (!aid) continue;
      if (f.trashed) { if (!lixo[aid]) lixo[aid] = f; }
      else if (!achados[aid]) achados[aid] = f.id;
    }
    for (const aid of Object.keys(lixo)) if (!achados[aid]) anexosNaLixeira.set(aid, lixo[aid]);
    const sairam = {};
    for (const aid of Object.keys(meta.anexos)) {
      if (achados[aid]) { anexosNaLixeira.delete(aid); continue; }
      if (lixo[aid] && lixo[aid].id === meta.anexos[aid]) continue; // já anotado
      const driveId = meta.anexos[aid];
      let f = null;
      try { f = await api("GET", "files/" + encodeURIComponent(driveId), { query: { fields: "id,trashed,parents" } }); }
      catch (e) { if (e.code !== "nao_encontrado") throw e; }
      if (!f) { sairam[aid] = driveId; anexosNaLixeira.delete(aid); }
      else if (f.trashed) anexosNaLixeira.set(aid, f);
      else anexosNaLixeira.delete(aid);
    }
    const mapa = Object.assign({}, meta.anexos, achados);
    for (const aid of Object.keys(sairam)) if (mapa[aid] === sairam[aid]) delete mapa[aid];
    meta.anexos = mapa;
    mapaFresco = true;
    await salvarMeta("anexos");
  }

  // Ids de anexo citados por algum registro vivo (ids de 22 caracteres aleatórios)
  function textoDosRegistros() {
    const partes = [];
    for (const r of docs.values()) if (!r.apagado && r.dados) partes.push(JSON.stringify(r.dados));
    return partes.join("\n");
  }

  // Depois de conferir o mapa: anexo citado que foi para a lixeira volta para a pasta
  // "anexos"; anexo citado que não está mais no Drive é enviado de novo do aparelho.
  async function reconciliarAnexos(pastas) {
    const texto = textoDosRegistros();
    const citado = (aid) => texto.includes(aid);
    let mexeu = false;
    for (const [aid, f] of Array.from(anexosNaLixeira)) {
      anexosNaLixeira.delete(aid);
      const noMapa = meta.anexos[aid];
      if (noMapa && noMapa !== f.id) continue; // há outra cópia fora da lixeira
      if (citado(aid) && await tirarDaLixeira(f, pastas.anexos)) {
        meta.anexos = Object.assign({}, meta.anexos, { [aid]: f.id });
        mexeu = true;
        continue;
      }
      if (noMapa) {
        // apagado de propósito (não citado) ou não deu para tirar da lixeira
        const resto = Object.assign({}, meta.anexos);
        delete resto[aid];
        meta.anexos = resto;
        mexeu = true;
      }
    }
    if (mexeu) await salvarMeta("anexos");
    let blobs = [];
    try { blobs = (await operar("blobs", "readonly", (s) => s.getAll())) || []; } catch (e) { blobs = []; }
    for (const b of blobs) {
      if (!b || !b.id || !b.blob || !b.enviado || meta.anexos[b.id] || !citado(b.id)) continue;
      try { await operar("blobs", "readwrite", (s) => s.put(Object.assign({}, b, { enviado: 0 }), b.id)); } catch (e) { /* segue na memória */ }
      filaEnvio.add(b.id);
    }
  }

  async function tirarDaLixeira(f, destino) {
    if (!destino) return false;
    try {
      await api("PATCH", "files/" + encodeURIComponent(f.id), {
        query: { fields: "id", addParents: destino, removeParents: (f.parents || []).filter((p) => p !== destino).join(",") },
        json: { trashed: false }
      });
      return true;
    } catch (e) {
      if (e.code === "login" || e.code === "offline") throw e;
      return false;
    }
  }

  async function marcarEnviado(aid, rec) {
    if (rec && !rec.enviado) {
      const novo = Object.assign({}, rec, { enviado: 1 });
      await operar("blobs", "readwrite", (s) => s.put(novo, aid));
    }
    filaEnvio.delete(aid);
    atualizarEstado();
  }

  const lerBlobRec = (aid) => operar("blobs", "readonly", (s) => s.get(aid)).catch(() => null);

  async function enviarAnexosPendentes(pastas) {
    if (!filaEnvio.size) return false;
    if (!mapaFresco) await atualizarMapaAnexos();
    for (const aid of Array.from(filaEnvio)) {
      const rec = await lerBlobRec(aid);
      if (!rec || !rec.blob) { filaEnvio.delete(aid); continue; }
      if (meta.anexos[aid]) { await marcarEnviado(aid, rec); continue; } // já está no Drive
      const nome = rec.nome || ("anexo-" + aid + (TIPO_EXT[rec.tipo] || ""));
      const r = await criarArquivo({ nome, tipo: rec.tipo, pais: [pastas.anexos], props: { app: "prontuario", aid } }, rec.blob);
      if (!r || !r.id) throw erro("drive", "O Google Drive não aceitou o envio do arquivo.");
      meta.anexos = Object.assign({}, meta.anexos, { [aid]: r.id });
      await salvarMeta("anexos");
      const ainda = await lerBlobRec(aid);
      if (!ainda) {
        // foi apagado enquanto subia
        filaEnvio.delete(aid);
        if (!meta.lixeira.includes(aid)) await mexerLixeira(null, aid);
        continue;
      }
      await marcarEnviado(aid, ainda);
    }
    return true;
  }

  async function esvaziarLixeira() {
    if (!meta.lixeira.length) return false;
    if (!mapaFresco && meta.lixeira.some((aid) => !meta.anexos[aid])) await atualizarMapaAnexos();
    const texto = textoDosRegistros();
    for (const aid of Array.from(meta.lixeira)) {
      // a versão que venceu a mescla (de outro aparelho) ainda cita o anexo: fica no Drive
      if (texto.includes(aid)) { await mexerLixeira(aid, null); atualizarEstado(); continue; }
      const driveId = meta.anexos[aid];
      if (driveId) {
        try { await api("PATCH", "files/" + encodeURIComponent(driveId), { query: { fields: "id" }, json: { trashed: true } }); }
        catch (e) { if (e.code !== "nao_encontrado") throw e; }
      }
      const resto = Object.assign({}, meta.anexos);
      delete resto[aid];
      meta.anexos = resto;
      anexosNaLixeira.delete(aid);
      await salvarMeta("anexos");
      await mexerLixeira(aid, null);
      atualizarEstado();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Motor: uma sincronização por vez
  // ---------------------------------------------------------------------------
  let rodada = null, deNovo = false, esperandoProxima = [];

  function sincronizar() {
    if (rodada) {
      deNovo = true;
      return new Promise((ok) => esperandoProxima.push(ok));
    }
    rodada = (async () => {
      do {
        deNovo = false;
        const fila = esperandoProxima;
        esperandoProxima = [];
        try { await comTrava(umaSincronizacao); } catch (e) { avisarConsole("falha inesperada", e); }
        fila.forEach((ok) => ok());
      } while (deNovo || esperandoProxima.length);
    })().finally(() => {
      rodada = null;
      if (esperandoProxima.length) {
        const fila = esperandoProxima;
        esperandoProxima = [];
        sincronizar().then(() => fila.forEach((ok) => ok()));
      }
    });
    return rodada;
  }

  // Trava entre abas quando o navegador tem Web Locks
  function comTrava(fn) {
    const locks = G.navigator && G.navigator.locks;
    if (locks && typeof locks.request === "function") return locks.request("prontuario-sync", () => fn());
    return fn();
  }

  function traduzirErro(e) {
    const code = e && e.code;
    if (code === "sem_token") return null;
    if (code === "offline" || code === "cota" || code === "sem_permissao" || code === "login") return erro(code, e.mensagem || MSG[code]);
    if (code === "drive") return erro("drive", e.mensagem || MSG.drive);
    return erro("drive", MSG.drive);
  }

  async function umaSincronizacao() {
    await prontoPromessa;
    if (!CONFIGURADO) { resolverPrimeiroPull(); return; }
    token = lerToken() || token;
    if (!tokenValido()) {
      if (token) descartarToken();
      resolverPrimeiroPull();
      atualizarEstado();
      return;
    }
    if (G.navigator && G.navigator.onLine === false) {
      erroAtual = erro("offline", MSG.offline);
      resolverPrimeiroPull();
      atualizarEstado();
      return;
    }
    ultimaTentativa = agora();
    sincronizando = true;
    mapaFresco = false;
    atualizarEstado();
    const colsMudadas = new Set();
    let blobsMexidos = false;
    try {
      if (precisaPerfil || !ls.ler(CHAVE.conta)) await buscarPerfil();
      const pastas = await garantirPastas();
      const arquivos = await listarArquivosDados();
      const cols = new Set(COLECOES);
      for (const r of docs.values()) cols.add(r.col);
      for (const c of Object.keys(arquivos)) cols.add(c);
      for (const col of cols) {
        if (await sincronizarColecao(col, arquivos[col] || [], pastas.dados)) colsMudadas.add(col);
      }
      meta.ultimoPull = agora();
      await salvarMeta("ultimoPull");
      await limparSemBase();
      resolverPrimeiroPull();
      // Uma vez por sessão (ou se as pastas mudaram): confere se os anexos ainda estão no Drive
      if (!mapaConferido || pastasMudaram || filaEnvio.size) await atualizarMapaAnexos();
      if (mapaFresco || anexosNaLixeira.size) {
        const antes = filaEnvio.size;
        await reconciliarAnexos(pastas);
        if (filaEnvio.size !== antes) { blobsMexidos = true; atualizarEstado(); }
      }
      mapaConferido = true;
      pastasMudaram = false;
      blobsMexidos = (await enviarAnexosPendentes(pastas)) || blobsMexidos;
      blobsMexidos = (await esvaziarLixeira()) || blobsMexidos;
      meta.ultimaSync = agora();
      await salvarMeta("ultimaSync");
      erroAtual = null;
    } catch (e) {
      erroAtual = traduzirErro(e);
      if (!(e && e.code)) avisarConsole("erro na sincronização", e);
    } finally {
      sincronizando = false;
      resolverPrimeiroPull();
      atualizarEstado();
      avisarAbas(Array.from(colsMudadas), blobsMexidos, true);
    }
  }

  const podeSincronizar = () => CONFIGURADO && tokenValido();
  const visivel = () => !G.document || G.document.visibilityState !== "hidden";

  // 1,5 s depois da última escrita local
  function agendarSync() {
    if (agendado) clearTimeout(agendado);
    agendado = setTimeout(() => {
      agendado = null;
      if (podeSincronizar()) sincronizar(); else atualizarEstado();
    }, ATRASO_SYNC);
  }

  function ouvir(alvo, evento, fn) {
    try { if (alvo && typeof alvo.addEventListener === "function") alvo.addEventListener(evento, fn); } catch (e) { /* ok */ }
  }

  function ligarGatilhos() {
    ouvir(G, "online", () => { carregarGis(); if (podeSincronizar()) sincronizar(); else atualizarEstado(); });
    ouvir(G, "offline", () => atualizarEstado());
    ouvir(G.document, "visibilitychange", () => {
      if (!visivel()) return;
      carregarGis(); // se não carregou antes (sem internet), tenta de novo
      token = lerToken();
      if (podeSincronizar()) sincronizar(); else atualizarEstado();
    });
    // login/logout feito em outra aba
    ouvir(G, "storage", (ev) => {
      if (!ev || (ev.key && !String(ev.key).startsWith("prontuario."))) return;
      token = lerToken();
      atualizarEstado();
    });
    relogio = setInterval(() => {
      atualizarEstado();
      if (visivel() && podeSincronizar() && agora() - ultimaTentativa >= 180000) sincronizar();
    }, 30000);
    try { if (relogio && typeof relogio.unref === "function") relogio.unref(); } catch (e) { /* ok */ }
  }

  // ---------------------------------------------------------------------------
  // Várias abas: avisa as outras pelo BroadcastChannel
  // ---------------------------------------------------------------------------
  function ligarCanal() {
    try {
      if (typeof G.BroadcastChannel !== "function") return;
      canal = new G.BroadcastChannel("prontuario");
      canal.onmessage = (ev) => { aoAvisoDeOutraAba(ev && ev.data); };
    } catch (e) { canal = null; }
  }

  function avisarAbas(cols, blobs, sync) {
    if (!canal || armazem.memoria) return;
    try { canal.postMessage({ tipo: "mudou", aba: ABA, cols: cols || [], blobs: !!blobs, sync: !!sync }); } catch (e) { /* ok */ }
  }

  async function aoAvisoDeOutraAba(msg) {
    if (!msg || msg.tipo !== "mudou" || msg.aba === ABA || armazem.memoria) return;
    await prontoPromessa;
    token = lerToken();
    try {
      const mudaram = await recarregarDoArmazem(!!msg.blobs);
      for (const col of mudaram) emitirColecao(col);
    } catch (e) { avisarConsole("não consegui reler os dados", e); }
    atualizarEstado();
  }

  // ---------------------------------------------------------------------------
  // Estado para a interface
  // ---------------------------------------------------------------------------
  const ouvintesEstado = new Set();
  let ultimoEstadoTexto = "";

  function contarSujos() { let n = 0; for (const r of docs.values()) if (r.sujo) n++; return n; }

  function estado() {
    const pendentes = contarSujos() + filaEnvio.size + meta.lixeira.length;
    const conectado = CONFIGURADO && tokenValido();
    const conta = ls.ler(CHAVE.conta);
    const pullVelho = meta.ultimoPull == null || agora() - meta.ultimoPull > 10 * 60000;
    return {
      configurado: CONFIGURADO,
      conectado,
      contaConhecida: !!conta,
      conta: conta || null,
      nome: ls.ler(CHAVE.nome) || null,
      precisaLogin: CONFIGURADO && !conectado && (pendentes > 0 || (!!conta && pullVelho)),
      sincronizando,
      pendentes,
      ultimaSync: meta.ultimaSync == null ? null : meta.ultimaSync,
      erro: erroAtual ? { code: erroAtual.code, mensagem: erroAtual.mensagem } : null,
      metodo,
      armazenamentoLocal: armazem.tipo,
      pastaId: (meta.pastas && meta.pastas.raiz) || null
    };
  }

  function atualizarEstado() {
    const e = estado();
    const texto = JSON.stringify(e);
    if (texto === ultimoEstadoTexto) return;
    ultimoEstadoTexto = texto;
    for (const fn of Array.from(ouvintesEstado)) {
      try { fn(JSON.parse(texto)); } catch (x) { avisarConsole("erro no ouvinte de estado", x); }
    }
  }

  function aoEvento(nome, fn) {
    if (nome !== "estado" || typeof fn !== "function") return () => {};
    ouvintesEstado.add(fn);
    Promise.resolve().then(() => { if (ouvintesEstado.has(fn)) { try { fn(estado()); } catch (x) { avisarConsole(x); } } });
    return () => { ouvintesEstado.delete(fn); };
  }

  // ---------------------------------------------------------------------------
  // API de controle (drive) e backups
  // ---------------------------------------------------------------------------
  async function salvarArquivo(nome, dados) {
    if (!CONFIGURADO || !tokenValido()) throw erro("login", "Conecte o Google Drive primeiro.");
    nome = String(nome || "backup");
    const blob = typeof Blob !== "undefined" && dados instanceof Blob ? dados : new Blob([dados == null ? "" : dados], { type: tipoPorNome(nome) });
    const tipo = (blob.type || tipoPorNome(nome)).split(";")[0];
    try {
      await prontoPromessa;
      let pastas = await garantirPastas();
      if (!(await pastaViva(pastas.backups))) { meta.pastas = {}; pastas = await garantirPastas(); }
      const r = await criarArquivo({ nome, tipo, pais: [pastas.backups], props: { app: "prontuario", papel: "backup" } }, blob);
      if (!r || !r.id) throw erro("drive", MSG.drive);
      return { id: r.id, url: "https://drive.google.com/file/d/" + r.id + "/view" };
    } catch (e) {
      const t = traduzirErro(e) || erro("login", MSG.login);
      throw t;
    }
  }

  const controle = {
    estado,
    on: aoEvento,
    conectar,
    sincronizar: () => sincronizar(),
    desconectar,
    definirMetodo,
    pastaUrl: () => (meta.pastas && meta.pastas.raiz ? "https://drive.google.com/drive/folders/" + meta.pastas.raiz : null),
    salvarArquivo,
    compartilhar: (blob, nome) => entregarArquivo(nome, blob)
  };

  const capacidades = {
    db,
    assets: { upload: enviarAnexo, delete: apagarAnexo, list: listarAnexos },
    user: { can: async () => true },
    downloads: { save: (o) => entregarArquivo(o && o.filename, o && o.data) }
  };

  // ---------------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------------
  function pedirPersistencia() {
    try {
      const st = G.navigator && G.navigator.storage;
      if (st && typeof st.persist === "function") Promise.resolve(st.persist()).catch(() => {});
    } catch (e) { /* ok */ }
  }

  async function iniciar() {
    try { await abrirArmazem(); } catch (e) { usarMemoria(); }
    try {
      await recarregarDoArmazem(true);
    } catch (e) {
      avisarConsole("não consegui ler o IndexedDB, usando memória", e);
      usarMemoria();
    }
  }

  function depoisDeIniciar() {
    atualizarEstado();
    pedirPersistencia();
    ligarCanal();
    ligarGatilhos();
    carregarGis();
    if (podeSincronizar()) sincronizar();
    else resolverPrimeiroPull();
  }

  function parar() {
    if (relogio) clearInterval(relogio);
    if (agendado) clearTimeout(agendado);
    relogio = agendado = null;
    try { if (canal) canal.close(); } catch (e) { /* ok */ }
    canal = null;
  }

  // Lê o retorno do login antes de tudo (antes do app rodar)
  try { lerRetornoLogin(); } catch (e) { avisarConsole("retorno do login", e); }

  prontoPromessa = iniciar();
  prontoPromessa.then(depoisDeIniciar);

  G.claude = {
    modo: "drive",
    use: (nome) => Promise.resolve(Object.prototype.hasOwnProperty.call(capacidades, nome) ? capacidades[nome] : null),
    blobUrl: urlDoBlob,
    blobGet: pegarBlob,
    drive: controle
  };

  if (TESTE) {
    G.__driveInterno = {
      pronto: prontoPromessa, docs, meta, filaEnvio, armazem,
      dispositivo: DISPOSITIVO, esperarInicio, montarArquivo, sincronizar, parar,
      token: () => token
    };
  }
})();
