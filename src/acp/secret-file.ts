/**
 * 密钥文件读取工具
 * 
 * 功能概述：
 * 提供安全的密钥文件读取功能，用于从文件中加载敏感信息
 * 
 * 主要功能：
 * 1. 定义密钥文件的最大大小限制
 * 2. 提供安全的密钥文件读取接口
 * 
 * 安全特性：
 * - 限制文件大小，防止读取过大的文件
 * - 拒绝符号链接，防止路径遍历攻击
 */

import { DEFAULT_SECRET_FILE_MAX_BYTES, readSecretFileSync } from "../infra/secret-file.js";
// 导入默认的密钥文件最大字节数和同步读取函数

/**
 * 密钥文件的最大字节数限制
 * 从默认值继承，用于限制密钥文件的大小
 */
export const MAX_SECRET_FILE_BYTES = DEFAULT_SECRET_FILE_MAX_BYTES;

/**
 * 从文件中读取密钥
 * 
 * @param filePath - 密钥文件路径
 * @param label - 密钥标签，用于错误消息（如"Gateway token"、"Gateway password"）
 * @returns 文件内容字符串
 * 
 * 安全特性：
 * - 限制文件大小为MAX_SECRET_FILE_BYTES字节
 * - 拒绝符号链接，防止路径遍历攻击
 * 
 * @throws 如果文件不存在、无法读取或超过大小限制
 */
export function readSecretFromFile(filePath: string, label: string): string {
  // 调用底层同步读取函数，应用安全限制
  return readSecretFileSync(filePath, label, {
    maxBytes: MAX_SECRET_FILE_BYTES, // 限制文件大小
    rejectSymlink: true, // 拒绝符号链接
  });
}
