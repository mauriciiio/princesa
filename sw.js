/* Service worker do Prontuário da Princesa.
   Guarda o "casco" do app para abrir sem internet. Os dados NÃO passam por aqui:
   ficam no IndexedDB (drive.js) e no Google Drive.
   As duas linhas VERSAO e ARQUIVOS são reescritas pelo build.py. */
const VERSAO = "04cba3e77d9e";
const ARQUIVOS = ["./index.html", "./config.js", "./drive.js", "./icons/apple-touch-icon-180.png", "./icons/favicon-32.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-192.png", "./icons/maskable-512.png", "./manifest.webmanifest", "./vendor/pdfjs/pdf.min.js", "./vendor/pdfjs/pdf.worker.min.js", "./vendor/qrcode/qrcode.min.js"];

const CASCO = "casco-" + VERSAO;
const CDN = "cdn-v1"; // fontes do Google e cdnjs: versões fixas, cache separado e estável
const CDN_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"]);
const BASE = new URL("./", self.location).href; // pasta do app (escopo)

self.addEventListener("install", (e) => {
  // sem skipWaiting aqui: a versão nova espera o usuário tocar em "Atualizar"
  e.waitUntil((async () => {
    const c = await caches.open(CASCO);
    await c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: "reload" })));
  })());
});

self.addEventListener("message", (e) => {
  const d = e.data;
  if (d === "SKIP_WAITING" || (d && d.tipo === "atualizar")) self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("casco-") && k !== CASCO) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// Resposta vinda de redirecionamento não pode responder navegação: copia sem a marca.
async function limpa(r) {
  if (!r || !r.redirected) return r;
  const corpo = await r.blob();
  return new Response(corpo, { status: r.status, statusText: r.statusText, headers: r.headers });
}

function ehGoogleApi(url) {
  // nunca mexer com login nem com a API do Drive (nem com o Google falso dos testes)
  const h = url.hostname;
  if (h === "accounts.google.com" || h === "oauth2.googleapis.com" || h === "apis.google.com") return true;
  if (h.endsWith(".googleapis.com") && !CDN_HOSTS.has(h)) return true;
  if (h === "googleapis.com") return true;
  return url.origin === self.location.origin && (url.pathname.startsWith("/_google/") || url.pathname.startsWith("/_teste/"));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (ehGoogleApi(url)) return;

  if (req.mode === "navigate") {
    // abrir o app: casco do cache primeiro, rede se faltar
    const ehApp = url.origin === self.location.origin &&
      (url.href.split(/[?#]/)[0] === BASE || url.href.split(/[?#]/)[0] === BASE + "index.html");
    if (!ehApp) return;
    e.respondWith((async () => {
      const r = await caches.match("./index.html", { ignoreSearch: true, cacheName: CASCO });
      if (r) return limpa(r);
      return fetch(req);
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    // arquivos do próprio app: cache primeiro
    e.respondWith((async () => {
      const r = await caches.match(req, { cacheName: CASCO });
      return r || fetch(req);
    })());
    return;
  }

  if (CDN_HOSTS.has(url.hostname)) {
    // fontes e cdnjs: responde do cache e atualiza por trás
    e.respondWith((async () => {
      const c = await caches.open(CDN);
      const hit = await c.match(req);
      const rede = fetch(req).then((r) => {
        if (r.ok || r.type === "opaque") c.put(req, r.clone()).catch(() => {});
        return r;
      }).catch(() => hit || Response.error());
      if (hit) {
        e.waitUntil(rede.then(() => {}, () => {}));
        return hit;
      }
      return rede;
    })());
  }
  // o resto (outros sites) passa direto
});
