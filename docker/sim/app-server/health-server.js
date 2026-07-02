// Stand-in for the "health endpoint" in the architecture diagram
// (docs/initial-architecture-proposal.md). Always healthy: this simulates the
// mechanics of a health check gate, not real backend health.
// Plain CommonJS: no package.json in the image to opt into ESM.
const { createServer } = require("node:http");

const port = 8080;

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok" }));
}).listen(port, () => {
  console.log(`sim health server listening on ${port}`);
});
