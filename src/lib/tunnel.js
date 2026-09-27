import net from 'node:net';
import { connectionFromRow, withConnection } from './ssh.js';

/**
 * Reach `host:port` as seen from `server`, for drivers that only know how to
 * dial a TCP address (MongoDB, Redis, PostgreSQL).
 *
 * A listener on 127.0.0.1:<random> is opened for the duration of `fn`; every
 * socket that connects to it is piped through the server's SSH connection.
 * Without a server, `fn` simply gets the address it asked for.
 */
export async function withTunnel(server, host, port, fn) {
  if (!server) return fn({ host, port });

  return withConnection(connectionFromRow(server), async (ssh) => {
    const sockets = new Set();
    const listener = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      ssh.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) {
          socket.destroy(tunnelError(err));
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.close?.());
      });
    });

    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });

    try {
      return await fn({ host: '127.0.0.1', port: listener.address().port });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => listener.close(() => resolve()));
    }
  });
}

function tunnelError(err) {
  const e = new Error(
    `SSH tunnel failed: ${err.message}. Check that the database is running on the server and that AllowTcpForwarding is enabled in sshd_config.`
  );
  e.cause = err.message;
  return e;
}
