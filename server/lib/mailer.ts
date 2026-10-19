import { config } from "../config.js";

/**
 * Envio de e-mail, com o provedor escolhido por MAIL_PROVIDER:
 *
 *   console  imprime no log (padrão; dev e testes). Único modo em que o
 *            conteúdo — inclusive o código de recuperação — aparece no log.
 *   resend   API HTTP do Resend, por fetch (sem SDK). Exige RESEND_API_KEY.
 *   smtp     nodemailer com SMTP_URL (smtps://usuario:senha@host:465).
 *
 * Validação das variáveis em config.ts: um provedor mal configurado derruba o
 * boot, em vez de falhar só quando alguém pedir recuperação de senha.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// ---------------------------------------------------------------------------
// Hook de teste
// ---------------------------------------------------------------------------

type MailListener = (mail: Mail) => void;
const listeners = new Set<MailListener>();

/**
 * Observa os e-mails enviados. Existe para o teste de integração pegar o
 * código de recuperação sem ler o log; não há rota que o alcance. Devolve a
 * função que remove o observador.
 */
export function onMailSent(listener: MailListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Provedores
// ---------------------------------------------------------------------------

async function sendWithResend(mail: Mail): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.MAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });

  if (!response.ok) {
    // O corpo do erro do Resend não contém o e-mail enviado, só o motivo.
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend respondeu ${response.status}: ${detail.slice(0, 300)}`);
  }
}

// O transporte SMTP é criado uma vez e reaproveitado (pool de conexões). O
// import é dinâmico: quem não usa SMTP não carrega o nodemailer.
let smtpTransport: import("nodemailer").Transporter | null = null;

async function sendWithSmtp(mail: Mail): Promise<void> {
  if (!smtpTransport) {
    const nodemailer = await import("nodemailer");
    smtpTransport = nodemailer.createTransport(config.SMTP_URL);
  }
  await smtpTransport.sendMail({
    from: config.MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

function printToConsole(mail: Mail): void {
  console.log(
    [
      "📧 E-mail (MAIL_PROVIDER=console — não enviado de verdade)",
      `   Para: ${mail.to}`,
      `   Assunto: ${mail.subject}`,
      ...mail.text.split("\n").map((line) => `   | ${line}`),
    ].join("\n"),
  );
}

export async function sendMail(mail: Mail): Promise<void> {
  if (config.MAIL_PROVIDER === "resend") {
    await sendWithResend(mail);
  } else if (config.MAIL_PROVIDER === "smtp") {
    await sendWithSmtp(mail);
  } else {
    printToConsole(mail);
  }

  for (const listener of listeners) listener(mail);
}

/**
 * Envia sem segurar a resposta HTTP. Usado onde o tempo de resposta não pode
 * depender do envio — no "esqueci a senha", esperar o provedor só quando a
 * conta existe revelaria quais e-mails estão cadastrados. Falha vai para o log
 * (sem o conteúdo do e-mail).
 */
export function sendMailInBackground(mail: Mail): void {
  sendMail(mail).catch((err: Error) => {
    console.error(`Falha ao enviar e-mail ("${mail.subject}"):`, err.message);
  });
}

/** Escapa texto para os templates HTML dos e-mails. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
