/**
 * The sidecar relay.
 *
 * Runs in its own container attached to both the job's internal network and
 * the outside world, and does exactly one thing: forward TCP from a fixed port
 * to the host-side model proxy. It exists because Docker's ``--internal``
 * network has no route to the host, and the alternative -- attaching the job
 * container to a routable network -- would hand model-generated code the
 * operator's LAN and, on a cloud host, the instance metadata service.
 *
 * It is deliberately dumb. No parsing, no buffering beyond the socket, no
 * credentials. The allow-listing and key injection happen on the host, in
 * model-proxy.ts, where the job container cannot reach them.
 */
import { createServer, connect } from "node:net";

const LISTEN_PORT = 8900;

const target = process.argv[2] ?? "";
const separator = target.lastIndexOf(":");
const host = separator > 0 ? target.slice(0, separator) : "";
const port = separator > 0 ? Number.parseInt(target.slice(separator + 1), 10) : Number.NaN;

if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write("relay: expected a host:port argument\n");
  process.exit(2);
}

const server = createServer((inbound) => {
  const outbound = connect({ host, port });
  const bail = (): void => {
    inbound.destroy();
    outbound.destroy();
  };
  inbound.on("error", bail);
  outbound.on("error", bail);
  inbound.pipe(outbound);
  outbound.pipe(inbound);
});

server.on("error", (error) => {
  process.stderr.write(`relay: ${error.message}\n`);
  process.exit(1);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  process.stderr.write(`relay: listening on ${LISTEN_PORT}\n`);
});
