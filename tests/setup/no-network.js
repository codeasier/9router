// Selected transport regressions must never reach a real provider, even if a
// stale mock falls through to native fetch/undici. Scoped to the PR test config.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => { throw new Error("External network disabled in offline regression tests"); };
globalThis.fetch = async () => blocked();
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
syncBuiltinESMExports();
