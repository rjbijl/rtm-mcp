#!/usr/bin/env node
/**
 * One-time authorization via RTM's desktop flow:
 *   getFrob -> user approves in the browser -> getToken.
 * The token never expires on its own; only when you revoke access in RTM.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadCredentials, writeStoredAuth } from './config.js';
import { AUTH_ENDPOINT, RtmClient, signParams } from './rtm.js';

const PERMS = 'delete'; // implies read + write; widening later means redoing the whole flow

async function main(): Promise<void> {
  const creds = loadCredentials(false);
  const client = new RtmClient({ ...creds, authToken: undefined });

  const frobRsp = await client.call<{ frob: string }>(
    'rtm.auth.getFrob',
    {},
    { authenticated: false }
  );
  const frob = frobRsp.frob;

  // The auth URL is signed separately: only api_key, perms and frob are included.
  const authParams: Record<string, string> = {
    api_key: creds.apiKey,
    perms: PERMS,
    frob
  };
  authParams.api_sig = signParams(authParams, creds.sharedSecret);
  const url = `${AUTH_ENDPOINT}?${new URLSearchParams(authParams).toString()}`;

  console.log('\nOpen this URL in your browser and approve access:\n');
  console.log(url);
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('Press Enter once you have clicked "OK, I\'ll allow it"... ');
  rl.close();

  const tokenRsp = await client.call<{
    auth: { token: string; perms: string; user: { username: string; fullname: string } };
  }>('rtm.auth.getToken', { frob }, { authenticated: false });

  const path = writeStoredAuth({
    auth_token: tokenRsp.auth.token,
    username: tokenRsp.auth.user.username,
    perms: tokenRsp.auth.perms
  });

  console.log(`\nDone. Logged in as ${tokenRsp.auth.user.username} (perms: ${tokenRsp.auth.perms}).`);
  console.log(`Token stored in ${path}`);
}

main().catch((e) => {
  console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`);
  if (String(e).includes('101')) {
    console.error('Code 101 means the frob has not been approved yet. Open the URL first.');
  }
  process.exit(1);
});
