// Configuração do app no celular.
// Para usar: copie este arquivo para "config.js" (na mesma pasta pwa)
// e troque COLE_AQUI pelo "ID do cliente" que o Google Cloud mostrou.
// Esse ID não é segredo: pode ficar no GitHub sem problema.
window.PRONTUARIO_CONFIG = {
  clientId: "644670718664-klpilkb3ouf5l9m2cqbupt4grhtd6r8k.apps.googleusercontent.com",
  // Chave de API (links de compartilhamento). Também não é segredo: fica restrita ao seu site.
  apiKey: "COLE_A_CHAVE_DE_API_AQUI",
  apiBase: "https://www.googleapis.com",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  gisSrc: "https://accounts.google.com/gsi/client",
  pdfjsBase: "./vendor/pdfjs/",
  nomePasta: "Prontuário da Princesa"
};
