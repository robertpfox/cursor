import './helpers/env.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  clientAddress,
  isLocalRequest,
  isLoopback,
  isPrivateAddress,
  normalizeAddress,
} from '../src/core/network.js';

/** Minimal stand-in for an http.IncomingMessage. */
function request({ remoteAddress = '192.168.1.20', headers = {} } = {}) {
  return { socket: { remoteAddress }, headers };
}

describe('address classification', () => {
  test('normalises IPv4-mapped IPv6 and zone ids', () => {
    assert.equal(normalizeAddress('::ffff:192.168.1.5'), '192.168.1.5');
    assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1');
    assert.equal(normalizeAddress('  10.0.0.1 '), '10.0.0.1');
  });

  test('recognises loopback', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopback(ip), true, ip);
    }
    assert.equal(isLoopback('192.168.1.1'), false);
  });

  test('accepts every private range a home network actually uses', () => {
    for (const ip of [
      '10.0.0.5',
      '192.168.1.20',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.10.1',
      '100.101.102.103', // Tailscale CGNAT
      'fd00::1',
      'fe80::abcd',
      '::ffff:10.1.2.3',
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  test('rejects public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.1.1', '2606:4700::1', '', 'garbage']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe('is this request on my network', () => {
  test('a LAN client is allowed', () => {
    assert.equal(isLocalRequest(request({ remoteAddress: '192.168.1.50' })), true);
  });

  test('a loopback client with no proxy headers is allowed', () => {
    assert.equal(isLocalRequest(request({ remoteAddress: '127.0.0.1' })), true);
  });

  test('a public client straight off the socket is refused', () => {
    assert.equal(isLocalRequest(request({ remoteAddress: '203.0.113.7' })), false);
  });

  test('a tunnel on the host forwarding a public visitor is refused', () => {
    // This is the case the socket check alone misses: cloudflared, ngrok and
    // friends connect over loopback, so only the forwarded chain reveals that
    // the actual visitor is on the internet.
    const req = request({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7, 172.71.0.1' },
    });
    assert.equal(isLocalRequest(req), false);
  });

  test('a LAN reverse proxy forwarding a LAN visitor is allowed', () => {
    const req = request({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '192.168.1.44' },
    });
    assert.equal(isLocalRequest(req), true);
  });

  test('a forged private forwarded header still fails on the socket', () => {
    const req = request({
      remoteAddress: '203.0.113.7',
      headers: { 'x-forwarded-for': '192.168.1.44' },
    });
    assert.equal(isLocalRequest(req), false, 'the header must never be able to grant access');
  });

  test('reports the original client, not the proxy', () => {
    const req = request({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7, 172.71.0.1' },
    });
    assert.deepEqual(clientAddress(req), { address: '203.0.113.7', viaProxy: true });
  });
});
