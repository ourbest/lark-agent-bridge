export interface InboundAttachment {
  /** 文件在飞书的唯一标识 */
  fileKey: string;
  /** 原始文件名 */
  fileName: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** 下载后的本地路径 */
  localPath?: string;
  /** 附件类型 */
  attachmentType?: 'image' | 'file';
}

export interface InboundMessage {
  source: 'lark';
  sessionId: string;
  messageId: string;
  text: string;
  senderId: string;
  timestamp: string;
  /** 附件列表（文件/图片消息） */
  attachments?: InboundAttachment[];
  cardAction?: {
    action: 'approve' | 'approve-all' | 'approve-auto' | 'deny';
    requestId: string;
  };
}

export interface OutboundMessage {
  targetSessionId: string;
  text: string;
}

export interface OutboundReaction {
  targetMessageId: string;
  emojiType: string;
}

export interface ProjectReply {
  text: string;
}
