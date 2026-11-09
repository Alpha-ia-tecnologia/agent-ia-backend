import { randomInt } from 'crypto';

/** Sem 0/O e 1/I: o código é lido em voz alta, projetado e digitado no celular. */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return code;
}

/** O que a pessoa digitou → forma guardada (maiúsculas, sem hífen/espaço). */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Exibição: K7P29QXA → K7P2-9QXA */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
