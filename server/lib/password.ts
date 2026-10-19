import { z } from "zod";

/**
 * Regras de senha, num lugar só: o cadastro e a troca de senha precisam
 * exigir exatamente a mesma coisa, senão dá para "trocar" para uma senha que o
 * cadastro recusaria. O front (register.ts, profile-settings.ts) espelha estas
 * regras só para dar o erro antes do request.
 */
export const passwordSchema = z
  .string()
  .min(8, "Senha deve ter no mínimo 8 caracteres")
  .max(200, "Senha muito longa")
  .refine(
    (pwd) => (pwd.match(/\d/g) ?? []).length >= 3,
    "Senha precisa de pelo menos 3 números",
  )
  .refine(
    (pwd) => /[^A-Za-z0-9]/.test(pwd),
    "Senha precisa de pelo menos 1 caractere especial",
  );

/** Custo do bcrypt. Mudar aqui vale para cadastro e troca de senha. */
export const BCRYPT_ROUNDS = 12;
