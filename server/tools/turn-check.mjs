#!/usr/bin/env node
/**
 * Does the relay actually relay?
 *
 * `/rtc/ice` returning `hasTurn: true` only proves the server has credentials in
 * hand. It says nothing about whether the relay is reachable from this network,
 * whether those credentials authenticate, or whether the provider will hand out
 * an allocation — and all three fail silently, as a call that connects for
 * everyone except the people who needed the relay.
 *
 * So this speaks TURN directly: a STUN Allocate against every relay URL the
 * server would give a browser, using the long-term credential mechanism
 * (RFC 5389 §10.2, RFC 8656 §7). A relay that answers with a relayed transport
 * address has proven the whole path end to end. The allocation is released
 * immediately afterwards, so running this does not eat into a usage quota
 * beyond the handful of packets it takes.
 *
 * Run it from `server/`:
 *
 *   node tools/turn-check.mjs
 *
 * No arguments: it reads the same `.env` the server does and checks exactly what
 * the server would serve. Nothing here needs a browser, a camera or a second
 * device.
 */

import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { buildIceConfig, turnProviders } from '../src/turn.js';

const MAGIC_COOKIE = 0x2112a442;
const COOKIE_BYTES = Buffer.alloc(4);
COOKIE_BYTES.writeUInt32BE(MAGIC_COOKIE);

/** Message types, pre-encoded — the class bits are interleaved into the method. */
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const REFRESH_REQUEST = 0x0004;

const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
};

const REQUEST_TIMEOUT_MS = 6000;

/**
 * Encode one STUN attribute: 16-bit type, 16-bit length, value, padded to a
 * 4-byte boundary. The padding is not counted in the length.
 */
function encodeAttribute(type, value) {
  const padding = (4 - (value.length % 4)) % 4;
  const buffer = Buffer.alloc(4 + value.length + padding);
  buffer.writeUInt16BE(type, 0);
  buffer.writeUInt16BE(value.length, 2);
  value.copy(buffer, 4);
  return buffer;
}

/**
 * Build a STUN message, optionally authenticated.
 *
 * The subtlety in MESSAGE-INTEGRITY: the HMAC covers the message *without* the
 * integrity attribute, but with the header's length field already counting it.
 * Get that wrong and the server answers 401 forever with no hint as to why.
 */
function buildMessage({ type, transactionId, attributes = [], integrityKey = null }) {
  const body = Buffer.concat(attributes.map(([t, v]) => encodeAttribute(t, v)));
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);

  if (!integrityKey) {
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }

  header.writeUInt16BE(body.length + 24, 2);
  const mac = crypto
    .createHmac('sha1', integrityKey)
    .update(Buffer.concat([header, body]))
    .digest();
  return Buffer.concat([header, body, encodeAttribute(ATTR.MESSAGE_INTEGRITY, mac)]);
}

function parseAttributes(message) {
  const attributes = new Map();
  const end = 20 + message.readUInt16BE(2);
  let offset = 20;
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    attributes.set(type, message.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return attributes;
}

/** ERROR-CODE packs the class into one byte and the number into the next. */
function errorCode(attributes) {
  const value = attributes.get(ATTR.ERROR_CODE);
  if (!value || value.length < 4) return null;
  return { code: value[2] * 100 + value[3], reason: value.subarray(4).toString('utf8') };
}

/**
 * XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS. Addresses are obfuscated against
 * NATs that rewrite anything resembling an IP inside a payload — which is the
 * entire reason the XOR variants exist.
 */
function decodeXorAddress(value, transactionId) {
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const raw = Buffer.from(value.subarray(4));
  const mask = value[1] === 0x01 ? COOKIE_BYTES : Buffer.concat([COOKIE_BYTES, transactionId]);
  for (let i = 0; i < raw.length; i += 1) raw[i] ^= mask[i];

  if (value[1] === 0x01) return `${raw.join('.')}:${port}`;
  const groups = [];
  for (let i = 0; i < raw.length; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
  return `[${groups.join(':')}]:${port}`;
}

/**
 * `turn:host:port?transport=tcp` and friends (RFC 7065). `turns:` implies TLS,
 * and its default transport is TCP rather than UDP.
 */
function parseTurnUrl(url) {
  const match = /^(turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(\w+))?$/i.exec(url.trim());
  if (!match) throw new Error(`unparseable relay URL: ${url}`);
  const [, scheme, rawHost, port, transport] = match;
  const secure = scheme.toLowerCase() === 'turns';
  return {
    url,
    secure,
    host: rawHost.replace(/^\[|\]$/g, ''),
    port: Number(port) || (secure ? 5349 : 3478),
    transport: (transport || (secure ? 'tcp' : 'udp')).toLowerCase(),
  };
}

/**
 * One request/response exchange at a time, which is all this needs. Stream
 * transports get length-prefix framing (the STUN header's length field);
 * datagrams arrive whole.
 */
function attach(socket, { datagram = false, target = null } = {}) {
  let buffered = Buffer.alloc(0);
  let pending = null;
  let closed = null;

  const deliver = (message) => {
    if (!pending) return;
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    resolve(message);
  };

  const fail = (error) => {
    closed = error;
    if (!pending) return;
    const { reject, timer } = pending;
    pending = null;
    clearTimeout(timer);
    reject(error);
  };

  if (datagram) {
    socket.on('message', (message) => deliver(Buffer.from(message)));
  } else {
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 20) {
        const total = 20 + buffered.readUInt16BE(2);
        if (buffered.length < total) break;
        const message = Buffer.from(buffered.subarray(0, total));
        buffered = buffered.subarray(total);
        deliver(message);
      }
    });
    socket.on('end', () => fail(new Error('relay closed the connection')));
  }
  socket.on('error', (error) => fail(error));

  return {
    request(message) {
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => fail(new Error(`no answer within ${REQUEST_TIMEOUT_MS}ms`)),
          REQUEST_TIMEOUT_MS
        );
        pending = { resolve, reject, timer };
        if (datagram) socket.send(message, target.port, target.host, (e) => e && fail(e));
        else socket.write(message);
      });
    },
    close() {
      if (pending) clearTimeout(pending.timer);
      try {
        if (datagram) socket.close();
        else socket.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

async function connect(relay) {
  if (relay.transport === 'udp' && !relay.secure) {
    const socket = dgram.createSocket(net.isIPv6(relay.host) ? 'udp6' : 'udp4');
    return attach(socket, { datagram: true, target: relay });
  }

  const socket = await new Promise((resolve, reject) => {
    const options = { host: relay.host, port: relay.port };
    // `servername` matters on shared relay hosts, which pick a certificate by SNI.
    const s = relay.secure
      ? tls.connect({ ...options, servername: relay.host }, () => resolve(s))
      : net.connect(options, () => resolve(s));
    s.setTimeout(REQUEST_TIMEOUT_MS, () => s.destroy(new Error('connect timed out')));
    s.once('error', reject);
  });
  socket.setTimeout(0);
  return attach(socket);
}

/** REQUESTED-TRANSPORT: 17 is UDP, the only value a browser ever asks for. */
const REQUESTED_TRANSPORT_UDP = Buffer.from([17, 0, 0, 0]);

/**
 * The two-round-trip dance TURN requires: the first Allocate is expected to be
 * rejected with 401 plus a realm and a nonce, and only the second one — signed
 * with a key derived from all three — can succeed. An immediate success would
 * mean an open relay, which is worth shouting about.
 */
async function allocate(relay, username, password) {
  const connection = await connect(relay);
  try {
    const probeId = crypto.randomBytes(12);
    const probe = parseAttributes(
      await connection.request(
        buildMessage({
          type: ALLOCATE_REQUEST,
          transactionId: probeId,
          attributes: [[ATTR.REQUESTED_TRANSPORT, REQUESTED_TRANSPORT_UDP]],
        })
      )
    );

    const challenge = errorCode(probe);
    if (!challenge) throw new Error('relay allocated without asking for credentials (open relay?)');
    if (challenge.code !== 401) {
      throw new Error(`unexpected ${challenge.code} ${challenge.reason || ''}`.trim());
    }

    const realm = probe.get(ATTR.REALM);
    const nonce = probe.get(ATTR.NONCE);
    if (!realm || !nonce) throw new Error('401 without a realm or nonce');

    // Long-term credential key. MD5 is not a choice — it is what RFC 5389 §15.4
    // specifies, and both ends must derive the same bytes.
    const key = crypto
      .createHash('md5')
      .update(`${username}:${realm.toString('utf8')}:${password}`)
      .digest();

    const transactionId = crypto.randomBytes(12);
    const credentials = [
      [ATTR.USERNAME, Buffer.from(username, 'utf8')],
      [ATTR.REALM, realm],
      [ATTR.NONCE, nonce],
    ];
    const response = await connection.request(
      buildMessage({
        type: ALLOCATE_REQUEST,
        transactionId,
        attributes: [[ATTR.REQUESTED_TRANSPORT, REQUESTED_TRANSPORT_UDP], ...credentials],
        integrityKey: key,
      })
    );

    const attributes = parseAttributes(response);
    const type = response.readUInt16BE(0);
    if (type === ALLOCATE_ERROR) {
      const failure = errorCode(attributes) || { code: 0, reason: 'unknown' };
      throw new Error(`${failure.code} ${failure.reason}`.trim());
    }
    if (type !== ALLOCATE_SUCCESS) throw new Error(`unexpected message type 0x${type.toString(16)}`);

    const relayed = attributes.get(ATTR.XOR_RELAYED_ADDRESS);
    const reflexive = attributes.get(ATTR.XOR_MAPPED_ADDRESS);
    const lifetime = attributes.get(ATTR.LIFETIME);

    // Hand the allocation back rather than letting it idle out. Costs one packet
    // and keeps a repeated run from stacking up allocations on a metered plan.
    await connection
      .request(
        buildMessage({
          type: REFRESH_REQUEST,
          transactionId: crypto.randomBytes(12),
          attributes: [[ATTR.LIFETIME, Buffer.alloc(4)], ...credentials],
          integrityKey: key,
        })
      )
      .catch(() => {});

    return {
      relayed: relayed ? decodeXorAddress(relayed, transactionId) : null,
      reflexive: reflexive ? decodeXorAddress(reflexive, transactionId) : null,
      lifetimeSeconds: lifetime ? lifetime.readUInt32BE(0) : null,
    };
  } finally {
    connection.close();
  }
}

/** Every relay URL in the ICE config, flattened, since `urls` may be an array. */
function relayTargets(iceServers) {
  const targets = [];
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (!/^turns?:/i.test(url)) continue;
      targets.push({ url, username: server.username, credential: server.credential });
    }
  }
  return targets;
}

async function main() {
  const config = await buildIceConfig('turn-check');
  const providers = turnProviders();

  console.log(`configured: ${providers.length ? providers.join(' + ') : 'nothing'}`);
  console.log(`stun: ${config.iceServers.filter((s) => /^stun:/i.test(s.urls)).length} server(s)`);

  const targets = relayTargets(config.iceServers);
  if (targets.length === 0) {
    console.log('\nNo relay in the ICE config, so there is nothing to test.');
    console.log('Calls will fail for peers behind symmetric NAT, CGNAT or UDP-blocking');
    console.log('firewalls. See NETWORK-SETUP.md for how to configure one.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nAllocating against ${targets.length} relay URL(s):\n`);
  let worked = 0;
  let skipped = 0;

  for (const target of targets) {
    const label = target.url;
    if (!target.username || !target.credential) {
      console.log(`  ✗ ${label}\n      no credentials attached — the browser could not use this either`);
      continue;
    }

    let relay;
    try {
      relay = parseTurnUrl(target.url);
    } catch (error) {
      console.log(`  ✗ ${label}\n      ${error.message}`);
      continue;
    }

    // A DTLS client is a lot of machinery for a diagnostic; browsers reach
    // `turns:` over TCP anyway, and that URL is almost always offered too.
    if (relay.secure && relay.transport === 'udp') {
      console.log(`  – ${label}\n      skipped: this checker does not speak DTLS`);
      skipped += 1;
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await allocate(relay, target.username, target.credential);
      const ms = Date.now() - startedAt;
      worked += 1;
      console.log(`  ✓ ${label}  (${ms}ms)`);
      console.log(`      relayed address: ${result.relayed ?? 'not reported'}`);
      if (result.lifetimeSeconds !== null) {
        console.log(`      allocation lifetime: ${result.lifetimeSeconds}s (released)`);
      }
    } catch (error) {
      console.log(`  ✗ ${label}  (${Date.now() - startedAt}ms)`);
      console.log(`      ${error.message}`);
    }
  }

  console.log('');
  if (worked > 0) {
    console.log(`${worked} of ${targets.length} relay URL(s) allocated successfully.`);
    console.log('The relay is reachable and the credentials authenticate — a peer that');
    console.log('cannot connect directly now has a path.');
  } else {
    console.log('No relay allocated. Media will fail for peers that cannot connect');
    console.log('directly. Common causes: wrong credentials (401 above), the relay');
    console.log('unreachable from this network, or an expired dashboard credential.');
    process.exitCode = 1;
  }
  if (skipped > 0) console.log(`${skipped} URL(s) skipped, listed above.`);
}

await main();
