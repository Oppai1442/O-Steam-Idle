'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = path.join(__dirname, '..', 'data', 'credentials.dat');
if (!fs.existsSync(file)) {
  console.error('No saved Steam login found. Run O-Steam-Idle locally, log in with QR, then try again.');
  process.exit(1);
}

function ps(script, input = '') {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

try {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  let token = '';
  if (payload.mode === 'plain') {
    token = payload.token || '';
  } else if (payload.mode === 'dpapi' && process.platform === 'win32') {
    const script = [
      '$ErrorActionPreference="Stop";',
      'Add-Type -AssemblyName System.Security;',
      '$s=[Console]::In.ReadToEnd().Trim();',
      '$b=[Convert]::FromBase64String($s);',
      '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p));'
    ].join('');
    const r = ps(script, payload.blob || '');
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || 'DPAPI decrypt failed').trim());
    token = r.stdout.trim();
  } else {
    throw new Error(`Credential format ${payload.mode || 'unknown'} cannot be decrypted on ${process.platform}`);
  }

  if (!token) throw new Error('Saved credential did not contain a refresh token');
  console.log('Steam refresh token (treat this like a password):');
  console.log(token);
  console.log('\nPaste it into: npx wrangler secret put STEAM_REFRESH_TOKEN');
} catch (err) {
  console.error(`Could not export refresh token: ${err.message}`);
  process.exit(1);
}
