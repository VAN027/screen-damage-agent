// Screen Damage Agent - Local Tunnel Script
// Exposes local port 8080 to the public internet via localtunnel

const lt = require('localtunnel');

async function start() {
  console.log('Establishing tunnel...\n');

  const tunnel = await lt({ port: 8080 });

  console.log('========================================');
  console.log('  Tunnel is LIVE!');
  console.log(`  URL: ${tunnel.url}`);
  console.log('========================================');
  console.log('');
  console.log('NOTES:');
  console.log('  1. Share the URL above with anyone');
  console.log('  2. Keep this window open - closing it stops the tunnel');
  console.log('  3. First-time visitors need to click "Click to Continue"');
  console.log('');

  tunnel.on('close', () => {
    console.log('Tunnel closed.');
  });
}

start().catch(err => {
  console.error('Tunnel failed:', err.message);
  console.log('\nPlease run: npm install localtunnel');
  process.exit(1);
});
