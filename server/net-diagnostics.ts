/**
 * Diagnóstico de alcance do banco externo.
 *
 * Roda só quando a conexão falha, para transformar um erro genérico num
 * veredito. Hospedagem gerenciada costuma filtrar saída por porta, e os
 * sintomas são parecidos mas as causas não: cada camada aqui separa um caso.
 *
 * A sonda de controle na 443 é a peça que decide: se o mesmo host responde na
 * 443 mas não na porta do Postgres, o problema é filtro de porta — e aí a saída
 * é um driver que fala por HTTPS. Se nem a 443 responde, é a rede.
 */
import dns from "node:dns";
import net from "node:net";

type Probe = { ok: boolean; detail: string };

function parseTarget(databaseUrl: string): { host: string; port: number } | null {
  try {
    const url = new URL(databaseUrl);
    return {
      host: decodeURIComponent(url.hostname),
      port: url.port ? Number(url.port) : 5432,
    };
  } catch {
    return null;
  }
}

async function probeDns(host: string): Promise<Probe> {
  try {
    const { address } = await dns.promises.lookup(host);
    return { ok: true, detail: address };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "erro";
    return { ok: false, detail: code };
  }
}

function probeTcp(host: string, port: number, timeoutMs = 8000): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (probe: Probe) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(probe);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () =>
      finish({ ok: true, detail: `${Date.now() - started}ms` }),
    );
    // Timeout e recusa querem dizer coisas diferentes: DROP silencioso de
    // firewall vira timeout, REJECT vira ECONNREFUSED.
    socket.on("timeout", () => finish({ ok: false, detail: "timeout (pacote descartado)" }));
    socket.on("error", (err: NodeJS.ErrnoException) =>
      finish({ ok: false, detail: err.code ?? err.message }),
    );
  });
}

/** Imprime o diagnóstico. Nunca lança: é ferramenta de log, não de controle. */
export async function diagnoseDatabaseReachability(
  databaseUrl: string,
): Promise<void> {
  const target = parseTarget(databaseUrl);
  if (!target) {
    console.error("Diagnóstico: DATABASE_URL não é uma URL válida.");
    return;
  }

  const { host, port } = target;
  console.error(`\n── Diagnóstico de alcance do banco (${host}:${port}) ──`);

  const dnsProbe = await probeDns(host);
  console.error(`  DNS            : ${dnsProbe.ok ? dnsProbe.detail : `FALHOU (${dnsProbe.detail})`}`);

  if (!dnsProbe.ok) {
    console.error(
      "  → O host não resolve. Confira o DATABASE_URL; se estiver certo,\n" +
        "    a hospedagem está bloqueando DNS de saída.",
    );
    return;
  }

  const [dbPort, controlPort] = await Promise.all([
    probeTcp(host, port),
    probeTcp(host, 443),
  ]);

  console.error(`  TCP :${port}${String(port).length < 4 ? " " : ""}      : ${dbPort.ok ? `aberto (${dbPort.detail})` : `FALHOU (${dbPort.detail})`}`);
  console.error(`  TCP :443 (ref.): ${controlPort.ok ? `aberto (${controlPort.detail})` : `FALHOU (${controlPort.detail})`}`);

  if (dbPort.ok) {
    console.error(
      "  → A porta do banco está alcançável. A falha é DEPOIS do TCP:\n" +
        "    credenciais, nome do banco, ou TLS. Veja a mensagem do erro acima.",
    );
  } else if (controlPort.ok) {
    console.error(
      `  → A 443 responde mas a ${port} não: a hospedagem filtra saída por\n` +
        "    porta. Postgres por TCP não funciona aqui — a saída é um banco\n" +
        "    que aceite consulta sobre HTTPS, ou outra hospedagem.",
    );
  } else {
    console.error(
      "  → Nenhuma porta responde neste host. Pode ser egress totalmente\n" +
        "    bloqueado, ou o host do banco estar fora do ar.",
    );
  }
  console.error("────────────────────────────────────────────────────\n");
}
