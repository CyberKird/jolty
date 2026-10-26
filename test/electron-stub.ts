export const app = { getPath: () => process.env.JOLTY_DATA_DIR || '' }
export const safeStorage = { isEncryptionAvailable: () => false }
export const shell = { openExternal: async (_url: string) => undefined }
export const BrowserWindow = { getFocusedWindow: () => undefined }
export const dialog = {}
