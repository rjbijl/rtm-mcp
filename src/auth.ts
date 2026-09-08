#!/usr/bin/env node
/**
 * Eenmalige autorisatie via RTM's desktop-flow:
 *   getFrob -> gebruiker keurt goed in de browser -> getToken.
 * Het token verloopt niet vanzelf; alleen als je de toegang in RTM intrekt.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadCredentials, writeStoredAuth } from './config.js';
import { AUTH_ENDPOINT, RtmClient, signParams } from './rtm.js';

const PERMS = 'delete'; // impliceert read + write; verbreden vereist de hele flow opnieuw

async function main(): Promise<void> {
  const creds = loadCredentials(false);
  const client = new RtmClient({ ...creds, authToken: undefined });

  const frobRsp = await client.call<{ frob: string }>(
    'rtm.auth.getFrob',
    {},
    { authenticated: false }
  );
  const frob = frobRsp.frob;

  // De auth-URL wordt apart ondertekend: alleen api_key, perms en frob tellen mee.
  const authParams: Record<string, string> = {
    api_key: creds.apiKey,
    perms: PERMS,
    frob
  };
  authParams.api_sig = signParams(authParams, creds.sharedSecret);
  const url = `${AUTH_ENDPOINT}?${new URLSearchParams(authParams).toString()}`;

  console.log('\nOpen deze URL in je browser en keur de toegang goed:\n');
  console.log(url);
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('Druk op Enter zodra je "OK, I\'ll allow it" hebt geklikt... ');
  rl.close();

  const tokenRsp = await client.call<{
    auth: { token: string; perms: string; user: { username: string; fullname: string } };
  }>('rtm.auth.getToken', { frob }, { authenticated: false });

  const path = writeStoredAuth({
    auth_token: tokenRsp.auth.token,
    username: tokenRsp.auth.user.username,
    perms: tokenRsp.auth.perms
  });

  console.log(`\nGelukt. Ingelogd als ${tokenRsp.auth.user.username} (perms: ${tokenRsp.auth.perms}).`);
  console.log(`Token opgeslagen in ${path}`);
}

main().catch((e) => {
  console.error(`\nMislukt: ${e instanceof Error ? e.message : String(e)}`);
  if (String(e).includes('101')) {
    console.error('Code 101 betekent dat de frob nog niet goedgekeurd is. Klik eerst de URL af.');
  }
  process.exit(1);
});
