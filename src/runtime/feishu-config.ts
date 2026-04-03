export interface FeishuRuntimeConfig {
  appId: string;
  appSecret: string;
  wsEnabled: boolean;
}

export interface FeishuRuntimeEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  BRIDGE_FEISHU_WS_ENABLED?: string;
}

export function resolveFeishuRuntimeConfig(env: FeishuRuntimeEnv = process.env): FeishuRuntimeConfig | null {
  const appId = env.FEISHU_APP_ID?.trim() ?? '';
  const appSecret = env.FEISHU_APP_SECRET?.trim() ?? '';

  if (appId === '') {
    return null;
  }

  return {
    appId,
    appSecret,
    wsEnabled: env.BRIDGE_FEISHU_WS_ENABLED === '1',
  };
}
