export const app = { getPath: () => process.env.JOLTY_DATA_DIR || '' }
export const safeStorage = { isEncryptionAvailable: () => false }
