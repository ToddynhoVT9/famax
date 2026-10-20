/**
 * Descrição curta de um dispositivo a partir do User-Agent, para a lista de
 * sessões ativas ("Chrome no Windows"). Heurística de propósito simples: o
 * objetivo é a pessoa reconhecer o próprio aparelho, não identificar versões
 * — e uma lib de parsing inteira seria muito para isso.
 *
 * A ordem dos testes importa: o UA do Edge contém "Chrome", o do Chrome
 * contém "Safari", o do Android contém "Linux".
 */

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconhecido";
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} no ${system}`;
  if (browser || system) return (browser ?? system)!;
  // Clientes de API (curl, apps) — corta para não despejar um UA inteiro.
  return userAgent.split(/[\s/]/)[0].slice(0, 40) || "Dispositivo desconhecido";
}

/**
 * IP parcial: o suficiente para a pessoa estranhar "esse não fui eu", sem
 * expor o endereço completo na tela. IPv4 mostra os dois primeiros blocos;
 * IPv6, os três primeiros grupos.
 */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, "");
  if (ip === "::1" || v4.startsWith("127.")) return "rede local";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const [a, b] = v4.split(".");
    return `${a}.${b}.*.*`;
  }
  if (ip.includes(":")) {
    return `${ip.split(":").filter(Boolean).slice(0, 3).join(":")}:*`;
  }
  return null;
}
