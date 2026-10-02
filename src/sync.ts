import type { Identity, Op } from './types'
import { uid } from './model'

/**
 * 两个浏览器窗口 / 标签页共享同一 localStorage 分区。
 * - storage 事件：跨窗口持久同步通道（其它窗口写入时本窗口收到）
 * - BroadcastChannel：同源窗口即时消息，补齐 storage 事件在同窗口多标签下的时序
 * - outbox：离线期间的修改排队，恢复连接时一次性并入共享操作日志
 */

const LOG_KEY = 'sologsb-1016-collab-log-v2'
const IDENTITY_KEY = 'sologsb-1016-collab-identity-v2'
const OUTBOX_KEY = 'sologsb-1016-collab-outbox-v2'
const PRESENCE_PREFIX = 'sologsb-1016-collab-presence-v2:'
const CHANNEL_NAME = 'sologsb-1016-collab-v2'

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function loadIdentity(): Identity | null {
  return safeParse<Identity | null>(localStorage.getItem(IDENTITY_KEY), null)
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
}

export function loadLog(): Op[] {
  return safeParse<Op[]>(localStorage.getItem(LOG_KEY), [])
}

export function saveLog(ops: Op[]): void {
  localStorage.setItem(LOG_KEY, JSON.stringify(ops))
}

export function loadOutbox(): Op[] {
  return safeParse<Op[]>(localStorage.getItem(OUTBOX_KEY), [])
}

export function saveOutbox(ops: Op[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops))
}

export interface PresenceEntry extends Identity {
  lastSeen: string
}

export function writePresence(identity: Identity): void {
  const entry: PresenceEntry = { ...identity, lastSeen: new Date().toISOString() }
  localStorage.setItem(PRESENCE_PREFIX + identity.peerId, JSON.stringify(entry))
}

export function readPresence(selfId: string): PresenceEntry[] {
  const now = Date.now()
  const result: PresenceEntry[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(PRESENCE_PREFIX)) continue
    const entry = safeParse<PresenceEntry | null>(localStorage.getItem(key), null)
    if (!entry) continue
    // 12 秒心跳超时即视为离线
    if (now - new Date(entry.lastSeen).getTime() > 12_000) continue
    if (entry.peerId === selfId) continue
    result.push(entry)
  }
  return result
}

type BusMessage =
  | { kind: 'ops'; ops: Op[]; from: string }
  | { kind: 'sync-request'; from: string }
  | { kind: 'sync-response'; ops: Op[]; from: string }
  | { kind: 'presence'; identity: Identity }

export class SyncBus {
  private channel: BroadcastChannel | null = null
  onRemoteOps: (ops: Op[]) => void = () => undefined
  onSyncRequest: (from: string) => void = () => undefined

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event: MessageEvent<BusMessage>) => {
        const msg = event.data
        if (msg.kind === 'ops' || msg.kind === 'sync-response') this.onRemoteOps(msg.ops)
        else if (msg.kind === 'sync-request') this.onSyncRequest(msg.from)
      }
    }
    window.addEventListener('storage', this.handleStorage)
  }

  private handleStorage = (event: StorageEvent) => {
    if (!event.key) return
    if (event.key === LOG_KEY) {
      const ops = safeParse<Op[]>(event.newValue, [])
      this.onRemoteOps(ops)
    } else if (event.key.startsWith(PRESENCE_PREFIX)) {
      // presence 轮询兜底即可，这里无需处理
    }
  }

  postOps(ops: Op[], selfId: string): void {
    this.channel?.postMessage({ kind: 'ops', ops, from: selfId } as BusMessage)
  }

  broadcastPresence(identity: Identity): void {
    this.channel?.postMessage({ kind: 'presence', identity } as BusMessage)
  }

  requestSync(selfId: string): void {
    this.channel?.postMessage({ kind: 'sync-request', from: selfId } as BusMessage)
  }

  respondSync(ops: Op[], selfId: string): void {
    this.channel?.postMessage({ kind: 'sync-response', ops, from: selfId } as BusMessage)
  }

  dispose(): void {
    this.channel?.close()
    window.removeEventListener('storage', this.handleStorage)
  }
}

export function makePeerId(): string {
  return uid('peer')
}

const PRESENCE_KEYS = (): string[] => {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith(PRESENCE_PREFIX)) keys.push(key)
  }
  return keys
}

/**
 * 退出当前窗口身份：只清除本窗口的身份与离线队列，以及它自己的在线心跳。
 * 绝不删除共享操作日志 LOG_KEY——那是两窗口共同的协作成果，由另一窗口继续持有；
 * 本窗口以新身份重开后会通过 storage / 同步请求重新拿到整份日志。
 */
export function clearCollabStorage(peerId: string): void {
  localStorage.removeItem(IDENTITY_KEY)
  localStorage.removeItem(OUTBOX_KEY)
  for (const key of PRESENCE_KEYS()) {
    const entry = safeParse<PresenceEntry | null>(localStorage.getItem(key), null)
    if (entry?.peerId === peerId) localStorage.removeItem(key)
  }
}
