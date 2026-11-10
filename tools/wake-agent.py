#!/usr/bin/env python3
"""Jolty wake agent: starts a PC that is switched off, for a phone that cannot reach it.

A PC that is off cannot answer, and a Wake-on-LAN packet only works from inside its own network. So this small
program runs on any device that stays on in the same network (a Raspberry Pi, a NAS, a spare Linux box or PC) and
sends the packet when your phone asks. Your phone reaches it privately through Tailscale (`tailscale serve`),
so no port is opened to the internet. It needs Python 3 and nothing else.

    python3 wake-agent.py --mac 60:CF:84:C8:F3:48 --token <secret> --origin https://my-pc.tailnet.ts.net

Jolty (Settings, Phone, Wake from phone) writes this command for you, with the right values.
"""
import argparse
import hmac
import json
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1


def parse_mac(text):
    digits = ''.join(c for c in text if c in '0123456789abcdefABCDEF')
    if len(digits) != 12:
        raise argparse.ArgumentTypeError('the MAC address needs 12 hex digits, like 60:CF:84:C8:F3:48')
    return bytes.fromhex(digits)


def local_broadcasts():
    """The broadcast address of the network this device is on (assuming the usual /24), besides the global one."""
    found = []
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(('10.255.255.255', 1))
        ip = probe.getsockname()[0]
        probe.close()
        parts = ip.split('.')
        if len(parts) == 4 and parts[0] != '127':
            found.append('.'.join(parts[:3] + ['255']))
    except OSError:
        pass
    return found


def wake(mac, targets, port):
    packet = b'\xff' * 6 + mac * 16
    sent = 0
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        for target in targets:
            for p in {port, 7, 9} if port == 9 else {port}:
                try:
                    sock.sendto(packet, (target, p))
                    sent += 1
                except OSError:
                    pass
    finally:
        sock.close()
    return sent


def main():
    ap = argparse.ArgumentParser(description='Sends Wake-on-LAN packets when a paired phone asks.')
    ap.add_argument('--mac', required=True, type=parse_mac, help='MAC address of the PC to wake')
    ap.add_argument('--token', required=True, help='the secret Jolty made for this agent')
    ap.add_argument('--origin', required=True, help="the address your PC's Jolty page is opened on, like https://my-pc.tailnet.ts.net")
    ap.add_argument('--port', type=int, default=8787, help='port to listen on, on this device only (default 8787)')
    ap.add_argument('--bind', default='127.0.0.1', help='address to listen on (default 127.0.0.1: only this device, tailscale serve passes requests on)')
    ap.add_argument('--broadcast', action='append', help='where to send the packet (default: this network and the global broadcast)')
    ap.add_argument('--wol-port', type=int, default=9, help='UDP port of the packet (default 9)')
    args = ap.parse_args()
    if len(args.token) < 16:
        sys.exit('The token is too short: use the one Jolty gave you.')

    targets = args.broadcast or (['255.255.255.255'] + local_broadcasts())
    recent = []

    class Handler(BaseHTTPRequestHandler):
        server_version = 'JoltyWake/%d' % VERSION

        def log_message(self, fmt, *a):
            pass

        def cors(self):
            origin = self.headers.get('Origin')
            if origin and origin.rstrip('/') == args.origin.rstrip('/'):
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Max-Age', '600')

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.cors()
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            auth = self.headers.get('Authorization', '')
            return auth.startswith('Bearer ') and hmac.compare_digest(auth[7:].encode(), args.token.encode())

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_GET(self):
            if self.path != '/ping':
                return self.reply(404, {'error': 'not found'})
            if not self.allowed():
                return self.reply(401, {'error': 'wrong token'})
            self.reply(200, {'ok': True, 'agent': VERSION, 'mac': ':'.join('%02X' % b for b in args.mac)})

        def do_POST(self):
            if self.path != '/wake':
                return self.reply(404, {'error': 'not found'})
            if not self.allowed():
                return self.reply(401, {'error': 'wrong token'})
            now = time.time()
            recent[:] = [t for t in recent if now - t < 60]
            if len(recent) >= 12:
                return self.reply(429, {'error': 'too many requests, wait a minute'})
            recent.append(now)
            self.reply(200, {'ok': True, 'sent': wake(args.mac, targets, args.wol_port)})

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print('Jolty wake agent on %s:%d for %s (packets to %s)' % (args.bind, args.port, ':'.join('%02X' % b for b in args.mac), ', '.join(targets)), flush=True)
    print('Next, once: tailscale serve --bg --https=8443 http://127.0.0.1:%d' % args.port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
