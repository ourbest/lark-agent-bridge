import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InboundAttachment } from '../core/events/message.ts';

export interface FileUploadOptions {
  /** 项目的工作目录路径 */
  cwd: string;
  /** 附件列表 */
  attachments: InboundAttachment[];
  /** 下载文件的函数 */
  downloadFile: (attachment: InboundAttachment) => Promise<Buffer>;
}

export interface FileUploadResult {
  /** 保存的文件路径列表 */
  savedFiles: Array<{
    originalName: string;
    savedPath: string;
    fileSize: number;
    attachmentType: 'image' | 'file';
  }>;
  /** 下载失败的附件错误信息 */
  errors: Array<{
    fileName: string;
    fileKey: string;
    reason: string;
  }>;
}

/**
 * 将飞书消息中的附件下载到项目的 .upload 目录
 */
export async function saveMessageAttachments(options: FileUploadOptions): Promise<FileUploadResult> {
  const { cwd, attachments, downloadFile } = options;

  if (attachments.length === 0) {
    return { savedFiles: [], errors: [] };
  }

  // 创建 .upload 目录
  const uploadDir = path.join(cwd, '.upload');
  await mkdir(uploadDir, { recursive: true });

  // 并行下载所有附件
  const results = await Promise.allSettled(
    attachments.map(async (attachment): Promise<FileUploadResult['savedFiles'][number] | null> => {
      // 下载文件
      const buffer = await downloadFile(attachment);

      // 生成唯一的文件名（避免重名覆盖）
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const ext = path.extname(attachment.fileName) || '';
      const baseName = path.basename(attachment.fileName, ext);
      const uniqueFileName = `${baseName}_${timestamp}_${randomSuffix}${ext}`;

      // 保存文件
      const savedPath = path.join(uploadDir, uniqueFileName);
      await writeFile(savedPath, buffer);

      // 更新附件的本地路径
      attachment.localPath = savedPath;

      console.log(`[file-upload] saved file: ${attachment.fileName} -> ${savedPath} (${buffer.length} bytes)`);

      return {
        originalName: attachment.fileName,
        savedPath,
        fileSize: buffer.length,
        attachmentType: attachment.attachmentType ?? 'file',
      };
    }),
  );

  const savedFiles: FileUploadResult['savedFiles'] = [];
  const errors: FileUploadResult['errors'] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      savedFiles.push(result.value);
    } else {
      const reason = result.status === 'rejected'
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : 'unknown';
      const attachment = attachments[results.indexOf(result)];
      errors.push({
        fileName: attachment?.fileName ?? 'unknown',
        fileKey: attachment?.fileKey ?? 'unknown',
        reason,
      });
      console.error(`[file-upload] failed to save file: ${reason}`);
    }
  }

  return { savedFiles, errors };
}

/**
 * 获取项目的 .upload 目录路径
 */
export function getUploadDir(cwd: string): string {
  return path.join(cwd, '.upload');
}
