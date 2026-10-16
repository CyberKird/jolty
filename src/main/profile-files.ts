import fs from 'fs'
import path from 'path'

/** Remove profile entries without following shared links or using native recursive deletion. */
export function removeProfileFiles(dir: string): void {
  const detach = (entry: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(entry)) detach(path.join(entry, name))
      fs.rmdirSync(entry)
    } else fs.unlinkSync(entry)
  }
  detach(dir)
}
