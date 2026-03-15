// 本文件实现了配置文件备份的轮换机制。
// 这是一种常见策略，通过保留文件的几个旧版本来防止数据丢失。
// 当主配置文件被写入时，会触发备份维护流程。

import path from "node:path";

/**
 * 要保留的配置文件备份的数量。
 */
export const CONFIG_BACKUP_COUNT = 5;

/**
 * 定义备份轮换所需的文件系统操作的接口。
 * 这有助于在测试中模拟文件系统。
 */
export interface BackupRotationFs {
  unlink: (path: string) => Promise<void>; // 删除文件
  rename: (from: string, to: string) => Promise<void>; // 重命名/移动文件
  chmod?: (path: string, mode: number) => Promise<void>; // 更改文件权限
  readdir?: (path: string) => Promise<string[]>; // 读取目录内容
}

/**
 * 扩展了 `BackupRotationFs`，增加了备份维护所需的 `copyFile` 操作。
 */
export interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>; // 复制文件
}

/**
 * 轮换配置文件的备份。
 * 这个函数实现了备份文件的“移位”逻辑。
 * 例如，如果 `CONFIG_BACKUP_COUNT` 是 5：
 * - 删除 `config.bak.4`
 * - `config.bak.3` 重命名为 `config.bak.4`
 * - `config.bak.2` 重命名为 `config.bak.3`
 * - `config.bak.1` 重命名为 `config.bak.2`
 * - `config.bak`   重命名为 `config.bak.1`
 * @param configPath 主配置文件的路径。
 * @param ioFs 实现文件系统操作的对象。
 */
export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  // 如果备份数小于等于1，则无需轮换。
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  // 删除最旧的备份文件，尽力而为（忽略错误）。
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    // best-effort
  });
  // 将所有备份文件向前移动一个位置。
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      // best-effort
    });
  }
  // 将主备份文件（.bak）移到 .bak.1。
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    // best-effort
  });
}

/**
 * 强化备份文件的权限。
 * `copyFile` 在某些平台（如Windows）上不保证保留权限，
 * 所以我们明确地将每个备份文件的权限设置为仅所有者可读写（0o600），
 * 以匹配主配置文件的权限。
 * @param configPath 主配置文件的路径。
 * @param ioFs 实现文件系统操作的对象。
 */
export async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  // 强化主 .bak 文件的权限。
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    // best-effort
  });
  // 强化带编号的备份文件的权限。
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    await ioFs.chmod(`${backupBase}.${i}`, 0o600).catch(() => {
      // best-effort
    });
  }
}

/**
 * 删除轮换环之外的孤立备份文件。
 * 这些文件可能是由于写入中断、手动复制或带PID的备份（例如 openclaw.json.bak.1772352289）而累积的。
 *
 * 只有匹配 `<configBasename>.bak.*` 的文件会被考虑；
 * 主 `.bak` 和编号的 `.bak.1` 到 `.bak.{N-1}` 会被保留。
 * @param configPath 主配置文件的路径。
 * @param ioFs 实现文件系统操作的对象。
 */
export async function cleanOrphanBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.readdir) {
    return;
  }
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const bakPrefix = `${base}.bak.`;

  // 构建有效的编号后缀集合："1", "2", ..., "{N-1}"
  const validSuffixes = new Set<string>();
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    validSuffixes.add(String(i));
  }

  let entries: string[];
  try {
    entries = await ioFs.readdir(dir);
  } catch {
    return; // 尽力而为
  }

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (validSuffixes.has(suffix)) {
      continue;
    }
    // 这是一个孤立文件 — 删除它。
    await ioFs.unlink(path.join(dir, entry)).catch(() => {
      // best-effort
    });
  }
}

/**
 * 在配置文件写入前后运行完整的备份维护周期。
 * 顺序很重要：轮换备份环 -> 创建新的 .bak 文件 -> 强化权限模式 -> 修剪孤立的 .bak.* 文件。
 * @param configPath 主配置文件的路径。
 * @param ioFs 实现文件系统操作的对象。
 */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs,
): Promise<void> {
  // 1. 轮换现有备份，为新备份腾出空间
  await rotateConfigBackups(configPath, ioFs);
  // 2. 从当前配置文件创建新的主备份（.bak）
  await ioFs.copyFile(configPath, `${configPath}.bak`).catch(() => {
    // best-effort
  });
  // 3. 确保所有备份文件都有严格的权限
  await hardenBackupPermissions(configPath, ioFs);
  // 4. 清理任何不再属于轮换系列的旧备份文件
  await cleanOrphanBackups(configPath, ioFs);
}
