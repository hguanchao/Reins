import { randomBytes } from 'node:crypto';

/**
 * UUID v7:48 位毫秒时间戳 + 12 位序号 + 62 位随机后缀。
 *
 * 为什么自己实现:Node 的 `crypto.randomUUID()` 是 v4(纯随机),字典序与时间无关,
 * 而会话标识要靠「按 id 排序 = 按时间排序」这条性质——既能当同秒内的稳定平局裁决,
 * 也能直接从 id 反解出创建时刻。标准格式没多少代码,不值得为此引一个依赖。
 *
 * 序号解决两件事:同一毫秒内连续生成不重号且保持递增;时钟回拨时绝不往回走,
 * 否则排序就断了。每毫秒的起始序号取随机值,是为了多个进程写同一台机器时不撞号。
 */

/** rand_a 字段的位数:同毫秒内的单调序号上限。 */
const SEQ_MAX = 0xfff;

let lastMillis = -1;
let sequence = 0;

/** 生成一个 UUID v7:36 字符、小写、`8-4-4-4-12` 分组。 */
export function uuidv7(now: number = Date.now()): string {
  // 传入非有限值时回退到当前时刻,否则 writeUIntBE 会抛 RangeError
  const stamp = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : Date.now();
  if (stamp <= lastMillis) {
    // 时钟停滞或回拨:靠序号继续前进;序号用尽就把时间往后推一毫秒,保证只朝前
    sequence += 1;
    if (sequence > SEQ_MAX) {
      lastMillis += 1;
      sequence = 0;
    }
  } else {
    lastMillis = stamp;
    sequence = randomBytes(2).readUInt16BE(0) & SEQ_MAX;
  }
  return format(lastMillis, sequence);
}

function format(millis: number, seq: number): string {
  const bytes = Buffer.allocUnsafe(16);
  bytes.writeUIntBE(millis, 0, 6);
  const tail = randomBytes(8);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f); // 版本号 7 占高 4 位,低 4 位是序号高位
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | ((tail[0] ?? 0) & 0x3f); // RFC 4122 的 variant 位
  tail.copy(bytes, 9, 1, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
