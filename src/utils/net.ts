import { lookup } from 'dns/promises';
import ipaddr from 'ipaddr.js';

export async function isBlockedHost(hostname: string): Promise<{ blocked: boolean; reason?: string }> {
  const hn = hostname.toLowerCase();
  if (hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn.endsWith('.local')) {
    return { blocked: true, reason: 'BLOCKED_HOST' };
  }
  try {
    const { address } = await lookup(hn, { all: false });
    if (isPrivateIp(address)) return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };
  } catch {
    return { blocked: true, reason: 'DNS_RESOLUTION_FAILED' };
  }
  return { blocked: false };
}

export function isPrivateIp(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    return ip.range() !== 'unicast';
  } catch {
    return true;
  }
}