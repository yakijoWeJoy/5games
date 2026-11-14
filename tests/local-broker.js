// A tiny MQTT-over-WebSocket broker for the network tests (stands in for the public relay servers).
// Needs: npm i aedes ws websocket-stream
// Run:   node tests/local-broker.js 9101 9102
const aedes = require('aedes');
const http = require('http');
const ws = require('websocket-stream');

for (const port of process.argv.slice(2).map(Number)) {
  const broker = aedes();
  const server = http.createServer();
  ws.createServer({ server }, broker.handle);
  server.listen(port, () => console.log('mqtt/ws broker on', port));
}
